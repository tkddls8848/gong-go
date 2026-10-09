const { sleep } = require("./store");

const PAGE_SIZE = 999;
const RETRIES = 3;
// 요청 하나의 전체 시한. 본문을 다 받는 시간까지 포함한다. 본공고 한 페이지가 5~6MB라
// 동시 8요청에서는 정상 응답도 15~30초가 걸려, 30초로는 멀쩡한 페이지가 시한에 잘렸다.
const REQUEST_TIMEOUT_MS = 90_000;
const MODES = {
  pre: {
    base: "/1230000/ao/HrcspSsstndrdInfoService",
    ops: { 물품: "getPublicPrcureThngInfoThngPPSSrch", 외자: "getPublicPrcureThngInfoFrgcptPPSSrch", 용역: "getPublicPrcureThngInfoServcPPSSrch", 공사: "getPublicPrcureThngInfoCnstwkPPSSrch" },
  },
  bid: {
    base: "/1230000/ad/BidPublicInfoService",
    ops: { 물품: "getBidPblancListInfoThngPPSSrch", 외자: "getBidPblancListInfoFrgcptPPSSrch", 용역: "getBidPblancListInfoServcPPSSrch", 공사: "getBidPblancListInfoCnstwkPPSSrch" },
    // 제안요청정보 첨부(e발주 첨부파일정보). 업무구분 없이 하나이고, 응답은 공고가 아니라 파일 한 건이
    // 한 행이다. 조회 범위는 공고 게시일시라 같은 구간의 공고 목록과 짝이 맞는다(collector/eorder-files.js).
    eorder: "getBidPblancListInfoEorderAtchFileInfo",
  },
  // 발주계획현황(15129462). 앞의 둘과 달리 조회 범위를 지정할 수 없다 — orderBgnYm/orderEndYm과
  // inqryBgnDt/inqryEndDt를 모두 받아 형식까지 검증하면서도(잘못된 포맷은 "DATE Format 에러")
  // 어떤 값을 넣든 결과가 바뀌지 않는다. 실제로 돌아오는 것은 최근 며칠 안에 게시된 계획뿐이다.
  //
  // 그래서 이 모드는 snapshot으로 둔다. 과거를 소급해 받을 수 없고, 매 실행이 "지금 열려 있는
  // 창"을 한 번 떠 오는 것이다. 보유 데이터는 그 스냅샷이 nticeDt(게시일시) 기준으로 쌓여 만들어진다.
  plan: {
    base: "/1230000/ao/OrderPlanSttusService",
    ops: { 물품: "getOrderPlanSttusListThngPPSSrch", 외자: "getOrderPlanSttusListFrgcptPPSSrch", 용역: "getOrderPlanSttusListServcPPSSrch", 공사: "getOrderPlanSttusListCnstwkPPSSrch" },
    snapshot: true,
  },
};

// 제안요청정보 작업의 type. 업무구분(물품·외자·용역·공사)과 겹치지 않는 이름이다.
const EORDER_TYPE = "제안요청정보";
function operationOf(job) { return job.type === EORDER_TYPE ? MODES[job.mode].eorder : MODES[job.mode].ops[job.type]; }
function sourceEndpoint(job) { return `${MODES[job.mode].base}/${operationOf(job)}`; }

function ymd(value) { return String(value).replaceAll("-", ""); }
function ym(value) { return ymd(value).slice(0, 6); }

