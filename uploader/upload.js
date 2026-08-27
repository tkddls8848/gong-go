// 로컬 data/ 산출물 중 바뀐 것만 R2에 올린다.
//
// 별도의 상태 파일을 두지 않는다 — 버킷의 키+ETag가 곧 상태다. R2의 ETag는 단일 PUT 객체에서
// MD5와 같으므로, 로컬 MD5와 대조해 다른 것만 보낸다. zlib.gzipSync가 결정적이라(MTIME을 0으로
// 쓴다) 재수집해도 내용이 같으면 바이트가 같고, 그런 파일은 여기서 걸러진다.
//
// 크론 러너는 최근 며칠치만 로컬에 갖고 있다. 그래서 "로컬에 없으면 지운다" 같은 규칙은
// 절대 쓰지 않는다 — 삭제 판정은 버킷 안 정보(또는 SYNC_BEGIN/END로 명시된 구간)로만 한다.
//
// 사용: node uploader/upload.js [--commit] [--put-only|--index-only]
//   기본값     올릴/지울 대상만 출력한다(dry-run)
//   --commit   실제 업로드·삭제를 수행한다
//   --put-only 로컬 파일만 PUT한다. 과거 백필처럼 운영 인덱스·삭제 판정과 격리할 때 쓴다.
//   --index-only 파일·삭제는 건드리지 않고 R2 목록과 기존 인덱스를 합쳐 index.json만 갱신한다.
//
// 자격증명(.env 또는 환경변수): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
const crypto = require("node:crypto");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { ROOT, DATA_DIR, fs, path, loadEnv, mapPool, readJson, buildIndexEntries, SEALED_PATH } = require("../shared/pipeline-utils");

loadEnv(path.join(ROOT, ".env"));

const BUCKET = "gong-go-data";
const CONCURRENCY = 8;
const INDEX_KEY = "index.json";
const ANALYSIS_INDEX_KEY = "analysis-index.json";
const DAILY_KEY = /^(pre|bid|plan)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/;
// 구간을 지정해 다시 받을 수 있는 모드. vanishedDaily의 "구간 안에서는 로컬이 완전하다"는
// 전제가 이 모드에서만 성립한다 — plan은 API가 최근 며칠치만 주므로(collector.js의 snapshot)
// 로컬에 없다는 것이 "그날 0건이 됐다"는 뜻이 아니라 "애초에 받을 수 없다"는 뜻이다.
const RANGED_DAILY_KEY = /^(pre|bid)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/;
const RANGED_RAW_DAILY_KEY = /^raw\/(pre|bid)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/;
const MODES = ["pre", "bid", "plan"];

