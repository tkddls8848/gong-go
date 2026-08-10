const test = require("node:test");
const assert = require("node:assert/strict");
const { supersededDaily, vanishedDaily, indexFiles, monthOf, dateOf } = require("./upload");

test("monthOf는 일별 키와 월별 키를 같은 월로 모은다", () => {
  assert.equal(monthOf("bid/2023/12/11.csv.gz"), "bid/2023/12");
  assert.equal(monthOf("bid/2023/12.csv.gz"), "bid/2023/12");
  assert.notEqual(monthOf("pre/2023/12.csv.gz"), monthOf("bid/2023/12.csv.gz"));
});

test("dateOf는 일별 키에서 날짜를 뽑는다", () => {
  assert.equal(dateOf("pre/2026/07/03.csv.gz"), "2026-07-03");
});

test("월별 봉인 키가 버킷에 있을 때만 그 달 일별 키를 지운다", () => {
  const present = new Set([
    "bid/2023/12.csv.gz", "bid/2023/12/11.csv.gz", "bid/2023/12/12.csv.gz",
    "pre/2023/12/11.csv.gz",           // pre는 봉인되지 않았다
    "bid/2026/07/01.csv.gz",           // 재수집 창 안쪽, 봉인 없음
    "index.json", "state/sync-state.json", "raw/bid/2023/12/11.csv.gz",
  ]);
  assert.deepEqual(supersededDaily(present).sort(), ["bid/2023/12/11.csv.gz", "bid/2023/12/12.csv.gz"]);
});

test("봉인 키가 없으면 일별 키를 하나도 지우지 않는다", () => {
  // 크론 러너는 최근 며칠치만 로컬에 갖고 있다. "로컬에 없으면 지운다"였다면
  // 이 집합에서 나머지 전부가 삭제 대상이 됐을 것이다.
  const present = new Set(["bid/2020/01/01.csv.gz", "bid/2026/08/01.csv.gz", "pre/2020/01/01.csv.gz"]);
  assert.deepEqual(supersededDaily(present), []);
});

test("state/·raw/·analysis/ 프리픽스는 삭제 대상이 아니다", () => {
  const present = new Set(["bid/2023/12.csv.gz", "state/sync-state.json", "raw/bid/2023/12/11.csv.gz", "analysis/bid/1234.json"]);
  assert.deepEqual(supersededDaily(present), []);
});

test("수집 구간이 없으면 사라진 일별 키를 지우지 않는다", () => {
  const present = new Set(["bid/2026/07/01.csv.gz"]);
  assert.deepEqual(vanishedDaily(present, [], "", ""), []);
});

test("수집 구간 안에서 로컬에 없어진 일별 키만 지운다", () => {
  const present = new Set(["bid/2026/07/01.csv.gz", "bid/2026/07/02.csv.gz", "bid/2020/01/01.csv.gz"]);
  const local = [{ key: "bid/2026/07/02.csv.gz" }];
  // 2026-07-01은 구간 안인데 로컬에 없다 → 그날 공고가 0건이 된 것이므로 지운다.
  // 2020-01-01은 구간 밖이라 러너가 받지 않았을 뿐이므로 건드리지 않는다.
  assert.deepEqual(vanishedDaily(present, local, "2026-07-01", "2026-07-31"), ["bid/2026/07/01.csv.gz"]);
});

test("발주계획은 구간 안에서 로컬에 없어도 지우지 않는다", () => {
  // API가 최근 며칠치만 주므로 러너의 로컬에는 스냅샷 구간만 생긴다. 이걸 "사라졌다"로 보면
  // 크론이 돌 때마다 그 앞에 쌓아 둔 발주계획이 전부 삭제된다.
  const present = new Set(["plan/2026/07/15.csv.gz", "plan/2026/08/10.csv.gz", "bid/2026/07/01.csv.gz"]);
  const local = [{ key: "plan/2026/08/10.csv.gz" }];
  assert.deepEqual(vanishedDaily(present, local, "2026-07-01", "2026-08-10"), ["bid/2026/07/01.csv.gz"]);
});

test("인덱스는 로컬에 없는 과거 키의 건수를 버킷 인덱스에서 승계한다", () => {
  const present = new Set(["bid/2020/01.csv.gz", "bid/2026/08/01.csv.gz"]);
  const local = [{ path: "bid/2026/08/01.csv.gz", count: 7 }];          // 러너가 오늘 받은 것뿐
  const remote = [{ path: "bid/2020/01.csv.gz", count: 26691 }, { path: "bid/2026/08/01.csv.gz", count: 3 }];
  const files = indexFiles(present, new Set(), local, remote);
  assert.deepEqual(files, [
    { mode: "bid", begin: "2020-01-01", end: "2020-01-31", path: "bid/2020/01.csv.gz", count: 26691 },
    { mode: "bid", begin: "2026-08-01", end: "2026-08-01", path: "bid/2026/08/01.csv.gz", count: 7 },
  ]);
});

test("지울 키와 데이터가 아닌 키는 인덱스에 넣지 않는다", () => {
  const present = new Set(["bid/2023/12.csv.gz", "bid/2023/12/11.csv.gz", "state/sync-state.json", "analysis/bid/1.json"]);
  const files = indexFiles(present, new Set(["bid/2023/12/11.csv.gz"]), [{ path: "bid/2023/12.csv.gz", count: 42170 }], []);
  assert.deepEqual(files.map((file) => file.path), ["bid/2023/12.csv.gz"]);
});

test("봉인 직후 삭제 전이라도 인덱스는 월 항목만 남긴다", () => {
  // ②인덱스 PUT이 ③삭제보다 먼저다. 그 사이에 인덱스가 일별 키를 가리키면 안 된다.
  const present = new Set(["bid/2023/12.csv.gz", "bid/2023/12/11.csv.gz"]);
  const local = [{ path: "bid/2023/12.csv.gz", count: 42170 }, { path: "bid/2023/12/11.csv.gz", count: 1500 }];
  assert.deepEqual(indexFiles(present, new Set(), local, []).map((file) => file.path), ["bid/2023/12.csv.gz"]);
});
