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
    async delete(key) { store.delete(key); },
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
  const env = { DATA: bucket(), AI: { run: async (model, options) => { calls++; assert.equal(model, ECR_MODEL); assert.equal(options.max_tokens, 2048); return modelResult(); } } };
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
  const env = { DATA: bucket(), AI: { toMarkdown: async ({ name, blob }) => { assert.equal(name, "rfp.pdf"); assert.equal(blob.type, "application/pdf", "Cloudflare 변환기는 빈 mimeType을 거부한다"); assert.equal(await blob.text(), "%PDF-test"); return { format: "markdown", data: source }; } } };
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

test("출력이 잘리면 한도를 먼저 올리고, 끝까지 모자랄 때만 구간을 나눈다", async () => {
  const limits = [];
  const env = { DATA: bucket(), AI: { run: async (model, options) => { limits.push(options.max_tokens); return limits.length <= 3 ? { choices: [{ finish_reason: "length" }] } : { response: { items: [] } }; } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, "설명".repeat(500)), env)).json();
  const step = async () => (await handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env)).json();
  assert.equal((await step()).retry, true);
  assert.equal((await step()).retry, true);
  assert.equal((await step()).retry, true);
  assert.deepEqual(limits, [2048, 4096, 8192], "한도를 두 배씩 올린 뒤에 나눈다");
  assert.equal((await step()).retry, true, "나눈 앞부분을 먼저 끝낸다");
  assert.ok((await step()).analysis);
  // 나눈 조각은 올려 둔 한도를 물려받아 사다리를 다시 타지 않는다. 성공한 조각은 재호출하지 않는다.
  assert.deepEqual(limits.slice(3), [8192, 8192]);
});

test("재업로드는 이전 구간과 캐시를 보존하고 우선순위 순서의 마지막 요청에서 합친다", async () => {
  const env = { DATA: bucket(), AI: { run: async () => ({ response: { items: [] } }) } };
  const job = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, "일반".repeat(3000)), env)).json();
  const key = `_ecr/jobs/${job.id}.json`;
  const stored = await (await env.DATA.get(key)).json();
  stored.chunks = ["일반 배경", "ECR-001\n세부 내용 CPU 32코어"];
  await env.DATA.put(key, JSON.stringify(stored));
  const again = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, "일반".repeat(3000)), env)).json();
  assert.deepEqual(again.order, [1, 0]);
  const first = await (await handleEcr(request({ action: "step", id: job.id, index: 1, finalize: "0" }), env)).json();
  assert.equal(first.analysis, undefined);
  const final = await (await handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env)).json();
  assert.ok(final.analysis);
});

test("본문이 길어도 상세 표만 작으면 분석하고, 표가 없는 긴 문서는 그대로 막는다", () => {
  const table = (id) => `| 요구사항 고유번호 | ${id} |\n| 세부 내용 | ${id} 서버 메모리 256GB 이상 |\n`;
  const body = "일반 배경 설명입니다.\n".repeat(12000);
  const chunks = splitDocument(body + table("ECR-001") + table("ECR-002"));
  assert.equal(chunks.length, 2);
  assert.ok(!chunks.join("").includes("일반 배경"));
  assert.throws(() => splitDocument(body), /문서가 너무 큽니다/);
});

test("스위치 규격도 줄 범위로 복원하고 분석 대상이 아닌 종류는 거절한다", () => {
  const text = "ECR-026\nSAN 스위치 2대 신규 도입\n32Gbps 24포트 이상";
  const result = { response: { items: [{ id: "ECR-026", kind: "스위치", name: "SAN 스위치", facts: [{ field: "포트 속도", from: 3, to: 3 }] }] } };
  const [item] = parseResult(result, text, "rfp", 0);
  assert.equal(item.분류, "스위치");
  assert.equal(item.장비요약[0].규격[0].값, "32Gbps 24포트 이상");
  result.response.items[0].kind = "랙";
  assert.throws(() => parseResult(result, text, "rfp", 0), /장비 형식/);
});

