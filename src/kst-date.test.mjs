import test from "node:test";
import assert from "node:assert/strict";
import { kstToday, shift } from "./kst-date.js";

test("kstToday는 UTC 15:00에 KST 다음 날로 넘어간다", () => {
  assert.equal(kstToday(Date.parse("2026-08-12T14:59:59Z")), "2026-08-12");
  assert.equal(kstToday(Date.parse("2026-08-12T15:00:00Z")), "2026-08-13");
});

test("shift는 월·연 경계를 넘는다", () => {
  assert.equal(shift("2026-03-01", -1), "2026-02-28");
  assert.equal(shift("2024-03-01", -1), "2024-02-29");
  assert.equal(shift("2026-12-31", 1), "2027-01-01");
});

