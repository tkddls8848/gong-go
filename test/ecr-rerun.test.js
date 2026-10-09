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
    GongHttp: { async requestJson(url, options) { requests.push({ url, ...options }); const data = replies.shift(); return { response: { ok: !data.failed }, data }; } },
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
  assert.equal(s.$("#ecr-retry-btn").hidden, true, "누락이 없으면 재분석을 권하지 않는다");
});

test("직접 고른 파일이 공고 첨부보다 먼저다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.$("#ecr-file").files = [new File(["ECR-001"], "mine.md")];
  s.replies.push({ id: "job", total: 0 });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.downloads.length, 0);
  assert.match(s.requests[0].url, /name=mine.md/);
});

test("고를 원본이 없으면 요청하지 않고 안내한다", async () => {
  const s = setup();
  s.ui.loadEcr();
  assert.match(s.$("#ecr-source-hint").textContent, /바로 분석할 수 있는 첨부/);
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.requests.length, 0);
  assert.match(s.$("#ecr-progress").textContent, /첨부를 고르거나 파일을 선택/);
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

test("누락 번호 재분석은 같은 업로드 본문으로 그 번호만 다시 묻고 결과를 합친다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.replies.push({ id: "job", total: 1 }, { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-001")], 누락: ["ECR-002"], coverage: coverage(["ECR-001"], ["ECR-002"]), verification: { errors: [], warnings: [] } } });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  assert.equal(s.$("#ecr-retry-btn").hidden, false);
  assert.equal(s.$("#ecr-retry-btn").textContent, "누락 번호 다시 분석 (1개)");
  const body = s.requests[0].body;
  s.replies.push({ id: "retry", total: 1, retry: ["ECR-002"] }, { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-002")], 누락: [], coverage: coverage(["ECR-001", "ECR-002"], []), verification: { errors: [], warnings: [] }, retry: { focus: ["ECR-002"], recovered: ["ECR-002"] } } });
  await s.ui.retryMissing();
  const params = new URL(s.requests[2].url, "https://x").searchParams;
  assert.equal(params.get("focus"), "ECR-002");
  assert.equal(params.get("matched"), "ECR-001");
  assert.equal(s.requests[2].body, body, "다시 받거나 다시 변환하지 않는다");
  assert.equal(s.downloads.length, 1);
  assert.deepEqual(s.model.currentAnalysis.ecr.map((item) => item.id), ["ECR-001", "ECR-002"]);
  assert.equal(s.model.currentAnalysis.coverage.status, "matched");
  assert.equal(s.$("#ecr-retry-btn").hidden, true);
  assert.match(s.$("#ecr-progress").textContent, /1개 중 1개의 규격을 찾아 합쳤습니다/);
});

test("재분석이 실패해도 직전 결과를 그대로 둔다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.replies.push({ id: "job", total: 1 }, { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [usable("ECR-001")], 누락: ["ECR-002"], coverage: coverage(["ECR-001"], ["ECR-002"]) } });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  const before = s.model.currentAnalysis;
  s.replies.push({ failed: true, message: "오늘 분석 예산을 모두 썼습니다." });
  await s.ui.retryMissing();
  assert.equal(s.model.currentAnalysis, before);
  assert.equal(s.$("#ecr-progress").textContent, "오늘 분석 예산을 모두 썼습니다. 직전 분석 결과는 그대로 둡니다.");
  assert.equal(s.$("#ecr-retry-btn").hidden, false, "다시 시도할 수 있다");
  assert.equal(s.state.ecrBusy, false);
});

test("다른 공고로 옮기면 직전 업로드로 재분석하지 않는다", async () => {
  const s = setup({ files: [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/a" }] });
  s.ui.loadEcr();
  s.replies.push({ id: "job", total: 1 }, { completed: 1, total: 1, analysis: { schemaVersion: 2, verified: false, ecr: [], 누락: ["ECR-002"], coverage: coverage([], ["ECR-001", "ECR-002"]) } });
  await s.ui.startEcrAnalysis({ preventDefault() {} });
  s.model.currentRow = { mode: "bid", number: "R26-2", files: [] };
  await s.ui.retryMissing();
  assert.equal(s.requests.length, 2);
});

test("제안요청정보 첨부는 드롭다운에 출처와 문서 구분을 밝혀 보인다", () => {
  const s = setup({ files: [{ name: "제안요청서.hwp", url: "https://www.g2b.go.kr/a" }, { name: "<제안>.hwp", url: "https://www.g2b.go.kr/rfp", source: "제안요청정보", kind: "제안요청서" }] });
  s.ui.loadEcr();
  assert.match(s.$("#ecr-attachment").innerHTML, /<option value="0">제안요청서.hwp<\/option><option value="1">\[제안요청정보·제안요청서\] &lt;제안&gt;.hwp<\/option>/);
});
