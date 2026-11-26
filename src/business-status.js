import { jsonResponse } from "./http.js";
import { UpstreamError, readUpstreamPage, num, noticeState, chainNotices, bidders } from "./business-status-normalize.js";

export const MAX_UPSTREAM_CALLS = 40;
const MAX_CHAIN_NOTICES = 8, PAGE_SIZE = 100, MAX_PAGES = 3;
const TYPES = { "용역": "Servc", "물품": "Thng", "공사": "Cnstwk", "외자": "Frgcpt" };
const CHAIN_BASE = "https://apis.data.go.kr/1230000/ao/CntrctProcssIntgOpenService/";
const RESULT_BASE = "https://apis.data.go.kr/1230000/as/ScsbidInfoService/";
const VALID_NO = /^[A-Z0-9]{8,20}$/;
const string = value => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
class CallLimit extends Error {}

export async function handleBusinessStatus(request, env, url, context) {
  if (request.method !== "GET") return jsonResponse({ message: "GET만 지원합니다." }, 405, { Allow: "GET" });
  if (!env.DATA_GO_KR_SERVICE_KEY) return jsonResponse({ message: "DATA_GO_KR_SERVICE_KEY 시크릿이 설정되지 않았습니다." }, 501);
  const input = Object.fromEntries(["bidNtceNo", "specNo", "planNo", "businessType"].map(key => [key, url.searchParams.get(key) || ""]));
  if ((!input.bidNtceNo && !input.specNo) || [input.bidNtceNo, input.specNo, input.planNo].some(no => no && !VALID_NO.test(no)) || (input.businessType && !Object.hasOwn(TYPES, input.businessType))) {
    return jsonResponse({ message: "공고번호 또는 업무구분이 올바르지 않습니다." }, 400);
  }
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`${url.origin}/api/business-status?${new URLSearchParams(input)}`);
  try {
    const hit = await cache?.match(cacheKey);
    if (hit) { const headers = new Headers(hit.headers); headers.set("Cache-Control", "no-store"); return new Response(hit.body, { headers }); }
  } catch { /* Cache availability must not prevent a fresh lookup. */ }

  let calls = 0, businessType = input.businessType, partial = "";
  let chainKey = input.specNo ? { kind: "spec", no: input.specNo } : input.planNo ? { kind: "plan", no: input.planNo } : null;
  let notices = [], current = null;
  const markLimit = () => { partial = "limit"; };
  async function page(base, op, params, pageNo) {
    if (calls >= MAX_UPSTREAM_CALLS) throw new CallLimit();
    calls++;
    const query = new URLSearchParams({ type: "json", ServiceKey: env.DATA_GO_KR_SERVICE_KEY, numOfRows: String(PAGE_SIZE), pageNo: String(pageNo), ...params });
    const response = await fetch(`${base}${op}?${query}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    return readUpstreamPage(response);
  }
  async function pages(base, op, params, validate) {
    const rows = []; let truncated = false;
    for (let i = 1; i <= MAX_PAGES; i++) {
      const result = await page(base, op, params, i);
      if (result.rows.some(row => !validate(row))) throw new UpstreamError();
      rows.push(...result.rows);
      const more = result.totalCount === null ? result.rows.length === PAGE_SIZE : rows.length < result.totalCount;
      if (!more) break;
      if (!result.rows.length) throw new UpstreamError();
      if (i === MAX_PAGES) truncated = true;
    }
    return { rows, truncated };
  }
  async function probe(base, prefix, params, validate) {
    const types = businessType ? [businessType] : Object.keys(TYPES);
    for (const type of types) {
      const result = await pages(base, prefix + TYPES[type], params, validate);
      if (result.truncated) markLimit();
      if (result.rows.length) { businessType = type; return result; }
    }
    return { rows: [], truncated: false };
  }
  const validChain = row => typeof row.bidNtceNo === "string" && (!row.bidNtceNo || VALID_NO.test(row.bidNtceNo));
  const validStatus = row => VALID_NO.test(string(row.bidNtceNo)) && !!string(row.progrsDivCdNm);
  const fallback = () => chainNotices([{ bidNtceNo: input.bidNtceNo }]);
  try {
    let source = [];
    if (!chainKey) {
      source = (await probe(CHAIN_BASE, "getCntrctProcssIntgOpen", { inqryDiv: "1", bidNtceNo: input.bidNtceNo }, validChain)).rows;
      source = source.filter(row => row.bidNtceNo === input.bidNtceNo);
      const latest = [...source].sort((a, b) => (num(b.bidNtceOrd) ?? 0) - (num(a.bidNtceOrd) ?? 0))[0];
      if (latest) {
        const spec = string(latest.bfSpecRgstNo), plan = string(latest.orderPlanNo);
        if (spec && VALID_NO.test(spec)) chainKey = { kind: "spec", no: spec };
        else if (plan && VALID_NO.test(plan)) chainKey = { kind: "plan", no: plan };
      }
    }
    if (chainKey) {
      try {
        const params = chainKey.kind === "spec" ? { inqryDiv: "2", bfSpecRgstNo: chainKey.no } : { inqryDiv: "3", orderPlanNo: chainKey.no };
        source = (await probe(CHAIN_BASE, "getCntrctProcssIntgOpen", params, validChain)).rows;
      } catch (error) {
        if (!input.bidNtceNo || error instanceof CallLimit || error.code === "not_authorized") throw error;
        partial = "chain";
        source = source.filter(row => row.bidNtceNo === input.bidNtceNo);
      }
    }
    if (new Set(source.map(row => row.bidNtceNo).filter(Boolean)).size > MAX_CHAIN_NOTICES) markLimit();
    notices = chainNotices(source, MAX_CHAIN_NOTICES);
    if (!notices.length && input.bidNtceNo) notices = fallback();
    // Unqueried records remain explicitly unknown if the request budget runs out.
    notices.forEach(notice => { notice.state = "other"; notice.stateLabel = "확인하지 못함"; });
    for (const notice of notices) {
      const { rows: resultRows, truncated: statusTruncated } = await probe(RESULT_BASE, "getOpengResultListInfo", { inqryDiv: "4", bidNtceNo: notice.bidNtceNo }, validStatus);
      let rows = resultRows.filter(row => row.bidNtceNo === notice.bidNtceNo);
      const ord = notice.ord || [...rows].sort((a, b) => (num(b.bidNtceOrd) ?? 0) - (num(a.bidNtceOrd) ?? 0))[0]?.bidNtceOrd;
      if (ord) rows = rows.filter(row => !string(row.bidNtceOrd) || num(row.bidNtceOrd) === num(ord));
      if (new Set(rows.map(row => string(row.bidClsfcNo))).size > 1) markLimit();
      rows.sort((a, b) => (num(b.rbidNo) ?? 0) - (num(a.rbidNo) ?? 0) || string(a.bidClsfcNo).localeCompare(string(b.bidClsfcNo)));
      const row = rows[0];
      notice.state = row ? noticeState(row.progrsDivCdNm) : statusTruncated ? "other" : "before";
      notice.stateLabel = row ? string(row.progrsDivCdNm) : statusTruncated ? "확인하지 못함" : "";
      notice.openedAt = string(row?.opengDt);
      notice.reason = string(row?.opengRsltNtcCntnts);
      if (!notice.ord && row) notice.ord = string(row.bidNtceOrd);
      if (notice !== notices.at(-1)) continue;
      current = { ...notice, participants: num(row?.prtcptCnum), notice: string(row?.opengRsltNtcCntnts), bidders: [], biddersTruncated: false };
      if (!row) continue;
      const params = { bidNtceNo: notice.bidNtceNo };
      for (const key of ["bidNtceOrd", "bidClsfcNo", "rbidNo"]) if (string(row[key])) params[key] = string(row[key]);
      // APIs sometimes return multiple rounds even with filters; retain only this round.
      const sameRound = value => Object.entries(params).every(([key, val]) => !string(value[key]) || (key === "bidNtceNo" ? string(value[key]) === val : num(value[key]) === num(val)));
      if (notice.state === "opened") {
        const detail = await pages(RESULT_BASE, "getOpengResultListInfoOpengCompt", params, value => !!string(value.prcbdrNm));
        current.bidders = bidders(detail.rows.filter(sameRound));
        current.biddersTruncated = detail.truncated;
        if (detail.truncated) markLimit();
      } else if (notice.state === "failed" || notice.state === "rebid") {
        const failed = notice.state === "failed", field = failed ? "nobidRsn" : "rbidRsn";
        const detail = await pages(RESULT_BASE, `getOpengResultListInfo${failed ? "Failing" : "Rebid"}`, params, value => typeof value[field] === "string");
        current.reason = detail.rows.filter(sameRound).map(value => string(value[field])).filter(Boolean).join(" · ") || notice.reason;
        notice.reason = current.reason;
        if (detail.truncated) markLimit();
      }
    }
  } catch (error) {
    if (error instanceof CallLimit && notices.length) {
      markLimit();
      if (current?.state === "opened") current.biddersTruncated = true;
    }
    else {
      const safe = error instanceof UpstreamError ? error : new UpstreamError();
      return jsonResponse({ code: safe.code, message: safe.message }, 502);
    }
  }
  if (!current && notices.length) current = { ...notices.at(-1), participants: null, notice: "", bidders: [], biddersTruncated: partial === "limit" };
  const response = jsonResponse({ businessType, chainKey, stage: notices.length ? "bid" : "spec", notices, current, partial });
  // Partial responses are retried; only complete successes occupy the five-minute cache.
  if (cache && !partial) {
    const cacheable = response.clone(); cacheable.headers.set("Cache-Control", "public, max-age=300");
    const writing = cache.put(cacheKey, cacheable).catch(() => {});
    if (context?.waitUntil) context.waitUntil(writing); else await writing;
  }
  return response;
}
