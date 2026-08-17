// 파이프라인 공용 함수. 인덱스 항목 모양은 프런트(public/app.js)와 Worker(src/worker.js)가
// 함께 읽는 데이터 계약이라 여기서 고정한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const nodePath = require("node:path");
const {
  fs, buildIndexEntries, lastDayOfMonth, mapPool, loadEnv,
  noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName,
  writeGzipText, readGzipText, readCsvGz, readJson,
} = require("./pipeline-utils");
const { serializeCsv } = require("./csv-record");

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

test("행에서 뽑는 값은 모드마다 우선순위가 다르다", () => {
  const bid = { bidNtceNo: "20260105123-00", bidNtceDt: "2026-01-05 09:00:00", rgstDt: "2026-01-04 08:00:00", dminsttNm: "기관", rlDminsttNm: "실수요기관", bidNtceNm: "서버 도입" };
  assert.equal(noticeNumber(bid), "20260105123-00");
  // 등록일시가 게시일시보다 앞선다 — 조회 화면의 게시일과 같은 값을 써야 파일 분류와 어긋나지 않는다.
  assert.equal(rowDate(bid), "20260104");
  assert.equal(institution(bid), "실수요기관");
  assert.equal(title(bid), "서버 도입");

  const plan = { orderPlanUntyNo: "P-2026-0001", nticeDt: "2026-02-03 11:00:00", orderInsttNm: "국민연금공단", bizNm: "차세대 포털" };
  assert.equal(noticeNumber(plan), "P-2026-0001");
  assert.equal(rowDate(plan), "20260203");
  assert.equal(institution(plan), "국민연금공단");
  assert.equal(title(plan), "차세대 포털");

  // 날짜가 없거나 형식이 다르면 숫자만 남기고 8자리로 자른다.
  assert.equal(rowDate({}), "");
  assert.equal(rowDate({ rgstDt: "2026/01/05" }), "20260105");
});

test("첨부 슬롯 수는 본공고 10개, 사전공고 5개다", () => {
  const bid = { bidNtceNo: "1" };
  for (let index = 1; index <= 12; index += 1) bid[`ntceSpecDocUrl${index}`] = `https://example.go.kr/f/${index}`;
  // 11·12번째는 원본에 있어도 읽지 않는다.
  assert.equal(normalizeFiles(bid).length, 10);

  const pre = { bfSpecRgstNo: "1" };
  for (let index = 1; index <= 7; index += 1) pre[`specDocFileUrl${index}`] = `https://example.go.kr/f/${index}`;
  assert.equal(normalizeFiles(pre).length, 5);
});

test("첨부는 URL이 있는 슬롯만 남고 이름이 없으면 URL에서 찾는다", () => {
  const row = {
    bidNtceNo: "1",
    ntceSpecDocUrl1: "https://example.go.kr/get?fileNm=%EA%B7%9C%EA%B2%A9%EC%84%9C.hwp", ntceSpecFileNm1: "",
    ntceSpecDocUrl2: "https://example.go.kr/get?id=2", ntceSpecFileNm2: "과업지시서.hwp",
    ntceSpecDocUrl3: "https://example.go.kr/get?id=3", ntceSpecFileNm3: "",
    ntceSpecDocUrl4: "", ntceSpecFileNm4: "이름만 있고 URL이 없다",
    ntceSpecDocUrl5: "ftp://example.go.kr/x",          // http(s)가 아니면 버린다
  };
  assert.deepEqual(normalizeFiles(row), [
    { url: "https://example.go.kr/get?fileNm=%EA%B7%9C%EA%B2%A9%EC%84%9C.hwp", name: "규격서.hwp" },
    { url: "https://example.go.kr/get?id=2", name: "과업지시서.hwp" },
    { url: "https://example.go.kr/get?id=3", name: "첨부파일_3" },
  ]);
});

test("파일명은 경로와 금지 문자를 없애고 길이를 자른다", () => {
  // 다운로더가 이 값으로 디스크에 쓴다. 경로가 남으면 data/ 밖으로 나간다.
  // 상위 이동은 basename에서 떨어지고 이름만 남는다(점 파일 자체는 이름으로 허용된다).
  assert.equal(safeFileName("../../.env"), ".env");
  assert.equal(safeFileName("/etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Windows\\system32\\drivers\\etc\\hosts"), "hosts");
  assert.equal(safeFileName("규격서<1>:*?.hwp"), "규격서_1____.hwp");
  assert.equal(safeFileName(".."), "_");
  assert.equal(safeFileName(""), "attachment");
  assert.equal(safeFileName("", "기본값"), "기본값");
  assert.equal(safeFileName("가".repeat(300)).length, 180);
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

test("파일이 없으면 loadEnv와 readJson·readCsvGz는 조용히 넘어간다", async (t) => {
  const dir = await tempDir(t);
  assert.doesNotThrow(() => loadEnv(nodePath.join(dir, "없는파일")));
  assert.deepEqual(await readJson(nodePath.join(dir, "없음.json"), { files: [] }), { files: [] });
  assert.deepEqual(await readCsvGz(nodePath.join(dir, "없음.csv.gz")), []);
});

test("gzip 텍스트는 없는 디렉터리를 만들어 쓰고 그대로 되읽는다", async (t) => {
  const dir = await tempDir(t);
  const file = nodePath.join(dir, "bid", "2026", "08", "11.csv.gz");
  // 입력은 collector가 실제로 쓰는 직렬화기로 만든다 — 형식이 어긋나면 여기서 걸린다.
  const rows = [{ bidNtceNo: "1", bidNtceNm: '서버 "이중화", 1식\n(추가 협의)' }];
  const text = `${serializeCsv(rows)}\n`;
  await writeGzipText(file, text);
  assert.equal(await readGzipText(file), text);
  assert.deepEqual(await readCsvGz(file), rows);
});
