const test = require("node:test");
const assert = require("node:assert/strict");

const { createScanner } = require("../public/search-scan.js");
function pool(failAt) {
  const workers = []; let calls = 0;
  const scanner = createScanner({
    model: {}, POOL_SIZE: 3, workerUrl: new URL("https://local.test/search-worker.js"),
    createWorker(url) {
      calls++;
      if (calls === failAt) throw new Error("Worker unavailable");
      const worker = { url: String(url), terminated: false, terminate() { this.terminated = true; } };
      workers.push(worker);
      return worker;
    }
  });
  return { get: scanner.pool, workers, calls: () => calls };
}

test("Worker 일부 생성 후 실패하면 생성된 Worker를 모두 정리한다", () => {
  const ui = pool(3);
  assert.equal(ui.get().length, 0);
  assert.equal(ui.workers.length, 2);
  assert.ok(ui.workers.every((worker) => worker.terminated));
  ui.get();
  assert.equal(ui.calls(), 3, "failed pool should remain on inline fallback without repeated creation");
});

