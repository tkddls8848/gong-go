// verifyExtraction은 모델 출력을 믿을지 말지를 정하는 유일한 관문이다. 로컬 소형 모델에서는
// 총괄표와 상세가 어긋나는 일이 흔해서, 여기서 걸러지지 않으면 틀린 분석이 그대로 저장된다.
const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyExtraction } = require("./verify");

const FIRST = "공통 장비 구성과 설치 계획 및 운영 절차를 제안서에 상세하게 제출하여야 한다.";
const SECOND = "서버 CPU와 메모리 요구사항 및 장애 대응 방안을 제안서에 충실하게 기술하여야 한다.";
const MARKDOWN = `ECR-COM-01 ${FIRST}\nECR-HW-01 ${SECOND}`;

function result(overrides = {}) {
  return {
    요구사항수: 2,
    요구사항목록: [{ ID: "ECR-COM-01" }, { ID: "ECR-HW-01" }],
    ecr: [{ id: "ECR-COM-01", 세부내용_원문: FIRST }, { id: "ECR-HW-01", 세부내용_원문: SECOND }],
    ...overrides,
  };
}

test("총괄표에 없는 ECR을 지어내도 잡는다", () => {
  const check = verifyExtraction(result({ ecr: [...result().ecr, { id: "ECR-SW-99", 세부내용_원문: FIRST }] }), MARKDOWN);
  assert.equal(check.verified, false);
  assert.ok(check.errors.some((error) => error.includes("총괄표에 없는 ECR")));
});

