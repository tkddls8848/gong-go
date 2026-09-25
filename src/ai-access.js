// 사이트 조회 권한과 뉴런 사용 권한을 분리한다. 서명 쿠키는 30분 동안만 유효하다.
const COOKIE = "gong_ai_access";
const LIFETIME = 30 * 60 * 1000;
const enc = new TextEncoder();
// 위쪽 한도는 아래 passwordBody가 받는 길이와 같아야 한다. 어긋나면 설정은 되었다고
// 표시되는데 맞는 비밀번호로도 잠금이 풀리지 않는다.
const configured = (env) => typeof env.AI_ANALYSIS_PASSWORD === "string" && env.AI_ANALYSIS_PASSWORD.length >= 16 && env.AI_ANALYSIS_PASSWORD.length <= 512;
const reply = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
const hex = (bytes) => [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
async function signingKey(secret) { return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
function cookie(value, request, age = 1800) {
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function clearAiAccessCookie(request) { return cookie("", request, 0); }
export async function hasAiAccess(request, env, now = Date.now()) {
  if (!configured(env)) return false;
  const token = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
  const match = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[1]) <= now || Number(match[1]) > now + LIFETIME) return false;
  const signature = Uint8Array.from(match[3].match(/../g), (pair) => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await signingKey(env.AI_ANALYSIS_PASSWORD), signature, enc.encode(`ai-access:v1:${match[1]}.${match[2]}`));
}
export async function requireAiAccess(request, env) {
  if (await hasAiAccess(request, env)) return null;
  return reply({ message: configured(env) ? "AI 분석이 잠겨 있습니다. ECR 분석에서 전용 비밀번호로 잠금을 해제하세요." : "AI 분석이 잠겨 있습니다. 운영자가 AI_ANALYSIS_PASSWORD 시크릿(16자 이상)을 설정해야 합니다.", locked: true }, 403);
}
async function attemptLimit(bucket, key, limit, now) {
  if (!bucket) return false;
  const window = Math.floor(now / 600000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const prior = await bucket.get(key), state = prior ? await prior.json() : null;
    const count = state?.window === window ? state.count : 0;
    if (!Number.isInteger(count) || count < 0 || count >= limit) return false;
    const saved = await bucket.put(key, JSON.stringify({ window, count: count + 1 }), { onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: "*" } });
    if (saved) return true;
  }
  return false;
}
async function passwordBody(request) {
  if (!request.body || Number(request.headers.get("Content-Length")) > 2048) throw new Error("body");
  const reader = request.body.getReader(); let size = 0; const parts = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2048) { await reader.cancel(); throw new Error("body"); }
    parts.push(value);
  }
  return JSON.parse(await new Blob(parts).text());
}
export async function handleAiAccess(request, env) {
  if (request.method === "GET") return reply({ unlocked: await hasAiAccess(request, env), configured: configured(env) });
  if (request.method !== "POST" && request.method !== "DELETE") return reply({ message: "지원하지 않는 요청입니다." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply({ message: "같은 사이트에서만 잠금을 변경할 수 있습니다." }, 403);
  if (request.method === "DELETE") return reply({ unlocked: false }, 200, { "Set-Cookie": cookie("", request, 0) });
  if (!configured(env)) return requireAiAccess(request, env);
  try {
    const now = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(ip)));
    // 전역 한도는 게이트를 이미 지난 사람들이 함께 쓴다. 한 사람의 오타가 남의 잠금까지
    // 막지 않도록 IP 한도보다 넉넉히 둔다. 남은 시간은 실제 창이 끝나는 시각으로 알린다.
    const remain = Math.ceil((600000 - now % 600000) / 1000);
    if (!await attemptLimit(env.DATA, `_meta/ai-access/ip-${ipHash}.json`, 5, now) || !await attemptLimit(env.DATA, "_meta/ai-access/global.json", 200, now)) {
      return reply({ message: `잠금 해제 시도가 너무 많습니다. ${Math.ceil(remain / 60)}분 후 다시 시도하세요.` }, 429, { "Retry-After": String(remain) });
    }
    const body = await passwordBody(request);
    if (typeof body.password !== "string" || body.password.length > 512) return reply({ message: "비밀번호가 올바르지 않습니다." }, 403);
    // 고정 길이 서명으로 비교해 평문 비교의 길이/접두사 타이밍 차이를 피한다.
    const expected = await signingKey(env.AI_ANALYSIS_PASSWORD);
    const submitted = await signingKey(body.password || " ");
    const probe = enc.encode("gong-ai-password-check");
    const signature = await crypto.subtle.sign("HMAC", submitted, probe);
    if (!await crypto.subtle.verify("HMAC", expected, signature, probe)) return reply({ message: "비밀번호가 올바르지 않습니다." }, 403);
    const payload = `${now + LIFETIME}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const signed = hex(await crypto.subtle.sign("HMAC", expected, enc.encode(`ai-access:v1:${payload}`)));
    return reply({ unlocked: true }, 200, { "Set-Cookie": cookie(`${payload}.${signed}`, request) });
  } catch { return reply({ message: "잠금을 해제하지 못했습니다. 잠시 후 다시 시도하세요." }, 503); }
}
