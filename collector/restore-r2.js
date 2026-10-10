// 기간 만료로 제거된 서비스 CSV를 R2 raw 원본에서 복원한다. raw는 읽기만 한다.
// 기본은 계획 확인, --commit은 서비스 파일과 인덱스를 실제로 복원한다.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { loadEnv, DATA_DIR, mapPool, buildIndexEntries } = require("./store");
const { parseCsv, serializeCsv } = require("./csv-record");
const { project } = require("./service-columns");
const { SEAL_LAG } = require("./compact");
const Bucket = "gong-go-data";

function restoreCsv(buffers, mode) {
  const rows = buffers.flatMap((buffer) => parseCsv(zlib.gunzipSync(buffer).toString("utf8")));
  const body = zlib.gzipSync(Buffer.from(`\uFEFF${serializeCsv(rows.map((row) => project(row, mode)))}\n`));
  if (parseCsv(zlib.gunzipSync(body).toString("utf8")).length !== rows.length) throw new Error("복원 행 수 불일치");
  return { body, count: rows.length };
}
// uploader/upload.js endpoint()의 사본이다(모듈 경계상 import하지 않는다). S3 API 주소의 origin만 쓴다.
function endpoint() {
  let url = null;
  try { url = new URL((process.env.R2_ENDPOINT_URL || "").trim()); } catch { /* 아래에서 안내한다 */ }
  if (!url || url.protocol !== "https:" || !url.hostname.includes(".")) throw new Error("R2_ENDPOINT_URL을 확인하세요. 대시보드 R2 > 개요의 S3 API 주소(https://<계정ID>.r2.cloudflarestorage.com)를 넣으세요.");
  return url.origin;
}
async function main() {
  if (process.argv.slice(2).some((arg) => !["--commit", "--dry-run"].includes(arg))) throw new Error("--commit 또는 --dry-run만 지원합니다.");
  loadEnv();
  const client = new S3Client({ region: "auto", endpoint: endpoint(), credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  } });
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const recentMonth = new Date(Date.now() - SEAL_LAG * 86400000).toISOString().slice(0, 7);
  const groups = new Map();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: "raw/", ContinuationToken: token }));
    for (const object of page.Contents || []) {
      const match = /^raw\/(pre|bid|plan)\/(\d{4})\/(\d{2})\/(\d{2})\.csv\.gz$/.exec(object.Key);
      if (!match) continue;
      const [, mode, year, month, day] = match, date = `${year}-${month}-${day}`;
      if (date < "2020-01-01" || date > today) continue;
      const key = `${mode}/${year}/${month}${date.slice(0, 7) < recentMonth ? "" : `/${day}`}.csv.gz`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(object);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const sourceCount = [...groups.values()].reduce((sum, objects) => sum + objects.length, 0);
  console.log(`raw ${sourceCount}개 → 서비스 ${groups.size}개 (${today}까지). raw 변경·삭제 없음.`);
  if (!process.argv.includes("--commit")) return;
  const counts = new Map();
  let done = 0;
  for (const [key, objects] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    objects.sort((a, b) => a.Key.localeCompare(b.Key));
    const buffers = await mapPool(objects, 8, async (object) => {
      const response = await client.send(new GetObjectCommand({ Bucket, Key: object.Key, IfMatch: object.ETag }));
      return Buffer.from(await response.Body.transformToByteArray());
    });
    const { body, count } = restoreCsv(buffers, key.split("/")[0]);
    await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: "application/gzip" }));
    const file = path.join(DATA_DIR, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    counts.set(key, count);
    done++;
    if (done % 10 === 0 || done === groups.size) console.log(`복원 ${done}/${groups.size}: ${key} (${count}건)`);
  }
  // 수집과 겹치면 최신 인덱스를 다시 읽어 병합한다. 부분 복원 결과는 공개하지 않는다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.send(new GetObjectCommand({ Bucket, Key: "index.json" }));
    const index = JSON.parse(await response.Body.transformToString());
    const merged = new Map(index.files.map((file) => [file.path, file.count]));
    for (const [key, count] of counts) merged.set(key, count);
    const result = { ...index, updatedAt: new Date().toISOString(), schemaVersion: `full-history-${Date.now()}`, files: buildIndexEntries(merged) };
    try {
      await client.send(new PutObjectCommand({ Bucket, Key: "index.json", IfMatch: response.ETag, Body: JSON.stringify(result), ContentType: "application/json; charset=utf-8" }));
      await fs.writeFile(path.join(DATA_DIR, "index.json"), JSON.stringify(result, null, 2));
      console.log(`인덱스 복원 완료: ${result.files.length}개 파일, ${result.files.reduce((sum, file) => sum + file.count, 0)}건, ${result.files[0]?.begin} ~ ${result.files.at(-1)?.end}`);
      return;
    } catch (error) { if (error.$metadata?.httpStatusCode !== 412 || attempt === 2) throw error; }
  }
}
if (require.main === module) main().catch((error) => { console.error(error.message || error.name); process.exitCode = 1; });
module.exports = { restoreCsv, endpoint };
