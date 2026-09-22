import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { handleEcr as rawHandleEcr, parseResult, splitDocument, ECR_MODEL } from "./ecr.js";
import { handleAiAccess } from "./ai-access.js";
import { reserveNeurons, runBudgeted } from "./ai-budget.js";
const ORIGIN = "https://example.workers.dev";
// 추출 기능 테스트는 실제 잠금 해제 API로 쿠키를 얻는다. 잠금 거부는 ai-access.test.mjs에서 검증한다.
const accessCookies = new WeakMap();
async function handleEcr(request, env) {
  if (!accessCookies.has(env)) {
    env.AI_ANALYSIS_PASSWORD = "test-analysis-password";
    const response = await handleAiAccess(new Request(`${ORIGIN}/api/ai-access`, { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify({ password: env.AI_ANALYSIS_PASSWORD }) }), env);
    assert.equal(response.status, 200);
    accessCookies.set(env, response.headers.get("Set-Cookie").split(";")[0]);
  }
  const headers = new Headers(request.headers); headers.set("Cookie", accessCookies.get(env));
  return rawHandleEcr(new Request(request, { headers }), env);
}
function bucket() {
  const store = new Map(); let version = 0;
  return {
    store,
    async get(key) { const value = store.get(key); return value ? { etag: value.etag, json: async () => JSON.parse(value.body) } : null; },
    async put(key, body, { onlyIf } = {}) {
      const prior = store.get(key);
      if (onlyIf?.etagMatches && prior?.etag !== onlyIf.etagMatches || onlyIf?.etagDoesNotMatch === "*" && prior) return null;
      const value = { body, etag: String(++version) }; store.set(key, value); return value;
    },
  };
}
const request = (params, body, headers = {}) => new Request(`${ORIGIN}/api/ecr?${new URLSearchParams(params)}`, { method: "POST", body, headers: { Origin: ORIGIN, ...headers } });
const source = "ECR-001 서버 도입\n서버당 메모리 256GB 이상을 제공한다.";
const modelResult = () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ id: "ECR-001", kind: "서버", name: "서버 도입", facts: [{ field: "메모리", value: "서버당 메모리 256GB 이상", evidence: "서버당 메모리 256GB 이상을 제공한다." }] }] }) } }] });
test("병렬 예산 예약은 일일 한도를 넘기지 않고 UTC 날짜가 바뀌면 초기화된다", async () => {
  const data = bucket(), now = Date.parse("2026-09-22T23:59:00Z");
  const results = await Promise.allSettled([reserveNeurons(data, 5000, now), reserveNeurons(data, 5000, now)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 429);
  assert.equal((await reserveNeurons(data, 5000, now + 120000)).reserved, 5000);
});
test("예산 저장 실패와 소진시 AI 호출을 하지 않는다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; } } };
  await reserveNeurons(env.DATA, 8000);
  await assert.rejects(runBudgeted(env, ECR_MODEL, { messages: [], max_tokens: 4096 }), /예산/);
  await assert.rejects(runBudgeted({ ...env, DATA: null }, ECR_MODEL, { messages: [], max_tokens: 4096 }), /저장소/);
  assert.equal(calls, 0);
});
test("업로드부터 Workers AI 분석·저장·재조회까지 연결하고 재시도는 캐시를 사용한다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async (model, options) => { calls++; assert.equal(model, ECR_MODEL); assert.equal(options.max_tokens, 4096); return modelResult(); } } };
  const upload = await handleEcr(request({ action: "upload", notice: "R26-001", name: "rfp.md" }, source), env);
  assert.equal(upload.status, 200);
  const job = await upload.json();
  const step = () => handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  const result = await (await step()).json();
  assert.equal(result.analysis.provider, "workers-ai");
  assert.equal(result.analysis.ecr[0].장비요약[0].규격[0].검증, "원문 확인");
  assert.equal(result.analysis.verified, false, "문서 전체의 완전성은 별도로 확인해야 한다");
  assert.equal((await step()).status, 200);
  assert.equal(calls, 1);
  const saved = await handleEcr(new Request(`${ORIGIN}/api/ecr?notice=R26-001`), env);
  assert.equal((await saved.json()).ecr.length, 1);
});
test("인증 전 분석 경로와 다른 사이트의 업로드는 차단한다", async () => {
  const env = { GATE_PASSWORD: "secret", DATA: bucket(), AI: {} };
  assert.equal((await worker.fetch(request({ action: "upload", notice: "test", name: "rfp.md" }, source), env)).status, 401);
  assert.equal((await handleEcr(request({ action: "upload" }, source, { Origin: "https://other.example" }), env)).status, 403);
});
test("PDF는 원격 toMarkdown 변환을 거치고 HWP는 명시적으로 안내한다", async () => {
  const env = { DATA: bucket(), AI: { toMarkdown: async ({ name, blob }) => { assert.equal(name, "rfp.pdf"); assert.match(await blob.text(), /^%PDF-/); return { format: "markdown", data: source }; } } };
  assert.equal((await handleEcr(request({ action: "upload", notice: "test", name: "rfp.pdf" }, "%PDF-test"), env)).status, 200);
  assert.equal((await handleEcr(request({ action: "upload", notice: "test", name: "rfp.hwp" }, "test"), env)).status, 400);
  assert.equal((await handleEcr(request({ action: "upload", notice: "test", name: "rfp.pdf" }, "not pdf"), env)).status, 400);
});
test("문서 분할은 끝부분을 버리지 않고 너무 긴 문서는 거절한다", () => {
  const text = "가".repeat(11000) + "마지막 조건";
  const chunks = splitDocument(text);
  assert.ok(chunks.at(-1).endsWith("마지막 조건"));
  assert.equal(chunks[0].slice(-600), chunks[1].slice(0, 600));
  assert.throws(() => splitDocument("가".repeat(120001)), /너무 큽니다/);
});
test("출력 잘림, 깨진 JSON, 근거 없는 값은 성공으로 위장하지 않는다", () => {
  assert.throws(() => parseResult({ choices: [{ finish_reason: "length" }] }, source, "test", 0), /출력 한도/);
  assert.throws(() => parseResult({ response: "{" }, source, "test", 0), /형식/);
  const result = modelResult();
  result.choices[0].message.content = result.choices[0].message.content.replaceAll("256GB", "512GB");
  const items = parseResult(result, source, "test", 0);
  assert.equal(items[0].장비요약[0].규격[0].검증, "확인 필요");
});

test("마지막 구간만 실행해도 빠진 구간이 있으면 완성 결과를 저장하지 않는다", async () => {
  const env = { DATA: bucket(), AI: { run: async () => ({ response: { items: [] } }) } };
  const upload = await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, "문서".repeat(3000)), env);
  const job = await upload.json();
  const response = await handleEcr(request({ action: "step", id: job.id, index: job.total - 1 }), env);
  assert.equal(response.status, 409);
  assert.equal(await env.DATA.get("_ecr/notices/test.json"), null);
});

test("무료 예산 소진 응답은 429이며 기존 결과를 덮어쓰지 않는다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; return modelResult(); } } };
  await env.DATA.put("_ecr/notices/test.json", JSON.stringify({ old: true }));
  const job = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, source), env)).json();
  await reserveNeurons(env.DATA, 8000);
  const response = await handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  assert.equal(response.status, 429);
  assert.equal(calls, 0);
  assert.deepEqual(await (await env.DATA.get("_ecr/notices/test.json")).json(), { old: true });
});
