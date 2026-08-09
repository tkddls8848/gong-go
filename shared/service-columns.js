// 서비스가 실제로 쓰는 컬럼만 남긴다. 본공고 원본은 170컬럼인데 화면·파이프라인이 쓰는 것은
// 28개뿐이라 파일이 약 72% 작아진다. 버리는 컬럼은 낙찰방법·담당자 연락처·예산 항목·각종 코드로
// 조회 UI, downloader, converter, analyzer 어디서도 참조하지 않는다.
//
// 원본 전체는 data/backup/raw.csv.gz에 따로 남기므로, 나중에 다른 컬럼이 필요해지면
// 재수집 없이 거기서 꺼내면 된다.
const SERIES = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const SERVICE_COLUMNS = {
  // rgstDt/bidNtceDt는 collector의 recordDate가, bidNtceNo/bfSpecRgstNo는 recordKey가 쓴다.
  // 이 둘이 빠지면 증분 병합이 깨지므로 반드시 유지한다.
  bid: [
    "bidNtceNo", "ntceKindNm", "bidNtceNm", "bidNtceDt", "bidClseDt", "rgstDt",
    "dminsttCd", "dminsttNm", "rlDminsttNm", "ntceInsttNm",
    ...SERIES("ntceSpecDocUrl", 10), ...SERIES("ntceSpecFileNm", 10),
  ],
  pre: [
    "bfSpecRgstNo", "bsnsDivNm", "prdctClsfcNoNm", "rgstDt", "opninRgstClseDt",
    "orderInsttNm", "rlDminsttNm",
    ...SERIES("specDocFileUrl", 5), ...SERIES("specDocFileNm", 5),
  ],
};

function modeOf(row) { return row.bidNtceNo ? "bid" : row.bfSpecRgstNo ? "pre" : ""; }

// 원본에 없는 컬럼은 만들지 않는다. 모드를 판별할 수 없으면 원본을 그대로 둔다.
function project(row, mode = modeOf(row)) {
  const keep = SERVICE_COLUMNS[mode];
  if (!keep) return row;
  const result = {};
  for (const key of keep) if (key in row) result[key] = row[key];
  return result;
}

module.exports = { project };
