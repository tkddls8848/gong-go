const test = require("node:test");
const assert = require("node:assert/strict");
const { countRows, body, sealable, groupByMonth } = require("./compact");
const { serializeCsv, parseCsv } = require("../shared/csv-record");

test("countRows는 헤더를 뗀 본문의 행 수를 센다", () => {
  assert.equal(countRows("a,b\n"), 1);
  assert.equal(countRows("a,b\nc,d\n"), 2);
  assert.equal(countRows(""), 0);
});

test("countRows는 따옴표 안의 개행을 행 구분으로 세지 않는다", () => {
  // 사업명에 줄바꿈이 들어간 공고가 실제로 있다. 줄 수를 세면 여기서 틀린다.
  const rows = [{ title: "1차\n2차", note: "x" }, { title: "단일", note: "y" }];
  const text = serializeCsv(rows);
  assert.equal(countRows(body(text)), 2);
  assert.equal(parseCsv(text).length, 2);
});

test("countRows는 이어붙인 본문에서 합계와 같은 값을 낸다", () => {
  const first = serializeCsv([{ a: "1" }, { a: "2\n줄바꿈" }]);
  const second = serializeCsv([{ a: "3" }]);
  const merged = body(first) + body(second);
  assert.equal(countRows(merged), countRows(body(first)) + countRows(body(second)));
  assert.equal(countRows(merged), 3);
});

test("body는 끝 개행이 없는 본문을 보정한다 — 없으면 두 행이 한 행으로 붙는다", () => {
  const first = "h\nA\nB";     // 끝 개행 없음
  const second = "h\nC\n";
  assert.equal(body(first), "A\nB\n");
  assert.equal(countRows(body(first) + body(second)), 3);
  // 보정하지 않았다면 B와 C가 같은 행이 되어 2행이 된다.
  assert.equal(countRows("A\nB" + "C\n"), 2);
});

test("sealable은 월의 마지막 날 + lag가 지난 달만 고른다", () => {
  const now = new Date();
  const month = (offset) => { const date = new Date(now.getFullYear(), now.getMonth() + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; };
  assert.equal(sealable(month(0), 40), false);   // 당월은 아직 끝나지도 않았다
  assert.equal(sealable(month(-1), 40), false);  // 지난달은 재수집 창(40일) 안쪽이다
  assert.equal(sealable(month(-4), 40), true);
});

test("groupByMonth는 모드·월별로 묶고 날짜 오름차순으로 정렬한다", () => {
  const files = [
    { mode: "bid", date: "2023-12-02", path: "bid/2023/12/02.csv.gz" },
    { mode: "bid", date: "2023-12-01", path: "bid/2023/12/01.csv.gz" },
    { mode: "pre", date: "2023-12-01", path: "pre/2023/12/01.csv.gz" },
    { mode: "bid", date: "2024-01-01", path: "bid/2024/01/01.csv.gz" },
  ];
  const groups = groupByMonth(files);
  assert.deepEqual(groups.map((group) => `${group.mode}/${group.month}`), ["bid/2023-12", "pre/2023-12", "bid/2024-01"]);
  assert.deepEqual(groups[0].files.map((file) => file.date), ["2023-12-01", "2023-12-02"]);
});