test("더 손쓸 수 없다고 판정한 구간은 다시 요청해도 모델을 부르지 않는다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; return { choices: [{ finish_reason: "length" }] }; } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.txt" }, "설명".repeat(120)), env)).json();
  const step = () => handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env);
  await step(); await step();
  const 한계 = await step();
  assert.equal(한계.status, 422, "한도를 끝까지 올리고 더 나눌 수 없으면 실패로 끝낸다");
  const 소모 = calls;
  const 다시 = await step();
  assert.equal(다시.status, 422);
  assert.equal(calls, 소모, "판정을 남겼으므로 같은 추론을 되풀이하지 않는다");
});

test("같은 구간을 동시에 밀어도 모델은 한 번만 부른다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; await new Promise((done) => setTimeout(done, 10)); return { response: { items: [] } }; } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "test", name: "rfp.md" }, source), env)).json();
  const step = () => handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "0" }), env);
  const 응답 = await Promise.all((await Promise.all([step(), step()])).map((response) => response.json()));
  assert.equal(calls, 1, "뒤늦은 요청은 표식을 보고 되돌아간다");
  assert.equal(응답.filter((body) => body.retry).length, 1, "한 요청만 되돌아온다");
  assert.equal(응답.filter((body) => !body.retry).length, 1, "한 요청은 구간을 끝낸다");
});

test("빈 모델 결과를 병합하면 원문 대상 번호를 누락으로 저장한다", async () => {
  const env = { DATA: bucket(), AI: { run: async () => ({ response: { items: [] } }) } };
  const job = await (await handleEcr(request({ action: "upload", notice: "missing", name: "rfp.md" }, source), env)).json();
  const response = await handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  const { analysis } = await response.json();
  assert.deepEqual(analysis.누락, ["ECR-001"]);
  assert.equal(analysis.coverage.status, "partial");
  assert.equal(analysis.verified, false);
  const saved = await (await env.DATA.get("_ecr/notices/missing.json")).json();
  assert.deepEqual(saved.누락, ["ECR-001"]);
});

test("잠금 취득 전에 다른 요청이 끝나면 캐시를 다시 읽어 추론하지 않는다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; return modelResult(); } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "race", name: "rfp.md" }, source), env)).json();
  const step = () => handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "0" }), env);
  const get = env.DATA.get.bind(env.DATA);
  let intercepted = false;
  env.DATA.get = async (key) => {
    const snapshot = await get(key);
    if (!intercepted && key.includes("/parts/")) {
      intercepted = true;
      assert.equal((await step()).status, 200);
    }
    return snapshot;
  };
  assert.equal((await step()).status, 200);
  assert.equal(calls, 1);
});

test("이전 요청의 종료는 새 소유자의 잠금을 지우지 않는다", async () => {
  const env = { DATA: bucket(), AI: {} };
  const job = await (await handleEcr(request({ action: "upload", notice: "owner", name: "rfp.md" }, source), env)).json();
  const key = `_ecr/lease/${job.id}/0.json`;
  env.AI.run = async () => {
    await env.DATA.put(key, JSON.stringify({ at: Date.now(), owner: "successor" }));
    throw new Error("provider unavailable");
  };
  const result = await handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  assert.ok(result.status >= 400);
  assert.equal((await (await env.DATA.get(key)).json()).owner, "successor");
});

test("완료 결과를 저장할 때까지 잠금을 유지한다", async () => {
  const data = bucket();
  const env = { DATA: data, AI: { run: async () => modelResult() } };
  const job = await (await handleEcr(request({ action: "upload", notice: "save-order", name: "rfp.md" }, source), env)).json();
  const put = data.put.bind(data);
  let checked = false;
  data.put = async (key, body, options) => {
    if (key.includes("/parts/")) {
      checked = true;
      assert.ok((await (await data.get(`_ecr/lease/${job.id}/0.json`)).json()).at > 0);
    }
    return put(key, body, options);
  };
  assert.equal((await handleEcr(request({ action: "step", id: job.id, index: 0 }), env)).status, 200);
  assert.ok(checked);
});

