const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyEquipment } = require("./equipment");
const source = "ECR-001 서버 2대, 각 서버당 메모리 256GB 이상 장착. 기존 스토리지 Usable 100TB 이상 증설.";
function item(value = "각 서버당 메모리 256GB 이상", evidence = "각 서버당 메모리 256GB 이상 장착.") {
  return { id: "ECR-001", 세부내용_원문: source, 장비요약: [{ 종류: "서버", 명칭: "업무 서버", 규격: [{ 항목: "메모리", 값: value, 근거: evidence }] }] };
}
test("지어낸 값, 다른 ECR의 근거, Raw/Usable 추정은 통과하지 않는다", () => {
  assert.equal(verifyEquipment([item("512GB")], source).length, 1);
  assert.equal(verifyEquipment([item("Raw 100TB", "Raw 100TB")], source).length, 1);
  assert.equal(verifyEquipment([item("CPU 64코어", "CPU 64코어")], source + " CPU 64코어").length, 1);
});
