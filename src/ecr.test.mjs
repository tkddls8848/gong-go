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
      const value = { body, etag: String(++version), uploaded: new Date() }; store.set(key, value); return value;
    },
    // R2는 키 배열을 한 번에 지운다. 정리가 그 형태를 쓰므로 모의도 같게 받는다.
    async delete(keys) { for (const key of [].concat(keys)) store.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const objects = [...store.entries()].filter(([key]) => key.startsWith(prefix))
        .slice(0, limit).map(([key, value]) => ({ key, uploaded: value.uploaded }));
      return { objects, truncated: false };
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
test("업로드부터 Workers AI 분석까지 연결하고 결과는 응답으로만 돌려준다", async () => {
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
  assert.equal((await step()).status, 404, "끝난 작업은 지워져 다시 올려야 한다");
  assert.equal(calls, 1, "다시 보낸 요청으로 추론하지 않는다");
  assert.deepEqual([...env.DATA.store.keys()].filter((key) => key.startsWith("_ecr/")), [], "결과도 작업 자료도 남기지 않는다");
  const saved = await handleEcr(new Request(`${ORIGIN}/api/ecr?notice=R26-001`), env);
  assert.equal(saved.status, 405, "저장 결과 조회 경로는 없다");
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
test("출력 잘림, 깨진 JSON, 근거 없는 값은 성공으로 위장하지 않는다", () => {
  assert.throws(() => parseResult({ choices: [{ finish_reason: "length" }] }, source, "test", 0), /출력 한도/);
  assert.throws(() => parseResult({ response: "{" }, source, "test", 0), /형식/);
  const result = modelResult();
  result.choices[0].message.content = result.choices[0].message.content.replaceAll("256GB", "512GB");
  const items = parseResult(result, source, "test", 0);
  assert.equal(items[0].장비요약[0].규격[0].검증, "확인 필요");
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

test("완주하면 결과를 응답으로만 돌려주고 작업 자료를 모두 지운다", async () => {
  let calls = 0;
  const env = { DATA: bucket(), AI: { run: async () => { calls++; return modelResult(); } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "R26-900", name: "rfp.md" }, source), env)).json();
  const done = await (await handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env)).json();
  assert.equal(done.analysis.ecr.length, 1);
  assert.deepEqual([...env.DATA.store.keys()].filter((key) => key.startsWith("_ecr/")), [], "결과·원문·구간·표식 어느 것도 남지 않는다");
  const 재요청 = await handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env);
  assert.equal(재요청.status, 404);
  assert.equal(calls, 1);
});

const twoTables = "ECR-001 서버 도입\n서버당 메모리 256GB 이상을 제공한다.\nECR-002 스토리지 도입\nUsable 용량 100TB 이상을 제공한다.";
test("누락 번호 재분석은 그 번호의 표만 대상 번호를 못박아 다시 묻고 문서 전체 기준으로 대조한다", async () => {
  const calls = [];
  const env = { DATA: bucket(), AI: { run: async (model, options) => {
    calls.push(options);
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ id: "ECR-002", kind: "스토리지", name: "스토리지 도입", facts: [{ field: "Usable 용량", from: 2, to: 2 }] }] }) } }] };
  } } };
  const upload = await handleEcr(request({ action: "upload", notice: "R26-777", name: "rfp.md", focus: "ECR-002", matched: "ECR-001" }, twoTables), env);
  assert.equal(upload.status, 200);
  const job = await upload.json();
  assert.equal(job.total, 1, "대상 번호의 표만 자른다");
  assert.deepEqual(job.retry, ["ECR-002"]);
  const { analysis } = await (await handleEcr(request({ action: "step", id: job.id, index: 0, finalize: "1" }), env)).json();
  assert.match(calls[0].messages[1].content, /^\[대상 요구사항 번호: ECR-002\]/);
  assert.deepEqual(calls[0].response_format.json_schema.properties.items.items.properties.id.enum, ["ECR-002"], "다른 번호를 돌려줄 수 없게 한다");
  assert.equal(analysis.ecr.length, 1);
  assert.equal(analysis.coverage.status, "matched", "이어받은 번호와 합쳐 문서 전체를 대조한다");
  assert.deepEqual(analysis.coverage.matchedIds, ["ECR-001", "ECR-002"]);
  assert.deepEqual(analysis.retry, { focus: ["ECR-002"], recovered: ["ECR-002"] });
  assert.deepEqual(analysis.ecr[0].장비요약[0].규격[0].정규화, [{ 수치: 100, 단위: "TB", 조건: "이상" }]);
  assert.deepEqual([...env.DATA.store.keys()].filter((key) => key.startsWith("_ecr/")), [], "재분석도 끝나면 작업 자료를 지운다");
});

