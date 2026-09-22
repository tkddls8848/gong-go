const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyEquipment } = require("./equipment");
const { completeSource } = require("./source");
const { ECR_SCHEMA, SCHEMA_VERSION } = require("./spec-schema");
const source = "ECR-001 서버 2대, 각 서버당 메모리 256GB 이상 장착. 기존 스토리지 Usable 100TB 이상 증설.";
function item(value = "각 서버당 메모리 256GB 이상", evidence = "각 서버당 메모리 256GB 이상 장착.") {
  return { id: "ECR-001", 세부내용_원문: source, 장비요약: [{ 종류: "서버", 명칭: "업무 서버", 규격: [{ 항목: "메모리", 값: value, 근거: evidence }] }] };
}
test("장비당 조건과 이상 표현을 보존한 규격은 원문과 대조된다", () => {
  const data = item();
  assert.deepEqual(verifyEquipment([data], source), []);
  assert.equal(data.장비요약[0].규격[0].검증, "원문 확인");
});
test("지어낸 값, 다른 ECR의 근거, Raw/Usable 추정은 통과하지 않는다", () => {
  assert.equal(verifyEquipment([item("512GB")], source).length, 1);
  assert.equal(verifyEquipment([item("Raw 100TB", "Raw 100TB")], source).length, 1);
  assert.equal(verifyEquipment([item("CPU 64코어", "CPU 64코어")], source + " CPU 64코어").length, 1);
});
test("요약 누락과 장비 없음은 구별한다", () => {
  assert.equal(verifyEquipment([{ id: "ECR-001" }], source).length, 1);
  assert.deepEqual(verifyEquipment([{ id: "ECR-001", 장비요약: [] }], source), []);
  assert.equal(SCHEMA_VERSION, 2);
  assert.ok(ECR_SCHEMA.properties.ecr.items.required.includes("장비요약"));
});
test("긴 규격의 후반부와 복수 문서를 보존하고 한도 초과는 명시적으로 실패한다", () => {
  const docs = [{ name: "제안요청서", text: "내용".repeat(4000) + " 마지막 유지보수 5년" }, { name: "별첨", text: "Usable 100TB" }];
  const text = completeSource(docs, "규격 추출", 65536);
  assert.ok(text.includes("마지막 유지보수 5년"));
  assert.ok(text.includes("Usable 100TB"));
  assert.throws(() => completeSource(docs, "규격 추출", 8192), /원문을 자르지 않았습니다/);
});
