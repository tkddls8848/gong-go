// ============================================================
// config.js — 튜닝 상수 · 관심기관 · API 모드 정의 (사전공고 / 입찰공고)
//  · 동작·필드·엔드포인트 변경은 대부분 이 파일만 수정 → LLM 편집 시 이 파일만 열면 됨
//  · 엔진/UI 골격은 app.js. 두 파일은 전역 스코프를 공유하며 index.html에서 config.js를 먼저 로드
// ============================================================
 
// 동시 요청 수. 오픈API에서 429/한도 오류가 뜨면 3~4로 낮추세요.
const CONCURRENCY = 6;
 
// 한 페이지 결과 수 (실측 상한 999)
const NUM_OF_ROWS = 999;
 
// API 조회기간 제한 (일). 실측 30일.
const MAX_RANGE_DAYS = 30;
 
// 기간 초과 오류 시 재분할 최대 깊이
const MAX_SPLIT_DEPTH = 6;
 
// 전체 다운로드 시 파일 간 간격(ms)
const DOWNLOAD_INTERVAL = 700;
 
const COLUMNS = [
  "수요기관명",
  "업무구분",
  "사업명",
  "입찰공고번호",
  "입찰공고일시",
  "입찰마감일시",
];
 
const DEFAULT_INSTITUTIONS = [
  { name: "국민건강보험공단", code: "" },
  { name: "건강보험심사평가원", code: "" },
  { name: "국민건강보험공단 일산병원", code: "" },
  { name: "보건복지부", code: "" },
  { name: "한국사회보장정보원", code: "" },
  { name: "국민연금공단", code: "" },
  { name: "한국고용정보원", code: "" },
  { name: "재단법인자동차손해배상진흥원", code: "" },
  { name: "공영홈쇼핑", code: "" },
  { name: "한국지능정보사회진흥원", code: "" },
];
 
const norm = (v) => String(v ?? "").replace(/\s+/g, "").trim();
 
// 사전규격 API는 파일명을 제공하지 않아 URL에서 추정하거나 순번 라벨로 표시합니다.
function guessFileName(url, index = 0) {
  try {
    const u = new URL(url);
 
    const nameParam =
      u.searchParams.get("fileNm") ||
      u.searchParams.get("orgFileNm") ||
      u.searchParams.get("fileName");
    if (nameParam) return decodeURIComponent(nameParam);
 
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    if (last.includes(".") && !/\.(do|jsp|php|asp|aspx)$/i.test(last)) {
      return decodeURIComponent(last);
    }
 
    const seq = u.searchParams.get("fileSeq") || u.searchParams.get("seq");
    return `첨부파일 ${seq || index + 1}`;
  } catch (e) {
    return `첨부파일 ${index + 1}`;
  }
}
 
