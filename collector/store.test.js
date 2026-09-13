// collector 모듈의 저장소 헬퍼. 인덱스 항목 모양은 프런트(public/app.js)와 Worker(src/worker.js)가
// 함께 읽는 **데이터** 계약이라 여기서 고정한다 — 저장 형식을 만드는 쪽이 이 모듈이기 때문이다.
// 같은 모양을 uploader도 따로 만든다(uploader/upload.js). 그쪽 사본은 uploader/upload.test.js가 지킨다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const nodePath = require("node:path");
const { buildIndexEntries, lastDayOfMonth, mapPool, loadEnv, readJson } = require("./store");

async function tempDir(t) {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "gong-go-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

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

test("인덱스는 시작일·모드 순으로 정렬한다", () => {
  const entries = buildIndexEntries(new Map([
    ["plan/2026/08/11.csv.gz", 1], ["bid/2026/08/11.csv.gz", 2],
    ["pre/2026/08/10.csv.gz", 3], ["bid/2026/08/10.csv.gz", 4],
  ]));
  assert.deepEqual(entries.map((entry) => `${entry.begin}/${entry.mode}`), [
    "2026-08-10/bid", "2026-08-10/pre", "2026-08-11/bid", "2026-08-11/plan",
  ]);
});

test("봉인 월의 말일은 윤년까지 맞춘다", () => {
  assert.equal(lastDayOfMonth("2024", "02"), "29");
  assert.equal(lastDayOfMonth("2026", "02"), "28");
  assert.equal(lastDayOfMonth("2100", "02"), "28");   // 100년 예외
  assert.equal(lastDayOfMonth("2026", "04"), "30");
  assert.equal(buildIndexEntries(new Map([["bid/2024/02.csv.gz", 1]]))[0].end, "2024-02-29");
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

test("loadEnv는 이미 있는 환경변수를 덮지 않는다", async (t) => {
  const dir = await tempDir(t);
  const file = nodePath.join(dir, ".env");
  await fs.writeFile(file, ['SERVICE_KEY="파일값"', "R2_ACCOUNT_ID='따옴표'", "# 주석", "잘못된 줄", "API_BASE=https://example.workers.dev/api/relay"].join("\n"), "utf8");
  const saved = { ...process.env };
  t.after(() => { for (const key of ["SERVICE_KEY", "R2_ACCOUNT_ID", "API_BASE"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  // 워크플로가 넣어 준 값이 우선이다. .env가 덮으면 러너에서 로컬 설정으로 돌아버린다.
  process.env.SERVICE_KEY = "환경값";
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.API_BASE;
  loadEnv(file);
  assert.equal(process.env.SERVICE_KEY, "환경값");
  assert.equal(process.env.R2_ACCOUNT_ID, "따옴표");
  assert.equal(process.env.API_BASE, "https://example.workers.dev/api/relay");
});

test("파일이 없으면 loadEnv와 readJson은 조용히 넘어간다", async (t) => {
  const dir = await tempDir(t);
  assert.doesNotThrow(() => loadEnv(nodePath.join(dir, "없는파일")));
  assert.deepEqual(await readJson(nodePath.join(dir, "없음.json"), { files: [] }), { files: [] });
});