const longTable = () => {
  const rows = Array.from({ length: 60 }, (_, index) => `| 항목${index + 1} | 전원 이중화 구성 및 10/25GbE ${(index + 1) * 2}Port, 디스크 ${(index + 1) * 16}GB 이상 제공 |`);
  return `요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n세부내용\n| CPU | 2.4GHz 16Core 이상 |\n${rows.join("\n")}\n| 수량 | 2대 |\n`;
};

test("여러 구간에 걸친 같은 장비는 결과에서 한 항목으로 합치고 값은 다듬어 싣는다", async () => {
  const text = longTable();
  const chunks = splitDocument(text);
  // 첫 구간의 마지막 줄은 둘째 구간에도 다시 실린다. 모델이 양쪽에서 같은 줄을 가리키는 상황이다.
  const shared = chunks[0].trimEnd().split("\n").at(-1);
  assert.ok(chunks[1].includes(shared));
  const env = { DATA: bucket(), AI: { run: async (model, options) => {
    const facts = [];
    for (const line of options.messages[1].content.split("\n")) {
      const [, number, body] = /^\[L(\d+)\] (.*)$/.exec(line) || [];
      const field = body?.startsWith("| CPU |") ? "CPU" : body?.startsWith("| 수량 |") ? "수량" : body === shared ? "기타 조건" : "";
      if (field) facts.push({ field, from: Number(number), to: Number(number) });
    }
    return { response: { items: [{ id: "ECR-001", kind: "서버", name: "WEB 서버", facts }] } };
  } } };
  const job = await (await handleEcr(request({ action: "upload", notice: "R26-910", name: "rfp.md" }, text), env)).json();
  assert.equal(job.total, chunks.length);
  let analysis;
  for (let index = 0; index < job.total; index++) ({ analysis } = await (await handleEcr(request({ action: "step", id: job.id, index, finalize: index === job.total - 1 ? "1" : "0" }), env)).json());
  assert.equal(analysis.ecr.length, 1, "구간 수만큼 항목을 만들지 않는다");
  const [item] = analysis.ecr;
  assert.equal(item.명칭, "WEB 서버");
  assert.equal(item.장비요약.length, 1);
  const specs = item.장비요약[0].규격;
  assert.deepEqual(specs.map((fact) => fact.항목), ["수량", "CPU", "기타 조건"], "겹친 줄의 규격은 한 번만 싣는다");
  assert.deepEqual(specs.map((fact) => fact.값), ["2대", "2.4GHz 16Core 이상", shared.replace(/^\| | \|$/g, "")]);
  assert.equal(specs[1].근거, "| CPU | 2.4GHz 16Core 이상 |", "근거는 원문 줄 그대로다");
  assert.equal(item.장비요약[0].출처, `rfp.md · 구간 ${chunks.map((_, index) => index + 1).join(", ")}`);
  assert.equal(item.세부내용_원문, text, "원문은 겹친 줄과 반복한 머리를 걷어 내고 한 번만 싣는다");
  assert.equal(analysis.coverage.status, "matched");
});

