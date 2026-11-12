const test = require("node:test");
const assert = require("node:assert/strict");

const { createAiAccess } = require("../public/ai-access.js");
const { createHttp } = require("../public/http.js");
function screen(timeoutMs) {
  const nodes = new Map(), requests = [], state = { ecrBusy: false, aiUnlocked: false };
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, value: "test-password", textContent: "", querySelectorAll: () => [$("#ai-password"), $("#submit")] });
    return nodes.get(id);
  };
  const GongHttp = createHttp({
    setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms),
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  });
  const access = createAiAccess({ $, state, GongHttp });
  return { $, requests, refresh: access.refreshAiAccess, show: access.showAiAccess,
    unlock: () => access.unlockAiAccess({ preventDefault() {} }), lock: access.lockAiAccess,
    unlocked: () => state.aiUnlocked };
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
