// 다운로더가 제 모듈 안에 가진 것들. 행에서 값을 뽑는 우선순위, 첨부 슬롯 수, 파일명 정리,
// 그리고 저장된 CSV를 읽는 파서까지 여기서 고정한다 — collector의 사본이 바뀌어도 이 테스트는
// "파일 형식"만 보므로 그대로 성립해야 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName } = require("./attachments");

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

test("본공고는 제안요청정보 첨부를 공고 첨부 뒤에 잇고, 사전공고는 읽지 않는다", () => {
  const bid = { bidNtceNo: "1", ntceSpecDocUrl1: "https://www.g2b.go.kr/a", ntceSpecFileNm1: "공고문.hwp",
    eorderAtchFileUrl1: "https://www.g2b.go.kr/rfp/6", eorderAtchFileNm1: "제안요청서.hwp", eorderAtchFileUrl2: "", eorderAtchFileNm2: "" };
  assert.deepEqual(normalizeFiles(bid).map((file) => file.name), ["공고문.hwp", "제안요청서.hwp"]);
  assert.deepEqual(normalizeFiles({ bfSpecRgstNo: "1", eorderAtchFileUrl1: "https://www.g2b.go.kr/rfp/6" }), []);
});

test("파일명은 경로와 금지 문자를 없애고 길이를 자른다", () => {
  // 다운로더가 이 값으로 디스크에 쓴다. 경로가 남으면 data/ 밖으로 나간다.
  // 상위 이동은 basename에서 떨어지고 이름만 남는다(점 파일 자체는 이름으로 허용된다).
  assert.equal(safeFileName("../../.env"), ".env");
  assert.equal(safeFileName("/etc/passwd"), "passwd");
  // 역슬래시는 Windows에서만 경로 구분자라 basename 결과가 플랫폼마다 다르다.
  // 어느 쪽이든 구분자가 남지 않아야 한다.
  const windowsPath = safeFileName("C:\\Windows\\system32\\drivers\\etc\\hosts");
  assert.match(windowsPath, /hosts$/);
  assert.doesNotMatch(windowsPath, /[\\/:]/);
  assert.equal(safeFileName("규격서<1>:*?.hwp"), "규격서_1____.hwp");
  assert.equal(safeFileName(".."), "_");
  assert.equal(safeFileName(""), "attachment");
  assert.equal(safeFileName("", "기본값"), "기본값");
  assert.equal(safeFileName("가".repeat(300)).length, 180);
});

test("따옴표 안의 쉼표·개행·따옴표는 셀을 가르지 않는다", () => {
  const text = '\uFEFFa,b\n"=""1차\n2차""","=""he said ""hi"""""\n';
  assert.deepEqual(parseCsv(text), [{ a: "1차\n2차", b: 'he said "hi"' }]);
});

