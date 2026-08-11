const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeCsv } = require("../shared/csv-record");
const {
  applyItems,
  clearJobRange,
  clearLegacySources,
  recordsForWrite,
  sourceEndpoint,
  serverTimingDuration,
  isRetryable,
} = require("./collector");

function storeOf(rows) {
  const store = { buckets: new Map(), location: new Map(), counts: new Map() };
  const changed = new Set();
  applyItems(store, rows, changed);
  return store;
}

test("CSV 행 순서는 Map 삽입 순서와 무관하게 공고 키로 고정된다", () => {
  const first = { bidNtceNo: "202608110003", bidNtceDt: "2026-08-11 03:00:00", bidNtceNm: "셋" };
  const second = { bidNtceNo: "202608110001", bidNtceDt: "2026-08-11 01:00:00", bidNtceNm: "하나" };
  const third = { bidNtceNo: "202608110002", bidNtceDt: "2026-08-11 02:00:00", bidNtceNm: "둘" };
  const a = storeOf([first, second, third]).buckets.get("bid|2026-08-11");
  const b = storeOf([third, first, second]).buckets.get("bid|2026-08-11");
  assert.equal(serializeCsv(recordsForWrite(a)), serializeCsv(recordsForWrite(b)));
  assert.deepEqual(recordsForWrite(a).map((row) => row.bidNtceNo), ["202608110001", "202608110002", "202608110003"]);
});

test("새 레코드는 ServiceKey가 없는 원천 endpoint 표식을 보존한다", () => {
  const job = { mode: "bid", type: "물품", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const store = storeOf([]), changed = new Set();
  applyItems(store, [{ bidNtceNo: "1", bidNtceDt: "2026-08-11" }], changed, job);
  const [record] = store.buckets.get("bid|2026-08-11").values();
  assert.equal(record.__sourceEndpoint, sourceEndpoint(job));
  assert.doesNotMatch(record.__sourceEndpoint, /ServiceKey|\?/);
  clearJobRange(store, job, changed);
  assert.equal(store.buckets.get("bid|2026-08-11").size, 0);
});

test("기존 사전공고의 세부 용역 구분은 용역 endpoint 재수집 때 제거된다", () => {
  const job = { mode: "pre", type: "용역", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const store = storeOf([{ bfSpecRgstNo: "1", rgstDt: "2026-08-11", bsnsDivNm: "기술용역" }]);
  clearJobRange(store, job, new Set());
  assert.equal(store.buckets.get("pre|2026-08-11").size, 0);
});

test("네 endpoint가 모두 성공한 범위에서만 무표식 본공고를 이관 정리한다", () => {
  const types = ["물품", "외자", "용역", "공사"];
  const range = { begin: "2026-08-11", end: "2026-08-11" };
  const entries = types.map((type) => ({ job: { mode: "bid", type, range }, id: type }));
  const incomplete = storeOf([{ bidNtceNo: "old", bidNtceDt: "2026-08-11" }]);
  assert.equal(clearLegacySources(incomplete, entries, new Set(types.slice(0, 3)), types, new Set()), 0);
  assert.equal(incomplete.location.size, 1);
  const complete = storeOf([{ bidNtceNo: "old", bidNtceDt: "2026-08-11" }]);
  assert.equal(clearLegacySources(complete, entries, new Set(types), types, new Set()), 1);
  assert.equal(complete.location.size, 0);
});

test("Server-Timing과 재시도 가능 상태를 분류한다", () => {
  assert.equal(serverTimingDuration("cache;desc=miss, upstream;dur=412.7", "upstream"), 412.7);
  assert.equal(serverTimingDuration("", "upstream"), null);
  assert.equal(isRetryable(new Error("server"), 503), true);
  assert.equal(isRetryable(new Error("rate"), 429), true);
  assert.equal(isRetryable(new Error("auth"), 401), false);
  assert.equal(isRetryable(new TypeError("fetch failed"), 0), true);
  assert.equal(isRetryable(new SyntaxError("truncated JSON"), 200), true);
});
