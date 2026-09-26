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

test("품질 CI는 잠금 설치·테스트·의존성 검사·브라우저 검증을 포함한다", () => {
  for (const command of ["npm ci", "npm test", "npm run test:runtime", "npm audit --audit-level=high", "npx wrangler deploy --dry-run", "npm run test:browser", "npm run test:search-load"]) assert.ok(source.includes(`run: ${command}`), command);
  const actions = [...source.matchAll(/uses:\s*([^\s]+)@([^\s]+)/g)];
  assert.equal(actions.length, 3);
  for (const action of actions) assert.match(action[2], /^[a-f0-9]{40}$/);
  assert.match(source, /retention-days:\s*7/);
  assert.ok(source.includes("run: npm run test:runtime-browser"));
  assert.ok(source.indexOf("run: npx playwright-core install") < source.indexOf("run: npm run test:runtime-browser"));
});
