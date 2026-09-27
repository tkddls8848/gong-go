import { jsonResponse } from "./http.js";

const RELAY_ORIGIN = "https://apis.data.go.kr";
const LIVE_PATH = "/api/live";
const DAY_MS = 86400000;
const LIVE_PAGE_SIZE = 100;
const LIVE_MAX_PAGE = 200;
// 같은 조회 조건은 짧은 시간 안에 반복되는 경우가 많다. 브라우저에는 저장하지 않되 Worker의
// Cache API에만 5분 보관해 검색 버튼·모드 왕복·여러 세션이 같은 나라장터 페이지를 다시
// 호출하지 않게 한다. 개발계정의 일일 호출 한도를 아끼는 것이 목적이다.
const LIVE_CACHE_TTL_SECONDS = 5 * 60;
const LIVE_SERVICES = {
  pre: {
    base: "/1230000/ao/HrcspSsstndrdInfoService",
    ops: { "물품": "getPublicPrcureThngInfoThngPPSSrch", "외자": "getPublicPrcureThngInfoFrgcptPPSSrch", "용역": "getPublicPrcureThngInfoServcPPSSrch", "공사": "getPublicPrcureThngInfoCnstwkPPSSrch" },
  },
  bid: {
    base: "/1230000/ad/BidPublicInfoService",
    ops: { "물품": "getBidPblancListInfoThngPPSSrch", "외자": "getBidPblancListInfoFrgcptPPSSrch", "용역": "getBidPblancListInfoServcPPSSrch", "공사": "getBidPblancListInfoCnstwkPPSSrch" },
  },
  plan: {
    base: "/1230000/ao/OrderPlanSttusService",
    ops: { "물품": "getOrderPlanSttusListThngPPSSrch", "외자": "getOrderPlanSttusListFrgcptPPSSrch", "용역": "getOrderPlanSttusListServcPPSSrch", "공사": "getOrderPlanSttusListCnstwkPPSSrch" },
    snapshot: true,
  },
};
export async function handleLive(request, env, url, context) {
  if (request.method !== "GET") return jsonResponse({ message: "GET만 지원합니다." }, 405, { Allow: "GET" });
  if (!env.SERVICE_KEY) return jsonResponse({ message: "SERVICE_KEY 시크릿이 설정되지 않았습니다." }, 501);

  const mode = url.searchParams.get("mode") || "";
  const businessType = url.searchParams.get("businessType") || "";
  const begin = url.searchParams.get("begin") || "";
  const end = url.searchParams.get("end") || "";
  const pageNo = Number(url.searchParams.get("pageNo") || "1");
  const service = LIVE_SERVICES[mode];
  if (!service || !service.ops[businessType]) return jsonResponse({ message: "공고 유형 또는 업무구분이 올바르지 않습니다." }, 400);
  if (!validLiveRange(begin, end)) return jsonResponse({ message: "실시간 조회 기간은 YYYY-MM-DD 형식의 연속 2일까지 지원합니다." }, 400);
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > LIVE_MAX_PAGE) return jsonResponse({ message: `pageNo는 1~${LIVE_MAX_PAGE}만 지원합니다.` }, 400);

  // 인증 쿠키와 ServiceKey는 캐시 키에 넣지 않는다. 검증을 마친 조회 조건만 정해진 순서로
  // 다시 조립하므로 쿼리 파라미터 순서가 달라도 같은 페이지는 같은 캐시 항목을 쓴다.
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(liveCacheUrl(url, { mode, businessType, begin, end, pageNo }));
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return liveClientResponse(cached, "HIT");
  }

  const params = new URLSearchParams({ type: "json", pageNo: String(pageNo), numOfRows: String(LIVE_PAGE_SIZE), inqryDiv: "1", ServiceKey: env.SERVICE_KEY });
  if (service.snapshot) {
    params.set("orderBgnYm", begin.slice(0, 7).replace("-", ""));
    params.set("orderEndYm", end.slice(0, 7).replace("-", ""));
  } else {
    params.set("inqryBgnDt", `${begin.replaceAll("-", "")}0000`);
    params.set("inqryEndDt", `${end.replaceAll("-", "")}2359`);
  }

  const started = performance.now();
  let upstream;
  try {
    upstream = await fetch(`${RELAY_ORIGIN}${service.base}/${service.ops[businessType]}?${params}`, { headers: { Accept: "application/json" } });
  } catch (error) {
    return jsonResponse({ message: `최신 정보 조회에 실패했습니다: ${error.message}` }, 502, { "Server-Timing": `upstream;dur=${(performance.now() - started).toFixed(1)}` });
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Server-Timing": `upstream;dur=${(performance.now() - started).toFixed(1)}`,
    "X-Gong-Live-Cache": "MISS",
  });
  if (upstream.headers.has("Retry-After")) headers.set("Retry-After", upstream.headers.get("Retry-After"));
  const response = new Response(upstream.body, { status: upstream.status, headers });
  // 오류와 한도 응답은 캐시하지 않는다. 성공 응답만 내부 캐시용 복제본의 수명을 바꿔 넣고,
  // 사용자에게 돌려주는 원본은 계속 no-store라 브라우저 디스크에는 남지 않는다.
  if (cache && upstream.ok) {
    const cacheable = response.clone();
    cacheable.headers.set("Cache-Control", `public, max-age=${LIVE_CACHE_TTL_SECONDS}`);
    cacheable.headers.delete("Retry-After");
    const writing = cache.put(cacheKey, cacheable).catch(() => {});
    if (context?.waitUntil) context.waitUntil(writing);
    else await writing;
  }
  return response;
}

function liveCacheUrl(url, condition) {
  const params = new URLSearchParams(Object.entries(condition).map(([key, value]) => [key, String(value)]));
  return `${url.origin}${LIVE_PATH}?${params}`;
}

function liveClientResponse(response, state) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Gong-Live-Cache", state);
  headers.set("Server-Timing", `live-cache;desc=${state.toLowerCase()}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function validLiveRange(begin, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(begin) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  const first = Date.parse(`${begin}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  return !Number.isNaN(first) && !Number.isNaN(last) && first <= last && last - first <= DAY_MS;
}
