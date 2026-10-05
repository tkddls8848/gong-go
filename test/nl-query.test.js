const test = require("node:test");
const assert = require("node:assert/strict");

const { createNlQuery } = require("../public/nl-query.js");
const { createHttp } = require("../public/http.js");
require("../public/dates.js");
function screen(timeoutMs) {
  const nodes = new Map(), requests = [], applied = [], statuses = [];
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { value: "", checked: false }); return nodes.get(id); };
  $("#nl-query").value = "서버 공고";
  const context = { searchVersion: 0, viewMode: "pre", page: 1 };
  const GongHttp = createHttp({
    setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms),
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
  });
  const { runNlQuery } = createNlQuery({
    model: context, $, GongHttp, collectInstitutions: () => [],
    setNl: (...args) => statuses.push(args), applyNlFilter: (state) => applied.push(state),
    applyFilters: () => { context.searchVersion++; }, resetPage: () => { context.page = 1; }
  });
  return { $, context, requests, applied, statuses, run: runNlQuery };
}

const response = { ok: true, json: async () => ({ filter: { q: "서버" } }) };
test("자연어 검색 Enter 반복은 하나의 요청만 전송한다", async () => {
  const ui = screen(), pending = ui.run();
  await ui.run();
  assert.equal(ui.requests.length, 1);
  ui.requests[0].resolve(response); await pending;
  assert.equal(ui.applied.length, 1);
  const next = ui.run();
  assert.equal(ui.requests.length, 2);
  ui.requests[1].resolve(response); await next;
});
for (const change of ["query", "filter", "mode", "search"]) {
  test(`자연어 검색 대기 중 ${change} 변경은 이전 결과 적용을 막는다`, async () => {
    const ui = screen(), pending = ui.run();
    if (change === "query") ui.$("#nl-query").value = "새 질의";
    if (change === "filter") ui.$("#q").value = "스토리지";
    if (change === "mode") ui.context.viewMode = "bid";
    if (change === "search") ui.context.searchVersion++;
    ui.requests[0].resolve(response); await pending;
    assert.equal(ui.applied.length, 0);
    assert.equal(ui.statuses.at(-1)[0], false);
  });
}
test("오래된 실패 응답을 현재 검색의 오류로 표시하지 않는다", async () => {
  const ui = screen(), pending = ui.run();
  ui.context.searchVersion++;
  ui.requests[0].reject(new Error("old error")); await pending;
  assert.equal(ui.applied.length, 0);
  assert.doesNotMatch(ui.statuses.at(-1)[1], /old error/);
  const next = ui.run();
  ui.requests[1].resolve(response); await next;
  assert.equal(ui.applied.length, 1);
});

test("시간 초과 후 검색 잠금을 풀고 늦은 성공 응답은 무시한다", async () => {
  const ui = screen(5);
  await ui.run();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.statuses.at(-1)[0], false);
  assert.match(ui.statuses.at(-1)[1], /대기 시간이 초과/);
  assert.doesNotMatch(ui.statuses.at(-1)[1], /같은 파일/);
  ui.requests[0].resolve(response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.applied.length, 0);
  const retry = ui.run();
  ui.requests[1].resolve(response); await retry;
  assert.equal(ui.applied.length, 1);
});

test("손상된 검색 응답으로 기존 조건을 초기화하지 않는다", async () => {
  for (const data of [null, {}, { filter: [] }, { filter: {}, notes: {} }, { filter: { institutions: "기관" } }]) {
    const ui = screen(), pending = ui.run();
    ui.requests[0].resolve({ ok: true, json: async () => data }); await pending;
    assert.equal(ui.applied.length, 0);
    assert.equal(ui.statuses.at(-1)[0], false);
    assert.match(ui.statuses.at(-1)[1], /형식/);
  }
});

test("검색 조건의 잘못된 날짜·열거값·자료형은 모두 적용 전에 거부한다", async () => {
  const filters = [
    { begin: "2026-02-30", end: "2026-03-01" },
    { begin: "2026-03-02", end: "2026-03-01" },
    { begin: "2026-03-01" }, { end: "2026-03-01" },
    { begin: 20260301, end: 20260302 }, { begin: null, end: null },
    { mode: "unknown" }, { mode: "toString" }, { type: "서버" },
    { q: {} }, { looseInstitution: "false" }, { institutions: [null] },
  ];
  for (const filter of filters) {
    const ui = screen(), pending = ui.run();
    ui.requests[0].resolve({ ok: true, json: async () => ({ filter }) }); await pending;
    assert.equal(ui.applied.length, 0, JSON.stringify(filter));
    assert.match(ui.statuses.at(-1)[1], /형식/);
  }
});

test("유효한 윤년 날짜와 기간 미지정 검색은 허용한다", async () => {
  for (const filter of [
    { mode: "bid", type: "물품", q: "서버", begin: "2024-02-29", end: "2024-03-01", institutions: ["조달청"], looseInstitution: true },
    { mode: "pre", type: "", q: "", begin: "", end: "", institutions: [], looseInstitution: false },
  ]) {
    const ui = screen(), pending = ui.run();
    ui.requests[0].resolve({ ok: true, json: async () => ({ filter, notes: [], explain: "조회 조건" }) }); await pending;
    assert.equal(ui.applied.length, 1);
  }
});
