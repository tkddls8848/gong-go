const test = require("node:test");
const assert = require("node:assert/strict");
const { createEcr } = require("../public/ecr-ui.js");
const EquipmentSummary = require("../public/equipment.js");
const EcrRetry = require("../public/ecr-retry.js");
const { html } = require("../public/format.js");

const usable = (id) => ({ id, 명칭: id, 불확실: [], 장비요약: [{ 종류: "서버", 명칭: id, 규격: [{ 항목: "메모리", 값: "256GB", 근거: "256GB", 검증: "원문 확인" }] }] });
const coverage = (matchedIds, missingIds) => ({ status: missingIds.length ? "partial" : "matched", expectedIds: ["ECR-001", "ECR-002"], matchedIds, missingIds, unexpectedIds: [] });
function setup({ files = [], download } = {}) {
  const nodes = new Map(), requests = [], downloads = [];
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", innerHTML: "", value: "", files: [], insertAdjacentHTML() {} });
    return nodes.get(id);
  };
  const replies = [];
  const model = { currentRow: { mode: "bid", number: "R26-1", files }, currentAnalysis: null };
  const state = { ecrBusy: false, aiUnlocked: true, ecrRun: 0 };
  const attachments = {
    candidates: (list) => list.map((file) => ({ ...file })),
    download: (file, options) => { downloads.push({ file, options }); return download ? download(file, options) : Promise.resolve(new File([new Uint8Array([1, 2, 3])], file.name)); },
  };
  const ui = createEcr({
    model, state, $, html, numberOf: (row) => row.number, renderEcr() {}, showAiAccess() {},
    EquipmentSummary: { ...EquipmentSummary, render: () => "" }, EcrRetry, attachments,
    GongHttp: { async requestJson(url, options) { requests.push({ url, ...options }); const data = await replies.shift(); return { response: { ok: !data.failed }, data }; } },
  });
  return { $, model, state, ui, requests, downloads, replies };
}

test("파일을 고르지 않으면 정렬된 첫 공고 첨부를 받아 분석한다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  assert.match(s.$("#ecr-attachment").innerHTML, /<option value="0">제안요청서.pdf<\/option>/);
  assert.equal(s.$("#ecr-attachment").value, "0");
  s.replies.push({ id: "job", total: 1 }, { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-001")], 누락: [], coverage: coverage(["ECR-001"], []) } });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.downloads.length, 1);
  assert.match(s.requests[0].url, /action=upload&notice=R26-1&name=%EC%A0%9C/);
  assert.equal(s.requests[0].body.name, "제안요청서.pdf");
  assert.equal(s.model.currentAnalysis.ecr.length, 1);
  assert.equal(s.$("#download-ecr-btn").disabled, false);
  assert.equal(s.$("#download-ecr-devices-btn").disabled, false, "결과가 있으면 장비별 규격표도 내려받을 수 있다");
  assert.equal(s.$("#ecr-retry-btn").hidden, true, "누락이 없으면 재분석을 권하지 않는다");
});

test("첨부를 받는 중에 중지하면 다운로드를 끊고 업로드하지 않는다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }], download: (file, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  s.ui.loadEcr();
  const run = s.ui.startEcrAnalysis({ preventDefault() {} });
  s.ui.stopEcrAnalysis();
  await run;
  assert.equal(s.downloads[0].options.signal.aborted, true);
  assert.equal(s.requests.length, 0);
  assert.equal(s.state.ecrBusy, false);
});

