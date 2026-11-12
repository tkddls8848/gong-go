const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { restoreCsv } = require("./restore-r2");
const { serializeCsv, parseCsv } = require("./csv-record");
test("2020년 raw에서 서비스 컬럼과 다중 행을 손실 없이 복원한다", () => {
  const rows = [{ bidNtceNo: "0001", bidNtceNm: '공고, "제목"\n줄바꿈', bidNtceDt: "2020-01-01", rawOnly: "원본" }, { bidNtceNo: "0002", bidNtceNm: "다음 공고" }];
  const buffers = rows.map((row) => zlib.gzipSync(Buffer.from(`\uFEFF${serializeCsv([row])}\n`)));
  const before = buffers.map((buffer) => Buffer.from(buffer));
  const result = restoreCsv(buffers, "bid");
  const restored = parseCsv(zlib.gunzipSync(result.body).toString("utf8"));
  assert.equal(result.count, 2);
  assert.equal(restored[0].bidNtceNo, "0001");
  assert.equal(restored[0].bidNtceNm, rows[0].bidNtceNm);
  assert.equal("rawOnly" in restored[0], false);
  assert.deepEqual(buffers, before);
});
