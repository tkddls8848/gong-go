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
