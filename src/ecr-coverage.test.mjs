import test from "node:test";
import assert from "node:assert/strict";
import { sourceCoverage, compareCoverage } from "./ecr-coverage.js";
import { requirementSections } from "./ecr-source.js";
const item = (id, facts = [{ 값: "256GB 이상", 검증: "원문 확인" }]) => ({ id, 장비요약: [{ 규격: facts }] });

test("선별된 상세 표와 미선별 번호를 구분하고 중복 번호를 합친다", () => {
  const manifest = sourceCoverage({ sections: [{ id: "ECR-001" }, { id: "ECR–001" }], ids: ["ECR-001", "ECR-002"] });
  assert.equal(manifest.expectedIds.length, 1);
  assert.deepEqual(manifest.excludedIds, ["ECR-002"]);
});
test("모델이 빈 목록을 반환해도 대상 번호의 누락을 기록한다", () => {
  const manifest = sourceCoverage(requirementSections("요구사항 번호 ECR-001\n요구사항 명칭 업무 서버\n세부내용 메모리 256GB 이상"));
  const result = compareCoverage(manifest, []);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.missingIds, ["ECR-001"]);
});
test("규격이 없거나 ID 근거가 불확실한 항목은 추출 완료로 세지 않는다", () => {
  const result = compareCoverage({ expectedIds: ["ECR-001", "ECR-002", "ECR-003"] }, [item("ECR-001", []), { ...item("ECR-002"), 불확실: ["요구사항 ID 원문 확인 필요"] }, item("ECR-003", [{ 값: "값", 검증: "확인 필요" }])]);
  assert.equal(result.missingIds.length, 3);
});
test("번호 일치는 완전성 검증으로 승격하지 않으며 범위 밖 번호를 드러낸다", () => {
  const result = compareCoverage({ expectedIds: ["ECR-001"] }, [item("ECR–001"), item("ECR-999")]);
  assert.equal(result.status, "matched");
  assert.equal(result.verified, undefined);
  assert.deepEqual(result.unexpectedIds, ["ECR-999"]);
});
test("구형 작업 또는 상세 표 미식별은 누락 없음이 아니라 확인 불가다", () => {
  for (const manifest of [undefined, { expectedIds: [], excludedIds: ["ECR-002"] }]) {
    const result = compareCoverage(manifest, []);
    assert.equal(result.status, "unknown");
    assert.ok(result.warnings.length);
  }
});
