const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillChunks, parseIso, argsOf } = require("./backfill-plan");

test("과거 구간을 달력상 3개월씩 나눈다", () => {
  assert.deepEqual(backfillChunks("2020-01-01", "2020-08-17", 3).include, [
    { begin: "2020-01-01", end: "2020-03-31", label: "2020-01-01_2020-03-31" },
    { begin: "2020-04-01", end: "2020-06-30", label: "2020-04-01_2020-06-30" },
    { begin: "2020-07-01", end: "2020-08-17", label: "2020-07-01_2020-08-17" },
  ]);
});

test("윤년과 월 중간 시작일을 보존한다", () => {
  assert.deepEqual(backfillChunks("2020-02-15", "2020-04-02", 1).include.map(({ begin, end }) => ({ begin, end })), [
    { begin: "2020-02-15", end: "2020-02-29" },
    { begin: "2020-03-01", end: "2020-03-31" },
    { begin: "2020-04-01", end: "2020-04-02" },
  ]);
});

test("백필 입력값을 엄격하게 검사한다", () => {
  assert.throws(() => parseIso("2021-02-29"), /달력에 없는/);
  assert.throws(() => backfillChunks("2020-02-01", "2020-01-01"), /늦습니다/);
  assert.throws(() => backfillChunks("2020-01-01", "2020-02-01", 0), /1~12/);
  assert.deepEqual(argsOf(["--begin=2020-01-01", "--end=2020-03-31", "--months=2"]), { begin: "2020-01-01", end: "2020-03-31", months: "2" });
});
