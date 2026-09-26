const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen(index, analysis) {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = source.indexOf("async function loadIndex("), end = source.indexOf("function renderDataStatus", start);
  const status = { textContent: "" }, writes = [];
  const context = vm.createContext({ DATA_BASE: "/data", INDEX_STORAGE_KEY: "index", indexRevision: 0, fileIndex: ["existing"], dataSchemaVersion: "old", analyses: new Map([["old", { path: "old.json" }]]),
    getJson: async (url) => url.includes("analysis-index") ? analysis : typeof index === "function" ? index() : index,
    localStorage: { getItem: () => "old", setItem: (...args) => writes.push(args) },
    renderDataStatus() {}, defaultRange() {}, $: () => status });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/dates.js"), "utf8"), context);
  vm.runInContext(source.slice(start, end), context);
  return { context, status, writes, load: () => context.loadIndex(true) };
}
const file = { path: "bid/2026/09.csv.gz", begin: "2026-09-01", end: "2026-09-30" };

test("ECR 인덱스의 문자열 검증 상태나 HTML·음수 건수는 목록에 적용하지 않는다", async () => {
  for (const invalid of [
    { verified: "false" }, { verified: "true" }, { verified: 1 }, { verified: null },
    { ecrCount: '<img src=x onerror="alert(1)">' }, { ecrCount: "2" },
    { ecrCount: -1 }, { ecrCount: 1.5 }, { ecrCount: Number.MAX_SAFE_INTEGER + 1 },
    { ecrCount: {} }, { ecrCount: null },
  ]) {
    const ui = screen({ files: [file] }, { entries: [{ notice: "new", path: "analysis/new.json", ...invalid }] });
    const result = await ui.load();
    assert.equal(result.analysisUnavailable, true);
    assert.equal(ui.context.analyses.has("old"), true);
    assert.equal(ui.context.analyses.has("new"), false);
    assert.equal(ui.context.fileIndex[0].path, file.path);
  }
});

test("ECR 인덱스의 불리언 검증·0건 및 선택 필드 없는 구형 항목은 유지한다", async () => {
  const entries = [
    { notice: "zero", path: "analysis/zero.json", verified: false, ecrCount: 0 },
    { notice: "ok", path: "analysis/ok.json", verified: true, ecrCount: 2 },
    { notice: "legacy", path: "analysis/legacy.json" },
  ];
  const ui = screen({ files: [file] }, { entries });
  assert.equal((await ui.load()).analysisUnavailable, false);
  assert.equal(ui.context.analyses.size, 3);
  assert.equal(ui.context.analyses.get("zero").verified, false);
  assert.equal(ui.context.analyses.get("ok").ecrCount, 2);
});
test("손상된 공고 인덱스는 기존 목록·분석·갱신 시각을 지우지 않는다", async () => {
  for (const index of [null, {}, { files: {} }, { files: [null] }, { files: [{ ...file, begin: "2026-02-30" }] }, { files: [{ ...file, path: "bid/../secret.csv.gz" }] }]) {
    const ui = screen(index, { entries: [] });
    await assert.rejects(ui.load(), /목록 형식/);
    assert.equal(ui.context.fileIndex[0], "existing");
    assert.equal(ui.context.analyses.has("old"), true);
    assert.equal(ui.writes.length, 0);
  }
});
test("ECR 목록이 손상돼도 유효한 공고 목록을 로드하고 기존 ECR 목록을 유지한다", async () => {
  const ui = screen({ files: [file] }, { entries: [null] });
  const result = await ui.load();
  assert.equal(ui.context.fileIndex[0].path, file.path);
  assert.equal(ui.context.analyses.has("old"), true);
  assert.equal(result.analysisUnavailable, true);
  assert.match(ui.status.textContent, /직접 조회/);
});
test("유효한 빈 인덱스는 정상적으로 이전 목록을 비운다", async () => {
  const ui = screen({ files: [], updatedAt: "new" }, { entries: [] });
  const result = await ui.load();
  assert.equal(ui.context.fileIndex.length, 0);
  assert.equal(ui.context.analyses.size, 0);
  assert.equal(result.changed, true);
});

