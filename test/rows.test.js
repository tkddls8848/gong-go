// rows.js는 브라우저 스크립트지만 self가 없으면 globalThis에 붙으므로 그대로 실행해 검사한다.
// 입력은 collector가 실제로 쓰는 직렬화기로 만든다 — 파일 형식이 어긋나면 여기서 걸린다.
//
// 다른 테스트와 달리 대상 옆에 두지 않는다. public/은 wrangler의 자산 디렉터리라
// 그 안에 있는 파일은 전부 사이트로 배포된다.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { serializeCsv } = require("../shared/csv-record");

require("../public/rows.js");
const Rows = globalThis.GongRows;

// collector/collector.js의 writeCsv와 같은 모양(BOM + 헤더 + 본문 + 끝 개행).
function csvOf(records) { return `﻿${serializeCsv(records)}\n`; }
function scan(records, mode, criteria = {}, checkDate = true) {
  return Rows.scanText(csvOf(records), mode, Rows.makeCriteria(criteria), checkDate);
}
function onlyRow(records, mode) {
  const result = scan(records, mode);
  assert.equal(result.matched.length, 1);
  return result.matched[0];
}

const BID = {
  bidNtceNo: "20260105123-00", ntceKindNm: "물품", bidNtceNm: "서버 도입", bidNtceDt: "2026-01-05 09:00:00",
  bidClseDt: "2026-01-20 18:00:00", rgstDt: "2026-01-05 08:30:00", dminsttCd: "B550001",
  dminsttNm: "국민건강보험공단", rlDminsttNm: "국민건강보험공단 일산병원",
  ntceSpecDocUrl1: "https://example.go.kr/get?fileNm=%EA%B7%9C%EA%B2%A9%EC%84%9C.hwp", ntceSpecFileNm1: "",
  ntceSpecDocUrl2: "https://example.go.kr/get?id=2", ntceSpecFileNm2: "과업지시서.hwp",
  ntceSpecDocUrl3: "", ntceSpecFileNm3: "",
};
const PRE = {
  bfSpecRgstNo: "20260107001", bsnsDivNm: "용역", prdctClsfcNoNm: "정보시스템 유지관리", rgstDt: "2026-01-07 10:00:00",
  opninRgstClseDt: "2026-01-14 18:00:00", orderInsttNm: "보건복지부", rlDminsttNm: "한국사회보장정보원",
  specDocFileUrl1: "", specDocFileNm1: "",
};
const PLAN = {
  orderPlanUntyNo: "P-2026-0001", nticeDt: "2026-02-03 11:00:00", bsnsDivNm: "기술용역", bizNm: "차세대 포털 구축",
  orderYear: "2026", orderMnth: "7", orderInsttNm: "국민연금공단", orderInsttCd: "B490000",
  sumOrderAmt: "1200000000", cntrctMthdNm: "일반경쟁", prcrmntMethd: "총액", orderPlanDtlUrl: "https://example.go.kr/plan/1",
  bidNtceNoList: "20260701001", atchFileExistnceYn: "Y",
};

test("본공고 행을 화면 모델로 옮긴다", () => {
  const row = onlyRow([BID], "bid");
  assert.equal(row.mode, "bid");
  assert.equal(row.announcementNumber, "20260105123-00");
  // rlDminsttNm이 dminsttNm보다 앞선다.
  assert.equal(row.institution, "국민건강보험공단 일산병원");
  assert.equal(row.dminsttCd, "B550001");
  assert.equal(row.businessType, "물품");
  assert.equal(row.title, "서버 도입");
  assert.equal(row.publishedAt, "2026-01-05 08:30:00");
  assert.equal(row.closeAt, "2026-01-20 18:00:00");
});

test("첨부는 URL이 있는 슬롯만 남고 이름이 없으면 URL에서 찾는다", () => {
  const files = onlyRow([BID], "bid").files;
  assert.deepEqual(files.map((file) => file.name), ["규격서.hwp", "과업지시서.hwp"]);
  assert.equal(files.length, 2);
});

test("첨부가 하나도 없어도 빈 배열이 된다", () => {
  // 예전 모델은 빈 슬롯마다 new URL("")로 예외를 던져 이 경로가 가장 비쌌다.
  const row = onlyRow([{ ...BID, ntceSpecDocUrl1: "", ntceSpecFileNm1: "", ntceSpecDocUrl2: "", ntceSpecFileNm2: "" }], "bid");
  assert.deepEqual(row.files, []);
});

test("이름도 URL 힌트도 없으면 슬롯 번호로 이름을 만든다", () => {
  const row = onlyRow([{ ...BID, ntceSpecDocUrl1: "", ntceSpecFileNm1: "", ntceSpecDocUrl2: "https://example.go.kr/get?id=2", ntceSpecFileNm2: "" }], "bid");
  assert.deepEqual(row.files.map((file) => file.name), ["첨부파일 2"]);
});

test("사전공고 행을 화면 모델로 옮긴다", () => {
  const row = onlyRow([PRE], "pre");
  assert.equal(row.mode, "pre");
  assert.equal(row.announcementNumber, "20260107001");
  assert.equal(row.institution, "한국사회보장정보원");
  assert.equal(row.businessType, "용역");
  assert.equal(row.title, "정보시스템 유지관리");
  assert.equal(row.closeAt, "2026-01-14 18:00:00");
  // 사전공고 CSV에는 기관 코드 컬럼이 없다.
  assert.equal(row.dminsttCd, "");
});

