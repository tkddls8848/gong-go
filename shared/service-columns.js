// 서비스가 실제로 쓰는 컬럼만 남긴다. 본공고 원본은 170컬럼인데 화면·파이프라인이 쓰는 것은
// 28개뿐이라 파일이 약 72% 작아진다. 버리는 컬럼은 낙찰방법·담당자 연락처·예산 항목·각종 코드로
// 조회 UI, downloader, converter, analyzer 어디서도 참조하지 않는다.
//
// 원본 전체는 collector가 data/raw 아래 같은 구조로 미러링해 둔다(collector.js의 writeCsv).
// 서비스 파일과 경로가 1:1로 대응하므로, 나중에 다른 컬럼이 필요해지면 재수집 없이
// 같은 날짜의 raw 파일에서 꺼내면 된다.
const SERIES = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const SERVICE_COLUMNS = {
  // rgstDt/bidNtceDt는 collector의 recordDate가, bidNtceNo/bfSpecRgstNo는 recordKey가 쓴다.
  // 이 둘이 빠지면 증분 병합이 깨지므로 반드시 유지한다.
  bid: [
    "bidNtceNo", "ntceKindNm", "bidNtceNm", "bidNtceDt", "bidClseDt", "rgstDt",
    "dminsttCd", "dminsttNm", "rlDminsttNm", "ntceInsttNm",
    // 나라장터 상세화면 링크. 발주계획의 orderPlanDtlUrl과 같은 자리다. 원본에는 값이 같은
    // bidNtceUrl도 있지만 512자짜리를 두 벌 저장할 이유가 없어 상세화면 쪽만 남긴다.
    "bidNtceDtlUrl",
    ...SERIES("ntceSpecDocUrl", 10), ...SERIES("ntceSpecFileNm", 10),
  ],
  pre: [
    "bfSpecRgstNo", "bsnsDivNm", "prdctClsfcNoNm", "rgstDt", "opninRgstClseDt",
    "orderInsttNm", "rlDminsttNm",
    ...SERIES("specDocFileUrl", 5), ...SERIES("specDocFileNm", 5),
  ],
  // 발주계획 원본은 59컬럼이다. 첨부파일 URL 계열이 아예 없고(상세 링크 orderPlanDtlUrl 하나뿐)
  // 규격항목(specItemNm1~5)·담당자 연락처·예산 코드는 조회 화면이 쓰지 않아 뺐다.
  // orderPlanUntyNo는 recordKey가, nticeDt는 recordDate가 쓰므로 반드시 유지한다.
  plan: [
    "orderPlanUntyNo", "nticeDt", "chgDt", "bsnsDivNm", "bizNm",
    "orderYear", "orderMnth", "orderInsttNm", "orderInsttCd", "totlmngInsttNm", "jrsdctnDivNm",
    "sumOrderAmt", "cntrctMthdNm", "prcrmntMethd", "prdctClsfcNoNm",
    "bidNtceNoList", "orderPlanDtlUrl", "atchFileExistnceYn",
  ],
};

function modeOf(row) { return row.bidNtceNo ? "bid" : row.bfSpecRgstNo ? "pre" : row.orderPlanUntyNo ? "plan" : ""; }

// 원본에 없는 컬럼은 만들지 않는다. 모드를 판별할 수 없으면 원본을 그대로 둔다.
function project(row, mode = modeOf(row)) {
  const keep = SERVICE_COLUMNS[mode];
  if (!keep) return row;
  const result = {};
  for (const key of keep) if (key in row) result[key] = row[key];
  return result;
}

module.exports = { project };
