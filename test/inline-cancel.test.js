const test = require("node:test");
const assert = require("node:assert/strict");

const { createScanner } = require("../public/search-scan.js");
function screen(maxRows = 100, matchedCount = 1) {
  const requests = [], progress = [], context = { searchVersion: 1, dataSchemaVersion: "" };
  const scanner = createScanner({
    model: context, POOL_SIZE: 0, workerUrl: "", FETCH_CONCURRENCY: 2, MAX_ROWS: maxRows,
    modeOf: () => "bid", Rows: { makeCriteria: (value) => value,
      fetchCsvText: (_url, options) => new Promise((resolve, reject) => {
        requests.push({ resolve, reject, signal: options.signal });
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }), scanText: () => ({ scanned: matchedCount, matched: Array.from({ length: matchedCount }, () => ({ title: "result" })) }) }
  });
  context.abortScan = scanner.cancel;
  return { context, requests, progress, scan: (count = 2) => scanner.scanInline(
    Array.from({ length: count }, () => ({ path: "file.gz", begin: "2026-09-01", end: "2026-09-01" })),
    {}, { begin: "2026-09-01", end: "2026-09-01" }, context.searchVersion, (state) => progress.push(state)) };
}

test("대체 검색 취소는 동시 다운로드를 중단하고 실패로 집계하지 않는다", async () => {
  const ui = screen(), pending = ui.scan();
  ui.context.abortScan();
  const state = await pending;
  assert.ok(ui.requests.every((request) => request.signal.aborted));
  assert.equal(state.rows.length, 0);
  assert.equal(state.failures, 0);
  assert.equal(ui.progress.length, 0);
});

test("이전 검색 종료가 새 검색의 취소 제어를 지우지 않는다", async () => {
  const ui = screen(), first = ui.scan(1);
  ui.context.abortScan(); ui.context.searchVersion++;
  const second = ui.scan(1);
  await first;
  ui.context.abortScan(); await second;
  assert.equal(ui.requests[1].signal.aborted, true);
});

test("표시 한도 도달 시 대체 경로의 나머지 다운로드를 취소한다", async () => {
  const ui = screen(1), pending = ui.scan();
  ui.requests[0].resolve("csv");
  const state = await pending;
  assert.equal(state.capped, true);
  assert.equal(state.rows.length, 1);
  assert.equal(state.failures, 0);
  assert.equal(ui.requests[1].signal.aborted, true);
});

test("한 CSV 결과가 표시 한도를 넘어도 대체 경로 누적 결과는 한도를 지킨다", async () => {
  const ui = screen(2, 10), pending = ui.scan(1);
  ui.requests[0].resolve("csv");
  const state = await pending;
  assert.equal(state.rows.length, 2);
  assert.equal(state.scanned, 10);
  assert.equal(state.capped, true);
});
