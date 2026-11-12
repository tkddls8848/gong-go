const test = require("node:test");
const assert = require("node:assert/strict");
const { retryPlan, mergeRetry } = require("../public/ecr-retry.js");

const usable = (id, value = "256GB") => ({ id, 명칭: id, 불확실: [], 장비요약: [{ 종류: "서버", 규격: [{ 항목: "메모리", 값: value, 근거: value, 검증: "원문 확인" }] }] });
const empty = (id, reason = "메모리: 모델이 가리킨 원문 줄(9~9)을 확인할 수 없어 제외함") => ({ id, 명칭: id, 불확실: [reason], 장비요약: [{ 종류: "서버", 규격: [] }] });
const previous = () => ({
  schemaVersion: 2, verified: false, analyzedAt: "2026-10-08T00:00:00Z", sourceFiles: ["rfp.pdf"],
  ecr: [usable("ECR-001"), empty("ECR-002")], 누락: ["ECR-002", "ECR-003"],
  coverage: { status: "partial", expectedIds: ["ECR-001", "ECR-002", "ECR-003"], matchedIds: ["ECR-001"], missingIds: ["ECR-002", "ECR-003"], unexpectedIds: ["ECR-X"] },
  verification: { errors: [], warnings: ["이전 경고"] },
});

test("번호 대조가 끝난 결과에서만 누락 번호와 이어받을 번호를 만든다", () => {
  assert.deepEqual(retryPlan(previous()), { focus: ["ECR-002", "ECR-003"], matched: ["ECR-001"], unexpected: ["ECR-X"] });
  assert.equal(retryPlan({ ...previous(), coverage: undefined }), null, "대조 목록이 없으면 무엇이 빠졌는지 모른다");
  assert.equal(retryPlan({ ...previous(), 누락: [], coverage: { ...previous().coverage, missingIds: [] } }), null);
});

test("되찾은 번호는 새 항목으로 바꾸고, 여전히 비는 번호는 직전 사유를 남긴다", () => {
  const before = previous();
  const snapshot = JSON.stringify(before);
  const retry = {
    analyzedAt: "2026-10-08T01:00:00Z", ecr: [usable("ECR-002", "512GB"), empty("ECR-003")], 누락: ["ECR-003"],
    coverage: { status: "partial", expectedIds: ["ECR-001", "ECR-002", "ECR-003"], matchedIds: ["ECR-001", "ECR-002"], missingIds: ["ECR-003"], unexpectedIds: ["ECR-X"], warnings: [] },
    verification: { errors: [], warnings: ["서버 경고"] },
    retry: { focus: ["ECR-002", "ECR-003"], recovered: ["ECR-002"] },
  };
  const merged = mergeRetry(before, retry);
  assert.equal(JSON.stringify(before), snapshot, "직전 결과를 고치지 않는다");
  assert.deepEqual(merged.ecr.map((item) => [item.id, item.장비요약[0].규격[0]?.값 || ""]), [["ECR-001", "256GB"], ["ECR-002", "512GB"], ["ECR-003", ""]]);
  assert.deepEqual(merged.누락, ["ECR-003"]);
  assert.equal(merged.coverage, retry.coverage, "서버가 문서 전체 기준으로 다시 대조한 목록을 쓴다");
  assert.equal(merged.verified, false);
  assert.deepEqual(merged.verification.errors, ["ECR-003: 메모리: 모델이 가리킨 원문 줄(9~9)을 확인할 수 없어 제외함"]);
  assert.match(merged.verification.warnings.at(-1), /2개를 다시 분석해 1개의 규격을 찾아/);
  assert.deepEqual(merged.sourceFiles, ["rfp.pdf"]);
  assert.equal(retryPlan(merged), null, "이미 다시 물은 번호는 또 묻지 않는다");
});

