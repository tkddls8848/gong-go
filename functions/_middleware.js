// Cloudflare Pages Functions - 공유 비밀번호(시크릿) 게이트
// 파일 위치: functions/_middleware.js
//
// 목적:
//   로그인 시스템 없이 "아는 사람만 쓰는 URL + 암호" 수준의 가벼운 접근 통제.
//   functions/ 최상위의 _middleware.js는 이 프로젝트로 들어오는 "모든" 요청
//   (정적 파일 index.html/app.js/... + /api 프록시 함수)보다 먼저 실행된다.
//   요청의 쿠키 또는 헤더 값을 env에 저장한 비밀번호와 대조해 통과 여부를 정한다.
//
// 설정(Cloudflare Pages > 설정 > 환경 변수):
//   GATE_PASSWORD   (필수) 공유 비밀번호. 값이 없으면 게이트는 비활성화되어 그대로 통과.
//   GATE_COOKIE_NAME(선택) 인증 쿠키 이름. 기본값 "gong_gate".
//   GATE_MAX_AGE    (선택) 인증 유지 시간(초). 기본값 604800(7일).
//
// 통과 방법:
//   1) 브라우저 - 최초 접속 시 간단한 비밀번호 입력 화면 → 성공하면 HttpOnly 쿠키 발급.
//   2) 프로그램/스크립트 - 요청 헤더 "X-Gate-Password: <비밀번호>" 로 매 요청 인증.
//
// 보안 수준:
//   Cloudflare Access(정식 로그인/SSO)보다 낮다. 단일 공유 암호이므로
//   유출되면 누구나 접근 가능하며, 개인별 감사/차단은 불가하다.
//   대신 설정이 단순하고 별도 로그인 인프라가 필요 없다.

const COOKIE_NAME_DEFAULT = "gong_gate";
const MAX_AGE_DEFAULT = 60 * 60 * 24 * 7; // 7일
const HEADER_NAME = "x-gate-password"; // 프로그램 접근용 헤더
const LOGIN_PATH = "/__gate/login";
const LOGOUT_PATH = "/__gate/logout";

export async function onRequest(context) {
  const { request, env, next } = context;
  const password = env.GATE_PASSWORD;

  // 비밀번호가 설정되지 않았으면 게이트를 켜지 않는다(그대로 통과).
  // 실수로 잠겨 사이트가 아예 안 열리는 상황을 피하기 위함.
  if (!password) return next();

  const url = new URL(request.url);
  const cookieName = env.GATE_COOKIE_NAME || COOKIE_NAME_DEFAULT;
  const secure = url.protocol === "https:";

  // 로그아웃: 쿠키 제거 후 로그인 화면으로.
  if (url.pathname === LOGOUT_PATH) {
    return redirect("/", clearCookie(cookieName, secure));
  }

  // 로그인 폼 제출 처리.
  if (request.method === "POST" && url.pathname === LOGIN_PATH) {
    return handleLogin(context, password, cookieName, secure);
  }

  // 이미 인증되었는가? (헤더 또는 쿠키)
  if (await isAuthenticated(request, password, cookieName)) {
    return next();
  }

  // 인증 실패 → 로그인 화면(원래 가려던 경로를 redirect 값으로 유지).
  const dest = safePath(url.pathname + url.search);
  return htmlResponse(loginPageHtml({ redirect: dest }), 401, {
    // 로그인 화면 자체는 캐시하지 않는다.
    "Cache-Control": "no-store",
  });
}

// ------------------------------------------------------------
// 인증 판별
// ------------------------------------------------------------
async function isAuthenticated(request, password, cookieName) {
  // 1) 헤더 인증(프로그램/스크립트용): X-Gate-Password
  const headerPw = request.headers.get(HEADER_NAME);
  if (headerPw && timingSafeEqual(headerPw, password)) return true;

  // 2) 쿠키 인증(브라우저용): 쿠키에는 원문 대신 해시 토큰을 저장.
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[cookieName];
  if (token) {
    const expected = await tokenFor(password);
    if (timingSafeEqual(token, expected)) return true;
  }

  return false;
}

