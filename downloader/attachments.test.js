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

test("첨부 슬롯 수는 본공고 10개, 사전공고 5개다", () => {
  const bid = { bidNtceNo: "1" };
  for (let index = 1; index <= 12; index += 1) bid[`ntceSpecDocUrl${index}`] = `https://example.go.kr/f/${index}`;
  // 11·12번째는 원본에 있어도 읽지 않는다.
  assert.equal(normalizeFiles(bid).length, 10);

  const pre = { bfSpecRgstNo: "1" };
  for (let index = 1; index <= 7; index += 1) pre[`specDocFileUrl${index}`] = `https://example.go.kr/f/${index}`;
  assert.equal(normalizeFiles(pre).length, 5);
});

test("다운로더는 URL이 있는 슬롯만 남기고 이름이 없으면 URL에서 찾는다", () => {
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

// 아래는 저장 형식(BOM + 헤더 + ="값")을 읽는 쪽의 계약이다. 입력은 수집기가 실제로 쓰는
// 바이트를 그대로 적어 둔다 — collector/csv-record.js를 require하지 않는 이유는 그 파일이
// 바뀐다고 다운로더가 함께 멈추면 안 되기 때문이다(README 모듈 경계).
test("저장된 CSV에서 값을 되읽는다", () => {
  const text = '\uFEFFbidNtceNo,bidNtceNm,ntceInsttNm\n'
    + '"=""20230100056""","=""교복(하복, 동복) 구매""","=""성수고등학교"""\n';
  assert.deepEqual(parseCsv(text), [
    // 앞자리 0과 긴 공고번호가 숫자로 바뀌지 않게 감싼 것을 그대로 벗긴다.
    { bidNtceNo: "20230100056", bidNtceNm: "교복(하복, 동복) 구매", ntceInsttNm: "성수고등학교" },
  ]);
});

test("따옴표 안의 쉼표·개행·따옴표는 셀을 가르지 않는다", () => {
  const text = '\uFEFFa,b\n"=""1차\n2차""","=""he said ""hi"""""\n';
  assert.deepEqual(parseCsv(text), [{ a: "1차\n2차", b: 'he said "hi"' }]);
});

test("빈 셀은 빈 문자열이고 헤더만 있으면 행이 없다", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\n"=""1""",\n'), [{ a: "1", b: "" }]);
  assert.deepEqual(parseCsv('\uFEFFa,b\n'), []);
  assert.deepEqual(parseCsv(""), []);
});
