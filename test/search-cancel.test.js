const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function worker(matchedCount = 1) {
  const requests = [], messages = [];
  let firstMessage;
  const received = new Promise((resolve) => { firstMessage = resolve; });
  const self = { postMessage: (message) => { messages.push(message); firstMessage(message); }, GongRows: {
    makeCriteria: (value) => value,
    fetchCsvText: (_url, options) => new Promise((resolve, reject) => {
      requests.push({ resolve, reject, signal: options.signal });
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    scanText: (text) => ({ scanned: matchedCount, matched: Array.from({ length: text === "no-match" ? 0 : matchedCount }, (_, id) => ({ id: `${text}:${id}`, title: "result" })) }),
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/search-worker.js"), "utf8"), { self, importScripts() {}, AbortController, setTimeout });
  const search = (version, count = 1) => self.onmessage({ data: { type: "search", version, base: "/data", files: Array.from({ length: count }, () => ({ path: "test.gz", begin: "2026-09-01", end: "2026-09-01" })), criteria: {}, span: { begin: "2026-09-01", end: "2026-09-01" }, concurrency: count } });
  return { requests, messages, received, search, cancel: (version) => self.onmessage({ data: { type: "cancel", version } }) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function completed(ui, version = 1) {
  const deadline = Date.now() + 2000;
  while (!ui.messages.some((message) => message.type === "done" && message.version === version) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ui.messages.some((message) => message.type === "done" && message.version === version));
  return ui.messages.filter((message) => message.type === "rows" && message.version === version);
}

test("새 검색은 이전 검색의 모든 동시 다운로드를 취소한다", async () => {
  const ui = worker(); ui.search(1, 2); ui.search(2);
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.equal(ui.requests[1].signal.aborted, true);
  assert.equal(ui.requests[2].signal.aborted, false);
  ui.requests[2].resolve("new"); await tick();
  assert.ok(ui.messages.length > 0);
  assert.ok(ui.messages.every((message) => message.version === 2));
  assert.equal(ui.messages.find((message) => message.type === "rows").failures, 0);
});

test("큰 CSV는 4000행 이하의 묶음으로 누락·중복 없이 전달한다", async () => {
  const ui = worker(10001); ui.search(1); ui.requests[0].resolve("large");
  const batches = await completed(ui);
  assert.ok(batches.every((message) => message.rows.length <= 4000));
  const rows = batches.flatMap((message) => message.rows);
  assert.equal(rows.length, 10001);
  assert.equal(new Set(rows.map((row) => row.id)).size, 10001);
  assert.equal(batches.reduce((sum, message) => sum + message.scanned, 0), 10001);
  assert.equal(batches.reduce((sum, message) => sum + message.done, 0), 1);
});

test("모든 파일이 실패해도 실패 수와 완료를 전송해 화면 대기를 종료한다", async () => {
  const ui = worker(); ui.search(1, 3);
  for (const request of ui.requests) request.reject(new Error("unavailable"));
  const batches = await completed(ui);
  assert.equal(batches.reduce((sum, message) => sum + message.failures, 0), 3);
  assert.equal(batches.reduce((sum, message) => sum + message.done, 0), 3);
  assert.equal(batches.reduce((sum, message) => sum + message.rows.length, 0), 0);
});

