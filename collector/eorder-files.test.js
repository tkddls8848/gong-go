const test = require("node:test");
const assert = require("node:assert/strict");
const { groupEorderFiles, mergeGroups } = require("./eorder-files");

const file = (bidNtceNo, bidNtceOrd, atchSno, eorderDocDivNm, eorderAtchFileNm, url = `https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadRfpFile.do?rfpNo=${bidNtceNo}&rfpOrd=${bidNtceOrd}&rfpUntyAtchFileNo=${atchSno}`) =>
  ({ bidNtceNo, bidNtceOrd, atchSno: String(atchSno), eorderDocDivNm, eorderAtchFileNm, eorderAtchFileUrl: url });

test("공고번호별로 묶고 제안요청서를 앞에, 나머지는 첨부 순번 순으로 둔다", () => {
  const groups = groupEorderFiles([
    file("R26BK1", "000", 5, "기타문서", "과업지시서.hwp"),
    file("R26BK1", "000", 6, "제안요청서", "제안요청서.hwp"),
    file("R26BK1", "000", 2, "기타문서", "붙임.pdf"),
    file("R26BK2", "000", 9, "제안요청서", "공고_제안요청서.hwpx"),
  ]);
  assert.deepEqual(groups.get("R26BK1").files.map((item) => item.name), ["제안요청서.hwp", "붙임.pdf", "과업지시서.hwp"]);
  assert.equal(groups.get("R26BK2").files.length, 1);
});

test("정정공고는 가장 높은 차수의 목록만 쓴다", () => {
  // 차수를 섞으면 수정 전 제안요청서가 함께 남는다.
  const groups = groupEorderFiles([
    file("R26BK1", "000", 1, "제안요청서", "제안요청서.hwp"),
    file("R26BK1", "001", 1, "제안요청서", "제안요청서(수정본).hwp"),
    file("R26BK1", "000", 2, "기타문서", "과업지시서.hwp"),
  ]);
  assert.equal(groups.get("R26BK1").ord, 1);
  assert.deepEqual(groups.get("R26BK1").files.map((item) => item.name), ["제안요청서(수정본).hwp"]);
  // 다른 범위에서 받은 낮은 차수가 나중에 와도 덮지 않는다.
  const merged = mergeGroups(new Map(groups), groupEorderFiles([file("R26BK1", "000", 1, "제안요청서", "제안요청서.hwp")]));
  assert.equal(merged.get("R26BK1").files[0].name, "제안요청서(수정본).hwp");
});

test("URL이 없거나 http(s)가 아닌 행, 같은 URL의 중복은 버린다", () => {
  const groups = groupEorderFiles([
    file("R26BK1", "000", 1, "제안요청서", "a.hwp", ""),
    file("R26BK1", "000", 2, "제안요청서", "b.hwp", "javascript:alert(1)"),
    file("R26BK1", "000", 3, "기타문서", "c.hwp", "https://www.g2b.go.kr/x"),
    file("R26BK1", "000", 4, "기타문서", "c 사본.hwp", "https://www.g2b.go.kr/x"),
    { bidNtceNo: "", eorderAtchFileUrl: "https://www.g2b.go.kr/y" },
  ]);
  assert.deepEqual([...groups.keys()], ["R26BK1"]);
  assert.deepEqual(groups.get("R26BK1").files.map((item) => item.name), ["c.hwp"]);
});

