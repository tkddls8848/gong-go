// 운영 모듈의 의존성은 바꾸지 않는다. 테스트에서만 실제 작성기와 독자를 연결해 파일 계약을 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { serializeCsv } = require("../collector/csv-record.js");
require("../public/rows.js");
const Rows = globalThis.GongRows;

function values() {
  const samples = ["", null, 0, false, '쉼표,따옴표"', "CR\rLF\nCRLF\r\n", "0000123", '=SUM(A1:A2)', "=\"원문\"", "끝 공백 ", "\t탭", "한글🙂", { memo: '객체,"\n' }];
  const alphabet = ['가', 'A', '0', ',', '"', '\r', '\n', '\t', ' ', '=', '🙂'];
  let seed = 20260925;
  for (let i = 0; i < 400; i++) {
    let value = "";
    for (let j = 0; j < i % 47; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      value += alphabet[seed % alphabet.length];
    }
    samples.push(value);
  }
  return samples;
}
const textOf = (value) => value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");

for (const [mode, number, title, published] of [
  ["pre", "bfSpecRgstNo", "prdctClsfcNoNm", "rgstDt"],
  ["bid", "bidNtceNo", "bidNtceNm", "bidNtceDt"],
  ["plan", "orderPlanUntyNo", "bizNm", "nticeDt"],
]) {
  test(`실제 수집기 ${mode} CSV를 gzip 수신·화면 파서로 읽어 특수문자를 보존한다`, async (t) => {
    const samples = values();
    const records = samples.map((value, i) => ({ [number]: `0000-${i}`, [title]: value, [published]: "2026-09-01 09:00:00", ...(i % 2 ? { optional: "" } : {}) }));
    const csv = `\uFEFF${serializeCsv(records)}\n`;
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(gzipSync(csv)); });
    const received = await Rows.fetchCsvText("/test-only.gz");
    // Fetch의 UTF-8 텍스트 디코딩은 선두 BOM을 제거한다. 본문 문자는 그대로여야 한다.
    assert.ok(received === csv.slice(1), "decoded CSV differs beyond the leading BOM");
    const result = Rows.scanText(received, mode, Rows.makeCriteria({}), true);
    assert.equal(result.scanned, samples.length);
    assert.equal(result.matched.length, samples.length);
    for (let i = 0; i < samples.length; i++) {
      assert.equal(result.matched[i].announcementNumber, `0000-${i}`);
      assert.equal(result.matched[i].title, textOf(samples[i]), `row ${i}`);
    }
    assert.equal(calls, 1);
  });
}