function createClient({
  SERVICE_KEY, API_BASE = "https://apis.data.go.kr", RELAY_TOKEN = "", concurrency = 1,
  fetch = (...args) => globalThis.fetch(...args),
}) {
  async function fetchJob(job) {
    // 1페이지로 전체 페이지 수를 확인한 뒤 나머지 페이지를 동시에 받는다.
    const first = await fetchPage(job, 1);
    if (first.totalPages <= 1) return first.items;
    const rest = await Promise.all(Array.from({ length: first.totalPages - 1 }, (_, index) => fetchPage(job, index + 2)));
    return [...first.items, ...rest.flatMap((page) => page.items)];
  }

  async function fetchPage(job, pageNo) {
    const definition = MODES[job.mode];
    const params = new URLSearchParams({ type: "json", pageNo: String(pageNo), numOfRows: String(PAGE_SIZE), inqryDiv: "1", ...rangeParams(job), ServiceKey: SERVICE_KEY });
    const data = await requestJson(`${API_BASE}${definition.base}/${operationOf(job)}?${params}`, {
      mode: job.mode,
      type: job.type,
      range: `${job.range.begin}~${job.range.end}`,
      page: pageNo,
    });
    const body = data?.response?.body;
    if (!body) throw new Error(data?.response?.header?.resultMsg || JSON.stringify(data));
    const items = Array.isArray(body.items) ? body.items : body.items?.item ? (Array.isArray(body.items.item) ? body.items.item : [body.items.item]) : [];
    return { items, totalPages: Math.max(1, Math.ceil(Number(body.totalCount || 0) / Number(body.numOfRows || PAGE_SIZE))) };
  }

  // 조회 범위 파라미터는 서비스마다 이름이 다르다. 발주계획은 일시(inqryBgnDt)가 아니라
  // 발주년월(orderBgnYm)을 받는다 — 지금은 어느 쪽도 결과를 거르지 않지만, 포털이 필터를
  // 고치면 그때는 요청한 구간만 오는 것이 맞으므로 명세대로 실어 보낸다.
  function rangeParams(job) {
    if (MODES[job.mode].snapshot) return { orderBgnYm: ym(job.range.begin), orderEndYm: ym(job.range.end) };
    return { inqryBgnDt: `${ymd(job.range.begin)}0000`, inqryEndDt: `${ymd(job.range.end)}2359` };
  }

  // 수집 실행별 HTTP 동시 실행 제한. 작업·페이지 병렬을 모두 이 세마포어 하나로 묶어
  // 나라장터 API에 동시에 나가는 요청 수를 한 값으로 통제한다.
  const httpLimit = Math.max(1, Number(concurrency));
  let httpActive = 0;
  const httpQueue = [];
  function acquireHttp() { if (httpActive < httpLimit) { httpActive += 1; return Promise.resolve(); } return new Promise((resolve) => httpQueue.push(resolve)); }
  function releaseHttp() { const next = httpQueue.shift(); if (next) next(); else httpActive -= 1; }

  async function requestJson(url, meta) {
    let lastError;
    for (let retry = 0; retry <= RETRIES; retry += 1) {
      const queuedAt = performance.now();
      await acquireHttp();
      const startedAt = performance.now();
      let status = 0;
      let bytes = 0;
      let upstreamMs = null;
      let error = null;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json", ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = response.status;
        upstreamMs = serverTimingDuration(response.headers.get("Server-Timing"), "upstream");
        const body = await response.text();
        bytes = Buffer.byteLength(body);
        if (!response.ok) {
          error = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
          error.httpStatus = response.status;
          error.retryAfterMs = retryAfterMs(response.headers.get("Retry-After"));
          throw error;
        }
        const data = JSON.parse(body);
        logRequest(meta, { queueWaitMs: startedAt - queuedAt, fetchMs: performance.now() - startedAt, status, bytes, retry, upstreamMs });
        return data;
      } catch (caught) {
        error = withCause(caught);
        lastError = error;
        logRequest(meta, {
          queueWaitMs: startedAt - queuedAt,
          fetchMs: performance.now() - startedAt,
          status,
          bytes,
          retry,
          upstreamMs,
          error: errorClass(error),
        }, true);
      } finally {
        // 재시도 backoff 중에는 HTTP permit을 잡고 있지 않는다. 느린 한 페이지가 다른 페이지의
        // 첫 시도까지 줄 세우지 않게 attempt 하나만 세마포어로 센다.
        releaseHttp();
      }
      if (retry >= RETRIES || !isRetryable(error)) throw lastError;
      await sleep(Math.max(error?.retryAfterMs || 0, retryDelay(retry)));
    }
    throw lastError;
  }

  function logRequest(meta, timing, failed = false) {
    const value = { ...meta, ...roundTiming(timing) };
    // URL에는 ServiceKey가 있으므로 어떤 경우에도 URL 자체는 로그에 넣지 않는다.
    (failed ? console.warn : console.log)(`HTTP ${JSON.stringify(value)}`);
  }
  function roundTiming(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, typeof item === "number" && !Number.isInteger(item) ? Number(item.toFixed(1)) : item]));
  }
  function retryAfterMs(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
  }
  function retryDelay(retry) { return 800 * 2 ** retry * (0.75 + Math.random() * 0.5); }
  function errorClass(error) { return error?.cause?.code || error?.code || error?.name || "Error"; }

  // fetch가 네트워크 단계에서 실패하면 message는 "fetch failed" 한 줄뿐이고 실제 사유는
  // cause에 들어간다. 로컬에서는 재현되지 않고 GitHub Actions에서만 터지는 경우가 있어,
  // DNS(ENOTFOUND)·연결 거부(ECONNREFUSED)·타임아웃·인증서 오류를 구분할 수 있어야 한다.
  function withCause(error) {
    const cause = error?.cause;
    if (!cause) return error;
    const detail = [cause.code, cause.message].filter(Boolean).join(": ");
    return detail ? new Error(`${error.message} (${detail})`, { cause }) : error;
  }
  return { fetchJob };
}

function serverTimingDuration(header, name) {
  const match = String(header || "").match(new RegExp(`(?:^|,)\\s*${name}\\s*;\\s*dur=([0-9.]+)`, "i"));
  return match ? Number(match[1]) : null;
}
// 상태가 아니라 오류로 재시도를 판단한다. HTTP 200 뒤 본문 전송이 끊기거나 JSON 해석이
// 실패한 경우도 재시도한다. 응답 상태가 실패 원인인 오류에만 httpStatus가 있다.
function isRetryable(error) {
  const status = error?.httpStatus;
  return status ? status === 408 || status === 429 || status >= 500 : true;
}
module.exports = { MODES, EORDER_TYPE, sourceEndpoint, createClient, serverTimingDuration, isRetryable };