test("잠금 해제 장애가 나도 저장된 결과는 재추론 없이 조회한다", async () => {
  const data = bucket(); let calls = 0;
  const env = { DATA: data, AI: { run: async () => { calls++; return modelResult(); } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "release-failure", name: "rfp.md" }, source), env)).json();
  const put = data.put.bind(data);
  data.put = async (key, body, options) => {
    if (key.includes("/lease/") && JSON.parse(body).at === 0) throw new Error("release unavailable");
    return put(key, body, options);
  };
  const step = () => handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  assert.equal((await step()).status, 200);
  assert.equal((await step()).status, 200);
  assert.equal(calls, 1);
});

test("잠금이 만료된 후 돌아온 모델 응답은 완료 결과로 저장하지 않는다", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const env = { DATA: bucket(), AI: { run: async () => { now += 180001; return modelResult(); } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "expired", name: "rfp.md" }, source), env)).json();
  const result = await handleEcr(request({ action: "step", id: job.id, index: 0 }), env);
  assert.equal(result.status, 409);
  assert.equal(await env.DATA.get(`_ecr/parts/${job.id}/0.json`), null);
});

test("정산 저장 장애는 성공한 모델 응답을 버리지 않는다", async () => {
  const data = bucket();
  const put = data.put.bind(data);
  const result = { response: { items: [] }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const env = { DATA: data, AI: { run: async () => {
    data.put = async () => { throw new Error("storage unavailable"); };
    return result;
  } } };
  assert.equal(await runBudgeted(env, ECR_MODEL, { messages: [], max_tokens: 2048 }), result);
  data.put = put;
  assert.ok((await (await data.get(`_meta/ai-budget/${new Date().toISOString().slice(0, 10)}.json`)).json()).reserved > 50);
});

test("자정을 넘긴 추론의 정산은 예약 날짜에만 적용된다", async (t) => {
  let now = Date.parse("2026-09-22T23:59:59Z");
  t.mock.method(Date, "now", () => now);
  const data = bucket();
  const nextDay = now + 2000;
  await reserveNeurons(data, 1000, nextDay);
  await runBudgeted({ DATA: data, AI: { run: async () => {
    now = nextDay;
    return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } }, ECR_MODEL, { messages: [], max_tokens: 2048 });
  assert.equal((await (await data.get("_meta/ai-budget/2026-09-23.json")).json()).reserved, 1000);
  assert.ok((await (await data.get("_meta/ai-budget/2026-09-22.json")).json()).reserved < 20);
});

test("null 사용량을 0으로 간주해 예약을 반환하지 않는다", async () => {
  const data = bucket();
  await runBudgeted({ DATA: data, AI: { run: async () => ({ usage: { prompt_tokens: null, completion_tokens: null } }) } }, ECR_MODEL, { messages: [], max_tokens: 2048 });
  assert.ok((await (await data.get(`_meta/ai-budget/${new Date().toISOString().slice(0, 10)}.json`)).json()).reserved > 50);
});

test("실제 사용량이 보고되면 예약해 둔 차액을 장부에서 되돌린다", async () => {
  const store = bucket();
  const 예산키 = `_meta/ai-budget/${new Date().toISOString().slice(0, 10)}.json`;
  const env = { DATA: store, AI: { run: async () => ({ response: { items: [] }, usage: { prompt_tokens: 900, completion_tokens: 120 } }) } };
  await runBudgeted(env, ECR_MODEL, { messages: [], max_tokens: 2048 });
  const 장부 = await (await store.get(예산키)).json();
  assert.ok(장부.reserved > 0, "쓴 만큼은 남는다");
  assert.ok(장부.reserved < 20, `출력 한도로 잡은 예약이 실제 사용량으로 줄어든다(현재 ${장부.reserved})`);
});

test("사용량이 없거나 이상하면 예약을 그대로 둔다", async () => {
  const store = bucket();
  const 예산키 = `_meta/ai-budget/${new Date().toISOString().slice(0, 10)}.json`;
  const env = { DATA: store, AI: { run: async () => ({ response: { items: [] }, usage: { prompt_tokens: "많음" } }) } };
  await runBudgeted(env, ECR_MODEL, { messages: [], max_tokens: 2048 });
  const 장부 = await (await store.get(예산키)).json();
  assert.ok(장부.reserved > 50, "덜 썼다는 증거가 없으면 되돌리지 않는다");
});