if (require.main === module) main().catch((error) => { console.error(`업로드 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const { dryRun, putOnly, indexOnly } = parseUploadArgs(process.argv.slice(2));
  const client = makeClient();
  const remote = await listAll(client);
  const local = await localFiles();
  console.log(`버킷 ${BUCKET}: 원격 ${remote.size}개 · 로컬 ${local.length}개`);

  // 이번 실행이 끝난 뒤 버킷에 남을 키. 삭제 판정과 인덱스 생성이 모두 이 집합을 본다.
  // present는 원격 키에 "이번에 올릴 로컬 키"를 더한 집합이다. 로컬 키를 미리 넣어도 되는
  // 이유는 삭제(③)가 업로드(①)보다 뒤이고, 업로드가 하나라도 실패하면 mapPool이 예외를
  // 던져 ③에 닿지 못하기 때문이다. 즉 ③에 도달한 시점에는 present가 곧 버킷의 내용이다.
  const present = new Set([...remote.keys(), ...local.map((entry) => entry.key)]);
  const removing = putOnly || indexOnly ? [] : [...new Set([...supersededDaily(present), ...vanishedDaily(present, local)])];
  const plan = {
    csv: indexOnly ? [] : local.filter((entry) => entry.key.endsWith(".csv.gz")),
    analysis: indexOnly ? [] : local.filter((entry) => entry.key.startsWith("analysis/")),
    analysisIndex: indexOnly ? [] : local.filter((entry) => entry.key === ANALYSIS_INDEX_KEY),
    removing,
  };

  const index = putOnly ? null : await mergedIndex(client, present, new Set(removing));
  if (dryRun) return report(plan, index, remote, putOnly);

  // 순서가 유일한 방어다. R2에는 트랜잭션이 없다.
  // ① 파일이 인덱스보다 먼저 있어야 프런트가 아직 없는 파일을 요청하지 않는다.
  // ② 인덱스가 바뀐 뒤에 지워야 구 인덱스를 캐시한 브라우저가 사라진 키에서 404를 만나지 않는다.
  // ③ 목록(analysis-index.json)은 그 목록이 가리키는 파일보다 뒤에 올린다.
  const uploaded = await putAll(client, plan.csv, remote);
  if (index) await putJson(client, INDEX_KEY, index);
  const deleted = putOnly ? 0 : await deleteAll(client, plan.removing);
  const analyses = await putAll(client, [...plan.analysis, ...plan.analysisIndex], remote);

  console.log(`완료: ${uploaded.count + analyses.count}건 업로드(${mb(uploaded.bytes + analyses.bytes)}), ${deleted}건 삭제${index ? `, 인덱스 ${index.files.length}항목` : ", 인덱스 유지(PUT 전용)"}`);
}

// 봉인으로 대체된 일별 키를 지운다. 조건은 하나뿐이다 —
// (pre|bid)/YYYY/MM/DD.csv.gz 는 버킷에 (pre|bid)/YYYY/MM.csv.gz 가 있을 때만 지운다.
// 버킷 안 정보만으로 판정되므로 로컬이 부분적이어도 안전하다.
function supersededDaily(present) {
  const sealed = new Set([...present].filter((key) => SEALED_PATH.test(key)).map((key) => monthOf(key)));
  return [...present].filter((key) => DAILY_KEY.test(key) && sealed.has(monthOf(key)));
}

// 수집 구간이 명시됐다면 그 구간은 로컬이 완전하다. 구간 안에서 사라진 일별 키(그날 공고가
// 0건이 되어 collector가 지운 파일)만 함께 지운다. 구간 밖은 손대지 않는다.
// plan은 제외한다 — 지우면 그때까지 쌓아 둔 발주계획이 매 크론마다 통째로 날아간다.
function vanishedDaily(present, local, begin = process.env.SYNC_BEGIN, end = process.env.SYNC_END || today()) {
  if (!begin) return [];
  const kept = new Set(local.map((entry) => entry.key));
  return [...present].filter((key) => (RANGED_DAILY_KEY.test(key) || RANGED_RAW_DAILY_KEY.test(key)) && !kept.has(key) && dateOf(key) >= begin && dateOf(key) <= end);
}

// 인덱스는 "이번 실행 뒤 버킷에 남는 키"의 투영이다. 건수는 로컬 인덱스를 우선하고,
// 로컬에 없는 키(러너가 안 받은 과거 구간)는 버킷의 기존 인덱스에서 승계한다.
// 이렇게 해야 최근 35일치만 가진 크론 러너가 과거 항목을 지워 버리지 않는다.
async function mergedIndex(client, present, removing) {
  const localIndex = await readJson(path.join(DATA_DIR, "index.json"), { files: [] });
  const remoteIndex = (await getJson(client, INDEX_KEY)) || { files: [] };
  return {
    updatedAt: localIndex.updatedAt || new Date().toISOString(),
    schemaVersion: process.env.DATA_SCHEMA_VERSION || remoteIndex.schemaVersion || localIndex.schemaVersion || "",
    files: indexFiles(present, removing, localIndex.files, remoteIndex.files),
  };
}

function indexFiles(present, removing, localFiles, remoteFiles) {
  const local = new Map(localFiles.map((file) => [file.path, Number(file.count) || 0]));
  const remote = new Map(remoteFiles.map((file) => [file.path, Number(file.count) || 0]));
  const counts = new Map();
  const unknown = [];
  for (const key of [...present].sort()) {
    if (removing.has(key) || !(DAILY_KEY.test(key) || SEALED_PATH.test(key))) continue;
    if (local.has(key)) counts.set(key, local.get(key));
    else if (remote.has(key)) counts.set(key, remote.get(key));
    else { counts.set(key, 0); unknown.push(key); }
  }
  if (unknown.length) console.warn(`경고: 건수를 알 수 없는 키 ${unknown.length}개를 0건으로 둡니다 (예: ${unknown[0]}). 로컬에서 전체 인덱스를 다시 만든 뒤 올리세요.`);
  return buildIndexEntries(counts);
}

// 올릴 대상: 서비스용 일별·월별 CSV, 원본 일별 CSV와 분석 산출물. raw는 화면에 직접
// 노출하지 않지만 새 기능에 컬럼이 필요할 때 재수집 없이 복원하는 R2 원본 백업이다.
// data/files, data/text, sync-state.json, sync-errors.json 등은 대상이 아니다.
// index.json은 여기에 넣지 않는다 — 로컬 인덱스를 그대로 올리면 최근 며칠치만 가진 크론
// 러너가 과거 항목을 지워 버린다. mergedIndex가 버킷 상태와 합쳐 따로 올린다.
async function localFiles() {
  const result = [];
  for (const mode of MODES) await collectGz(path.join(DATA_DIR, mode), mode, result);
  for (const mode of MODES) await collectGz(path.join(DATA_DIR, "raw", mode), `raw/${mode}`, result);
  if (await exists(path.join(DATA_DIR, ANALYSIS_INDEX_KEY))) result.push({ key: ANALYSIS_INDEX_KEY, file: path.join(DATA_DIR, ANALYSIS_INDEX_KEY) });
  const analysisDir = path.join(DATA_DIR, "analysis", "bid");
  for (const entry of await readdir(analysisDir)) if (entry.isFile() && entry.name.endsWith(".json")) result.push({ key: `analysis/bid/${entry.name}`, file: path.join(analysisDir, entry.name) });
  return result;
}

async function collectGz(dir, prefix, result) {
  for (const entry of await readdir(dir)) {
    if (entry.isDirectory()) { await collectGz(path.join(dir, entry.name), `${prefix}/${entry.name}`, result); continue; }
    if (entry.isFile() && entry.name.endsWith(".csv.gz")) result.push({ key: `${prefix}/${entry.name}`, file: path.join(dir, entry.name) });
  }
}

// ETag가 같으면 건너뛴다. 파일을 미리 다 읽지 않고 동시성 안에서 읽어 MD5를 낸다.
async function putAll(client, entries, remote) {
  let count = 0, bytes = 0;
  await mapPool(entries, CONCURRENCY, async (entry) => {
    const body = await fs.readFile(entry.file);
    if (remote.get(entry.key) === md5(body)) return;
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: entry.key, Body: body, ContentType: contentType(entry.key) }));
    count += 1; bytes += body.length; // await를 낀 누적은 값을 잃으므로 한 문장으로 더한다
  });
  return { count, bytes };
}

async function deleteAll(client, keys) {
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.slice(offset, offset + 1000).map((Key) => ({ Key })), Quiet: true } }));
  }
  return keys.length;
}

async function report(plan, index, remote, putOnly = false) {
  const sized = await mapPool([...plan.csv, ...plan.analysis, ...plan.analysisIndex], CONCURRENCY, async (entry) => {
    const body = await fs.readFile(entry.file);
    return remote.get(entry.key) === md5(body) ? 0 : body.length;
  });
  const changed = sized.filter(Boolean);
  console.log(`업로드 대상 ${changed.length}건 · ${mb(changed.reduce((sum, size) => sum + size, 0))}`);
  console.log(`삭제 예정 ${plan.removing.length}건${plan.removing.length ? ` (예: ${plan.removing[0]})` : ""}`);
  if (index) console.log(`인덱스 ${index.files.length}항목 · ${index.files.reduce((sum, file) => sum + file.count, 0).toLocaleString("ko-KR")}건 (dry-run)`);
  else if (putOnly) console.log("인덱스와 원격 삭제는 건드리지 않음 (PUT 전용 dry-run)");
}

function makeClient() {
  return new S3Client({
    region: "auto",
    endpoint: endpoint(),
    credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
  });
}

// R2_ACCOUNT_ID에 대시보드가 보여 주는 엔드포인트 URL을 통째로 붙여 넣는 실수가 잦다.
// 그대로 두면 endpoint가 https://https://... 가 되어 호스트가 "https"로 파싱되고, SDK가
// 버킷명을 앞에 붙인 "<버킷>.https"를 찾다가 ENOTFOUND로 죽는다. 원인이 전혀 안 보이는
// 오류라 여기서 형식을 맞춰 주고, 못 맞추면 무엇을 넣어야 하는지 말해 준다.
function endpoint() {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT.trim().replace(/\/+$/, "");
  const raw = required("R2_ACCOUNT_ID").trim();
  const account = raw.replace(/^https?:\/\//, "").replace(/\.r2\.cloudflarestorage\.com.*$/i, "").replace(/\/.*$/, "");
  if (!/^[0-9a-f]{32}$/i.test(account)) {
    throw new Error("R2_ACCOUNT_ID가 계정 ID 형식이 아닙니다.\n"
      + "대시보드 R2 > 개요의 S3 API 주소에서 https:// 와 .r2.cloudflarestorage.com 사이의 32자리 16진수만 넣으세요.\n"
      + "주소를 그대로 쓰고 싶으면 R2_ENDPOINT에 전체 URL을 넣으면 됩니다.");
  }
  return `https://${account}.r2.cloudflarestorage.com`;
}

async function listAll(client) {
  const result = new Map();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const object of page.Contents || []) result.set(object.Key, String(object.ETag || "").replaceAll('"', ""));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return result;
}

async function getObject(client, key) {
  try { return Buffer.from(await (await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body.transformToByteArray()); }
  catch (error) { if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null; throw error; }
}
async function getJson(client, key) { const body = await getObject(client, key); return body ? JSON.parse(body.toString("utf8")) : null; }
async function putJson(client, key, value) { await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from(JSON.stringify(value, null, 2), "utf8"), ContentType: "application/json; charset=utf-8" })); }

