import test from "node:test";
import assert from "node:assert/strict";
import { ymd, split, kstToday, lastDay, monthBounds, shift, weekOffset, validDate, recentMonth } from "./kst-date.js";

test("kstToday는 UTC 15:00에 KST 다음 날로 넘어간다", () => {
  assert.equal(kstToday(Date.parse("2026-08-12T14:59:59Z")), "2026-08-12");
  assert.equal(kstToday(Date.parse("2026-08-12T15:00:00Z")), "2026-08-13");
});

test("ymd와 split은 서로 되돌린다", () => {
  assert.equal(ymd(2026, 3, 7), "2026-03-07");
  assert.deepEqual(split("2026-03-07"), { year: 2026, month: 3, day: 7 });
});

test("shift는 월·연 경계를 넘는다", () => {
  assert.equal(shift("2026-03-01", -1), "2026-02-28");
  assert.equal(shift("2024-03-01", -1), "2024-02-29");
  assert.equal(shift("2026-12-31", 1), "2027-01-01");
});

test("weekOffset은 월요일 0, 일요일 6이다", () => {
  assert.equal(weekOffset("2026-08-10"), 0); // 월
  assert.equal(weekOffset("2026-08-16"), 6); // 일
});

test("말일·월 구간·달력 검증·최근 달", () => {
  assert.equal(lastDay(2024, 2), 29);
  assert.deepEqual(monthBounds(2026, 4), { begin: "2026-04-01", end: "2026-04-30" });
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(recentMonth("2026-08-13", 9), 2025);
  assert.equal(recentMonth("2026-08-13", 8), 2026);
});
