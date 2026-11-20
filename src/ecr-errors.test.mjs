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
test("표에 없는 공급자 오류도 번호와 종류만 로그에 남겨 오류 번호로 원인을 찾게 한다", () => {
  const error = Object.assign(new Error("5021: private document content exceeded the context window"), { name: "AiError" });
  const result = ecrError(error, "inference", "test-reference");
  assert.equal(result.status, 502);
  assert.equal(result.log.providerCode, 5021);
  assert.equal(result.log.errorName, "AiError");
  assert.equal(result.body.code, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private|context window/);
  const plain = ecrError(new Error("Network connection lost. 1234: secret"), "inference", "test-reference");
  assert.equal(plain.log.providerCode, null);
  assert.equal(plain.log.errorName, "Error");
  const odd = ecrError(Object.assign(new Error("x"), { name: "secret document name 123" }), "inference", "test-reference");
  assert.equal(odd.log.errorName, null);
});
