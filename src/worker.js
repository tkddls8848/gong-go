// 요청 인증과 라우팅. 각 API의 구현은 같은 src/ 안의 기능 모듈에 둔다.
import { handleEcr, purgeStaleJobs } from "./ecr.js";
import { handleAiAccess, clearAiAccessCookie, revokeAiAccess } from "./ai-access.js";
import { handleAsk } from "./ask-handler.js";
import { handleLive } from "./live.js";
import { handleRefresh, dispatchCollect } from "./refresh.js";
import { handleRelay, RELAY_PREFIX } from "./relay.js";
import { serveData } from "./data.js";
import { COOKIE_NAME, LOGIN_PATH, isAuthenticated, handleLogin, clearCookie,
  safePath, loginPageHtml } from "./gate.js";
import { redirect, htmlResponse } from "./http.js";

const LOGOUT_PATH = "/api/logout";
const LEGACY_LOGOUT_PATH = "/__gate/logout";
const DATA_PREFIX = "/data/";
const ROBOTS_PATH = "/robots.txt";
const REFRESH_PATH = "/api/refresh";
const ASK_PATH = "/api/ask";
const LIVE_PATH = "/api/live";

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    // 중계는 사람용 비밀번호 게이트와 별개다. 수집기(GitHub Actions)가 쓰는 기계 경로라
    // 자체 토큰으로만 인증하고, 로그인 화면을 돌려주지 않는다.
    if (url.pathname.startsWith(RELAY_PREFIX)) return handleRelay(request, env, url);

    // robots.txt도 게이트 앞이다. 뒤에 두면 크롤러는 이 자리에서도 401 로그인 페이지를
    // 받고, 그것은 "수집하지 말라"가 아니라 "규칙을 읽을 수 없다"로 읽힌다 — 규약은
    // 가져오지 못한 robots.txt를 "제한 없음"으로 보는 쪽과 "전부 금지"로 보는 쪽이
    // 갈려서, 결국 크롤러마다 다르게 굴게 된다. 내용을 공개하는 것이 아니라 오지 말라는
    // 말만 내보내는 자리이므로 인증을 걸 이유도 없다.
    if (url.pathname === ROBOTS_PATH) return env.ASSETS.fetch(request);

    const password = env.GATE_PASSWORD;

    if (!password) return new Response("GATE_PASSWORD is not configured", { status: 500 });

    const secure = url.protocol === "https:";

    if (url.pathname === LOGOUT_PATH || url.pathname === LEGACY_LOGOUT_PATH) {
      const origin = request.headers.get("Origin");
      if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (origin && origin !== url.origin)) return new Response("같은 사이트에서 로그아웃해 주세요.", { status: 403 });
      // /api 범위의 AI 쿠키를 받기 위해 브라우저가 해당 경로를 다시 요청하게 한다.
      if (url.pathname === LEGACY_LOGOUT_PATH) return redirect(LOGOUT_PATH);
      try { await revokeAiAccess(request, env); }
      catch {
        return htmlResponse('<!doctype html><html lang="ko"><meta charset="utf-8"><title>로그아웃 확인 필요</title><p>사이트 조회 쿠키는 삭제했습니다. AI 권한 취소에 실패했습니다.</p><p><a href="/api/logout">서버 권한 취소 다시 시도</a></p></html>', 503, { "Cache-Control": "no-store", "Set-Cookie": clearCookie(COOKIE_NAME, secure) });
      }
      const response = redirect("/", clearCookie(COOKIE_NAME, secure));
      response.headers.append("Set-Cookie", clearAiAccessCookie(request));
      return response;
    }

    if (request.method === "POST" && url.pathname === LOGIN_PATH) {
      return handleLogin(request, password, secure);
    }

    if (await isAuthenticated(request, password)) {
      return routeRequest(request, env, context);
    }

    const dest = safePath(url.pathname + url.search);
    return htmlResponse(loginPageHtml({ redirect: dest }), 401, {
      "Cache-Control": "no-store",
      // robots.txt를 읽지 않고 링크를 타고 들어온 크롤러가 실제로 받는 것은 이 페이지다.
      // 안의 <meta name="robots">와 같은 말이지만, 헤더 쪽은 HTML을 파싱하지 않는
      // 수집기도 본다.
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
  },

  // 업무 시간대 매시 갱신(wrangler.jsonc의 triggers.crons). 게이트와 무관한 경로다 —
  // 요청이 아니라 런타임이 부른다.
  //
  // scheduledTime은 "예정된 시각"이다. 호출이 조금 밀려도 이 값으로 날짜를 세야 09시 실행이
  // 09시 기준으로 남는다.
  async scheduled(event, env) {
    // 보존 기간이 지난 분석 작업 자료를 먼저 걷어 간다. 원문 사본을 쌓아 두지 않으려는 것이라
    // 수집 실패와 서로를 막지 않아야 한다 — 어느 쪽이 실패해도 다른 쪽은 돈다.
    try { await purgeStaleJobs(env, event.scheduledTime); }
    catch (error) { console.warn(JSON.stringify({ event: "ecr_retention_failed", message: error.message })); }
    await dispatchCollect(env, event.scheduledTime);
  },
};
async function routeRequest(request, env, context) {
  const url = new URL(request.url);
  if (url.pathname === REFRESH_PATH) return handleRefresh(request, env, url);
  if (url.pathname === LIVE_PATH) return handleLive(request, env, url, context);
  // 게이트를 통과한 요청만 여기 온다. 인증 앞에 두면 남이 계정 요금을 태울 수 있다.
  if (url.pathname === ASK_PATH) return handleAsk(request, env);
  if (url.pathname === "/api/ecr") return handleEcr(request, env);
  if (url.pathname === "/api/ai-access") return handleAiAccess(request, env);
  if (url.pathname.startsWith(DATA_PREFIX)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return serveData(request, env, url.pathname.slice(DATA_PREFIX.length));
  }
  return env.ASSETS.fetch(request);
}
