const test = require("node:test");
const assert = require("node:assert/strict");
const { html } = require("../public/format.js");

test("HTML 이스케이프는 0과 false를 지우지 않고 null·undefined만 빈 문자열로 둔다", () => {
  assert.equal(html(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(html(0), "0");
  assert.equal(html(false), "false");
  assert.equal(html(null), "");
  assert.equal(html(undefined), "");
});
