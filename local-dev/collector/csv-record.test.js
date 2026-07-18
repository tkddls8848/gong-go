const assert = require("node:assert/strict");
const test = require("node:test");

const { serializeCsv, parseCsv } = require("./csv-record.js");

// 표준 RFC 4180 파서. Excel 등 외부 도구가 어떻게 읽는지 검증한다.
// 이 도구의 lenient parser와 달리, 필드는 반드시 첫 글자가 "일 때만 인용된 것으로 본다.
function parseRfc4180(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (char === ",") { row.push(cell); cell = ""; atFieldStart = true; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = ""; atFieldStart = true;
    } else { cell += char; atFieldStart = false; }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

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

test("comma inside a value stays in one column for standard parsers", () => {
  const title = "2023학년도 성수고등학교 교복(하복, 동복) 학교주관구매 입찰 공고";
  const csv = serializeCsv([{ bidNtceNm: title, ntceInsttNm: "성수고등학교" }]);

  // 표준 RFC 4180 파서 기준으로도 열이 밀리지 않아야 한다.
  const [headerCells, dataCells] = parseRfc4180(csv.replace(/^﻿/, ""));
  assert.equal(dataCells.length, headerCells.length);
  const titleIndex = headerCells.indexOf("bidNtceNm");
  assert.equal(dataCells[titleIndex], `="${title}"`);
  assert.equal(dataCells[headerCells.indexOf("ntceInsttNm")], '="성수고등학교"');

  // 이 도구 자체 파서로도 원래 값이 그대로 복원되어야 한다.
  const rows = parseCsv(csv);
  assert.equal(rows[0].bidNtceNm, title);
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
