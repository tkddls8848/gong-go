const test = require("node:test");
const assert = require("node:assert/strict");
const { score } = require("./eval-pdf-vision.cjs");

test("빈 응답으로 양성 표본을 통과하지 않고 명시적인 음성 표본만 통과한다", () => {
  assert.equal(score({ ecr: [] }, { ids: ["ECR-001"], facts: [] }).passed, false);
  assert.equal(score({ ecr: [] }, { ids: [], facts: [] }).passed, true);
  assert.throws(() => score({ ecr: [] }, {}), /labels/);
});
