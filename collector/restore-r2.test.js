const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { restoreCsv, endpoint } = require("./restore-r2");
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
// .env.example은 R2_ENDPOINT_URL을 uploader와 restore-r2 모두에 안내한다. upload.test.js의 endpoint 규칙과 같게 고정한다.
test("endpoint는 R2_ENDPOINT_URL의 origin만 쓰고 계정 ID만 넣거나 스킴을 겹치면 거절한다", () => {
  const saved = process.env.R2_ENDPOINT_URL;
  const id = "0123456789abcdef0123456789abcdef";
  try {
    for (const value of [`https://${id}.r2.cloudflarestorage.com`, `https://${id}.r2.cloudflarestorage.com/`, `https://${id}.r2.cloudflarestorage.com/gong-go-data`, `  https://${id}.r2.cloudflarestorage.com  `]) {
      process.env.R2_ENDPOINT_URL = value;
      assert.equal(endpoint(), `https://${id}.r2.cloudflarestorage.com`);
    }
    process.env.R2_ENDPOINT_URL = "https://custom.example.com/";
    assert.equal(endpoint(), "https://custom.example.com");
    for (const value of [id, `https://https://${id}.r2.cloudflarestorage.com`, `http://${id}.r2.cloudflarestorage.com`, ""]) {
      process.env.R2_ENDPOINT_URL = value;
      assert.throws(() => endpoint(), /R2_ENDPOINT_URL/);
    }
  } finally {
    if (saved === undefined) delete process.env.R2_ENDPOINT_URL; else process.env.R2_ENDPOINT_URL = saved;
  }
});
