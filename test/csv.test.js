const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/csv.js");

test("CSV 외부 텍스트의 수식 시작 및 선행 공백 우회는 텍스트로 내보낸다", () => {
  for (const value of ["=1+1", "+cmd", "-1+2", "@SUM(A1)", "  =1", "\t=1", "\r=1", "\n=1", "\u0000=1", "\t서버"]) {
    const exported = GongCsv.cell(value);
    assert.ok(exported.startsWith("'") || exported.startsWith('"\''), JSON.stringify(value));
  }
});

test("CSV 쉼표·따옴표·CR·LF는 셀 내부에 보존하며 정상 문자열은 변경하지 않는다", () => {
  assert.equal(GongCsv.cell('서버, "이중화"'), '"서버, ""이중화"""');
  assert.equal(GongCsv.cell("서버\r스토리지"), '"서버\r스토리지"');
  assert.equal(GongCsv.cell("서버\n스토리지"), '"서버\n스토리지"');
  assert.equal(GongCsv.cell("ECR-001"), "ECR-001");
  assert.equal(GongCsv.cell(null), "");
  assert.equal(GongCsv.serialize([["번호", "규격"], ["ECR-001", "256GB 이상"]]), "번호,규격\r\nECR-001,256GB 이상");
});

