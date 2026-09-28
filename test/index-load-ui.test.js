const test = require("node:test");
const assert = require("node:assert/strict");

const { createIndex } = require("../public/data-index.js");
require("../public/dates.js");
function screen(index) {
  const status = { textContent: "" }, writes = [], calls = [];
  const context = { fileIndex: ["existing"], dataSchemaVersion: "old" };
  const { loadIndex } = createIndex({
    model: context, $: () => status,
    getJson: async (url) => {
      calls.push(url);
      return typeof index === "function" ? index() : index;
    },
    localStorage: { getItem: () => "old", setItem: (...args) => writes.push(args) },
    renderDataStatus() {}, defaultRange() {}, INDEX_STORAGE_KEY: "index"
  });
  return { context, status, writes, calls, load: () => loadIndex(true) };
}

const file = { path: "bid/2026/09.csv.gz", begin: "2026-09-01", end: "2026-09-30" };

test("손상된 공고 인덱스는 기존 목록·갱신 시각을 지우지 않는다", async () => {
  for (const index of [null, {}, { files: {} }, { files: [null] }, { files: [{ ...file, begin: "2026-02-30" }] }, { files: [{ ...file, path: "bid/../secret.csv.gz" }] }]) {
    const ui = screen(index);
    await assert.rejects(ui.load(), /목록 형식/);
    assert.equal(ui.context.fileIndex[0], "existing");
    assert.equal(ui.writes.length, 0);
  }
});
test("유효한 빈 인덱스는 정상적으로 이전 목록을 비운다", async () => {
  const ui = screen({ files: [], updatedAt: "new" });
  const result = await ui.load();
  assert.equal(ui.context.fileIndex.length, 0);
  assert.equal(result.changed, true);
});

test("중복 CSV 경로·경로와 다른 공고 모드·잘못된 건수는 적용하지 않는다", async () => {
  for (const files of [[file, { ...file }], [{ ...file, mode: "pre" }], [{ ...file, count: -1 }], [{ ...file, count: "10" }], [{ ...file, count: 1.5 }]]) {
    const ui = screen({ files });
    await assert.rejects(ui.load(), /목록 형식/);
    assert.equal(ui.context.fileIndex[0], "existing");
    assert.equal(ui.writes.length, 0);
  }
});

test("공고 목록 갱신은 ECR 저장 목록을 조회하거나 실패로 표시하지 않는다", async () => {
  const ui = screen({ files: [file] });
  await ui.load();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.calls[0], /\/index\.json/);
  assert.doesNotMatch(ui.status.textContent, /ECR/);
});

test("모드 생략 구형 항목과 정수 건수의 정상 항목은 허용한다", async () => {
  const ui = screen({ files: [{ ...file, count: 0 }, { path: "pre/2026/09/01.csv.gz", begin: "2026-09-01", end: "2026-09-01", mode: "pre", count: 10 }] });
  await ui.load();
  assert.equal(ui.context.fileIndex.length, 2);
});

test("응답 순서가 바뀌어도 최신 요청의 인덱스와 갱신 시각을 유지한다", async () => {
  const requests = [];
  const ui = screen(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
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
  const ui = screen(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const first = ui.load(), second = ui.load();
  requests[1].resolve({ files: [file] }); await second;
  requests[0].reject(new Error("old failure"));
  assert.equal((await first).stale, true);
  assert.equal(ui.context.fileIndex.length, 1);
});