// Content-Encoding은 설정하지 않는다. 붙이면 브라우저가 먼저 gzip을 풀어
// 프런트의 DecompressionStream과 이중 처리로 깨진다.
function contentType(key) { return key.endsWith(".csv.gz") ? "application/gzip" : "application/json; charset=utf-8"; }
function md5(buffer) { return crypto.createHash("md5").update(buffer).digest("hex"); }
// 일별 키(mode/YYYY/MM/DD.csv.gz)와 월별 키(mode/YYYY/MM.csv.gz)를 같은 월 식별자로 모은다.
function monthOf(key) { const [mode, year, month] = key.split("/"); return `${mode}/${year}/${month.slice(0, 2)}`; }
function dateOf(key) { const parts = key.split("/"); const offset = parts[0] === "raw" ? 1 : 0; return `${parts[offset + 1]}-${parts[offset + 2]}-${parts[offset + 3].slice(0, 2)}`; }
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name}을 .env 또는 환경변수로 설정하세요.`); return value; }
function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)}MB`; }
function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
function parseUploadArgs(args) {
  const unknown = args.filter((arg) => arg !== "--dry-run" && arg !== "--commit" && arg !== "--put-only" && arg !== "--index-only");
  if (unknown.length) throw new Error(`알 수 없는 인자: ${unknown.join(", ")}`);
  if (args.includes("--dry-run") && args.includes("--commit")) throw new Error("--dry-run과 --commit을 함께 쓸 수 없습니다.");
  if (args.includes("--put-only") && args.includes("--index-only")) throw new Error("--put-only와 --index-only를 함께 쓸 수 없습니다.");
  return { dryRun: !args.includes("--commit"), putOnly: args.includes("--put-only"), indexOnly: args.includes("--index-only") };
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readdir(dir) { try { return await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }

// 삭제·인덱스 판정은 잘못되면 되돌릴 수 없다. 순수 함수로 떼어 두고 upload.test.js가 검증한다.
module.exports = { supersededDaily, vanishedDaily, indexFiles, monthOf, dateOf, endpoint, parseUploadArgs };
