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

test("중복 CSV 경로·경로와 다른 공고 모드·잘못된 건수는 적용하지 않는다", async () => {
  for (const files of [[file, { ...file }], [{ ...file, mode: "pre" }], [{ ...file, count: -1 }], [{ ...file, count: "10" }], [{ ...file, count: 1.5 }]]) {
    const ui = screen({ files });
    await assert.rejects(ui.load(), /목록 형식/);
    assert.equal(ui.context.fileIndex[0], "existing");
    assert.equal(ui.writes.length, 0);
  }
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

