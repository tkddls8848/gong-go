// collector 모듈의 저장소 헬퍼. 인덱스 항목 모양은 프런트(public/app.js)와 Worker(src/worker.js)가
// 함께 읽는 **데이터** 계약이라 여기서 고정한다 — 저장 형식을 만드는 쪽이 이 모듈이기 때문이다.
// 같은 모양을 uploader도 따로 만든다(uploader/upload.js). 그쪽 사본은 uploader/upload.test.js가 지킨다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildIndexEntries, mapPool } = require("./store");

test("인덱스 항목은 일별·월별을 같은 {mode,begin,end,path,count}로 낸다", () => {
  const entries = buildIndexEntries(new Map([
    ["bid/2026/08/11.csv.gz", 1200],
    ["pre/2023/12.csv.gz", 42170],
  ]));
  assert.deepEqual(entries, [
    // 봉인된 월은 그 달 전체를 덮는다. 일별은 begin === end다.
    { mode: "pre", begin: "2023-12-01", end: "2023-12-31", path: "pre/2023/12.csv.gz", count: 42170 },
    { mode: "bid", begin: "2026-08-11", end: "2026-08-11", path: "bid/2026/08/11.csv.gz", count: 1200 },
  ]);
});

test("같은 달에 봉인 파일과 일별 파일이 함께 있으면 월 항목만 남는다", () => {
  // 봉인 직후 --prune 전의 상태다. 둘 다 두면 프런트가 같은 행을 두 번 읽는다.
  const entries = buildIndexEntries(new Map([
    ["bid/2023/12.csv.gz", 42170],
    ["bid/2023/12/11.csv.gz", 1500],
    ["bid/2023/12/12.csv.gz", 1600],
    ["pre/2023/12/11.csv.gz", 900],   // pre는 봉인되지 않았으므로 남는다
  ]));
  // 봉인 항목의 begin은 그 달 1일이라 같은 달 일별 항목보다 앞선다.
  assert.deepEqual(entries.map((entry) => entry.path), ["bid/2023/12.csv.gz", "pre/2023/12/11.csv.gz"]);
});

test("mapPool은 입력 순서로 결과를 돌려주고 동시 실행 수를 지킨다", async () => {
  let active = 0, peak = 0;
  const results = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
  // 항목보다 큰 한도를 줘도 워커를 그만큼만 띄운다.
  assert.deepEqual(await mapPool([1], 8, async (value) => value), [1]);
  assert.deepEqual(await mapPool([], 4, async () => { throw new Error("불려서는 안 된다"); }), []);
});

