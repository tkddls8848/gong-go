const test = require("node:test");
const assert = require("node:assert/strict");

test("여러 Worker의 큰 결과 묶음을 합쳐도 저장 결과 표시 한도를 넘지 않는다", async () => {
  const sent = [], progress = [];
  const workers = [0, 1].map((slot) => ({ postMessage: (message) => sent.push({ slot, message }) }));
  let next = 0;
  const scanner = require("../public/search-scan.js").createScanner({
    model: { dataSchemaVersion: "" }, POOL_SIZE: 2, workerUrl: "",
    createWorker: () => workers[next++], FETCH_CONCURRENCY: 2, MAX_ROWS: 3
  });
  const pending = scanner.scanFiles([{}, {}], {}, {}, 1, (state) => progress.push(state.rows.length));
  workers[0].onmessage({ data: { type: "rows", version: 1, rows: [{ id: 1 }, { id: 2 }], done: 1, scanned: 2, failures: 0 } });
  workers[1].onmessage({ data: { type: "rows", version: 1, rows: [{ id: 3 }, { id: 4 }, { id: 5 }], done: 1, scanned: 3, failures: 0 } });
  const state = await pending;
  assert.equal(state.rows.length, 3);
  assert.equal(state.scanned, 5);
  assert.equal(state.capped, true);
  assert.ok(progress.every((length) => length <= 3));
  assert.equal(sent.filter(({ message }) => message.type === "cancel").length, 2);
});
