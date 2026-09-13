// 관심 본공고의 제안요청서/과업내용서만 로컬 data/files에 내려받는다.
//
// 이 파일은 제 모듈에 필요한 것을 전부 안에 갖는다 — CSV 읽기, 행에서 값 뽑기, 파일명 정리.
// 수집기(collector)와 코드를 공유하지 않는다. 둘 사이의 계약은 "data/에 저장된 파일 형식"이지
// 함수가 아니고, 다운로더 사정으로 수집이 멈추는 일이 없어야 한다(README 모듈 경계).
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(__dirname, "download.config.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const ERROR_FILE = path.join(DATA_DIR, "download-errors.json");

if (require.main === module) main().catch((error) => { console.error(`첨부 다운로드 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const config = await readJson(CONFIG_FILE);
  if (!config) throw new Error("downloader/download.config.json을 찾지 못했습니다.");
  const limit = numberFlag("--limit", config.maxNoticesPerRun ?? 50);
  const dryRun = process.argv.includes("--dry-run");
  const pattern = new RegExp(config.fileNamePattern || ".", "i");
  const index = await readJson(INDEX_FILE, { files: [] });
  const begin = String(config.begin || "0000-01-01").replaceAll("-", "");
  const mode = config.mode || "bid";
  const files = (index.files || []).filter((file) => file.mode === mode && file.end.replaceAll("-", "") >= begin);
  const rows = (await Promise.all(files.map((file) => readCsvGz(path.join(DATA_DIR, file.path)))).then((sets) => sets.flat()))
    .filter((row) => noticeNumber(row) && (!config.institutions?.length || config.institutions.some((name) => institution(row).includes(name))))
    .sort((a, b) => rowDate(b).localeCompare(rowDate(a)));
  const notices = new Map();
  for (const row of rows) if (!notices.has(noticeNumber(row))) notices.set(noticeNumber(row), row);
  const selected = [...notices.values()].slice(0, limit).map((row) => ({ row, files: normalizeFiles(row).filter((file) => pattern.test(file.name)) })).filter((entry) => entry.files.length);
  const total = selected.reduce((sum, entry) => sum + entry.files.length, 0);
  console.log(`대상 공고 ${selected.length}건, 첨부 ${total}건${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) return;
  const errors = [];
  const jobs = selected.flatMap(({ row, files }) => files.map((file, index) => ({ row, file, index })));
  await mapPool(jobs, Math.max(1, Number(config.concurrency) || 4), async (job) => {
    try { await download(job); } catch (error) { const entry = { notice: noticeNumber(job.row), title: title(job.row), url: job.file.url, name: job.file.name, error: error.message }; errors.push(entry); console.error(`실패 ${entry.notice}: ${entry.name} — ${entry.error}`); }
  });
  await writeJson(ERROR_FILE, errors);
  console.log(`완료: ${jobs.length - errors.length}/${jobs.length}건 다운로드, 실패 ${errors.length}건`);
}
async function download({ row, file, index }) {
  const notice = safeFileName(noticeNumber(row), "unknown");
  const name = `${String(index + 1).padStart(2, "0")}_${safeFileName(file.name, `attachment_${index + 1}`)}`;
  const destination = path.join(DATA_DIR, "files", "bid", notice, name);
  try { if ((await fs.stat(destination)).size > 0) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(file.url, { redirect: "follow" });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (/^text\/html\b/i.test(contentType)) throw new Error(`HTML 응답 수신 (${contentType})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("빈 응답");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data);
}

// 행에서 값 뽑기. 모드마다 컬럼 이름이 달라 우선순위를 여기서 고정한다.
// 등록일시(rgstDt)가 게시일시보다 앞선다 — 조회 화면의 게시일과 같은 값을 써야 파일 분류와
// 어긋나지 않는다.
function noticeNumber(row) { return String(row.bidNtceNo || row.bfSpecRgstNo || row.orderPlanUntyNo || "").trim(); }
function rowDate(row) { return String(row.rgstDt || row.bidNtceDt || row.nticeDt || "").replace(/\D/g, "").slice(0, 8); }
function institution(row) { return String(row.rlDminsttNm || row.dminsttNm || row.orderInsttNm || ""); }
function title(row) { return String(row.bizNm || row.prdctClsfcNoNm || row.bidNtceNm || ""); }

// 첨부 슬롯은 본공고 10개, 사전공고 5개다. 원본에 11번째가 있어도 읽지 않는다.
function normalizeFiles(row) {
  const pre = row.bfSpecRgstNo && !row.bidNtceNo;
  const prefix = pre ? "specDocFileUrl" : "ntceSpecDocUrl";
  const namePrefix = pre ? "specDocFileNm" : "ntceSpecFileNm";
  const count = pre ? 5 : 10;
  return Array.from({ length: count }, (_, index) => ({ url: row[`${prefix}${index + 1}`] || "", name: row[`${namePrefix}${index + 1}`] || guessName(row[`${prefix}${index + 1}`], index) })).filter((file) => /^https?:/i.test(file.url));
}
function guessName(url, index) {
  try { const parsed = new URL(url); return decodeURIComponent(parsed.searchParams.get("fileNm") || parsed.searchParams.get("orgFileNm") || parsed.searchParams.get("fileName") || `첨부파일_${index + 1}`); } catch { return `첨부파일_${index + 1}`; }
}
// 이 값으로 디스크에 쓴다. 경로가 남으면 data/ 밖으로 나간다.
function safeFileName(name, fallback = "attachment") {
  const base = path.basename(String(name || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_").trim();
  return base.slice(0, 180) || fallback;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8"); }
async function readCsvGz(file) {
  try { return parseCsv(zlib.gunzipSync(await fs.readFile(file)).toString("utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index], index); }
  }));
  return results;
}
function numberFlag(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 ? Math.max(0, Number(process.argv[index + 1]) || 0) : fallback; }

// 저장된 CSV를 읽기만 하는 파서. 쓰는 쪽(collector/csv-record.js)과 코드를 공유하지 않고
// **파일 형식**만 공유한다: BOM + 헤더 + `="값"`으로 감싼 셀. 같은 규칙의 읽기 전용 사본이
// public/rows.js에도 있다. 형식이 바뀌면 각 사본의 테스트가 각자 걸린다.
const EQUALS = 61, QUOTE = 34, COMMA = 44, LF = 10, CR = 13;

function parseCsv(text) {
  const rows = parseLines(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const header = rows[0];
  const records = new Array(rows.length - 1);
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const record = {};
    for (let column = 0; column < header.length; column += 1) record[header[column]] = fromTextCell(cells[column] || "");
    records[index - 1] = record;
  }
  return records;
}

// Excel 텍스트 강제 수식(="...")을 벗긴다. 앞자리 0과 긴 공고번호가 숫자로 바뀌지 않도록
// 수집기가 씌운 것이다.
function fromTextCell(value) {
  if (value === "" || value.charCodeAt(0) !== EQUALS) return value;
  if (value.length >= 3 && value.charCodeAt(1) === QUOTE && value.charCodeAt(value.length - 1) === QUOTE) return value.slice(2, -1);
  return value;
}

// 셀을 한 글자씩 이어붙이지 않고, 구분자 위치를 찾아 slice로 잘라낸다. 인용되지 않은
// 셀(빈 셀 포함)은 따옴표 처리를 건너뛴다.
function parseLines(text) {
  const rows = [];
  const length = text.length;
  let row = [];
  let index = 0;
  let pending = false; // 아직 행에 넣지 못한 셀이 남아 있는지
  while (index < length) {
    let cell;
    if (text.charCodeAt(index) === QUOTE) {
      index += 1;
      let start = index;
      cell = "";
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote === -1) { cell += text.slice(start); index = length; break; }
        if (text.charCodeAt(quote + 1) === QUOTE) { cell += text.slice(start, quote + 1); index = quote + 2; start = index; continue; }
        cell += text.slice(start, quote);
        index = quote + 1;
        break;
      }
    } else {
      let end = index;
      while (end < length) { const code = text.charCodeAt(end); if (code === COMMA || code === LF || code === CR) break; end += 1; }
      cell = text.slice(index, end);
      index = end;
    }
    row.push(cell);
    pending = true;
    const code = text.charCodeAt(index);
    if (code === COMMA) { index += 1; continue; }
    if (code === LF || code === CR) {
      if (code === CR && text.charCodeAt(index + 1) === LF) index += 1;
      index += 1;
      if (row.some(Boolean)) rows.push(row);
      row = [];
      pending = false;
    }
  }
  if (pending) rows.push(row);
  return rows;
}

// 디스크와 네트워크를 건드리지 않는 부분만 내보낸다. attachments.test.js가 검증한다.
module.exports = { parseCsv, noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName };
