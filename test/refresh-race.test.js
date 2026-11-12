const test = require("node:test");
const assert = require("node:assert/strict");
const { refreshScreen } = require("./helpers/refresh.js");
function screen() {
  const requests = [], finished = [];
  let received;
  const ui = refreshScreen({
    getJson: () => new Promise((resolve, reject) => requests.push({ reject, resolve(value) { received = value; resolve(value); } })),
    applyFilters: () => finished.push(received),
  });
  return { ...ui, requests, finished, statuses: ui.texts };
}

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

