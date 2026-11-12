const test = require("node:test");
const assert = require("node:assert/strict");
const { refreshScreen } = require("./helpers/refresh.js");
function screen(timeoutMs) {
  let polls = 0;
  const ui = refreshScreen({ timeoutMs, getJson: () => { polls++; return new Promise(() => {}); } });
  return { ...ui, statuses: ui.texts, polls: () => polls, start: ui.controller.startRefresh };
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