const partial = () => ({ completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-001")], 누락: ["ECR-002"], coverage: coverage(["ECR-001"], ["ECR-002"]), verification: { errors: [], warnings: [] } } });
const recovered = () => ({ completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-002")], 누락: [], coverage: coverage(["ECR-001", "ECR-002"], []), verification: { errors: [], warnings: [] }, retry: { focus: ["ECR-002"], recovered: ["ECR-002"] } } });

test("분석이 빠뜨린 번호는 같은 업로드 본문으로 그 번호만 자동으로 한 번 더 묻고 결과를 합친다", async () => {
  // 큰 문서는 실행마다 모델이 빠뜨리는 요구사항이 다르다. 버튼을 누르지 않아도 한 번은 다시 묻는다.
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.replies.push({ id: "job", total: 1 }, partial(), { id: "retry", total: 1, retry: ["ECR-002"] }, recovered());
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.requests.length, 4);
  const params = new URL(s.requests[2].url, "https://x").searchParams;
  assert.equal(params.get("focus"), "ECR-002");
  assert.equal(params.get("matched"), "ECR-001");
  assert.equal(s.requests[2].body, s.requests[0].body, "다시 받거나 다시 변환하지 않는다");
  assert.equal(s.downloads.length, 1);
  assert.deepEqual(s.model.currentAnalysis.ecr.map((item) => item.id), ["ECR-001", "ECR-002"]);
  assert.equal(s.model.currentAnalysis.coverage.status, "matched");
  assert.equal(s.$("#ecr-retry-btn").hidden, true);
  assert.match(s.$("#ecr-progress").textContent, /번호 1개를 다시 물어 1개를 찾았습니다/);
  assert.equal(s.state.ecrBusy, false);
});

test("다시 물어도 찾지 못한 번호는 또 묻지 않는다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  const nothing = { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [], 누락: ["ECR-002"], coverage: coverage(["ECR-001"], ["ECR-002"]), verification: { errors: [], warnings: [] }, retry: { focus: ["ECR-002"], recovered: [] } } };
  s.replies.push({ id: "job", total: 1 }, partial(), { id: "retry", total: 1, retry: ["ECR-002"] }, nothing);
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.requests.length, 4, "자동 재분석은 한 번뿐이다");
  assert.deepEqual(s.model.currentAnalysis.ecr.map((item) => item.id), ["ECR-001"]);
  assert.equal(s.$("#ecr-retry-btn").hidden, true, "같은 번호를 같은 지시로 다시 묻지 않는다");
  assert.match(s.$("#ecr-progress").textContent, /0개를 찾았습니다\. 나머지는 원문을 직접 확인하세요/);
});

test("자동 재분석이 실패해도 직전 결과를 그대로 두고 버튼으로 다시 시도할 수 있다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.replies.push({ id: "job", total: 1 }, partial(), { failed: true, message: "오늘 분석 예산을 모두 썼습니다." });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  const before = s.model.currentAnalysis;
  assert.deepEqual(before.ecr.map((item) => item.id), ["ECR-001"]);
  assert.match(s.$("#ecr-progress").textContent, /빠진 번호를 다시 묻다가 실패했습니다: 오늘 분석 예산을 모두 썼습니다\./);
  assert.equal(s.$("#ecr-retry-btn").hidden, false, "다시 시도할 수 있다");
  assert.equal(s.state.ecrBusy, false);
  // 버튼 재분석도 실패하면 직전 결과를 그대로 둔다.
  s.replies.push({ failed: true, message: "오늘 분석 예산을 모두 썼습니다." });
  await s.ui.retryMissing();
  assert.equal(s.model.currentAnalysis, before);
  assert.equal(s.$("#ecr-progress").textContent, "오늘 분석 예산을 모두 썼습니다. 직전 분석 결과는 그대로 둡니다.");
  // 버튼 재분석이 성공하면 합친다.
  s.replies.push({ id: "retry", total: 1, retry: ["ECR-002"] }, recovered());
  await s.ui.retryMissing();
  assert.deepEqual(s.model.currentAnalysis.ecr.map((item) => item.id), ["ECR-001", "ECR-002"]);
  assert.match(s.$("#ecr-progress").textContent, /1개 중 1개의 규격을 찾아 합쳤습니다/);
});

test("자동 재분석 중에 중지하면 직전 결과를 그대로 두고 더 묻지 않는다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  let release;
  // 재분석 업로드 응답을 붙잡아 두고 그 사이에 중지한다.
  s.replies.push({ id: "job", total: 1 }, partial(), new Promise((resolve) => { release = () => resolve({ id: "retry", total: 1, retry: ["ECR-002"] }); }));
  const run = s.ui.startEcrAnalysis({ preventDefault() {} });
  while (s.requests.length < 3) await new Promise((resolve) => setImmediate(resolve));
  s.ui.stopEcrAnalysis();
  release();
  await run;
  assert.equal(s.requests.length, 3, "중지한 뒤에는 구간을 묻지 않는다");
  assert.deepEqual(s.model.currentAnalysis.ecr.map((item) => item.id), ["ECR-001"]);
  assert.equal(s.state.ecrBusy, false);
});
