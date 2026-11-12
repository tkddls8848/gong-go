const test = require("node:test");
const assert = require("node:assert/strict");
const { createNoticeView } = require("../public/notice-view.js");
const { html, numberOf, format } = require("../public/format.js");
const noticeView = createNoticeView({ html, numberOf, format });
const fs = require("node:fs");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");

test("분석 결과가 없는 본공고에도 목록 ECR 버튼이 있고 누르면 분석 탭으로 바로 들어간다", () => {
  const buttons = [], opened = [];
  const rows = [{ mode: "bid", title: "서버 구매" }, { mode: "pre" }, { mode: "plan" }];
  const titles = rows.map((_, index) => ({ dataset: { index: String(index) }, parentElement: { append: (button) => buttons.push(button) } }));
  const document = { querySelectorAll: () => titles, createElement: () => ({ setAttribute() {} }) };
  const { wireEcrEntrypoints: run } = createNoticeView({ document, openModal: (...args) => opened.push(args) });
  run(rows);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, "ECR 분석");
  buttons[0].onclick();
  assert.deepEqual(opened, [[rows[0], "ecr"]]);
  assert.match(read("app.js"), /wireEcrEntrypoints\(visible\)/);
  assert.match(read("notice-modal.js"), /selectTab\(initialTab\)/);
});

test("외부 링크는 HTTP(S)만 허용하고 실행 스킴과 제어문자 우회를 차단한다", () => {
  const { safeExternalUrl, detailLink } = noticeView;
  for (const value of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/secret", "//example.com/file", "https://user:password@example.com/file", "https://example.com/\tfile", "https://", {}, null]) {
    assert.equal(safeExternalUrl(value), "", String(value));
    assert.doesNotMatch(detailLink({ mode: "bid", detailUrl: value }), /<a /);
  }
  assert.equal(safeExternalUrl(" https://www.g2b.go.kr/file?a=1&b=2 "), "https://www.g2b.go.kr/file?a=1&b=2");
  assert.equal(safeExternalUrl("http://example.go.kr/file"), "http://example.go.kr/file");
});

test("깨진 첨부 항목은 실행 경로에서 제외하고 건수를 안내한다", () => {
  const { normalizeFiles, attachmentWarnings } = noticeView;
  const files = [null, { name: "악성", url: "javascript:alert(1)" }, { name: "정상.pdf", url: "https://example.go.kr/file" }];
  assert.deepEqual(normalizeFiles(files), [files[2]]);
  assert.match(attachmentWarnings(files), /첨부 링크 2건을 제외/);
  assert.equal(files.length, 3, "원본 데이터는 변경하지 않는다");
});

