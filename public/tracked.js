(function (scope) {
  "use strict";
  const STORAGE_KEY = "gong-go:tracked-businesses";
  const TYPES = new Set(["", "물품", "외자", "용역", "공사"]);
  const STATES = new Set(["before", "opened", "failed", "rebid", "other"]);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" ? value : "";
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200;
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const safeError = code => ({ code: code === "not_authorized" ? code : "upstream", message: code === "not_authorized"
    ? "낙찰·계약과정 조회 권한이 없습니다. 서비스 키의 활용신청을 확인하세요."
    : "공고 진행 정보를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요." });
  function failure(code) {
    const info = code === "storage" ? { code, message: "관심사업을 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인하세요." } : safeError(code);
    return Object.assign(new Error(info.message), { code: info.code });
  }
  function chain(value) {
    if (value === null) return null;
    if (!record(value) || !["spec", "plan"].includes(value.kind) || !identifier(value.no)) throw failure();
    return { kind: value.kind, no: value.no };
  }
  function numeric(value) {
    if (value === undefined || value === null) return null;
    if (!finite(value)) throw failure();
    return value;
  }
  function strings(value, keys) {
    const out = {};
    for (const key of keys) {
      if (value[key] !== undefined && typeof value[key] !== "string") throw failure();
      out[key] = value[key] || "";
    }
    return out;
  }
  function bidder(value, winner = false) {
    if (!record(value) || typeof value.name !== "string") throw failure();
    const out = strings(value, winner ? ["name", "bizno"] : ["name", "bizno", "remark"]);
    for (const key of winner ? ["rank", "amount", "rate"] : ["rank", "amount", "rate", "techScore", "priceScore", "totalScore"]) out[key] = numeric(value[key]);
    return out;
  }
  function notice(value, current = false) {
    if (!record(value) || !identifier(value.bidNtceNo) || !STATES.has(value.state)) throw failure();
    const out = { ...strings(value, ["bidNtceNo", "ord", "title", "postedAt", "method", "bidMethod", "stateLabel", "openedAt", "reason"]), state: value.state };
    if (value.winners !== undefined && !Array.isArray(value.winners)) throw failure();
    out.winners = (value.winners || []).map(item => bidder(item, true));
    if (current) {
      if (value.bidders !== undefined && !Array.isArray(value.bidders)) throw failure();
      if (value.biddersTruncated !== undefined && typeof value.biddersTruncated !== "boolean") throw failure();
      out.participants = numeric(value.participants);
      out.notice = strings(value, ["notice"]).notice;
      out.bidders = (value.bidders || []).map(item => bidder(item));
      out.biddersTruncated = value.biddersTruncated || false;
    }
    return out;
  }
  function result(value) {
    if (!record(value) || !["spec", "bid"].includes(value.stage) || !TYPES.has(value.businessType) || !Array.isArray(value.notices) || !["", "chain", "limit"].includes(value.partial)) throw failure();
    const out = { stage: value.stage, businessType: value.businessType, chainKey: chain(value.chainKey), notices: value.notices.map(item => notice(item)), current: value.current === null ? null : notice(value.current, true), partial: value.partial };
    if (out.stage === "spec") {
      if (out.current || out.notices.length || out.chainKey?.kind !== "spec") throw failure();
    } else if (!out.current || !out.notices.length || out.notices.at(-1).bidNtceNo !== out.current.bidNtceNo) throw failure();
    return out;
  }
  function schedule(value) {
    if (!record(value)) return {};
    return Object.fromEntries(["bidClseDt", "opengDt", "opninRgstClseDt"].filter(key => typeof value[key] === "string").map(key => [key, value[key]]));
  }
  function parseTime(value) {
    if (typeof value !== "string" || !value) return NaN;
    const local = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(value);
    if (local) {
      const wallTime = `${local[1]}T${local[2] || "00:00"}:${local[3] || "00"}`;
      const parsed = Date.parse(`${wallTime}+09:00`);
      return Number.isFinite(parsed) && new Date(parsed + 9 * 3600000).toISOString().slice(0, 19) === wallTime ? parsed : NaN;
    }
    return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  }
  function sameChain(a, b) { return !!a && !!b && a.kind === b.kind && a.no === b.no; }
  function sameBusiness(a, b) {
    return a.id === b.id || sameChain(a.chainKey, b.chainKey)
      || (a.savedFrom === "bid" && b.result?.notices.some(item => item.bidNtceNo === a.savedNo))
      || (b.savedFrom === "bid" && a.result?.notices.some(item => item.bidNtceNo === b.savedNo));
  }
  function loadedItem(value) {
    if (!record(value) || !["bid", "pre"].includes(value.savedFrom) || !identifier(value.savedNo) || value.id !== `${value.savedFrom}:${value.savedNo}` || typeof value.title !== "string" || typeof value.institution !== "string" || !finite(value.savedAt)) return null;
    let key;
    try { key = chain(value.chainKey); } catch { return null; }
    let last = null;
    try { if (value.result !== null) last = result(value.result); } catch { /* Invalid cached results must be fetched again. */ }
    return {
      id: value.id, savedFrom: value.savedFrom, savedNo: value.savedNo, title: value.title,
      institution: value.institution, detailUrl: text(value.detailUrl), businessType: TYPES.has(value.businessType) ? value.businessType : "",
      chainKey: value.savedFrom === "pre" ? { kind: "spec", no: value.savedNo } : key,
      schedule: schedule(value.schedule), savedAt: value.savedAt, result: last,
      checkedAt: last && finite(value.checkedAt) ? value.checkedAt : null,
      error: record(value.error) ? safeError(value.error.code) : null,
    };
  }
  function createTracked({ storage, fetchJson, now = () => Date.now(), html, concurrency = 3 } = {}) {
    let unavailable = false, list = [], running = null;
    const generations = new Map();
    try {
      if (storage === undefined) storage = scope.localStorage;
      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") unavailable = true;
      else {
        const raw = storage.getItem(STORAGE_KEY);
        let saved;
        try { saved = JSON.parse(raw); } catch { saved = null; }
        if (saved?.version === 1 && Array.isArray(saved.items)) {
          for (const value of saved.items) {
            const item = loadedItem(value);
            if (item && !list.some(existing => sameBusiness(existing, item))) list.push(item);
          }
        }
      }
    } catch { unavailable = true; }
    list.forEach(item => generations.set(item.id, Symbol()));
    const limit = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 3) : 3;
    function commit(next) {
      if (unavailable) throw failure("storage");
      try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: next })); }
      catch { throw failure("storage"); }
      list = next;
      for (const id of generations.keys()) if (!list.some(item => item.id === id)) generations.delete(id);
    }
    function matching(row) {
      if (!row || !["bid", "pre"].includes(row.mode) || !identifier(row.announcementNumber)) return null;
      return list.find(item => item.id === `${row.mode}:${row.announcementNumber}`
        || (row.mode === "pre" && item.chainKey?.kind === "spec" && item.chainKey.no === row.announcementNumber)
        || (row.mode === "bid" && item.result?.notices.some(notice => notice.bidNtceNo === row.announcementNumber))) || null;
    }
    function remove(id) {
      if (list.some(item => item.id === id)) commit(list.filter(item => item.id !== id));
    }
    function toggle(row) {
      if (!row || !["bid", "pre"].includes(row.mode) || !identifier(row.announcementNumber)) return { saved: false, item: null };
      const existing = matching(row);
      if (existing) { remove(existing.id); return { saved: false, item: null }; }
      const item = {
        id: `${row.mode}:${row.announcementNumber}`, savedFrom: row.mode, savedNo: row.announcementNumber,
        title: text(row.title), institution: text(row.institution), detailUrl: text(row.detailUrl),
        businessType: row.mode === "pre" && TYPES.has(row.businessType) ? row.businessType : "",
        chainKey: row.mode === "pre" ? { kind: "spec", no: row.announcementNumber } : null,
        schedule: row.mode === "pre" ? { opninRgstClseDt: text(row.closeAt) } : schedule(row.bidSchedule || { bidClseDt: text(row.closeAt) }),
        savedAt: now(), result: null, checkedAt: null, error: null,
      };
      commit([...list, item]); generations.set(item.id, Symbol());
      return { saved: true, item: clone(item) };
    }
    function dueItems(nowMs = now()) {
      return clone(list.filter(item => {
        if (!item.result || item.checkedAt === null || item.error || item.result.partial || item.result.stage === "spec") return true;
        const current = item.result.current;
        if (current.state === "opened") return false;
        if (current.state !== "before" || current.bidNtceNo !== item.savedNo) return true;
        const reference = parseTime(item.schedule.opengDt || item.schedule.bidClseDt);
        return !Number.isFinite(reference) || reference <= nowMs;
      }));
    }
    function applyResult(id, body, receivedAt = now()) {
      const index = list.findIndex(item => item.id === id);
      if (index < 0) return;
      if (!finite(receivedAt)) throw failure();
      if (list[index].checkedAt !== null && receivedAt < list[index].checkedAt) return;
      const checked = result(body), next = clone(list);
      const updated = { ...next[index], result: checked, checkedAt: receivedAt, error: null };
      if (checked.businessType) updated.businessType = checked.businessType;
      if (checked.chainKey) updated.chainKey = checked.chainKey;
      next[index] = updated;
      // Keep the earliest saved snapshot when two previously separate entries are linked.
      const duplicates = next.filter(item => sameBusiness(item, updated));
      const survivor = duplicates[0];
      let replacedSurvivor = false;
      if (survivor.id !== updated.id && (survivor.checkedAt === null || receivedAt >= survivor.checkedAt)) {
        survivor.result = checked; survivor.checkedAt = receivedAt; survivor.error = null;
        survivor.businessType = updated.businessType; survivor.chainKey = updated.chainKey;
        replacedSurvivor = true;
      }
      const duplicateIds = new Set(duplicates.slice(1).map(item => item.id));
      commit(next.filter(item => !duplicateIds.has(item.id)));
      // A pending request for the survivor used its old snapshot. Once another saved
      // notice supplies its result, neither that old response nor its error may replace it.
      if (replacedSurvivor) generations.set(survivor.id, Symbol());
    }
    function applyError(id, error) {
      if (!list.some(item => item.id === id)) return;
      commit(list.map(item => item.id === id ? { ...item, error: safeError(error?.code) } : item));
    }
    function refresh({ all = false } = {}) {
      if (running) return running;
      const pending = (all ? clone(list) : dueItems()).map(item => ({ item, generation: generations.get(item.id) }));
      let cursor = 0;
      async function worker() {
        while (cursor < pending.length) {
          const { item, generation } = pending[cursor++];
          const current = () => generations.get(item.id) === generation;
          if (!current()) continue;
          const params = new URLSearchParams();
          if (item.savedFrom === "bid") params.set("bidNtceNo", item.savedNo);
          if (item.chainKey) params.set(item.chainKey.kind === "spec" ? "specNo" : "planNo", item.chainKey.no);
          if (item.businessType) params.set("businessType", item.businessType);
          try {
            const body = await fetchJson(`/api/business-status?${params}`);
            if (current()) applyResult(item.id, body, now());
          } catch (error) {
            if (!current()) continue;
            if (error?.code === "storage") throw error;
            applyError(item.id, error);
          }
        }
      }
      // Keep the shared run alive until every request settles, including when persistence fails.
      running = Promise.resolve().then(() => Promise.allSettled(Array.from({ length: Math.min(limit, pending.length) }, worker))).then(outcomes => {
        const rejected = outcomes.find(outcome => outcome.status === "rejected");
        if (rejected) throw rejected.reason;
      }).finally(() => { running = null; });
      return running;
    }
    const escape = html || (value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]));
    const DAY = 86400000, KST = 9 * 3600000;
    const kstText = ms => { const date = new Date(ms + KST); return finite(ms) && finite(date.getTime()) ? date.toISOString().slice(0, 16).replace("T", " ") : ""; };
    const shortDate = value => { const date = kstText(parseTime(value)); return date ? date.slice(5, 10).replace("-", "/") : ""; };
    const countdown = (end, at) => { const days = Math.floor((end + KST) / DAY) - Math.floor((at + KST) / DAY); return days === 0 ? "D-day" : `D-${days}`; };
    function statusLine(item, nowMs = now()) {
      if (item.error?.code === "not_authorized") return { label: "조회 권한 없음(서비스 키 활용신청 확인)", tone: "error" };
      if (item.error && !item.result) return { label: "결과를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.", tone: "error" };
      let label = "확인 전", tone = "wait";
      if (item.result?.stage === "spec") {
        const close = parseTime(item.schedule?.opninRgstClseDt);
        label = close > nowMs ? `사전규격 · 의견등록 마감 ${countdown(close, nowMs)}` : "본공고 대기";
      } else if (item.result?.current) {
        const current = item.result.current, date = shortDate(current.openedAt), suffix = date ? ` ${date}` : "";
        if (current.state === "before") {
          const savedSchedule = current.bidNtceNo === item.savedNo ? item.schedule || {} : {};
          const close = parseTime(savedSchedule.bidClseDt), open = parseTime(savedSchedule.opengDt);
          label = close > nowMs ? `입찰 마감 ${countdown(close, nowMs)}` : open > nowMs ? "개찰 대기"
            : Number.isFinite(open) || Number.isFinite(close) ? "개찰 결과 대기" : "일정 정보 없음";
        } else if (current.state === "opened") {
          const completed = current.method === "수의계약" ? `수의계약 · ${current.winners?.length ? "낙찰" : "개찰완료"}` : "개찰완료";
          label = `${completed}${suffix}`; tone = "done";
        } else if (current.state === "failed") {
          label = `유찰${suffix}${item.chainKey ? " · 재공고 대기" : ""}`; tone = "fail";
        } else if (current.state === "rebid") label = `재입찰${suffix}`;
        else label = current.stateLabel || "확인하지 못함";
      }
      if (item.error) { label += " · 최근 확인 실패"; tone = "error"; }
      return { label, tone };
    }
    function historyState(current) {
      if (current.state === "opened") return current.method === "수의계약" && current.winners?.length ? "낙찰" : "개찰완료";
      if (current.state === "failed") return "유찰";
      if (current.state === "rebid") return "재입찰";
      return current.state === "other" ? current.stateLabel || "확인하지 못함" : "진행 중";
    }
    function historyLine(item) {
      const notices = item.result?.notices || [];
      return notices.length < 2 ? "" : notices.map((notice, i) => `${i === 0 ? "1차" : notice.method === "수의계약" ? "수의계약" : `${i + 1}차`} ${historyState(notice)}`).join(" → ");
    }
    function winnerText(winners) {
      return (winners || []).map(winner => `${winner.name}${finite(winner.rate) ? ` ${winner.rate}%` : ""}`).join(" · ");
    }
    function resultSummary(item) {
      const current = item.result?.current;
      if (current?.state === "failed") return current.reason || "-";
      if (current?.state !== "opened") return "-";
      const first = [...(current.bidders || [])].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
      if (!first) return winnerText(current.winners) || "-";
      const rank = finite(first.rank) && first.rank > 0 ? `${first.rank}위` : "순위 미기재";
      const score = finite(first.totalScore) ? ` ${first.totalScore}점` : finite(first.rate) ? `(${first.rate}%)` : "";
      return `${rank} ${first.name}${score}${finite(current.participants) ? ` · ${current.participants}개사` : ""}`;
    }
    function warning(item) {
      if (item.result?.partial === "chain") return "이어진 공고를 확인하지 못했습니다. 저장한 공고만 표시합니다.";
      if (item.result?.partial === "limit") return "조회 범위 제한으로 공고 이력·분류 또는 업체 결과를 일부만 확인했습니다. 전체는 나라장터에서 확인하세요.";
      return "";
    }
    function checkedText(item) {
      const date = kstText(item.checkedAt);
      return date ? `마지막 확인 ${date} (한국시간)` : "";
    }
    function renderList(nowMs = now()) {
      if (!list.length) return '<p class="tracked-empty">저장한 관심사업이 없습니다. 본공고·사전공고 목록의 ☆를 눌러 저장하세요.</p>';
      return '<table class="tracked-table"><thead><tr><th>사업명</th><th>수요기관</th><th>현재 공고 번호</th><th>상태</th><th>결과</th><th>저장</th></tr></thead><tbody>' + list.map(item => {
        const status = statusLine(item, nowMs), history = historyLine(item), note = warning(item), checked = checkedText(item);
        return `<tr data-tracked-row="${escape(item.id)}"><td><button type="button" class="tracked-title" data-tracked-id="${escape(item.id)}" aria-expanded="false">${escape(item.title || "(사업명 없음)")}</button></td><td>${escape(item.institution || "-")}</td><td>${escape(item.result?.current?.bidNtceNo || item.savedNo)}</td><td><span class="tracked-state ${status.tone}">${escape(status.label)}</span>${history ? `<p class="tracked-history">${escape(history)}</p>` : ""}${note ? `<p class="tracked-warning">${escape(note)}</p>` : ""}${checked ? `<p class="tracked-checked">${escape(checked)}</p>` : ""}</td><td>${escape(resultSummary(item))}</td><td><button type="button" class="track-btn" data-untrack-id="${escape(item.id)}" aria-label="${escape(item.title || "관심사업")} 저장 해제">해제</button></td></tr>`;
      }).join("") + "</tbody></table>";
    }
    function externalLink(value) {
      if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\//i.test(value.trim())) return "";
      try { const url = new URL(value.trim()); return url.hostname && !url.username && !url.password ? value.trim() : ""; } catch { return ""; }
    }
    function renderDetail(id) {
      const item = list.find(entry => entry.id === id);
      if (!item) return "";
      const note = warning(item), status = statusLine(item), checked = checkedText(item), url = externalLink(item.detailUrl);
      let output = `<div class="tracked-detail"><p class="tracked-state ${status.tone}">${escape(status.label)}</p>`;
      if (checked) output += `<p class="tracked-checked">${escape(checked)}</p>`;
      if (note) output += `<p class="tracked-warning">${escape(note)}</p>`;
      if (item.result && !item.chainKey) output += '<p class="tracked-warning">사전규격·발주계획 연결 정보가 없어 이 공고만 추적합니다.</p>';
      if (url) output += `<p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">저장한 공고 원문 열기</a></p>`;
      const notices = item.result?.notices || [];
      if (notices.length) output += '<h3>공고 이력</h3><div class="tracked-detail-scroll"><table><thead><tr><th>공고번호</th><th>게시일</th><th>계약방법</th><th>상태</th><th>사유 또는 낙찰자</th></tr></thead><tbody>' + notices.map(notice => `<tr><td>${escape(notice.bidNtceNo)}</td><td>${escape(notice.postedAt || "-")}</td><td>${escape(notice.method || "-")}</td><td>${escape(historyState(notice))}</td><td>${escape(notice.reason || winnerText(notice.winners) || "-")}</td></tr>`).join("") + '</tbody></table></div>';
      const current = item.result?.current, bidders = current?.bidders || [];
      if (bidders.length) {
        const scores = bidders.some(bidder => [bidder.techScore, bidder.priceScore, bidder.totalScore].some(finite));
        const amounts = bidders.some(bidder => finite(bidder.amount)), rates = bidders.some(bidder => finite(bidder.rate));
        const columns = [["rank", "순위"], ["name", "업체명"], ["bizno", "사업자번호"], ...(amounts ? [["amount", "투찰금액"]] : []), ...(rates ? [["rate", "투찰률"]] : []), ...(scores ? [["techScore", "기술"], ["priceScore", "가격"], ["totalScore", "종합"]] : []), ["remark", "비고"]];
        output += '<h3>현재 공고 참여업체</h3><div class="tracked-detail-scroll"><table><thead><tr>' + columns.map(([, title]) => `<th>${title}</th>`).join("") + '</tr></thead><tbody>' + bidders.map(bidder => '<tr>' + columns.map(([key]) => `<td>${escape(bidder[key] === null || bidder[key] === undefined || bidder[key] === "" ? "-" : bidder[key])}</td>`).join("") + '</tr>').join("") + '</tbody></table></div>';
      } else if (current?.state === "opened" && !current.biddersTruncated) output += `<p>${escape(winnerText(current.winners) || "공개된 참여업체 결과가 없습니다.")}</p>`;
      if (current?.biddersTruncated) output += `<p class="tracked-warning">${bidders.length ? `상위 ${bidders.length}곳만 표시합니다.` : "참여업체 결과를 확인하지 못했습니다."} 전체는 나라장터에서 확인하세요.</p>`;
      return output + "</div>";
    }
    return { items: () => clone(list), count: () => list.length, isSaved: row => !!matching(row), toggle, remove, dueItems, applyResult, applyError, refresh, statusLine, historyLine, resultSummary, renderList, renderDetail };
  }
  const api = { createTracked };
  scope.GongTracked = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self === "undefined" ? globalThis : self);
