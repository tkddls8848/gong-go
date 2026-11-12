// rows.js는 브라우저 스크립트지만 self가 없으면 globalThis에 붙으므로 그대로 실행해 검사한다.
// 입력은 collector가 저장하는 것과 같은 형식으로 만든다 — 형식이 어긋나면 여기서 걸린다.
//
// 다른 테스트와 달리 대상 옆에 두지 않는다. public/은 wrangler의 자산 디렉터리라
// 그 안에 있는 파일은 전부 사이트로 배포된다.
const test = require("node:test");
const assert = require("node:assert/strict");

test("손상된 gzip은 정상 CSV로 반환하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not gzip"));
  await assert.rejects(Rows.fetchCsvText("/fixture.gz", undefined, 1000));
});

// 입력은 collector가 실제로 쓰는 것과 같은 **형식**으로 만든다. collector/csv-record.js를
// require하지 않는 이유는 조회 화면 테스트가 수집기 모듈에 묶이지 않게 하기 위해서다 —
// 두 모듈이 맞춰야 하는 것은 저장된 파일 형식이지 함수가 아니다(README 모듈 경계).
// 형식: 헤더는 컬럼 합집합, 값이 있는 셀은 ="값"을 RFC 4180 따옴표로 감싸고 빈 셀은 빈 필드.
function serializeCsv(rows) {
  const columns = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return [columns.join(","), ...rows.map((row) => columns.map((key) => cell(row[key])).join(","))].join("\n");
}
function cell(value) {
  const text = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  if (text === "") return "";
  return `"${`="${text}"`.replaceAll('"', '""')}"`;
}

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
  bidQlfctRgstDt: "2026-01-19 18:00:00", cmmnSpldmdAgrmntClseDt: "2026-01-19 18:00:00",
  bidBeginDt: "2026-01-15 09:00:00", bidClseDt: "2026-01-20 18:00:00", opengDt: "2026-01-21 10:00:00",
  rgstDt: "2026-01-05 08:30:00", dminsttCd: "B550001",
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
  assert.deepEqual(row.bidSchedule, {
    bidNtceDt: "2026-01-05 09:00:00",
    bidQlfctRgstDt: "2026-01-19 18:00:00",
    cmmnSpldmdAgrmntClseDt: "2026-01-19 18:00:00",
    bidBeginDt: "2026-01-15 09:00:00",
    bidClseDt: "2026-01-20 18:00:00",
    opengDt: "2026-01-21 10:00:00",
  });
});

test("게시일이 조회 구간 밖이면 거른다", () => {
  const criteria = { from: "20260106", to: "20260131" };
  assert.equal(scan([BID], "bid", criteria).matched.length, 0);
  assert.equal(scan([PRE], "pre", criteria).matched.length, 1);
});

test("검색어는 공고번호·기관명·사업명을 함께 본다", () => {
  for (const q of ["일산병원", "서버", "20260105123"]) assert.equal(scan([BID], "bid", { q }).matched.length, 1, q);
  assert.equal(scan([BID], "bid", { q: "없는말" }).matched.length, 0);
});

test("코드를 가진 항목은 행에 코드가 있을 때 코드로만 맞춘다", () => {
  const byCode = [{ name: "", code: "B550001" }];
  assert.equal(scan([BID], "bid", { institutions: byCode }).matched.length, 1);
  assert.equal(scan([BID], "bid", { institutions: [{ name: "", code: "B999999" }] }).matched.length, 0);
  // 이름이 맞아도 코드가 다르면 떨어진다.
  assert.equal(scan([BID], "bid", { institutions: [{ name: "국민건강보험공단 일산병원", code: "B999999" }] }).matched.length, 0);
});

test("검색어는 공백으로 갈라 모두 포함해야 통과한다", () => {
  // 예전에는 통째로 한 번 includes 해서 떨어져 있는 두 낱말이 걸리지 않았다.
  assert.equal(scan([BID], "bid", { q: "일산병원 서버" }).matched.length, 1);
  assert.equal(scan([BID], "bid", { q: "서버 일산병원" }).matched.length, 1);
  assert.equal(scan([BID], "bid", { q: "일산병원 없는말" }).matched.length, 0);
});

test("쉼표·따옴표·개행이 든 값을 왕복해도 깨지지 않는다", () => {
  const messy = { ...BID, bidNtceNm: '서버 "이중화", 1식\n(추가 협의)' };
  assert.equal(onlyRow([messy], "bid").title, '서버 "이중화", 1식\n(추가 협의)');
});

test("HTML·다른 공고 종류·중복 헤더는 정상 0건으로 숨기지 않는다", () => {
  for (const text of ["<html>gateway error</html>", "bfSpecRgstNo,prdctClsfcNoNm\nPRE-1,서버", "bidNtceNo,bidNtceNo\nBID-1,BID-2"]) {
    assert.throws(() => Rows.scanText(text, "bid", Rows.makeCriteria({}), false), /공고번호 열|헤더가 중복/);
  }
});

test("닫히지 않은 인용 필드와 잘못된 인용 뒤 문자는 파일 오류로 처리한다", () => {
  for (const text of ['bidNtceNo,bidNtceNm\nBID-1,"잘린 제목', 'bidNtceNo,bidNtceNm\nBID-1,"제목"extra', 'bidNtceNo,bidNtceNm\nBID-1,제목,추가열']) {
    assert.throws(() => Rows.scanText(text, "bid", Rows.makeCriteria({}), false), /CSV/);
  }
});

