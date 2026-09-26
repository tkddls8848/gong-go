import test from "node:test";
import assert from "node:assert/strict";
import { handleAiAccess, hasAiAccess } from "./ai-access.js";
import { handleEcr } from "./ecr.js";
import worker from "./worker.js";
const ORIGIN = "https://gong-go.example.workers.dev";
const SECRET = "only-owner-analysis-password";
function envOf() {
  const store = new Map(); let version = 0;
  return { GATE_PASSWORD: "site-login", AI_ANALYSIS_PASSWORD: SECRET, AI: { run() { throw new Error("AI must not run"); }, toMarkdown() { throw new Error("conversion must not run"); } }, DATA: {
    async get(key) { const item = store.get(key); return item ? { etag: item.etag, json: async () => JSON.parse(item.text) } : null; },
    async put(key, text, { onlyIf } = {}) {
      const old = store.get(key);
      if (onlyIf?.etagMatches && old?.etag !== onlyIf.etagMatches || onlyIf?.etagDoesNotMatch === "*" && old) return null;
      const item = { text, etag: String(++version) }; store.set(key, item); return item;
    },
  } };
}
function req(path = "/api/ai-access", method = "GET", body, cookie = "", origin = ORIGIN) {
  return new Request(ORIGIN + path, { method, headers: { Origin: origin, Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function unlock(env) { return handleAiAccess(req("/api/ai-access", "POST", { password: SECRET }), env); }

test("암호 끝의 NUL을 추가하거나 제거한 입력은 같은 암호가 아니다", async () => {
  for (const [actual, submitted] of [[SECRET, SECRET + "\u0000"], [SECRET + "\u0000", SECRET]]) {
    const env = envOf(); env.AI_ANALYSIS_PASSWORD = actual;
    const response = await handleAiAccess(req("/api/ai-access", "POST", { password: submitted }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

test("NUL 문자를 포함한 암호 변경도 이전 쿠키를 무효화한다", async () => {
  const env = envOf();
  const response = await unlock(env);
  const cookie = response.headers.get("Set-Cookie").split(";")[0];
  env.AI_ANALYSIS_PASSWORD += "\u0000";
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), false);
});

test("서로 다른 비정상 UTF-16 코드 단위를 동일 암호로 인증하지 않는다", async () => {
  const env = envOf(); env.AI_ANALYSIS_PASSWORD = SECRET + "\ud800";
  const response = await handleAiAccess(req("/api/ai-access", "POST", { password: SECRET + "\ud801" }), env);
  assert.equal(response.status, 403);
});

test("특수문자를 포함한 정확한 암호는 쿠키 발급과 검증까지 성공한다", async () => {
  for (const suffix of ["\u0000", "\ud800", "한글🔐", "\\u0000"]) {
    const env = envOf(); env.AI_ANALYSIS_PASSWORD = SECRET + suffix;
    const response = await handleAiAccess(req("/api/ai-access", "POST", { password: env.AI_ANALYSIS_PASSWORD }), env);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie").split(";")[0];
    assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), true);
  }
});

test("이전 v1 서명 쿠키는 새 인증 방식으로 자동 승계하지 않는다", async () => {
  const env = envOf(), enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = `${Date.now() + 1800000}.${"a".repeat(32)}`;
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`ai-access:v1:${payload}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, `gong_ai_access=${payload}.${hex}`), env), false);
});

test("설정 가능한 512자 암호는 JSON 이스케이프 후에도 제출할 수 있다", async () => {
  const env = envOf();
  env.AI_ANALYSIS_PASSWORD = "\u0001".repeat(512);
  assert.equal((await (await handleAiAccess(req(), env)).json()).configured, true);
  const response = await handleAiAccess(req("/api/ai-access", "POST", { password: env.AI_ANALYSIS_PASSWORD }), env);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("Set-Cookie"));
});

test("유니코드 이스케이프로 제출해도 허용된 비밀번호는 인증한다", async () => {
  const env = envOf();
  env.AI_ANALYSIS_PASSWORD = "a".repeat(512);
  const request = new Request(ORIGIN + "/api/ai-access", { method: "POST", headers: { Origin: ORIGIN }, body: '{"password":"' + "\\u0061".repeat(512) + '"}' });
  assert.equal((await handleAiAccess(request, env)).status, 200);
});

test("잘못된 JSON과 초과 본문은 400이며 쿠키를 발급하지 않는다", async () => {
  for (const body of ["{", "null", "[]", '"text"', " ".repeat(4097)]) {
    const response = await handleAiAccess(new Request(ORIGIN + "/api/ai-access", { method: "POST", headers: { Origin: ORIGIN }, body }), envOf());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.match((await response.json()).message, /형식/);
  }
});

test("저장소 장애는 입력 오류와 구분하고 실패 시 잠금을 유지한다", async () => {
  const env = envOf();
  env.DATA.get = async () => { throw new Error("private storage details"); };
  const response = await unlock(env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.doesNotMatch(await response.text(), /private storage/);
});
test("미설정·사이트 쿠키만으로 ECR 업로드/단계 실행은 막히고 AI는 호출되지 않는다", async () => {
  for (const configured of [false, true]) {
    const env = envOf(); if (!configured) delete env.AI_ANALYSIS_PASSWORD;
    for (const action of ["upload", "step"]) {
      const response = await handleEcr(req(`/api/ecr?action=${action}`, "POST", {}, "gong_gate=site-login"), env);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).locked, true);
    }
  }
});
test("전용 비밀번호로 발급한 쿠키만 허용하고 변조·만료·암호 변경을 거부한다", async () => {
  const env = envOf(), response = await unlock(env);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("Set-Cookie"), cookie = setCookie.split(";")[0];
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=1800; Secure/);
  const request = req("/api/ecr", "GET", undefined, cookie);
  assert.equal(await hasAiAccess(request, env), true);
  assert.equal(await hasAiAccess(request, env, Date.now() + 1800001), false);
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie + "0"), env), false);
  assert.equal(await hasAiAccess(request, { ...env, AI_ANALYSIS_PASSWORD: SECRET + "new" }), false);
  const locked = await handleAiAccess(req("/api/ai-access", "DELETE", undefined, cookie), env);
  assert.match(locked.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal(await hasAiAccess(request, env), false, "브라우저가 쿠키를 다시 보내도 서버에서 취소된 권한이다");
});

test("서버 잠금은 해당 토큰만 취소하며 새 잠금 해제는 허용한다", async () => {
  const env = envOf();
  const first = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  const second = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  await handleAiAccess(req("/api/ai-access", "DELETE", undefined, first), env);
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, first), env), false);
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, second), env), true);
  const blocked = await handleEcr(req("/api/ecr?action=upload", "POST", {}, first), env);
  assert.equal(blocked.status, 403);
});

test("취소 저장 실패는 잠금 성공으로 표시하지 않고 재시도할 쿠키를 유지한다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  env.DATA.put = async () => { throw new Error("storage failed"); };
  const locked = await handleAiAccess(req("/api/ai-access", "DELETE", undefined, cookie), env);
  assert.equal(locked.status, 503);
  assert.equal(locked.headers.get("Set-Cookie"), null);
});

test("취소 목록 조회 장애 시 유효 서명만으로 AI를 허용하지 않는다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  env.DATA.get = async () => { throw new Error("storage failed"); };
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), false);
});

test("사이트 로그아웃도 기존 AI 쿠키를 서버에서 취소한다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  const result = await worker.fetch(req("/api/logout", "GET", undefined, cookie), env);
  assert.equal(result.status, 302);
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), false);
  assert.match(result.headers.get("Set-Cookie"), /gong_gate=;/);
  assert.match(result.headers.get("Set-Cookie"), /gong_ai_access=;/);
});

test("사이트 로그아웃의 취소 실패는 조회 쿠키를 지우고 재시도 경로를 남긴다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  env.DATA.put = async () => { throw new Error("private storage failure"); };
  const result = await worker.fetch(req("/api/logout", "GET", undefined, cookie), env);
  assert.equal(result.status, 503);
  assert.match(result.headers.get("Set-Cookie"), /gong_gate=;/);
  assert.doesNotMatch(result.headers.get("Set-Cookie"), /gong_ai_access/);
  const body = await result.text();
  assert.match(body, /권한 취소 다시 시도/);
  assert.doesNotMatch(body, /private storage/);
});

test("외부 사이트에서 유도한 로그아웃은 쿠키와 권한을 변경하지 않는다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  const result = await worker.fetch(req("/api/logout", "GET", undefined, cookie, "https://other.example"), env);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("Set-Cookie"), null);
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), true);
});
test("오답 반복·다른 사이트 잠금 해제 요청은 거부한다", async () => {
  const env = envOf();
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await handleAiAccess(req("/api/ai-access", "POST", { password: "wrong" }), env)).status, 403);
  assert.equal((await unlock(env)).status, 429);
  assert.equal((await handleAiAccess(req("/api/ai-access", "POST", { password: SECRET }, "", "https://other.example"), envOf())).status, 403);
});
test("사이트 로그인 없이 잠금 해제 API를 호출할 수 없다", async () => {
  assert.equal((await worker.fetch(req("/api/ai-access", "POST", { password: SECRET }), envOf())).status, 401);
});
test("사이트 로그인만 한 자연어 검색은 뉴런 없이 규칙 기반으로 처리한다", async () => {
  const env = envOf();
  const login = await worker.fetch(new Request(ORIGIN + "/__gate/login", { method: "POST", body: new URLSearchParams({ password: env.GATE_PASSWORD }) }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const response = await worker.fetch(req("/api/ask", "POST", { q: "오늘 본공고" }, cookie), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "rule");
});
test("설정 한도와 입력 한도가 어긋나 잠금을 못 푸는 비밀번호는 미설정으로 본다", async () => {
  const env = envOf();
  env.AI_ANALYSIS_PASSWORD = "가".repeat(513);
  const state = await (await handleAiAccess(req("/api/ai-access", "GET"), env)).json();
  assert.equal(state.configured, false, "제출할 수 없는 길이는 설정된 것으로 알리지 않는다");
  const 시도 = await handleAiAccess(req("/api/ai-access", "POST", { password: env.AI_ANALYSIS_PASSWORD }), env);
  assert.equal(시도.status, 403);
});
