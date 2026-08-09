// 인증 후 정적 자산, R2 데이터, GitHub Actions 갱신 API를 제공한다.

const COOKIE_NAME = "gong_gate";
const LOGIN_PATH = "/__gate/login";
const LOGOUT_PATH = "/__gate/logout";
const DATA_PREFIX = "/data/";
const REFRESH_PATH = "/api/refresh";
const KEY = /^(index\.json|analysis-index\.json|(pre|bid)\/\d{4}\/\d{2}(\/\d{2})?\.csv\.gz|analysis\/bid\/[^/]{1,160}\.json)$/;
const RECENT_DAYS = 40;
const GITHUB_API = "https://api.github.com/repos/tkddls8848/gong-go";
const WORKFLOW = "collect.yml";
const WORKFLOW_REF = "dev";

export default {
  async fetch(request, env) {
    const password = env.GATE_PASSWORD;

    if (!password) return new Response("GATE_PASSWORD is not configured", { status: 500 });

    const url = new URL(request.url);
    const secure = url.protocol === "https:";

    if (url.pathname === LOGOUT_PATH) {
      return redirect("/", clearCookie(COOKIE_NAME, secure));
    }

    if (request.method === "POST" && url.pathname === LOGIN_PATH) {
      return handleLogin(request, password, secure);
    }

    if (await isAuthenticated(request, password)) {
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
  if (url.pathname === REFRESH_PATH) return handleRefresh(request, env, url);
  if (url.pathname.startsWith(DATA_PREFIX)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return serveData(request, env, url.pathname.slice(DATA_PREFIX.length));
  }
  return env.ASSETS.fetch(request);
}

async function handleRefresh(request, env, url) {
  if (!env.GITHUB_TOKEN) return jsonResponse({ message: "GITHUB_TOKEN 시크릿이 설정되지 않았습니다." }, 501);
  if (request.method === "POST") {
    const response = await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: WORKFLOW_REF, inputs: { begin: "", end: "" } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return jsonResponse({ message: data.message || `GitHub Actions 실행 요청 실패 (${response.status})` }, response.status);
    return jsonResponse({ running: true, runId: data.workflow_run_id, runUrl: data.html_url, lastLine: "GitHub Actions 실행을 요청했습니다." }, 202);
  }
  if (request.method !== "GET") return jsonResponse({ message: "GET 또는 POST만 지원합니다." }, 405, { Allow: "GET, POST" });

  const runId = url.searchParams.get("runId");
  const endpoint = runId && /^\d+$/.test(runId)
    ? `/actions/runs/${runId}`
    : `/actions/workflows/${WORKFLOW}/runs?branch=${WORKFLOW_REF}&event=workflow_dispatch&per_page=1`;
  const response = await github(env, endpoint);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return jsonResponse({ message: data.message || `GitHub Actions 상태 조회 실패 (${response.status})` }, response.status);
  const run = runId ? data : data.workflow_runs?.[0];
  if (!run) return jsonResponse({ running: false });
  const running = run.status !== "completed";
  return jsonResponse({
    running,
    runId: run.id,
    runUrl: run.html_url,
    startedAt: run.run_started_at || run.created_at,
    finishedAt: running ? null : run.updated_at,
    error: !running && run.conclusion !== "success" ? `GitHub Actions가 ${run.conclusion || "실패"} 상태로 끝났습니다.` : null,
    lastLine: running ? `GitHub Actions ${run.status}` : `GitHub Actions ${run.conclusion}`,
  });
}

function github(env, path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "gong-go-worker",
      "X-GitHub-Api-Version": "2026-03-10",
      ...init.headers,
    },
  });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
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

async function isAuthenticated(request, password) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[COOKIE_NAME];
  if (token) {
    const expected = await tokenFor(password);
    if (timingSafeEqual(token, expected)) return true;
  }
  return false;
}

async function handleLogin(request, password, secure) {
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

// 백슬래시도 막는다. "/\evil.com"은 여기서 통과해도 브라우저가 URL 정규화 단계에서
// "//evil.com"으로 바꿔 프로토콜-상대 URL이 되므로, 로그인에 성공한 요청이 외부로 튕긴다.
function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  if (path.startsWith("//") || path.includes("\\")) return "/";
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
