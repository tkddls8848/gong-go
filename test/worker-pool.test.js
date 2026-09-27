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

test("첫 Worker 생성 실패도 빈 풀로 대체한다", () => {
  const ui = pool(1);
  assert.equal(ui.get().length, 0);
  assert.equal(ui.workers.length, 0);
});

test("정상 Worker 풀은 검색마다 다시 생성하지 않고 재사용한다", () => {
  const ui = pool();
  const first = ui.get();
  assert.equal(first.length, 3);
  assert.equal(ui.get(), first);
  assert.equal(ui.calls(), 3);
  assert.ok(ui.workers.every((worker) => !worker.terminated && worker.url === "https://local.test/search-worker.js"));
});
