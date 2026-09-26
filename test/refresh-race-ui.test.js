const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = source.indexOf("function refreshUrl("), end = source.indexOf("async function finishRefresh", start);
  const requests = [], statuses = [], finished = [], button = { disabled: false };
  const context = vm.createContext({ refreshRevision: 0, refreshRunId: null, refreshSince: null, refreshRange: null, REFRESH_API: "/api/refresh", REFRESH_WAIT_LIMIT_MS: 10000,
    $: () => button, getJson: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    setRefresh: (busy, text) => { button.disabled = busy; statuses.push(text); }, refreshText: () => "running", finishRefresh: (state) => finished.push(state), setTimeout, pollDelay: () => 1 });
  vm.runInContext(source.slice(start, end), context);
  return { context, requests, statuses, finished, button };
}
test("지연된 초기 상태 복구는 새 갱신 실행을 덮어쓰지 않는다", async () => {
  const ui = screen(), pending = ui.context.resumeRefresh();
  ui.context.refreshRevision++; ui.context.refreshRunId = "new"; ui.button.disabled = true;
  ui.requests[0].resolve({ running: true, runId: "old" }); await pending;
  assert.equal(ui.context.refreshRunId, "new");
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.statuses.length, 0);
});
test("이전 폴링의 완료·실패는 새 실행 UI를 변경하지 않는다", async () => {
  for (const failure of [false, true]) {
    const ui = screen(), pending = ui.context.pollRefresh();
    ui.context.refreshRevision++; ui.context.refreshRunId = "new";
    if (failure) ui.requests[0].reject(new Error("old failure"));
    else ui.requests[0].resolve({ running: false, runId: "old" });
    await pending;
    assert.equal(ui.finished.length, 0);
    assert.equal(ui.statuses.length, 0);
    assert.equal(ui.context.refreshRunId, "new");
  }
});

test("손상된 갱신 상태는 완료로 처리하지 않고 오류 안내 후 종료한다", async () => {
  for (const state of [{}, { running: "false" }, { running: false, waiting: true }, { running: true, runId: {} }, { running: true, waiting: "true" }]) {
    const ui = screen(), pending = ui.context.pollRefresh();
    ui.requests[0].resolve(state); await pending;
    assert.equal(ui.finished.length, 0);
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.button.disabled, false);
    assert.match(ui.statuses.at(-1), /완료 여부를 확인할 수 없습니다/);
  }
});

test("정상 완료 응답은 실행 번호를 보존하며 완료 처리한다", async () => {
  for (const runId of [12345, "local-run"]) {
    const ui = screen(), pending = ui.context.pollRefresh();
    ui.requests[0].resolve({ running: false, runId }); await pending;
    assert.equal(ui.finished.length, 1);
    assert.equal(ui.finished[0].runId, runId);
    assert.equal(ui.context.refreshRunId, String(runId));
  }
});
