const test = require("node:test");
const assert = require("node:assert/strict");
const { createEcrView } = require("../public/ecr-view.js");
const { html, numberOf, format } = require("../public/format.js");
const EquipmentSummary = require("../public/equipment.js");
test("모달 안의 기본규격 표도 가로 스크롤 상자 안에 있다", () => {
  const { specTable } = createEcrView({ html });
  const rendered = specTable([{ 구분: "서버", 항목: "CPU", 요구사항: "16코어 이상", 수량: "2대" }]);
  assert.match(rendered, /<div class="ecr-scroll"><table class="nested-spec">/);
  assert.match(rendered, /<\/table><\/div>$/, "표가 스크롤 상자 밖에서 끝난다");
  assert.equal(specTable([]), "");
});

test("제외된 규격의 사유는 요약 상자에만 두고 경고 묶음에서는 뺀다", () => {
  // EquipmentSummary가 결과 머리에 전용 상자로 세어 모은다. 여기서도 내면 같은 문장이 두 번
  // 나오고, 정작 확인해야 할 다른 불확실 메시지가 그 사이에 묻힌다.
  let captured = "";
  const content = { set innerHTML(value) { captured = value; } };
  const { renderEcr: run } = createEcrView({ $: () => content, html, document: { querySelectorAll: () => [] }, EquipmentSummary });
  run({ 누락: ["ECR-010"], verification: { errors: ["ECR-002 수량 불일치"] }, ecr: [{ id: "ECR-001", 불확실: ["CPU를 원문에서 확인하지 못해 제외함", "쪽 번호가 어긋남"] }] });
  assert.ok(!captured.includes("제외함"), "제외 사유가 경고 묶음에 또 나온다");
  assert.ok(captured.includes("쪽 번호가 어긋남"), "제외가 아닌 불확실 메시지는 그대로 남아야 한다");
  assert.ok(captured.includes("ECR-002 수량 불일치"), "검증 오류는 그대로 남아야 한다");
  assert.ok(captured.includes("누락: ECR-010"), "누락 안내는 그대로 남아야 한다");
});

test("빈 ECR은 verified 플래그가 있어도 검증 통과로 표시하지 않는다", () => {
  let captured = "";
  const content = { set innerHTML(value) { captured = value; } };
  const { renderEcr: render } = createEcrView({ $: () => content, html, document: { querySelectorAll: () => [] }, EquipmentSummary });
  render({ verified: true, ecr: [] });
  assert.match(captured, /ecr-status unverified/);
  assert.match(captured, /요구사항이 없다는 뜻은 아닙니다/);
  assert.doesNotMatch(captured, /자동 검증 통과/);
});
