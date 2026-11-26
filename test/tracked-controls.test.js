const test = require("node:test");
const assert = require("node:assert/strict");
const { createTrackedUi } = require("../public/tracked-ui.js");
const { createTracked } = require("../public/tracked.js");
const { html } = require("../public/format.js");

function fixture(options = {}) {
  const nodes = new Map(), data = new Map();
  const $ = key => {
    if (!nodes.has(key)) nodes.set(key, { hidden: false, textContent: "", innerHTML: "", disabled: false,
      attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, querySelectorAll: () => [], addEventListener() {} });
    return nodes.get(key);
  };
  const storage = options.storage || { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const tracked = createTracked({ storage, html, fetchJson: options.fetchJson || (async path => body(new URL(path, "http://test").searchParams.get("bidNtceNo"))) });
  const model = { currentRow: null, filtered: [], viewMode: "bid" };
  const ui = createTrackedUi({ $, document: { querySelectorAll: () => [] }, tracked, model, html, modeSubtitles: { bid: "본공고" } });
  return { $, tracked, model, ui };
}
const row = no => ({ mode: "bid", announcementNumber: no, title: "사업", institution: "기관" });
const body = no => ({ stage: "bid", businessType: "물품", chainKey: null, notices: [{ bidNtceNo: no, state: "opened" }], current: { bidNtceNo: no, state: "opened", bidders: [] }, partial: "" });

test("조회 도중 새 저장은 기존 조회가 끝난 뒤 한 번 더 확인한다", async () => {
  let started, finish;
  const began = new Promise(resolve => { started = resolve; });
  const first = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const { ui, tracked, $ } = fixture({ fetchJson: async path => {
    const no = new URL(path, "http://test").searchParams.get("bidNtceNo"); calls.push(no);
    if (calls.length === 1) { started(); await first; }
    return body(no);
  } });
  const work = ui.toggle(row("FIRST"));
  await began;
  ui.toggle(row("SECOND"));
  finish(); await work;
  assert.deepEqual(calls, ["FIRST", "SECOND"]);
  assert.ok(tracked.items().every(item => item.result?.current.state === "opened"));
  assert.equal($("#tracked-refresh").disabled, false);
});

test("관심보기 중 검색 행 재렌더는 제목을 바꾸지 않고 복귀 시 현재 모드가 돌아온다", async () => {
  const { ui, $ } = fixture();
  await ui.show(); ui.syncRows([]);
  assert.equal($("#results-heading").textContent, "관심사업");
  assert.equal($(".table-scroll").hidden, true);
  ui.leave();
  assert.equal($("#results-heading").textContent, "조회 결과");
  assert.equal($("#app-subtitle").textContent, "본공고");
  assert.equal($(".table-scroll").hidden, false);
});

test("목록과 모달의 저장 실패는 보이는 상태 영역에 표시한다", async () => {
  const { ui, $, model, tracked } = fixture({ storage: { getItem: () => null, setItem() { throw Error("private storage detail"); } } });
  model.currentRow = row("FIRST");
  await ui.toggle(model.currentRow);
  assert.match($("#status").textContent, /저장하지 못했습니다/);
  assert.match($("#modal-track-status").textContent, /저장하지 못했습니다/);
  assert.doesNotMatch($("#status").textContent, /private/);
  assert.equal(tracked.count(), 0);
});

test("개별 조회 오류는 성공으로 알리지 않고 숨겨지지 않는다", async () => {
  const { ui, $, tracked } = fixture({ fetchJson: async () => { throw Object.assign(Error("private"), { code: "not_authorized" }); } });
  await ui.toggle(row("FIRST"));
  assert.match($("#status").textContent, /1건을 확인하지 못했습니다/);
  assert.equal(tracked.items()[0].error.code, "not_authorized");
  assert.doesNotMatch($("#status").textContent, /private/);
});

test("저장 버튼은 본공고·사전공고만 제공하고 모달 선택을 따라간다", async () => {
  const { ui, model, $ } = fixture();
  assert.equal(ui.rowButton({ mode: "plan" }, 0), "");
  assert.match(ui.rowButton({ ...row("FIRST"), title: "<img>" }, 0), /&lt;img&gt;/);
  assert.match(ui.rowButton({ ...row("FIRST"), mode: "pre" }, 0), /aria-pressed="false"/);
  model.currentRow = row("FIRST"); await ui.toggle(model.currentRow); ui.modalOpened();
  assert.equal($("#modal-track-btn").attributes["aria-pressed"], "true");
  model.currentRow = { mode: "plan" }; ui.modalOpened();
  assert.equal($("#modal-track-btn").hidden, true);
});