test("중복 CSV 경로·경로와 다른 공고 모드·잘못된 건수는 적용하지 않는다", async () => {
  for (const files of [[file, { ...file }], [{ ...file, mode: "pre" }], [{ ...file, count: -1 }], [{ ...file, count: "10" }], [{ ...file, count: 1.5 }]]) {
    const ui = screen({ files }, { entries: [] });
    await assert.rejects(ui.load(), /목록 형식/);
    assert.equal(ui.context.fileIndex[0], "existing");
    assert.equal(ui.writes.length, 0);
  }
});

test("같은 공고의 ECR 경로가 두 개이면 임의의 마지막 항목으로 덮어쓰지 않는다", async () => {
  const ui = screen({ files: [file] }, { entries: [{ notice: "same", path: "analysis/first.json" }, { notice: "same", path: "analysis/second.json" }] });
  const result = await ui.load();
  assert.equal(result.analysisUnavailable, true);
  assert.equal(ui.context.analyses.has("old"), true);
  assert.equal(ui.context.analyses.has("same"), false);
});

test("ECR 인덱스는 다른 API·외부 URL·경로 이탈과 공고번호 불일치를 거부한다", async () => {
  for (const path of ["/api/logout", "/api/refresh", "/api/ecr?notice=other", "/api/ecr?notice=one&action=upload", "https://example.com/a.json", "//example.com/a.json", "analysis/../secret.json", "analysis/./one.json", "analysis//one.json", "analysis/%2e%2e/one.json", "analysis/a\\one.json", "analysis/one.json?x=1", "analysis/one.json#x", "analysis/one\n.json", "analysis/one.json "]) {
    const ui = screen({ files: [file] }, { entries: [{ notice: "one", path }] });
    assert.equal((await ui.load()).analysisUnavailable, true, path);
    assert.equal(ui.context.analyses.has("old"), true);
  }
});

test("실제 생성되는 구형 저장 경로와 같은 공고의 클라우드 조회 경로를 허용한다", async () => {
  const entries = [
    { notice: "R26BK-001", path: "analysis/bid/R26BK-001.json" },
    { notice: "공고 1", path: "analysis/bid/공고 1.json" },
    { notice: "cloud-one", path: "/api/ecr?notice=cloud-one" },
  ];
  const ui = screen({ files: [file] }, { entries });
  assert.equal((await ui.load()).analysisUnavailable, false);
  assert.equal(ui.context.analyses.size, 3);
});

test("잘못된 유니코드 공고번호도 공고 인덱스 로딩 전체를 중단시키지 않는다", async () => {
  const ui = screen({ files: [file] }, { entries: [{ notice: "\ud800", path: "analysis/one.json" }] });
  assert.equal((await ui.load()).analysisUnavailable, true);
  assert.equal(ui.context.fileIndex[0].path, file.path);
  assert.equal(ui.context.analyses.has("old"), true);
});

test("모드 생략 구형 항목과 정수 건수의 정상 항목은 허용한다", async () => {
  const ui = screen({ files: [{ ...file, count: 0 }, { path: "pre/2026/09/01.csv.gz", begin: "2026-09-01", end: "2026-09-01", mode: "pre", count: 10 }] }, { entries: [] });
  await ui.load();
  assert.equal(ui.context.fileIndex.length, 2);
});

test("응답 순서가 바뀌어도 최신 요청의 인덱스와 갱신 시각을 유지한다", async () => {
  const requests = [];
  const ui = screen(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), { entries: [] });
  const first = ui.load(), second = ui.load();
  requests[1].resolve({ files: [file], updatedAt: "new", schemaVersion: "new-schema" }); await second;
  requests[0].resolve({ files: [], updatedAt: "old" });
  assert.equal((await first).stale, true);
  assert.equal(ui.context.fileIndex.length, 1);
  assert.equal(ui.context.dataSchemaVersion, "new-schema");
  assert.deepEqual(ui.writes, [["index", "new"]]);
});

test("늦은 이전 인덱스 실패는 새 결과를 지우는 오류로 전파하지 않는다", async () => {
  const requests = [];
  const ui = screen(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), { entries: [] });
  const first = ui.load(), second = ui.load();
  requests[1].resolve({ files: [file] }); await second;
  requests[0].reject(new Error("old failure"));
  assert.equal((await first).stale, true);
  assert.equal(ui.context.fileIndex.length, 1);
});
