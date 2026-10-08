// 화면의 재분석 계획(public/ecr-retry.js)이 만든 번호 목록을 Worker(src/ecr.js)가 받는지 잇는다.
// 두 쪽은 번호 규칙을 사본으로 갖는다. 한쪽만 바꾸면 재분석이 400으로 막힌다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { retryPlan } = require("../public/ecr-retry.js");

test("재분석 계획의 번호 목록을 Worker가 형식 오류 없이 받는다", async () => {
  const [{ handleEcr }, { handleAiAccess }] = await Promise.all([import("../src/ecr.js"), import("../src/ai-access.js")]);
  const ORIGIN = "https://example.workers.dev", store = new Map();
  const DATA = {
    async get(key) { const value = store.get(key); return value ? { etag: "1", json: async () => JSON.parse(value) } : null; },
    async put(key, body) { store.set(key, body); return { etag: "1" }; },
    async delete() {}, async list() { return { objects: [] }; },
  };
  const env = { DATA, AI: { run: async () => ({ response: { items: [] } }) }, AI_ANALYSIS_PASSWORD: "test-analysis-password" };
  const unlocked = await handleAiAccess(new Request(`${ORIGIN}/api/ai-access`, { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify({ password: env.AI_ANALYSIS_PASSWORD }) }), env);
  const cookie = unlocked.headers.get("Set-Cookie").split(";")[0];
  const ids = ["ECR-001", "ECR-HW-02", "장비-003", "장비 4", "기능-001", "ECR–005"];
  const plan = retryPlan({ 누락: ids, coverage: { expectedIds: ids, matchedIds: [], missingIds: ids, unexpectedIds: ["확인 필요 (3)", "ECR-X1"] } });
  const text = ids.map((id) => `${id} 서버 도입\n메모리 256GB 이상`).join("\n");
  const params = new URLSearchParams({ action: "upload", notice: "R26-1", name: "rfp.md", focus: plan.focus.join(","), matched: plan.matched.join(","), unexpected: plan.unexpected.join(",") });
  const response = await handleEcr(new Request(`${ORIGIN}/api/ecr?${params}`, { method: "POST", body: text, headers: { Origin: ORIGIN, Cookie: cookie } }), env);
  assert.notEqual(response.status, 400, (await response.clone().json()).message);
});
