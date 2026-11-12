import test from "node:test";
import assert from "node:assert/strict";
import { handleAiAccess, hasAiAccess } from "./ai-access.js";
import { handleEcr } from "./ecr.js";
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

test("취소 목록 조회 장애 시 유효 서명만으로 AI를 허용하지 않는다", async () => {
  const env = envOf();
  const cookie = (await unlock(env)).headers.get("Set-Cookie").split(";")[0];
  env.DATA.get = async () => { throw new Error("storage failed"); };
  assert.equal(await hasAiAccess(req("/api/ecr", "GET", undefined, cookie), env), false);
});

test("오답 반복·다른 사이트 잠금 해제 요청은 거부한다", async () => {
  const env = envOf();
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await handleAiAccess(req("/api/ai-access", "POST", { password: "wrong" }), env)).status, 403);
  assert.equal((await unlock(env)).status, 429);
  assert.equal((await handleAiAccess(req("/api/ai-access", "POST", { password: SECRET }, "", "https://other.example"), envOf())).status, 403);
});