// ------------------------------------------------------------
// 로그인 폼 제출 처리
// ------------------------------------------------------------
async function handleLogin(context, password, cookieName, secure) {
  const { request, env } = context;

  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(loginPageHtml({ error: "요청을 읽을 수 없습니다." }), 400, {
      "Cache-Control": "no-store",
    });
  }

  const submitted = String(form.get("password") || "");
  const dest = safePath(String(form.get("redirect") || "/"));

  if (!timingSafeEqual(submitted, password)) {
    return htmlResponse(
      loginPageHtml({ redirect: dest, error: "비밀번호가 올바르지 않습니다." }),
      401,
      { "Cache-Control": "no-store" }
    );
  }

  // 인증 성공 → 해시 토큰을 HttpOnly 쿠키로 발급하고 원래 경로로 이동.
  const maxAge = Number(env.GATE_MAX_AGE) > 0 ? Number(env.GATE_MAX_AGE) : MAX_AGE_DEFAULT;
  const token = await tokenFor(password);
  const cookie = buildCookie(cookieName, token, { maxAge, secure });
  return redirect(dest, cookie);
}

// ------------------------------------------------------------
// 쿠키에 저장할 토큰: 비밀번호의 SHA-256 해시(hex).
// 원문 비밀번호를 쿠키에 그대로 두지 않기 위함.
// ------------------------------------------------------------
async function tokenFor(password) {
  const data = new TextEncoder().encode("gong-gate:v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 길이·내용 노출을 줄이기 위한 상수 시간 비교.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  // 길이가 다르면 즉시 실패이지만, 조기 반환으로 인한 타이밍 차이를 줄이려
  // 동일 길이 버퍼에 대해 XOR 누적 후 마지막에 길이도 함께 판정한다.
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// ------------------------------------------------------------
// 쿠키 유틸
// ------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildCookie(name, value, { maxAge, secure }) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie(name, secure) {
  const attrs = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// ------------------------------------------------------------
// 오픈 리다이렉트 방지: 같은 사이트 내부 절대경로만 허용.
// ------------------------------------------------------------
function safePath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//")) return "/";
  return p;
}

// ------------------------------------------------------------
// 응답 헬퍼
// ------------------------------------------------------------
function redirect(location, setCookie) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

function htmlResponse(html, status, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

// HTML 특수문자 이스케이프(입력값을 화면에 넣을 때 XSS 방지).
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ------------------------------------------------------------
// 로그인 화면(최소 UI). 외부 리소스 없이 인라인으로만 구성.
// ------------------------------------------------------------
function loginPageHtml({ redirect = "/", error = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>접근 확인</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f172a; color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 360px; background: #1e293b; border: 1px solid #334155;
    border-radius: 14px; padding: 28px 24px; box-shadow: 0 10px 30px rgba(0,0,0,.35);
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #94a3b8; line-height: 1.5; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #cbd5e1; }
  input[type="password"] {
    width: 100%; padding: 11px 12px; font-size: 15px; border-radius: 9px;
    border: 1px solid #475569; background: #0f172a; color: #e2e8f0; outline: none;
  }
  input[type="password"]:focus { border-color: #3b82f6; }
  button {
    width: 100%; margin-top: 16px; padding: 11px 12px; font-size: 15px; font-weight: 600;
    border: none; border-radius: 9px; background: #3b82f6; color: #fff; cursor: pointer;
  }
  button:hover { background: #2563eb; }
  .error {
    margin: 0 0 14px; padding: 9px 11px; font-size: 13px; border-radius: 8px;
    background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35); color: #fca5a5;
  }
</style>
</head>
<body>
  <form class="card" method="POST" action="${LOGIN_PATH}">
    <h1>접근 확인</h1>
    <p class="sub">이 페이지는 비밀번호로 보호되어 있습니다. 공유받은 암호를 입력하세요.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <label for="pw">비밀번호</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required />
    <input type="hidden" name="redirect" value="${esc(redirect)}" />
    <button type="submit">들어가기</button>
  </form>
</body>
</html>`;
}
