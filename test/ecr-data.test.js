const test = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../public/equipment.js");

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
