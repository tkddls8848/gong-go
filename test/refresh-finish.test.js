const test = require("node:test");
const assert = require("node:assert/strict");
const { refreshScreen } = require("./helpers/refresh.js");
function screen() {
  const requests = [], searches = [];
  const ui = refreshScreen({
    initial: { refreshRevision: 1, refreshRunId: "old" },
    loadIndex: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    applyFilters: (options) => searches.push(options),
  });
  return { ...ui, requests, searches, finish: () => ui.controller.finishRefresh({}) };
}

test("현재 갱신 완료는 정상적으로 최신 날짜와 검색을 갱신한다", async () => {
  const ui = screen(), pending = ui.finish();
  ui.requests[0].resolve({ changed: true }); await pending;
  assert.equal(ui.input.value, "2026-09-10");
  assert.equal(ui.searches.length, 1);
  assert.equal(ui.searches[0].revalidateRecent, true);
  assert.match(ui.statuses[0][1], /갱신 완료/);
});