// ============================================================
// 모드 정의: 두 앱의 차이를 이 설정 객체 안에 캡슐화
// ============================================================
const MODES = {
  // ---------- 사전공고 (사전규격정보서비스) ----------
  pre: {
    key: "pre",
    label: "사전공고",
    title: "나라장터 사전공고 조회",
    subtitle: "조달청 공식 오픈API 기반 · 관심 기관의 사전규격 공고 현황을 조회합니다.",
    periodLabel: "조회 기간",
    resultsHint: "사업명을 클릭하면 해당 공고의 규격서·제안요청서 등 첨부파일을 확인하고 일괄 내려받을 수 있습니다.",
    resultNoun: "공고",
    csvName: "사전공고현황",
    baseUrl: "/api/1230000/ao/HrcspSsstndrdInfoService",
    inqryDiv: "1",
    operations: {
      물품: "getPublicPrcureThngInfoThngPPSSrch",
      외자: "getPublicPrcureThngInfoFrgcptPPSSrch",
      용역: "getPublicPrcureThngInfoServcPPSSrch",
      공사: "getPublicPrcureThngInfoCnstwkPPSSrch",
    },
    // 사전규격은 실수요기관(rl*)까지 함께 매칭
    matchesInstitution(item, inst) {
      if (inst.code) {
        const target = norm(inst.code);
        return [item.dminsttCd, item.rlDminsttCd].some((c) => norm(c) === target);
      }
      const target = norm(inst.name);
      return [item.dminsttNm, item.rlDminsttNm].some((n) => norm(n) === target);
    },
    dedupKey(item, bsnsDiv) {
      const no = String(item.bfSpecRgstNo || "").trim();
      return no ? `${bsnsDiv}::${no}` : "";
    },
    mapRow(item, bsnsDiv) {
      return {
        수요기관명: item.rlDminsttNm || item.dminsttNm || "",
        업무구분: bsnsDiv,
        사업명: item.prdctClsfcNoNm || "",
        입찰공고번호: String(item.bfSpecRgstNo || "").trim(),
        입찰공고일시: item.rgstDt || "",
        입찰마감일시: item.opninRgstClseDt || "",
      };
    },
    // 첨부파일: specDocFileUrl1~5 (파일명 미제공)
    extractFiles(item) {
      const files = [];
      for (let i = 1; i <= 5; i++) {
        const url = String(item[`specDocFileUrl${i}`] ?? "").trim();
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (files.some((f) => f.url === url)) continue;
        files.push({ url, name: guessFileName(url, files.length) });
      }
      return files;
    },
    sortDesc: true,
  },
 
  // ---------- 입찰공고 (본공고, 입찰공고정보서비스) ----------
  bid: {
    key: "bid",
    label: "입찰공고(본공고)",
    title: "나라장터 입찰공고(본공고) 일괄조회",
    subtitle: "조달청 공식 오픈API 기반 · 관심 기관의 입찰공고 현황을 조회합니다. (1차 참고용 - 상세 확인은 나라장터에서 직접 확인하세요)",
    periodLabel: "조회 기간 (공고게시일시 기준)",
    resultsHint: "사업명을 클릭하면 해당 공고의 공고서·제안요청서 등 첨부파일을 확인하고 일괄 내려받을 수 있습니다.",
    resultNoun: "입찰공고",
    csvName: "입찰공고현황",
    baseUrl: "/api/1230000/ad/BidPublicInfoService",
    inqryDiv: "1", // 1 = 공고게시일시
    operations: {
      물품: "getBidPblancListInfoThngPPSSrch",
      외자: "getBidPblancListInfoFrgcptPPSSrch",
      용역: "getBidPblancListInfoServcPPSSrch",
      공사: "getBidPblancListInfoCnstwkPPSSrch",
    },
    matchesInstitution(item, inst) {
      if (inst.code) {
        return norm(item.dminsttCd) === norm(inst.code);
      }
      return norm(item.dminsttNm) === norm(inst.name);
    },
    dedupKey(item, bsnsDiv) {
      const no = String(item.bidNtceNo || "").trim();
      const ord = String(item.bidNtceOrd || "").trim();
      return no ? `${bsnsDiv}::${no}::${ord}` : "";
    },
    mapRow(item, bsnsDiv) {
      return {
        수요기관명: item.dminsttNm || "",
        업무구분: bsnsDiv,
        사업명: item.bidNtceNm || "",
        입찰공고번호: String(item.bidNtceNo || "").trim(),
        입찰공고일시: item.bidNtceDt || "",
        입찰마감일시: item.bidClseDt || "",
      };
    },
    // 첨부파일: ntceSpecDocUrl1~10 + ntceSpecFileNm1~10 (파일명 제공)
    extractFiles(item) {
      const files = [];
      for (let i = 1; i <= 10; i++) {
        const url = String(item[`ntceSpecDocUrl${i}`] ?? "").trim();
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (files.some((f) => f.url === url)) continue;
        let name = String(item[`ntceSpecFileNm${i}`] ?? "").trim();
        if (!name) name = `첨부파일 ${i}`;
        files.push({ url, name });
      }
      return files;
    },
    sortDesc: true,
  },
};
 
// 세션 내 학습값(모드별): 기간 초과 오류가 나면 줄어듭니다.
MODES.pre.effectiveRangeDays = MAX_RANGE_DAYS;
MODES.bid.effectiveRangeDays = MAX_RANGE_DAYS;
 
let currentMode = MODES.pre;
 
