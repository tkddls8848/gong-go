const test = require("node:test");
const assert = require("node:assert/strict");
const { createNoticeView } = require("../public/notice-view.js");
const { createExports } = require("../public/exports.js");
const { html, numberOf, format } = require("../public/format.js");
const noticeView = createNoticeView({ html, numberOf, format });
const fs = require("node:fs");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
const HTML = read("index.html");

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

test("상세 링크가 있는 공고는 모드와 무관하게 나라장터로 열 수 있다", () => {
  const { detailLink } = noticeView;
  const bid = detailLink({ mode: "bid", detailUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R25BK1&bidPbancOrd=000" });
  assert.match(bid, /href="https:\/\/www\.g2b\.go\.kr\/link\/PNPE027_01\/single\/\?bidPbancNo=R25BK1&amp;bidPbancOrd=000"/, "쿼리의 &가 이스케이프되지 않았다");
  assert.match(bid, /rel="noopener noreferrer"/);
  assert.match(bid, /나라장터 공고 상세 열기/);
  assert.match(detailLink({ mode: "plan", detailUrl: "https://example.go.kr/p" }), /나라장터 발주계획 상세 열기/);
  // 사전공고와, 컬럼을 추가하기 전에 모은 본공고에는 링크가 없다.
  assert.equal(detailLink({ mode: "pre" }), "");
  assert.equal(detailLink({ mode: "bid", detailUrl: "" }), "");
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

test("전체 다운로드도 화면과 동일하게 검증된 링크만 연다", async () => {
  const opened = [], button = {};
  const run = (currentRow, $, window) => createExports({ model: { currentRow }, $, window, normalizeFiles: noticeView.normalizeFiles }).downloadAll;
  await run({ files: [{ url: "javascript:alert(1)" }, { url: "https://example.go.kr/file" }] }, () => button, { open: (url) => opened.push(url) })();
  assert.deepEqual(opened, ["https://example.go.kr/file"]);
});

test("본공고 모달은 공공 API의 입찰 진행 일정을 순서대로 표시한다", () => {
  assert.match(HTML, /id="schedule-tab"[^>]*data-tab="schedule"/);
  assert.match(HTML, /id="schedule-content"[^>]*hidden/);
  const { scheduleItems, renderBidSchedule } = noticeView;
  const row = {
    closeAt: "2026-09-10 18:00:00",
    bidSchedule: {
      bidNtceDt: "2026-08-27 09:00:00",
      bidBeginDt: "2026-09-08 09:00:00",
      opengDt: "2026-09-11 10:00:00",
    },
  };
  assert.deepEqual(scheduleItems(row), [
    ["공고 게시", "2026-08-27 09:00:00"],
    ["입찰서 제출 시작", "2026-09-08 09:00:00"],
    ["입찰서 제출 마감", "2026-09-10 18:00:00"],
    ["개찰 예정", "2026-09-11 10:00:00"],
  ]);
  const rendered = renderBidSchedule(row);
  assert.match(rendered, /입찰서 제출 시작/);
  assert.match(rendered, /2026-09-11 10:00:00/);
  assert.match(rendered, /실제 개찰 처리 시각이 아니라/);
});
