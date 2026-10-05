const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/rows.js");
require("../public/dates.js");
const { createHttp } = require("../public/http.js");
const { createSearch } = require("../public/search.js");

const TODAY = "2026-10-05";
function screen(requestJson) {
  const fields = { "#begin": { value: TODAY }, "#end": { value: TODAY }, "#q": { value: "" }, "#business-type": { value: "물품" }, "#inst-loose": { checked: false }, "#status": { textContent: "" } };
  const model = { searchVersion: 0, viewMode: "bid", fileIndex: [] };
  const search = createSearch({
    model, $: (selector) => fields[selector], renderRows() {}, collectInstitutions: () => [], todayFile: () => true,
    MODE_NAMES: { bid: "본공고" }, format: String, numberOf: (row) => row.announcementNumber || "",
    scanner: { cancel() {}, scanFiles: async () => ({ rows: [], scanned: 0, failures: 0 }) },
    today: () => TODAY, requestJson
  });
  return { search, status: () => fields["#status"].textContent };
}
async function settled(ui, pattern) {
  const deadline = Date.now() + 2000;
  while (!pattern.test(ui.status()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(ui.status(), pattern);
}

test("최신 공고 조회는 공용 요청 함수를 30초 제한과 검색 안내로 부른다", async () => {
  const calls = [];
  const ui = screen(async (url, options, timeoutMs, purpose) => {
    calls.push({ url, options, timeoutMs, purpose });
    return { response: { ok: true, status: 200 }, data: { response: { body: { items: [], totalCount: 0, numOfRows: 100 } } } };
  });
  await ui.search.applyFilters();
  await settled(ui, /최신 정보 확인 완료/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/api\/live\?/);
  assert.equal(calls[0].timeoutMs, 30000);
  assert.equal(calls[0].purpose, "search");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("상류가 응답하지 않으면 30초 제한으로 실패를 표시하고 저장 결과는 유지한다", async () => {
  const delays = [];
  const { requestJson } = createHttp({
    fetch: () => new Promise(() => {}),
    setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
    clearTimeout
  });
  const ui = screen(requestJson);
  await ui.search.applyFilters();
  await settled(ui, /최신 정보 일부만 반영 .*실패 1페이지 \(응답 대기 시간이 초과/);
  assert.deepEqual(delays, [30000]);
  assert.match(ui.status(), /^0개 CSV에서 0건을 읽어/, "저장 결과 안내가 사라졌다");
});

test("새 조회가 진행 중인 최신 조회를 취소하면 실패로 집계하지 않는다", async () => {
  const signals = [];
  const { requestJson } = createHttp({
    fetch: (_url, options) => new Promise((_, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    setTimeout: () => 0, clearTimeout() {}
  });
  const ui = screen(requestJson);
  await ui.search.applyFilters();
  await ui.search.applyFilters();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, "이전 최신 조회 요청이 취소되지 않았다");
  assert.equal(signals[1].aborted, false);
  assert.doesNotMatch(ui.status(), /실패/);
  await ui.search.applyFilters();
  assert.equal(signals[1].aborted, true);
});
