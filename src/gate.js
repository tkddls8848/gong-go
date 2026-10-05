import { timingSafeEqual, redirect, htmlResponse } from "./http.js";

export const COOKIE_NAME = "gong_gate";
export const LOGIN_PATH = "/__gate/login";

export async function isAuthenticated(request, password) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[COOKIE_NAME];
  if (token) {
    const expected = await tokenFor(password);
    if (timingSafeEqual(token, expected)) return true;
  }
  return false;
}

export async function handleLogin(request, password, secure) {
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
    return htmlResponse(loginPageHtml({ redirect: dest, error: "비밀번호가 올바르지 않습니다." }), 401, {
      "Cache-Control": "no-store",
    });
  }

  const token = await tokenFor(password);
  return redirect(dest, buildCookie(COOKIE_NAME, token, { secure }));
}

async function tokenFor(password) {
  const data = new TextEncoder().encode("gong-gate:v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function buildCookie(name, value, { secure }) {
  // Max-Age/Expires 없는 세션 쿠키: 브라우저를 닫으면 만료된다.
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(name, secure) {
  const attrs = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// 백슬래시도 막는다. "/\evil.com"은 여기서 통과해도 브라우저가 URL 정규화 단계에서
// "//evil.com"으로 바꿔 프로토콜-상대 URL이 되므로, 로그인에 성공한 요청이 외부로 튕긴다.
export function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  if (path.startsWith("//") || path.includes("\\")) return "/";
  return path;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function loginPageHtml({ redirect = "/", error = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#151a21" />
<title>접근 확인</title>
<style>
  /* 조회 화면(public/style.css)과 같은 규칙·같은 색을 쓴다. 여기 값이 어긋나면 들어가는
     순간 화면이 번쩍이고 서로 다른 앱을 지나온 것처럼 보인다. Worker가 문자열로 내려주는
     페이지라 style.css를 공유할 수 없어 토큰을 그대로 옮겨 적는다. */
  * { box-sizing: border-box; }
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: #151a21; color: #e7ebf1; font-family: "Pretendard", "Noto Sans KR", system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
  .card { display: flex; flex-direction: column; width: 100%; max-width: 340px; }
  .brand { display: flex; align-items: center; gap: 10px; padding-bottom: 26px; }
  .brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 34px; height: 34px; border-radius: 10px; background: #1b212b; }
  .brand-mark svg { width: 17px; height: 17px; fill: none; stroke: #a5afbd; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .brand-name { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-tag { margin-top: 2px; color: #8a94a2; font-size: 12px; }
  h1 { margin: 0 0 7px; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  p.sub { margin: 0 0 26px; font-size: 13px; line-height: 1.65; color: #8a94a2; }
  label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: #8a94a2; }
  input[type="password"] { width: 100%; height: 44px; padding: 0 13px; font-family: inherit; font-size: 15px;
    border: 1px solid transparent; border-radius: 10px; background: #1b212b; color: #e7ebf1; outline: none; }
  input[type="password"]:focus { border-color: #2c4b7a; background: #1d232d; box-shadow: 0 0 0 3px rgba(72, 128, 224, .22); }
  button { height: 44px; margin-top: 14px; border: 0; border-radius: 10px; background: #3a72d8; color: #fff;
    font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2f62c4; }
  .error input[type="password"] { border-color: #6b3a3d; background: #2b1a1c; }
  .error-text { display: flex; align-items: center; gap: 6px; margin: 9px 0 0; font-size: 12px; color: #ef9a9a; }
  .error-text svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .note { margin: 22px 0 0; font-size: 12px; line-height: 1.6; color: #79828f; }
</style>
</head>
<body>
  <form class="card${error ? " error" : ""}" method="POST" action="${LOGIN_PATH}">
    <div class="brand">
      <span class="brand-mark"><svg viewBox="0 0 20 20"><rect x="4" y="8.8" width="12" height="7.9" rx="2.2"></rect><path d="M7 8.8V6.5a3 3 0 0 1 6 0v2.3"></path><path d="M10 12.1v1.7"></path></svg></span>
      <div>
        <div class="brand-name">나라장터 조회</div>
        <div class="brand-tag">수집한 CSV에서 공고를 찾습니다</div>
      </div>
    </div>
    <h1>접근 확인</h1>
    <p class="sub">이 화면은 비밀번호로 보호되어 있습니다.<br />공유받은 비밀번호를 입력하세요.</p>
    <label for="pw">비밀번호</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required />
    ${error ? `<p class="error-text"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle><path d="M8 5v3.4M8 10.8v.2"></path></svg>${esc(error)}</p>` : ""}
    <input type="hidden" name="redirect" value="${esc(redirect)}" />
    <button type="submit">들어가기</button>
    <p class="note">이 페이지는 검색엔진에 노출되지 않습니다.</p>
  </form>
</body>
</html>`;
}
