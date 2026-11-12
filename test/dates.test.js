const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/dates.js");

test("최신 보강 조회는 한국시간 어제~오늘과 검색 범위의 교집합이다", () => {
  const { recentLiveSpan } = require("../public/search.js").createSearch({ GongDates, today: () => "2026-09-26" });
  const span = recentLiveSpan;
  assert.deepEqual(span("2026-09-01", "2026-09-30"), { begin: "2026-09-25", end: "2026-09-26" });
  assert.deepEqual(span("2026-09-26", "2026-09-26"), { begin: "2026-09-26", end: "2026-09-26" });
  assert.equal(span("2026-09-01", "2026-09-24"), null);
});
