// Cloudflare Workers 단일 진입점.
// Pages의 파일 기반 실행 순서 대신 여기서 게이트 → R2/정적 자산 순서를 명시적으로 고정한다.
// wrangler.jsonc의 assets.run_worker_first=true도 반드시 함께 유지해야 정적 자산이 먼저 새지 않는다.

const COOKIE_NAME_DEFAULT = "gong_gate";
const HEADER_NAME = "x-gate-password";
const LOGIN_PATH = "/__gate/login";
const LOGOUT_PATH = "/__gate/logout";
const DATA_PREFIX = "/data/";
const KEY = /^(index\.json|analysis-index\.json|(pre|bid)\/\d{4}\/\d{2}(\/\d{2})?\.csv\.gz|analysis\/bid\/[^/]{1,160}\.json)$/;
const RECENT_DAYS = 40;

export default {
  async fetch(request, env) {
    const password = env.GATE_PASSWORD;

    // 설정 누락으로 운영자가 잠겨 버리는 것을 피하기 위한 기존 통과 모드.
    if (!password) return routeRequest(request, env);

    const url = new URL(request.url);
    const cookieName = env.GATE_COOKIE_NAME || COOKIE_NAME_DEFAULT;
    const secure = url.protocol === "https:";

    if (url.pathname === LOGOUT_PATH) {
      return redirect("/", clearCookie(cookieName, secure));
    }

    if (request.method === "POST" && url.pathname === LOGIN_PATH) {
      return handleLogin(request, password, cookieName, secure);
    }

    if (await isAuthenticated(request, password, cookieName)) {
      return routeRequest(request, env);
    }

    const dest = safePath(url.pathname + url.search);
    return htmlResponse(loginPageHtml({ redirect: dest }), 401, {
      "Cache-Control": "no-store",
    });
  },
};

async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(DATA_PREFIX)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return serveData(request, env, url.pathname.slice(DATA_PREFIX.length));
  }
  return env.ASSETS.fetch(request);
}

async function serveData(request, env, encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });

  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
    "Cache-Control": cacheControl(key),
    ETag: object.httpEtag,
  });
  // Content-Encoding은 절대 붙이지 않는다. 프런트가 gzip을 직접 해제하므로 이중 해제가 된다.
  // onlyIf 조건이 맞으면 본문 없는 R2Object가 온다 = 클라이언트 캐시가 최신.
  if (!object.body) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(object.body, { headers });
}

function cacheControl(key) {
  if (key === "index.json" || key === "analysis-index.json") return "private, max-age=60";
  if (/^(pre|bid)\/\d{4}\/\d{2}\.csv\.gz$/.test(key)) {
    return "private, max-age=31536000, immutable";
  }
  const date = key.match(/(\d{4})\/(\d{2})\/(\d{2})\.csv\.gz$/);
  if (!date) return "private, max-age=3600";
  const days = (Date.now() - Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`)) / 86400000;
  return days > RECENT_DAYS ? "private, max-age=31536000, immutable" : "private, max-age=300";
}

async function isAuthenticated(request, password, cookieName) {
  const headerPw = request.headers.get(HEADER_NAME);
  if (headerPw && timingSafeEqual(headerPw, password)) return true;

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[cookieName];
  if (token) {
    const expected = await tokenFor(password);
    if (timingSafeEqual(token, expected)) return true;
  }
  return false;
}

async function handleLogin(request, password, cookieName, secure) {
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
  return redirect(dest, buildCookie(cookieName, token, { secure }));
}

async function tokenFor(password) {
  const data = new TextEncoder().encode("gong-gate:v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ba[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
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

function clearCookie(name, secure) {
  const attrs = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

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

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f172a; color: #e2e8f0; font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; padding: 20px; }
  .card { width: 100%; max-width: 360px; background: #1e293b; border: 1px solid #334155;
    border-radius: 14px; padding: 28px 24px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #94a3b8; line-height: 1.5; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #cbd5e1; }
  input[type="password"] { width: 100%; padding: 11px 12px; font-size: 15px; border-radius: 9px;
    border: 1px solid #475569; background: #0f172a; color: #e2e8f0; outline: none; }
  input[type="password"]:focus { border-color: #3b82f6; }
  button { width: 100%; margin-top: 16px; padding: 11px 12px; font-size: 15px; font-weight: 600;
    border: none; border-radius: 9px; background: #3b82f6; color: #fff; cursor: pointer; }
  button:hover { background: #2563eb; }
  .error { margin: 0 0 14px; padding: 9px 11px; font-size: 13px; border-radius: 8px;
    background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35); color: #fca5a5; }
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
