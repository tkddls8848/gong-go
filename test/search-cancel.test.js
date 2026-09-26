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

test("취소된 검색은 실패 집계나 완료 결과를 보내지 않는다", async () => {
  const ui = worker(); ui.search(1); ui.cancel(1); await tick();
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.equal(ui.messages.length, 0);
});

test("과거 검색 취소 메시지는 새 검색을 취소하지 않는다", async () => {
  const ui = worker(); ui.search(1); ui.search(2); ui.cancel(1);
  assert.equal(ui.requests[1].signal.aborted, false);
  ui.requests[1].resolve("new"); await tick();
  assert.ok(ui.messages.some((message) => message.version === 2 && message.type === "done"));
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

test("큰 CSV 전달 도중 취소하면 다음 묶음과 완료 메시지를 보내지 않는다", async () => {
  const ui = worker(10001); ui.search(1); ui.requests[0].resolve("large");
  await ui.received;
  assert.equal(ui.messages[0].rows.length, 4000);
  ui.cancel(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ui.messages.length, 1);
});

test("동시 큰 파일·0건 매칭·조회 실패의 증분 집계를 정확히 합산한다", async () => {
  const ui = worker(10001); ui.search(1, 4);
  ui.requests[0].resolve("first");
  ui.requests[1].resolve("second");
  ui.requests[2].resolve("no-match");
  ui.requests[3].reject(new Error("503"));
  const batches = await completed(ui);
  assert.ok(batches.every((message) => message.rows.length <= 4000));
  const rows = batches.flatMap((message) => message.rows);
  assert.equal(rows.length, 20002);
  assert.equal(new Set(rows.map((row) => row.id)).size, 20002);
  assert.equal(rows.filter((row) => row.id.startsWith("first:")).length, 10001);
  assert.equal(rows.filter((row) => row.id.startsWith("second:")).length, 10001);
  assert.equal(batches.reduce((sum, message) => sum + message.scanned, 0), 30003);
  assert.equal(batches.reduce((sum, message) => sum + message.done, 0), 4);
  assert.equal(batches.reduce((sum, message) => sum + message.failures, 0), 1);
  assert.equal(ui.messages.filter((message) => message.type === "done").length, 1);
});

test("모든 파일이 실패해도 실패 수와 완료를 전송해 화면 대기를 종료한다", async () => {
  const ui = worker(); ui.search(1, 3);
  for (const request of ui.requests) request.reject(new Error("unavailable"));
  const batches = await completed(ui);
  assert.equal(batches.reduce((sum, message) => sum + message.failures, 0), 3);
  assert.equal(batches.reduce((sum, message) => sum + message.done, 0), 3);
  assert.equal(batches.reduce((sum, message) => sum + message.rows.length, 0), 0);
});

test("이전 큰 결과 전송 중 새 검색을 시작하면 이후에는 새 버전만 전달한다", async () => {
  const ui = worker(10001); ui.search(1, 2);
  ui.requests[0].resolve("old-a"); ui.requests[1].resolve("old-b");
  await ui.received;
  const before = ui.messages.length;
  ui.search(2); ui.requests[2].resolve("new");
  const batches = await completed(ui, 2);
  assert.ok(ui.messages.slice(before).every((message) => message.version === 2));
  assert.equal(batches.reduce((sum, message) => sum + message.rows.length, 0), 10001);
  assert.equal(ui.messages.filter((message) => message.version === 1 && message.type === "done").length, 0);
});
