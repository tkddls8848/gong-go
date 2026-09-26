const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen(timeoutMs) {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = app.indexOf("async function startRefresh("), end = app.indexOf("function refreshUrl", start);
  const requests = [], statuses = [], button = { disabled: false }; let polls = 0;
  const context = vm.createContext({ AbortController, setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), clearTimeout, REFRESH_API: "/api/refresh",
    $: () => button, setRefresh: (busy, text) => { button.disabled = busy; statuses.push(text); },
    pollRefresh: () => polls++, fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject })),
    refreshRunId: null, refreshSince: null, refreshRange: null, refreshRevision: 0 });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/http.js"), "utf8"), context);
  vm.runInContext(app.slice(start, end), context);
  return { context, requests, statuses, button, polls: () => polls, start: () => context.startRefresh() };
}
test("갱신 시작 중 다른 진입점의 중복 요청을 차단한다", async () => {
  const ui = screen(), pending = ui.start();
  await ui.start();
  assert.equal(ui.requests.length, 1);
  ui.requests[0].resolve({ ok: true, json: async () => ({ runId: "test-run", dispatchedAt: "now" }) });
  await pending;
  assert.equal(ui.polls(), 1);
  assert.equal(ui.context.refreshRunId, "test-run");
});
test("갱신 시작 시간 초과는 자동 재전송 없이 컨트롤과 상태 확인 안내를 복구한다", async () => {
  const ui = screen(5); await ui.start();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].options.signal.aborted, true);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.polls(), 0);
  assert.match(ui.statuses.at(-1), /이미 시작됐을 수/);
  ui.requests[0].resolve({ ok: true, json: async () => ({ runId: "late" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.context.refreshRunId, null);
});
test("진행 중 응답 409는 기존 실행을 조회하고 서버 오류 설명은 보존한다", async () => {
  const ui = screen(), pending = ui.start();
  ui.requests[0].resolve({ ok: false, status: 409, json: async () => ({ runId: "existing" }) }); await pending;
  assert.equal(ui.polls(), 1);
  assert.equal(ui.context.refreshRunId, "existing");
  const failed = screen(), attempt = failed.start();
  failed.requests[0].resolve({ ok: false, status: 404, json: async () => ({ message: "워크플로 미등록" }) }); await attempt;
  assert.equal(failed.polls(), 0);
  assert.equal(failed.button.disabled, false);
  assert.equal(failed.statuses.at(-1), "워크플로 미등록");
});
