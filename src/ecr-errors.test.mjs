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
