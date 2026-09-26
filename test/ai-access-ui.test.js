// 실제 화면 핸들러를 응답 순서를 제어할 수 있는 DOM/통신 모형에서 실행한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen(timeoutMs) {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = app.indexOf("let ecrBusy = false, aiUnlocked = false;");
  const end = app.indexOf('$("#ecr-upload-form").onsubmit', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map(), requests = [];
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, value: "test-password", textContent: "", querySelectorAll: () => [$("#ai-password"), $("#submit")] });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, AbortController, clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/http.js"), "utf8"), context);
  vm.runInContext(app.slice(start, end), context);
  return { $, requests, refresh: () => context.refreshAiAccess(), show: (unlocked) => context.showAiAccess(unlocked),
    unlock: () => $("#ai-unlock-form").onsubmit({ preventDefault() {} }), lock: () => $("#ai-lock-btn").onclick(),
    unlocked: () => vm.runInContext("aiUnlocked", context) };
}
const response = (unlocked, ok = true) => ({ ok, json: async () => ({ unlocked, configured: true }) });

test("잠근 뒤 늦게 도착한 조회 응답은 분석 버튼을 다시 활성화하지 않는다", async () => {
  const ui = screen();
  const refresh = ui.refresh();
  ui.show(true);
  const lock = ui.lock();
  assert.equal(ui.unlocked(), false);
  ui.requests[1].resolve(response(false)); await lock;
  ui.requests[0].resolve(response(true)); await refresh;
  assert.equal(ui.unlocked(), false);
  assert.equal(ui.$("#ecr-analyze-btn").disabled, true);
});

test("오래된 조회 실패가 새 잠금 해제 성공을 덮어쓰지 않는다", async () => {
  const ui = screen();
  const refresh = ui.refresh();
  const unlock = ui.unlock();
  ui.requests[1].resolve(response(true)); await unlock;
  ui.requests[0].reject(new Error("offline")); await refresh;
  assert.equal(ui.unlocked(), true);
  assert.equal(ui.$("#ecr-analyze-btn").disabled, false);
});

test("잠금 변경 중 중복 제출·조회·반대 변경은 새 요청을 보내지 않는다", async () => {
  const ui = screen();
  const unlock = ui.unlock();
  assert.equal(ui.$("#ai-password").disabled, true);
  assert.equal(ui.$("#ai-password").value, "");
  await ui.unlock(); await ui.refresh(); await ui.lock();
  assert.equal(ui.requests.length, 1);
  ui.requests[0].resolve(response(true)); await unlock;
  assert.equal(ui.$("#ai-password").disabled, false);
  assert.equal(ui.unlocked(), true);
});

test("잠금 변경 실패는 추가 분석을 막고 입력 컨트롤을 복구한다", async () => {
  const ui = screen(); ui.show(true);
  const lock = ui.lock();
  ui.requests[0].resolve(response(false, false)); await lock;
  assert.equal(ui.unlocked(), false);
  assert.equal(ui.$("#ecr-analyze-btn").disabled, true);
  assert.equal(ui.$("#ai-password").disabled, false);
  assert.match(ui.$("#ai-access-status").textContent, /실패/);
  assert.equal(ui.$("#ai-lock-btn").hidden, false);
  assert.equal(ui.$("#ai-lock-btn").textContent, "서버 잠금 다시 시도");
});

test("겹친 조회는 마지막으로 시작한 조회 결과만 반영한다", async () => {
  const ui = screen();
  const first = ui.refresh(), second = ui.refresh();
  ui.requests[1].resolve(response(false)); await second;
  ui.requests[0].resolve(response(true)); await first;
  assert.equal(ui.unlocked(), false);
});

test("잠금 해제 시간 초과는 컨트롤을 복구하고 늦은 성공을 무시한다", async () => {
  const ui = screen(5);
  await ui.unlock();
  assert.equal(ui.unlocked(), false);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].options.signal.aborted, true);
  assert.equal(ui.$("#ai-password").disabled, false);
  assert.equal(ui.$("#ai-lock-btn").hidden, false);
  assert.match(ui.$("#ai-access-status").textContent, /확인하지 못했/);
  ui.requests[0].resolve(response(true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.unlocked(), false);
  const lock = ui.lock();
  ui.requests[1].resolve(response(false)); await lock;
  assert.equal(ui.$("#ai-lock-btn").hidden, true);
});

test("서버 잠금 본문 수신 지연도 성공으로 표시하지 않고 재시도를 제공한다", async () => {
  const ui = screen(5); ui.show(true);
  const lock = ui.lock();
  ui.requests[0].resolve({ ok: true, json: () => new Promise(() => {}) });
  await lock;
  assert.equal(ui.unlocked(), false);
  assert.equal(ui.$("#ai-lock-btn").hidden, false);
  assert.equal(ui.$("#ai-lock-btn").disabled, false);
  assert.match(ui.$("#ai-access-status").textContent, /실패/);
  assert.equal(ui.requests.length, 1);
});

test("서버 잠금은 명시적인 unlocked false 응답에서만 성공 처리한다", async () => {
  for (const data of [{}, { unlocked: true }, { unlocked: "false" }, null]) {
    const ui = screen(); ui.show(true);
    const lock = ui.lock();
    ui.requests[0].resolve({ ok: true, json: async () => data }); await lock;
    assert.equal(ui.unlocked(), false);
    assert.equal(ui.$("#ai-lock-btn").hidden, false);
    assert.match(ui.$("#ai-access-status").textContent, /실패/);
  }
});
