const test = require("node:test");
const assert = require("node:assert/strict");
const { score } = require("./eval-pdf-vision.cjs");

test("같은 숫자가 있어도 장비·항목·적용 구분이 다르면 점검 통과가 아니다", () => {
  const report = { ecr: [{ id: "ECR-001", 적용구분: "DR", 장비요약: [{ 규격: [{ 항목: "메모리", 값: "256GB 이상" }] }] }] };
  const label = { ids: ["ECR-001"], facts: [{ id: "ECR-001", scope: "운영", field: "메모리", contains: ["256GB", "이상"] }] };
  assert.equal(score(report, label).passed, false);
  label.facts[0].scope = "DR";
  assert.equal(score(report, label).passed, true);
  label.facts[0].field = "Usable 용량";
  assert.equal(score(report, label).passed, false);
});

test("빈 응답으로 양성 표본을 통과하지 않고 명시적인 음성 표본만 통과한다", () => {
  assert.equal(score({ ecr: [] }, { ids: ["ECR-001"], facts: [] }).passed, false);
  assert.equal(score({ ecr: [] }, { ids: [], facts: [] }).passed, true);
  assert.throws(() => score({ ecr: [] }, {}), /labels/);
});
