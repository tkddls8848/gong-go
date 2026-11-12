const assert = require("node:assert/strict");
const test = require("node:test");

const { serializeCsv, parseCsv } = require("./csv-record.js");

test("writes only API item keys and preserves JSON values through CSV", () => {
  const csv = serializeCsv([
    { common: "first", nested: { sequence: 1 }, id: "upstream-id" },
    { common: "second", onlySecond: ["a", "b"] },
  ]);
  const [header] = csv.split("\n");
  const rows = parseCsv(csv);

  assert.match(header, /common/);
  assert.match(header, /nested/);
  assert.match(header, /onlySecond/);
  assert.doesNotMatch(header, /mode/);
  assert.equal(rows[0].common, "first");
  assert.equal(rows[0].nested, '{"sequence":1}');
  assert.equal(rows[1].onlySecond, '["a","b"]');
});

test("round-trips values containing quotes, commas and newlines", () => {
  const rows = [{
    withComma: "a, b, c",
    withQuote: 'he said "hi"',
    withNewline: "line1\nline2",
    leadingZero: "000",
    bigNumber: "20230100056",
    empty: "",
  }];
  const parsed = parseCsv(serializeCsv(rows));
  assert.deepEqual(parsed[0], rows[0]);
});
