const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function screen() {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = source.indexOf("async function finishRefresh("), end = source.indexOf("function pollDelay", start);
  const requests = [], statuses = [], searches = [], input = { value: "2026-09-01" };
  const context = vm.createContext({ refreshRevision: 1, refreshRunId: "old", refreshRange: null, refreshSince: null,
    fileIndex: [], totalCount: () => 1, dataRange: () => ({ end: "2026-09-10" }),
    loadIndex: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    setRefresh: (...args) => statuses.push(args), $: () => input, format: String, page: 2,
    applyFilters: (options) => searches.push(options) });
  vm.runInContext(source.slice(start, end), context);
  return { context, requests, statuses, searches, input, finish: () => context.finishRefresh({}) };
}

test("이전 갱신의 목록 재조회 성공·실패는 새 실행 UI를 덮어쓰지 않는다", async () => {
  for (const failed of [false, true]) {
    const ui = screen(), pending = ui.finish();
    ui.context.refreshRevision++; ui.context.refreshRunId = "new";
    if (failed) ui.requests[0].reject(new Error("old error"));
    else ui.requests[0].resolve({ changed: true });
    await pending;
    assert.equal(ui.statuses.length, 0);
    assert.equal(ui.searches.length, 0);
    assert.equal(ui.context.refreshRunId, "new");
    assert.equal(ui.input.value, "2026-09-01");
  }
});
test("대체된 목록 조회는 갱신 완료 건수나 자동 검색으로 적용하지 않는다", async () => {
  const ui = screen(), pending = ui.finish();
  ui.requests[0].resolve({ stale: true }); await pending;
  assert.equal(ui.searches.length, 0);
  assert.match(ui.statuses[0][1], /적용하지 않았습니다/);
});
test("현재 갱신 완료는 정상적으로 최신 날짜와 검색을 갱신한다", async () => {
  const ui = screen(), pending = ui.finish();
  ui.requests[0].resolve({ changed: true }); await pending;
  assert.equal(ui.input.value, "2026-09-10");
  assert.equal(ui.searches.length, 1);
  assert.equal(ui.searches[0].revalidateRecent, true);
  assert.match(ui.statuses[0][1], /갱신 완료/);
});
