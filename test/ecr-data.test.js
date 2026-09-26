const test = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../public/equipment.js");

test("구형 선택 필드 누락과 정상 빈 분석은 보존한다", () => {
  for (const data of [{ ecr: [] }, { ecr: [{ id: "ECR-001", 기본규격: [{ 수량: "2대" }] }] }]) assert.equal(validate(data), data);
});

test("화면과 CSV에서 객체가 정상 텍스트처럼 출력되지 않도록 스칼라 필드를 검사한다", () => {
  for (const key of ["provider", "model", "analyzedAt"]) assert.throws(() => validate({ ecr: [], [key]: {} }), /형식/);
  for (const schemaVersion of ["2", 0, -1, 1.5, null]) assert.throws(() => validate({ ecr: [], schemaVersion }), /형식/);
  for (const key of ["id", "분류", "명칭", "세부내용_원문", "출처"]) {
    assert.throws(() => validate({ ecr: [{ [key]: ["문자열처럼 보임"] }] }), /형식/);
  }
  for (const key of ["구분", "항목", "요구사항", "수량"]) {
    assert.throws(() => validate({ ecr: [{ 기본규격: [{ [key]: {} }] }] }), /형식/);
  }
  for (const key of ["종류", "명칭", "출처"]) {
    assert.throws(() => validate({ ecr: [{ 장비요약: [{ [key]: {}, 규격: [] }] }] }), /형식/);
  }
  assert.throws(() => validate({ ecr: [], coverage: { status: {} } }), /형식/);
  const legacy = { ecr: [{ 기본규격: [{ 수량: 2 }] }] };
  assert.equal(validate(legacy), legacy);
});

test("원문 확인 표시는 항목·값·근거가 모두 있어야 소비할 수 있다", () => {
  const valid = { 항목: "메모리", 값: "256GB 이상", 근거: "메모리 256GB 이상", 검증: "원문 확인" };
  const wrap = (fact) => ({ ecr: [{ 장비요약: [{ 종류: "서버", 규격: [fact] }] }] });
  const data = wrap(valid);
  assert.equal(validate(data), data);
  for (const key of ["항목", "값", "근거"]) {
    for (const value of [undefined, "", " \n\t"]) assert.throws(() => validate(wrap({ ...valid, [key]: value })), /형식/);
  }
  // 미검증 결과는 없는 근거를 확인했다고 승격시키지 않고 그대로 보존한다.
  const uncertain = wrap({ 항목: "메모리", 값: "256GB", 검증: "확인 필요" });
  assert.equal(validate(uncertain), uncertain);
});
test("손상된 ECR 항목·규격·경고 구조와 문자열 검증 상태를 거부한다", () => {
  for (const data of [
    { ecr: [null] }, { ecr: [[]] }, { ecr: [{ 불확실: "warning" }] },
    { ecr: [{ 산출물: [null] }] }, { ecr: [{ 기본규격: [null] }] },
    { ecr: [{ 장비요약: {} }] }, { ecr: [{ 장비요약: [{ 규격: [null] }] }] },
    { ecr: [{ 장비요약: [{ 규격: [{ 값: {} }] }] }] },
    { ecr: [], verified: "false" }, { ecr: [], verification: { warnings: {} } },
    { ecr: [], coverage: { missingIds: "ECR-001" } }, { ecr: [], sourceFiles: [1] },
  ]) assert.throws(() => validate(data), /형식/);
});
