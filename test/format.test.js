const test = require("node:test");
const assert = require("node:assert/strict");
const { dateKey, dateFormat, html } = require("../public/format.js");

test("날짜 키는 행 모듈 없이 동작하고 행 모듈과 같은 규칙을 쓴다", () => {
  assert.equal(globalThis.GongRows, undefined, "이 테스트는 rows.js를 먼저 읽지 않은 상태여야 한다");
  const samples = ["2026-10-05 09:00", "20261005", "2026.10.5", "", null, undefined, 0, "-"];
  assert.equal(dateFormat("2026-10-05 09:00:00"), "2026-10-05");
  assert.equal(dateFormat(""), "-");
  const before = samples.map(dateKey);
  require("../public/rows.js");
  assert.deepEqual(before, samples.map(globalThis.GongRows.dateKey));
});

test("HTML 이스케이프는 0과 false를 지우지 않고 null·undefined만 빈 문자열로 둔다", () => {
  assert.equal(html(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(html(0), "0");
  assert.equal(html(false), "false");
  assert.equal(html(null), "");
  assert.equal(html(undefined), "");
});
