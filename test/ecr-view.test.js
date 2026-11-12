const test = require("node:test");
const assert = require("node:assert/strict");
const { createEcrView } = require("../public/ecr-view.js");
const { html, format } = require("../public/format.js");
const EquipmentSummary = require("../public/equipment.js");

test("빈 ECR은 verified 플래그가 있어도 검증 통과로 표시하지 않는다", () => {
  let captured = "";
  const content = { set innerHTML(value) { captured = value; } };
  const { renderEcr: render } = createEcrView({ $: () => content, html, document: { querySelectorAll: () => [] }, EquipmentSummary });
  render({ verified: true, ecr: [] });
  assert.match(captured, /ecr-status unverified/);
  assert.match(captured, /요구사항이 없다는 뜻은 아닙니다/);
  assert.doesNotMatch(captured, /자동 검증 통과/);
});
