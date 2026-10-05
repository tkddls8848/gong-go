import { jsonResponse, timingSafeEqual } from "./http.js";

export const RELAY_PREFIX = "/api/relay/";
// 중계가 열어 주는 경로. 이 목록에 없으면 통과시키지 않는다 — 임의 URL을 받아 주면
// 이 Worker가 그대로 공개 프록시가 된다. 수집기가 쓰는 세 서비스만 적는다.
const RELAY_ALLOW = /^\/1230000\/(ao\/HrcspSsstndrdInfoService|ad\/BidPublicInfoService|ao\/OrderPlanSttusService)\/[A-Za-z]{1,60}$/;
const RELAY_ORIGIN = "https://apis.data.go.kr";
// GitHub 러너(Azure 대역)에서는 apis.data.go.kr로 TCP 연결이 성립하지 않는다. 차단은 국가가
// 아니라 IP 대역 기준이라 Cloudflare 엣지에서는 통과한다 — 미국 LAX colo에서도 155~515ms로
// 응답이 온다. 그래서 수집기의 요청만 이 Worker가 대신 내보낸다.
// (docs/프로젝트-통합-문서.md 2부)
export async function handleRelay(request, env, url) {
  if (!env.RELAY_TOKEN) return jsonResponse({ message: "RELAY_TOKEN 시크릿이 설정되지 않았습니다." }, 501);

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // 토큰이 비어 있으면 timingSafeEqual을 태우지 않는다 — 빈 문자열끼리 맞아 떨어지면 안 된다.
  if (!token || !timingSafeEqual(token, env.RELAY_TOKEN)) return jsonResponse({ message: "중계 토큰이 올바르지 않습니다." }, 401);
  if (request.method !== "GET") return jsonResponse({ message: "GET만 지원합니다." }, 405, { Allow: "GET" });

  const target = url.pathname.slice(RELAY_PREFIX.length - 1);
  if (!RELAY_ALLOW.test(target)) return jsonResponse({ message: "허용되지 않은 중계 경로입니다." }, 403);

  let upstream;
  const upstreamStarted = performance.now();
  try {
    upstream = await fetch(`${RELAY_ORIGIN}${target}${url.search}`, { headers: { Accept: request.headers.get("Accept") || "application/json" } });
  } catch (error) {
    // 여기서 실패하면 Cloudflare 쪽에서도 못 나간 것이다. 수집기가 원인을 볼 수 있게 사유를 실어 준다.
    return jsonResponse({ message: `중계 요청이 실패했습니다: ${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ""}` }, 502, {
      "Server-Timing": `upstream;dur=${(performance.now() - upstreamStarted).toFixed(1)}`,
    });
  }
  // 응답 본문은 그대로 흘려보내고 헤더는 새로 만든다. 상류의 쿠키·캐시 지시를 옮기면
  // 서비스키가 실린 URL이 어딘가에 캐시될 수 있다.
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Server-Timing": `upstream;dur=${(performance.now() - upstreamStarted).toFixed(1)}`,
  });
  // 429/503에서 상류가 준 대기 시간은 재시도 폭주를 막는 지시이므로 안전하게 전달한다.
  if (upstream.headers.has("Retry-After")) headers.set("Retry-After", upstream.headers.get("Retry-After"));
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
