// 워크플로 전체 실행 검증이 아니라 안전 경계와 필수 단계의 정적 계약이다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../.github/workflows/quality.yml"), "utf8");

test("품질 CI는 시크릿·운영 배포·수집 작업을 실행하지 않는다", () => {
  assert.doesNotMatch(source, /secrets\.|pull_request_target|write-all|contents:\s*write/);
  assert.match(source, /contents:\s*read/);
  assert.match(source, /persist-credentials:\s*false/);
  for (const match of source.matchAll(/^\s*run:\s*(.+)$/gm)) {
    const command = match[1];
    if (/wrangler deploy/.test(command)) assert.match(command, /--dry-run/);
    assert.doesNotMatch(command, /npm run (?:collect|upload|deploy)|wrangler secret/);
  }
});

