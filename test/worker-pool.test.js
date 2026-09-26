const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function pool(failAt) {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = app.indexOf("let workerPool = null"), end = app.indexOf("function scanFiles", start);
  assert.ok(start >= 0 && end > start);
  const workers = []; let calls = 0;
  class Worker {
    constructor(url) {
      calls++;
      if (calls === failAt) throw new Error("Worker unavailable");
      this.url = String(url); this.terminated = false; workers.push(this);
    }
    terminate() { this.terminated = true; }
  }
  const context = vm.createContext({ URL, location: { href: "https://local.test/" }, POOL_SIZE: 3, Worker });
  vm.runInContext(app.slice(start, end), context);
  return { get: () => context.pool(), workers, calls: () => calls };
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