test("발주계획은 마감일 대신 발주예정월과 상세 링크를 싣는다", () => {
  const row = onlyRow([PLAN], "plan");
  assert.equal(row.mode, "plan");
  assert.equal(row.title, "차세대 포털 구축");
  assert.equal(row.publishedAt, "2026-02-03 11:00:00");
  assert.equal(row.closeAt, "");
  assert.equal(row.orderMonth, "2026-07");
  assert.equal(row.amount, "1200000000");
  assert.equal(row.detailUrl, "https://example.go.kr/plan/1");
  assert.equal(row.hasAttachment, true);
  assert.equal(row.linkedNotices, "20260701001");
  assert.deepEqual(row.files, []);
});

test("게시일이 조회 구간 밖이면 거른다", () => {
  const criteria = { from: "20260106", to: "20260131" };
  assert.equal(scan([BID], "bid", criteria).matched.length, 0);
  assert.equal(scan([PRE], "pre", criteria).matched.length, 1);
});

test("파일 구간이 조회 구간 안에 들어오면 날짜를 보지 않는다", () => {
  // 구간 안 파일은 호출자가 checkDate=false로 부른다. 그때는 from/to가 어긋나도 통과해야 한다.
  const result = scan([BID], "bid", { from: "20990101", to: "20991231" }, false);
  assert.equal(result.matched.length, 1);
  assert.equal(result.scanned, 1);
});

test("업무구분은 접미사 일치까지 허용한다", () => {
  // 발주계획은 "용역"이 아니라 "기술용역"으로 온다.
  assert.equal(scan([PLAN], "plan", { type: "용역" }).matched.length, 1);
  assert.equal(scan([PLAN], "plan", { type: "물품" }).matched.length, 0);
  assert.equal(scan([BID], "bid", { type: "물품" }).matched.length, 1);
});

test("검색어는 공고번호·기관명·사업명을 함께 본다", () => {
  for (const q of ["일산병원", "서버", "20260105123"]) assert.equal(scan([BID], "bid", { q }).matched.length, 1, q);
  assert.equal(scan([BID], "bid", { q: "없는말" }).matched.length, 0);
});

test("관심 기관이 비면 전부 통과한다", () => {
  assert.equal(scan([BID], "bid", { institutions: [] }).matched.length, 1);
});

test("코드를 가진 항목은 행에 코드가 있을 때 코드로만 맞춘다", () => {
  const byCode = [{ name: "", code: "B550001" }];
  assert.equal(scan([BID], "bid", { institutions: byCode }).matched.length, 1);
  assert.equal(scan([BID], "bid", { institutions: [{ name: "", code: "B999999" }] }).matched.length, 0);
  // 이름이 맞아도 코드가 다르면 떨어진다.
  assert.equal(scan([BID], "bid", { institutions: [{ name: "국민건강보험공단 일산병원", code: "B999999" }] }).matched.length, 0);
});

test("행에 코드가 없으면 이름으로 맞춘다", () => {
  // 사전공고에는 코드 컬럼이 없으므로 코드까지 적어 둔 항목도 이름으로 맞아야 한다.
  assert.equal(scan([PRE], "pre", { institutions: [{ name: "한국사회보장정보원", code: "B550001" }] }).matched.length, 1);
  // 기관명 비교는 공백을 무시한다.
  assert.equal(scan([PRE], "pre", { institutions: [{ name: " 한국사회보장 정보원 ", code: "" }] }).matched.length, 1);
});

test("코드 없는 항목은 행에 코드가 있어도 이름으로 맞는다", () => {
  assert.equal(scan([BID], "bid", { institutions: [{ name: "국민건강보험공단 일산병원", code: "" }] }).matched.length, 1);
});

test("쉼표·따옴표·개행이 든 값을 왕복해도 깨지지 않는다", () => {
  const messy = { ...BID, bidNtceNm: '서버 "이중화", 1식\n(추가 협의)' };
  assert.equal(onlyRow([messy], "bid").title, '서버 "이중화", 1식\n(추가 협의)');
});

test("여러 행에서 조건에 맞는 것만 남기고 읽은 행 수는 전부 센다", () => {
  const records = [BID, { ...BID, bidNtceNo: "20260105124-00", rlDminsttNm: "공영홈쇼핑", dminsttCd: "C010001" }];
  const result = scan(records, "bid", { institutions: [{ name: "공영홈쇼핑", code: "" }] });
  assert.equal(result.scanned, 2);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].announcementNumber, "20260105124-00");
});

test("헤더만 있는 파일은 빈 결과가 된다", () => {
  const result = Rows.scanText(`﻿${serializeCsv([BID]).split("\n")[0]}\n`, "bid", Rows.makeCriteria({}), true);
  assert.deepEqual(result.matched, []);
  assert.equal(result.scanned, 0);
});

test("CSV fetch는 갱신 직후 조건부 재검증 옵션을 전달한다", async () => {
  const originalFetch = globalThis.fetch;
  let received;
  try {
    globalThis.fetch = async (url, init) => {
      received = { url, init };
      return new Response(zlib.gzipSync(Buffer.from("hello", "utf8")), { status: 200 });
    };
    assert.equal(await Rows.fetchCsvText("/data/bid/2026/08/11.csv.gz", { cache: "no-cache" }), "hello");
    assert.deepEqual(received, { url: "/data/bid/2026/08/11.csv.gz", init: { cache: "no-cache" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
