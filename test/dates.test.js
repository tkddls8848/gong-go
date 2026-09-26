const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
require("../public/dates.js");

test("한국시간 자정은 UTC 15시이며 연도 경계도 반영한다", () => {
  assert.equal(GongDates.kstDate("2026-09-25T14:59:59Z"), "2026-09-25");
  assert.equal(GongDates.kstDate("2026-09-25T15:00:00Z"), "2026-09-26");
  assert.equal(GongDates.kstDate("2026-12-31T15:00:00Z"), "2027-01-01");
});
test("날짜 이동은 윤년·월 경계를 보존하고 잘못된 날짜를 거부한다", () => {
  assert.equal(GongDates.shiftDay("2024-03-01", -1), "2024-02-29");
  assert.equal(GongDates.shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(GongDates.shiftDay("2026-01-01", -6), "2025-12-26");
  for (const value of ["2026-02-30", "invalid", "2026-13-01"]) assert.throws(() => GongDates.shiftDay(value, -1));
});
test("최신 보강 조회는 한국시간 어제~오늘과 검색 범위의 교집합이다", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = app.indexOf("function recentLiveSpan(");
  const end = app.indexOf("\nfunction liveItems", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ GongDates, today: () => "2026-09-26" });
  vm.runInContext(app.slice(start, end), context);
  const span = (begin, end) => JSON.parse(JSON.stringify(context.recentLiveSpan(begin, end)));
  assert.deepEqual(span("2026-09-01", "2026-09-30"), { begin: "2026-09-25", end: "2026-09-26" });
  assert.deepEqual(span("2026-09-26", "2026-09-26"), { begin: "2026-09-26", end: "2026-09-26" });
  assert.equal(span("2026-09-01", "2026-09-24"), null);
});
