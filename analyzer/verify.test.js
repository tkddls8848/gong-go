const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyExtraction } = require("./verify");

test("verifies IDs and original-detail excerpts without assuming a numeric ID pattern", () => {
  const first = "공통 장비 구성과 설치 계획 및 운영 절차를 제안서에 상세하게 제출하여야 한다.";
  const second = "서버 CPU와 메모리 요구사항 및 장애 대응 방안을 제안서에 충실하게 기술하여야 한다.";
  const result = { 요구사항수: 2, 요구사항목록: [{ ID: "ECR-COM-01" }, { ID: "ECR-HW-01" }], ecr: [{ id: "ECR-COM-01", 세부내용_원문: first }, { id: "ECR-HW-01", 세부내용_원문: second }] };
  const check = verifyExtraction(result, `ECR-COM-01 ${first}\nECR-HW-01 ${second}`);
  assert.equal(check.verified, true);
});
