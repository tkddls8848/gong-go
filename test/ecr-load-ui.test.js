const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen(timeoutMs) {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = app.indexOf("let ecrLoadRevision = 0;");
  const end = app.indexOf("function wireEcrEntrypoints", start);
  assert.ok(start >= 0 && end > start);
  const requests = [], renders = [], nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", insertAdjacentHTML() {} }); return nodes.get(id); };
  const context = vm.createContext({ $, AbortController, clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), DATA_BASE: "/data", currentRow: { announcementNumber: "one" }, currentAnalysis: null, ecrRun: 0,
    analyses: new Map(), numberOf: (row) => row.announcementNumber, html: (value) => value,
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    document: { querySelectorAll: () => [] },
    renderEcr: (data) => renders.push(data), EquipmentSummary: { ...require("../public/equipment.js"), render: () => "" } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/http.js"), "utf8"), context);
  vm.runInContext(app.slice(start, end), context);
  return { context, requests, renders, $, load: () => context.loadEcr() };
}
const result = (name) => ({ provider: "workers-ai", ecr: [], name });
const reply = (data) => ({ ok: true, json: async () => data });

test("실제 조회 결과의 누락은 구형 인덱스 통과 상태와 기존 배지를 바로 교정한다", async () => {
  const ui = screen();
  const badge = { className: "ecr-badge", textContent: "ECR 9" };
  const title = { querySelector: () => badge };
  const tr = { firstElementChild: { textContent: "one" }, querySelector: () => title };
  ui.context.document.querySelectorAll = () => [tr];
  ui.context.analyses.set("one", { path: "analysis/one.json", verified: true, ecrCount: 9 });
  const pending = ui.load();
  ui.requests[0].resolve(reply({ verified: true, ecr: [{ id: "ECR-001" }], 누락: ["ECR-002"] }));
  await pending;
  const entry = ui.context.analyses.get("one");
  assert.equal(entry.path, "analysis/one.json");
  assert.equal(entry.ecrCount, 1);
  assert.equal(entry.verified, false);
  assert.equal(badge.className, "ecr-badge warning");
  assert.equal(badge.textContent, "ECR 1 · 확인 필요");
  assert.equal(ui.requests.length, 1);
});

test("새 분석 배지는 기존 목록 버튼을 교체하지 않고 해당 공고에만 추가한다", () => {
  const ui = screen();
  const badges = [];
  const title = { querySelector: () => null, append: (badge) => badges.push(badge) };
  ui.context.document.querySelectorAll = () => [
    { firstElementChild: { textContent: "other" }, querySelector: () => assert.fail("다른 공고는 변경하지 않는다") },
    { firstElementChild: { textContent: "one" }, querySelector: () => title },
  ];
  ui.context.document.createElement = (name) => { assert.equal(name, "span"); return {}; };
  ui.context.rememberEcr(ui.context.currentRow, { verified: true, ecr: [] }, "/api/ecr?notice=one");
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, "ECR 0 · 확인 필요");
});

test("같은 공고에서 조회 응답 순서가 바뀌어도 최신 조회만 표시한다", async () => {
  const ui = screen(), first = ui.load(), second = ui.load();
  ui.requests[1].resolve(reply(result("new"))); await second;
  ui.requests[0].resolve(reply(result("old"))); await first;
  assert.equal(ui.context.currentAnalysis.name, "new");
  assert.equal(ui.renders.length, 1);
});

test("새 분석이 시작되면 앞서 요청한 저장 결과는 최신 분석을 덮어쓰지 않는다", async () => {
  const ui = screen(), pending = ui.load();
  ui.context.ecrRun++;
  ui.context.currentAnalysis = result("new analysis");
  ui.requests[0].resolve(reply(result("old saved"))); await pending;
  assert.equal(ui.context.currentAnalysis.name, "new analysis");
  assert.equal(ui.renders.length, 0);
});

test("같은 공고를 다시 열었을 때 이전 오류로 현재 화면을 바꾸지 않는다", async () => {
  const ui = screen(), pending = ui.load();
  ui.context.ecrRun++;
  ui.$("#ecr-content").innerHTML = "current screen";
  ui.requests[0].reject(new Error("old error")); await pending;
  assert.equal(ui.$("#ecr-content").innerHTML, "current screen");
});

test("공고가 닫힌 상태에서는 조회하지 않는다", async () => {
  const ui = screen(); ui.context.currentRow = null;
  await ui.load();
  assert.equal(ui.requests.length, 0);
});

test("저장 조회 시간 초과는 재분석 대신 재조회를 안내하고 늦은 응답을 무시한다", async () => {
  const ui = screen(5);
  await ui.load();
  assert.match(ui.$("#ecr-content").innerHTML, /다시 조회/);
  assert.match(ui.$("#ecr-content").innerHTML, /재분석할 필요는 없/);
  assert.equal(ui.requests.length, 1);
  ui.requests[0].resolve(reply(result("late")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.context.currentAnalysis, null);
  const retry = ui.load();
  ui.requests[1].resolve(reply(result("retry"))); await retry;
  assert.equal(ui.context.currentAnalysis.name, "retry");
});

test("손상된 저장 결과는 현재 분석과 목록 캐시를 오염시키지 않는다", async () => {
  const ui = screen(), pending = ui.load();
  ui.requests[0].resolve(reply({ provider: "workers-ai" })); await pending;
  assert.equal(ui.context.currentAnalysis, null);
  assert.equal(ui.context.analyses.size, 0);
  assert.equal(ui.renders.length, 0);
  assert.match(ui.$("#ecr-content").innerHTML, /형식/);
});

test("중첩 규격 손상도 현재 분석에 저장하기 전에 거부한다", async () => {
  const ui = screen(), pending = ui.load();
  ui.requests[0].resolve(reply({ provider: "workers-ai", ecr: [{ 장비요약: [{ 규격: [null] }] }] })); await pending;
  assert.equal(ui.context.currentAnalysis, null);
  assert.equal(ui.context.analyses.size, 0);
  assert.equal(ui.renders.length, 0);
  assert.match(ui.$("#ecr-content").innerHTML, /형식/);
});

test("클라우드 결과가 없으면 기존 저장 경로를 조회한다", async () => {
  const ui = screen();
  ui.context.analyses.set("one", { path: "analysis/one.json" });
  const pending = ui.load();
  ui.requests[0].resolve({ ok: false, status: 404, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.requests.length, 2);
  ui.requests[1].resolve(reply(result("legacy"))); await pending;
  assert.equal(ui.context.currentAnalysis.name, "legacy");
});

test("기존 저장 경로의 본문 지연에도 시간 제한이 적용된다", async () => {
  const ui = screen(5);
  ui.context.analyses.set("one", { path: "analysis/one.json" });
  const pending = ui.load();
  ui.requests[0].resolve({ ok: false, status: 404, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  ui.requests[1].resolve({ ok: true, json: () => new Promise(() => {}) });
  await pending;
  assert.equal(ui.context.currentAnalysis, null);
  assert.match(ui.$("#ecr-content").innerHTML, /대기 시간이 초과/);
});
