const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("여러 Worker의 큰 결과 묶음을 합쳐도 저장 결과 표시 한도를 넘지 않는다", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = source.indexOf("function scanFiles("), end = source.indexOf("async function scanInline", start);
  assert.ok(start >= 0 && end > start);
  const sent = [], progress = [];
  const workers = [0, 1].map((slot) => ({ postMessage: (message) => sent.push({ slot, message }) }));
  const context = vm.createContext({ pool: () => workers, FETCH_CONCURRENCY: 2, MAX_ROWS: 3, DATA_BASE: "/data", dataSchemaVersion: "", abortScan() {} });
  vm.runInContext(source.slice(start, end), context);
  const pending = context.scanFiles([{}, {}], {}, {}, 1, (state) => progress.push(state.rows.length));
  workers[0].onmessage({ data: { type: "rows", version: 1, rows: [{ id: 1 }, { id: 2 }], done: 1, scanned: 2, failures: 0 } });
  workers[1].onmessage({ data: { type: "rows", version: 1, rows: [{ id: 3 }, { id: 4 }, { id: 5 }], done: 1, scanned: 3, failures: 0 } });
  const state = await pending;
  assert.equal(state.rows.length, 3);
  assert.equal(state.scanned, 5);
  assert.equal(state.capped, true);
  assert.ok(progress.every((length) => length <= 3));
  assert.equal(sent.filter(({ message }) => message.type === "cancel").length, 2);
});
