// verifyExtraction은 모델 출력을 믿을지 말지를 정하는 유일한 관문이다. 로컬 소형 모델에서는
// 총괄표와 상세가 어긋나는 일이 흔해서, 여기서 걸러지지 않으면 틀린 분석이 그대로 저장된다.
const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyExtraction, ecrIds } = require("./verify");

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

test("verifies IDs and original-detail excerpts without assuming a numeric ID pattern", () => {
  const check = verifyExtraction(result(), MARKDOWN);
  assert.equal(check.verified, true);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.warnings, []);
  assert.deepEqual(check.missing, []);
});

test("총괄표에 있는데 상세가 빠지면 누락으로 잡는다", () => {
  // Pass B의 ID 구간 분할에서 한 덩이가 통째로 빠지는 것이 가장 흔한 실패다.
  const check = verifyExtraction(result({ ecr: [{ id: "ECR-COM-01", 세부내용_원문: FIRST }] }), MARKDOWN);
  assert.equal(check.verified, false);
  assert.deepEqual(check.missing, ["ECR-HW-01"]);
  assert.ok(check.errors.some((error) => error.includes("상세 추출 누락")));
});

test("총괄표에 없는 ECR을 지어내도 잡는다", () => {
  const check = verifyExtraction(result({ ecr: [...result().ecr, { id: "ECR-SW-99", 세부내용_원문: FIRST }] }), MARKDOWN);
  assert.equal(check.verified, false);
  assert.ok(check.errors.some((error) => error.includes("총괄표에 없는 ECR")));
});

test("선언한 요구사항 수와 목록 길이가 다르면 잡는다", () => {
  const check = verifyExtraction(result({ 요구사항수: 5 }), MARKDOWN);
  assert.equal(check.verified, false);
  assert.ok(check.errors.some((error) => error.includes("선언 5, 목록 2")));
  // 수를 아예 주지 않으면 그 검사만 건너뛴다.
  assert.equal(verifyExtraction(result({ 요구사항수: null }), MARKDOWN).verified, true);
});

test("원문이 짧거나 변환 텍스트에 없으면 지어낸 것으로 본다", () => {
  // 40자 대조가 핵심이다. 모델이 요약하거나 창작하면 여기서 걸린다.
  const short = verifyExtraction(result({ ecr: [{ id: "ECR-COM-01", 세부내용_원문: "짧은 원문" }, { id: "ECR-HW-01", 세부내용_원문: SECOND }] }), MARKDOWN);
  assert.ok(short.errors.some((error) => error.includes("너무 짧음")));

  const invented = verifyExtraction(result({ ecr: [{ id: "ECR-COM-01", 세부내용_원문: "이 문장은 변환 Markdown 어디에도 없는 충분히 긴 창작 문장이다." }, { id: "ECR-HW-01", 세부내용_원문: SECOND }] }), MARKDOWN);
  assert.ok(invented.errors.some((error) => error.includes("확인되지 않음")));
});

test("공백 차이는 대조에서 무시한다", () => {
  // HWPX 변환은 줄바꿈과 연속 공백을 원문과 다르게 낸다. 그것까지 실패로 보면 전부 실패한다.
  const spaced = FIRST.replace(/ /g, "\n  ");
  assert.equal(verifyExtraction(result({ ecr: [{ id: "ECR-COM-01", 세부내용_원문: spaced }, { id: "ECR-HW-01", 세부내용_원문: SECOND }] }), MARKDOWN).verified, true);
});

test("변환 텍스트에서 ID를 못 찾으면 경고일 뿐 실패가 아니다", () => {
  // 표 안의 ID는 변환 과정에서 깨지기도 한다. 원문 대조가 통과했다면 막지 않는다.
  const check = verifyExtraction(result(), `${FIRST}\n${SECOND}`);
  assert.equal(check.verified, true);
  assert.equal(check.errors.length, 0);
  assert.ok(check.warnings[0].includes("ECR-COM-01"));
});

test("ecrIds는 ECR로 시작하는 것만 모으고 ID·id를 함께 읽는다", () => {
  // 총괄표에 다른 체계의 요구사항(SFR·PER 등)이 섞여 있어도 ECR만 센다.
  assert.deepEqual([...ecrIds([{ ID: "ECR-COM-01" }, { id: "ecr-hw-01" }, { ID: "SFR-001" }, { ID: "" }, {}])], ["ECR-COM-01", "ecr-hw-01"]);
  assert.deepEqual([...ecrIds(null)], []);
  // 한글 문서에서 하이픈이 en dash로 바뀌어 오는 경우가 있다.
  assert.deepEqual([...ecrIds([{ ID: " ECR–COM–01 " }])], ["ECR–COM–01"]);
});
