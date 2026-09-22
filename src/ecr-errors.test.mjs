import test from "node:test";
import assert from "node:assert/strict";
import { ecrError } from "./ecr-errors.js";
test("PDF 변환/저장 장애는 뉴런 소진으로 표시하지 않고 발생 단계를 보존한다", () => {
  for (const stage of ["convert", "saveDocument", "budget", "savePart"]) {
    const result = ecrError(new Error("private document content and secret"), stage, "test-reference");
    assert.equal(result.body.stage, stage);
    assert.match(result.body.message, /test-reference/);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|할당량/);
  }
});
test("실제 모델의 할당량 소진과 혼잡 응답을 구분한다", () => {
  const quota = ecrError(new Error("AiError: 3036"), "inference", "ref");
  const busy = ecrError(new Error("AiError: 3040"), "inference", "ref");
  assert.equal(quota.status, 429);
  assert.match(quota.body.message, /무료 뉴런/);
  assert.equal(busy.status, 503);
  assert.match(busy.body.message, /혼잡/);
  assert.doesNotMatch(busy.body.message, /할당량/);
});
