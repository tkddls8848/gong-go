// 서비스 파일의 컬럼 계약. 여기서 빠뜨린 컬럼은 조용히 사라져 재수집으로도 되돌아오지
// 않는다(원본은 data/raw에만 남는다). 특히 recordKey·recordDate가 쓰는 컬럼이 빠지면
// 증분 병합 자체가 깨진다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { project } = require("./service-columns");

test("모드는 공고번호 컬럼으로 판별한다", () => {
  assert.deepEqual(project({ bidNtceNo: "1", 낙찰방법: "x" }), { bidNtceNo: "1" });
  assert.deepEqual(project({ bfSpecRgstNo: "1", 낙찰방법: "x" }), { bfSpecRgstNo: "1" });
  assert.deepEqual(project({ orderPlanUntyNo: "1", 낙찰방법: "x" }), { orderPlanUntyNo: "1" });
});

test("모드를 판별할 수 없으면 원본을 그대로 둔다", () => {
  // 알 수 없는 응답을 임의로 깎으면 원인을 볼 수 없게 된다.
  const row = { 알수없는컬럼: "값" };
  assert.equal(project(row), row);
});

test("증분 병합이 쓰는 컬럼은 반드시 남는다", () => {
  // recordKey는 공고번호를, recordDate는 rgstDt/bidNtceDt/nticeDt를 본다.
  const bid = project({ bidNtceNo: "1", rgstDt: "2026-08-11 09:00:00", bidNtceDt: "2026-08-11 10:00:00" });
  assert.deepEqual(Object.keys(bid).sort(), ["bidNtceDt", "bidNtceNo", "rgstDt"]);
  const pre = project({ bfSpecRgstNo: "1", rgstDt: "2026-08-11 09:00:00" });
  assert.deepEqual(Object.keys(pre).sort(), ["bfSpecRgstNo", "rgstDt"]);
  const plan = project({ orderPlanUntyNo: "1", nticeDt: "2026-08-11 09:00:00" });
  assert.deepEqual(Object.keys(plan).sort(), ["nticeDt", "orderPlanUntyNo"]);
});

test("화면과 파이프라인이 읽는 컬럼을 남긴다", () => {
  const bid = project({
    bidNtceNo: "1", ntceKindNm: "물품", bidNtceNm: "서버", bidQlfctRgstDt: "2026-08-19 18:00:00",
    cmmnSpldmdAgrmntClseDt: "2026-08-19 18:00:00", bidBeginDt: "2026-08-20 09:00:00",
    bidClseDt: "2026-08-20 18:00:00", opengDt: "2026-08-21 10:00:00",
    dminsttCd: "B550001", dminsttNm: "기관", rlDminsttNm: "실수요기관", ntceInsttNm: "공고기관",
    ntceSpecDocUrl1: "https://example.go.kr/1", ntceSpecFileNm1: "규격서.hwp",
    ntceSpecDocUrl10: "https://example.go.kr/10", ntceSpecFileNm10: "붙임10.hwp",
    // 아래는 조회 UI·downloader·converter·analyzer 어디서도 참조하지 않는다.
    sucsfbidMthdNm: "적격심사", ntceInsttOfclTelNo: "02-0000-0000", presmptPrce: "1000000",
  });
  for (const key of ["ntceKindNm", "bidNtceNm", "bidQlfctRgstDt", "cmmnSpldmdAgrmntClseDt", "bidBeginDt", "bidClseDt", "opengDt", "dminsttCd", "rlDminsttNm", "ntceSpecDocUrl1", "ntceSpecFileNm10"]) {
    assert.ok(key in bid, key);
  }
  for (const key of ["sucsfbidMthdNm", "ntceInsttOfclTelNo", "presmptPrce"]) assert.ok(!(key in bid), key);

  const plan = project({
    orderPlanUntyNo: "1", bizNm: "차세대 포털", orderYear: "2026", orderMnth: "7",
    orderInsttNm: "국민연금공단", orderInsttCd: "B490000", sumOrderAmt: "1200000000",
    orderPlanDtlUrl: "https://example.go.kr/plan/1", atchFileExistnceYn: "Y", bidNtceNoList: "20260701001",
    specItemNm1: "규격항목", ordererTelNo: "02-0000-0000",
  });
  for (const key of ["bizNm", "orderYear", "orderMnth", "orderInsttCd", "sumOrderAmt", "orderPlanDtlUrl", "atchFileExistnceYn", "bidNtceNoList"]) {
    assert.ok(key in plan, key);
  }
  for (const key of ["specItemNm1", "ordererTelNo"]) assert.ok(!(key in plan), key);
});

test("원본에 없는 컬럼은 만들지 않는다", () => {
  // 빈 문자열로 채우면 CSV 헤더가 실제로 받은 것과 달라진다.
  const row = project({ bidNtceNo: "1" });
  assert.deepEqual(row, { bidNtceNo: "1" });
  assert.equal("bidNtceNm" in row, false);
});

test("발주계획에는 첨부 URL 계열이 없다", () => {
  // 원본에 아예 없다. 상세 링크(orderPlanDtlUrl) 하나뿐이라 첨부 파이프라인을 태우지 않는다.
  const plan = project({ orderPlanUntyNo: "1", ntceSpecDocUrl1: "https://example.go.kr/1", specDocFileUrl1: "https://example.go.kr/2" });
  assert.deepEqual(plan, { orderPlanUntyNo: "1" });
});

test("모드를 직접 지정하면 그 목록으로 깎는다", () => {
  // 원본이 공고번호를 주지 않은 응답을 수집기가 모드와 함께 넘기는 경로다.
  assert.deepEqual(project({ bidNtceNm: "서버", 낙찰방법: "x" }, "bid"), { bidNtceNm: "서버" });
});

test("본공고는 나라장터 상세화면 링크 컬럼을 남긴다", () => {
  // 발주계획의 orderPlanDtlUrl과 같은 자리다. 이게 빠지면 조회 화면이 공고를
  // 나라장터에서 열 방법이 없다 — 사전공고 API에는 아예 없는 필드다.
  const bid = project({ bidNtceNo: "1", bidNtceDtlUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R25BK00932003&bidPbancOrd=000" });
  assert.ok("bidNtceDtlUrl" in bid);
});
