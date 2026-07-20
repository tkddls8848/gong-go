// 로컬 전용 전체 공고 수집기. Cloudflare Pages/Functions와 무관하게 실행된다.
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { serializeCsv } = require("./csv-record");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LEGACY_CSV_FILE = path.join(DATA_DIR, "notices.csv");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");
const CONFIG_FILE = path.join(ROOT, "sync.config.json");
const PAGE_SIZE = 999;
const RANGE_DAYS = 28;
const RETRIES = 3;
const DEFAULT_CONCURRENCY = 8;
const FILE_CONCURRENCY = 16;
const MIGRATIONS = ["rebalance-v1", "drop-generated-v1", "gzip-storage-v1"];
const TYPES = ["물품", "외자", "용역", "공사"];
const MODE_ALIASES = { 사전공고: "pre", 본공고: "bid", pre: "pre", bid: "bid" };
const MODE_LABELS = { pre: "사전공고", bid: "본공고" };

loadEnv(path.join(ROOT, ".env"));
const SERVICE_KEY = process.env.SERVICE_KEY || "";
const MODES = {
  pre: {
    base: "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService",
    ops: { 물품: "getPublicPrcureThngInfoThngPPSSrch", 외자: "getPublicPrcureThngInfoFrgcptPPSSrch", 용역: "getPublicPrcureThngInfoServcPPSSrch", 공사: "getPublicPrcureThngInfoCnstwkPPSSrch" },
  },
  bid: {
    base: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService",
    ops: { 물품: "getBidPblancListInfoThngPPSSrch", 외자: "getBidPblancListInfoFrgcptPPSSrch", 용역: "getBidPblancListInfoServcPPSSrch", 공사: "getBidPblancListInfoCnstwkPPSSrch" },
  },
};

main().catch((error) => { console.error(`수집 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const state = await readState();
  const migrateOnly = process.argv.includes("--migrate-only");
  await migrateLegacyCsv();
  await migrateModeDirectories();
  // 전체 CSV를 다시 읽는 일회성 정리 작업은 완료 표시를 남겨 다음 실행부터 건너뛴다.
  if (migrateOnly || !state.migrations.has("rebalance-v1")) { await rebalanceModeDirectories(); state.migrations.add("rebalance-v1"); }
  if (migrateOnly || !state.migrations.has("drop-generated-v1")) { await removeGeneratedColumns(); state.migrations.add("drop-generated-v1"); }
  if (migrateOnly || !state.migrations.has("gzip-storage-v1")) { await gzipStorage(); state.migrations.add("gzip-storage-v1"); }
  await saveState(state);
  if (migrateOnly) { await writeIndex(); return; }
  if (!SERVICE_KEY) throw new Error(".env에 SERVICE_KEY를 설정하세요.");
  const config = await readConfig();
  const begin = parseDate(config.begin || "2015-01-01");
  const end = parseDate(config.end || today());
  if (!begin || !end || begin > end) throw new Error("sync.config.json의 기간을 확인하세요.");
  const modes = (config.modes || ["사전공고", "본공고"]).map((mode) => MODE_ALIASES[mode]).filter((mode) => MODES[mode]);
  const types = (config.businessTypes || TYPES).filter((type) => TYPES.includes(type));
  const jobs = [];
  for (const range of chunks(begin, end)) for (const mode of modes) for (const type of types) jobs.push({ range, mode, type });
  httpLimit = Math.max(1, Number(config.concurrency) || DEFAULT_CONCURRENCY);
  const store = await readStore(begin, end);
  const errors = [];
  const completed = new Set(state.completedJobs);
  const entries = jobs.map((job, index) => ({ job, index, id: JSON.stringify(job) }));
  const pending = config.resume === false ? entries : entries.filter((entry) => !completed.has(entry.id));
  console.log(`전체 공고 수집 시작: ${jobs.length}개 작업(대상 ${pending.length}개), 기존 ${store.location.size}건, 동시 요청 ${httpLimit}`);

  // 배치 단위로 API를 동시에 호출하고, 병합·저장은 배치마다 한 번씩만 수행한다.
  for (let offset = 0; offset < pending.length; offset += httpLimit) {
    const batch = pending.slice(offset, offset + httpLimit);
    const results = await mapPool(batch, batch.length, async (entry) => {
      try { return { entry, items: await fetchJob(entry.job) }; } catch (error) { return { entry, error }; }
    });
    const changed = new Set();
    for (const { entry, items, error } of results) {
      const label = `[${entry.index + 1}/${jobs.length}] ${MODE_LABELS[entry.job.mode]}/${entry.job.type}/${entry.job.range.begin}`;
      if (error) { errors.push({ job: entry.job, error: error.message }); console.error(`${label} 실패: ${error.message}`); continue; }
      if (config.resume === false) clearJobRange(store, entry.job, changed);
      applyItems(store, items, changed);
      state.completedJobs.push(entry.id);
      console.log(`${label}~${entry.job.range.end}: ${items.length}건`);
    }
    await writeRecords(store, changed);
    await saveState(state);
  }
  await fs.writeFile(path.join(DATA_DIR, "sync-errors.json"), JSON.stringify(errors, null, 2), "utf8");
  console.log(`완료: ${store.location.size}건 저장, 실패 ${errors.length}건`);
}

async function fetchJob(job) {
  // 1페이지로 전체 페이지 수를 확인한 뒤 나머지 페이지를 동시에 받는다.
  const first = await fetchPage(job, 1);
  if (first.totalPages <= 1) return first.items;
  const rest = await Promise.all(Array.from({ length: first.totalPages - 1 }, (_, index) => fetchPage(job, index + 2)));
  return [...first.items, ...rest.flatMap((page) => page.items)];
}

async function fetchPage(job, pageNo) {
  const definition = MODES[job.mode];
  const params = new URLSearchParams({ type: "json", pageNo: String(pageNo), numOfRows: String(PAGE_SIZE), inqryDiv: "1", inqryBgnDt: `${ymd(job.range.begin)}0000`, inqryEndDt: `${ymd(job.range.end)}2359`, ServiceKey: SERVICE_KEY });
  const data = await requestJson(`${definition.base}/${definition.ops[job.type]}?${params}`);
  const body = data?.response?.body;
  if (!body) throw new Error(data?.response?.header?.resultMsg || JSON.stringify(data));
  const items = Array.isArray(body.items) ? body.items : body.items?.item ? (Array.isArray(body.items.item) ? body.items.item : [body.items.item]) : [];
  return { items, totalPages: Math.max(1, Math.ceil(Number(body.totalCount || 0) / Number(body.numOfRows || PAGE_SIZE))) };
}

// 전역 HTTP 동시 실행 제한. 작업·페이지 병렬을 모두 이 세마포어 하나로 묶어
// 나라장터 API에 동시에 나가는 요청 수를 한 값으로 통제한다.
let httpLimit = DEFAULT_CONCURRENCY;
let httpActive = 0;
const httpQueue = [];
function acquireHttp() { if (httpActive < httpLimit) { httpActive += 1; return Promise.resolve(); } return new Promise((resolve) => httpQueue.push(resolve)); }
function releaseHttp() { const next = httpQueue.shift(); if (next) next(); else httpActive -= 1; }

// 동시 실행 수를 제한하며 비동기 작업을 수행한다.
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index], index); }
  });
  await Promise.all(runners);
  return results;
}

async function requestJson(url) {
  await acquireHttp();
  try {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        if (attempt < RETRIES) await sleep(800 * 2 ** attempt);
      }
    }
    throw lastError;
  } finally {
    releaseHttp();
  }
}
// 레코드를 (공고구분|일자) 버킷으로 나눠 들고 있어, 저장할 때 전체 배열을 다시
// 훑지 않고 바뀐 버킷의 파일만 건드린다. counts는 index.json을 매번 다시 만들지
// 않기 위한 메모리 상의 파일별 건수 캐시다.
function bucketKeyOf(row) { return `${recordMode(row)}|${recordDate(row)}`; }
function relativePath(mode, day) { const [year, month, date] = day.split("-"); return `${mode}/${year}/${month}/${date}.csv.gz`; }

async function readStore(begin, end) {
  const files = await dailyFiles();
  const beginDate = iso(begin);
  const endDate = iso(end);
  const store = { buckets: new Map(), location: new Map(), counts: new Map() };
  let previous = new Map();
  try { previous = new Map(JSON.parse(await fs.readFile(INDEX_FILE, "utf8")).files.map((file) => [file.path, file.count])); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = files.filter((file) => file.date >= beginDate && file.date <= endDate);
  await mapPool(selected, FILE_CONCURRENCY, async (file) => {
    for (const row of await readCsv(path.join(DATA_DIR, file.path))) {
      const key = recordKey(row);
      if (!key) continue;
      bucketFor(store, bucketKeyOf(row)).set(key, row);
      store.location.set(key, bucketKeyOf(row));
    }
  });
  for (const [key, bucket] of store.buckets) { const [mode, day] = key.split("|"); store.counts.set(relativePath(mode, day), bucket.size); }
  // 수집 범위 밖 파일은 읽지 않고 기존 index.json 건수를 그대로 승계한다.
  const missing = files.filter((file) => !store.counts.has(file.path));
  await mapPool(missing, FILE_CONCURRENCY, async (file) => {
    store.counts.set(file.path, previous.has(file.path) ? previous.get(file.path) : (await readCsv(path.join(DATA_DIR, file.path))).length);
  });
  return store;
}

function bucketFor(store, key) { let bucket = store.buckets.get(key); if (!bucket) { bucket = new Map(); store.buckets.set(key, bucket); } return bucket; }

function applyItems(store, items, changed) {
  for (const item of items) {
    const key = recordKey(item);
    if (!key) continue;
    const target = bucketKeyOf(item);
    const source = store.location.get(key);
    // 등록일이 바뀐 공고는 이전 일자 파일에서 빼야 중복이 남지 않는다.
    if (source && source !== target) { store.buckets.get(source)?.delete(key); changed.add(source); }
    bucketFor(store, target).set(key, item);
    store.location.set(key, target);
    changed.add(target);
  }
}

async function writeRecords(store, changed) {
  for (const key of changed) {
    const [mode, day] = key.split("|");
    if (!mode || day === "undated") continue;
    const file = dataFile(day, mode);
    const rows = [...(store.buckets.get(key)?.values() ?? [])];
    if (!rows.length) { await fs.rm(file, { force: true }); store.buckets.delete(key); store.counts.delete(relativePath(mode, day)); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeCsv(file, rows);
    store.counts.set(relativePath(mode, day), rows.length);
  }
  await writeIndexFromStore(store);
}

// 디렉터리를 다시 훑거나 CSV를 다시 파싱하지 않고 메모리 건수로 index.json을 쓴다.
async function writeIndexFromStore(store) {
  const entries = [...store.counts.entries()]
    .map(([file, count]) => { const [mode, year, month, name] = file.split("/"); return { mode, date: `${year}-${month}-${name.slice(0, 2)}`, path: file, count }; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.mode.localeCompare(b.mode));
  await fs.writeFile(INDEX_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: entries }, null, 2), "utf8");
}
async function readCsv(file) { try { return parseCsv(zlib.gunzipSync(await fs.readFile(file)).toString("utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
async function writeCsv(file, rows) { await fs.writeFile(file, zlib.gzipSync(Buffer.from(`\uFEFF${serializeCsv(rows)}\n`, "utf8"))); }
function dataFile(day, mode) { const [year, month, date] = day.split("-"); return path.join(DATA_DIR, mode, year, month, `${date}.csv.gz`); }
async function dailyFiles(extension = "csv.gz") {
  const pattern = new RegExp(`^\\d{2}\\.${extension.replaceAll(".", "\\.")}$`);
  const result = [];
  for (const mode of Object.keys(MODES)) {
    const modePath = path.join(DATA_DIR, mode);
    let years;
    try { years = await fs.readdir(modePath, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const yearEntry of years) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
    const yearPath = path.join(modePath, yearEntry.name);
    const months = await fs.readdir(yearPath, { withFileTypes: true });
    for (const monthEntry of months) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) continue;
      const monthPath = path.join(yearPath, monthEntry.name);
      const days = await fs.readdir(monthPath, { withFileTypes: true });
      for (const dayEntry of days) {
        if (!dayEntry.isFile() || !pattern.test(dayEntry.name)) continue;
        const date = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name.slice(0, 2)}`;
        result.push({ mode, date, path: `${mode}/${yearEntry.name}/${monthEntry.name}/${dayEntry.name}` });
      }
    }
  }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.mode.localeCompare(b.mode));
}
// \uAE30\uC874 \uD3C9\uBB38 CSV(.csv)\uB97C gzip(.csv.gz)\uC73C\uB85C \uC555\uCD95\uD574 \uC800\uC7A5 \uC6A9\uB7C9\uC744 \uC904\uC774\uB294 1\uD68C\uC131 \uB9C8\uC774\uADF8\uB808\uC774\uC158.
async function gzipStorage() {
  const plainFiles = await dailyFiles("csv");
  if (!plainFiles.length) return;
  await mapPool(plainFiles, FILE_CONCURRENCY, async (file) => {
    const source = path.join(DATA_DIR, file.path);
    const text = await fs.readFile(source, "utf8");
    await fs.writeFile(`${source}.gz`, zlib.gzipSync(Buffer.from(text, "utf8")));
    await fs.rm(source);
  });
  await writeIndex();
  console.log(`\uAE30\uC874 CSV ${plainFiles.length}\uAC1C\uB97C gzip\uC73C\uB85C \uC555\uCD95\uD588\uC2B5\uB2C8\uB2E4.`);
}
async function writeIndex(changedDates) {
  const files = await dailyFiles();
  let previous = new Map();
  try { previous = new Map(JSON.parse(await fs.readFile(INDEX_FILE, "utf8")).files.map((file) => [file.path, file.count])); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const entries = await Promise.all(files.map(async (file) => ({ ...file, count: changedDates?.has(file.date) || !previous.has(file.path) ? (await readCsv(path.join(DATA_DIR, file.path))).length : previous.get(file.path) })));
  await fs.writeFile(INDEX_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: entries }, null, 2), "utf8");
}
function recordKey(row) { const number = String(row.bfSpecRgstNo || row.bidNtceNo || "").trim(); return number ? `${recordMode(row)}:${number}` : ""; }
function recordMode(row) { return row.bidNtceNo ? "bid" : row.bfSpecRgstNo ? "pre" : ""; }
function recordDate(row) { const match = String(row.rgstDt || row.bidNtceDt || "").match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/); return match ? `${match[1]}-${match[2]}-${match[3]}` : "undated"; }
function isInRange(value, range) { return value >= range.begin && value <= range.end; }
async function migrateLegacyCsv() {
  const existingDailyFiles = [...await dailyFiles(), ...await dailyFiles("csv"), ...await legacyDailyFiles()];
  if (existingDailyFiles.length) return;
  const backupFile = path.join(DATA_DIR, "notices.legacy.csv");
  let source = LEGACY_CSV_FILE;
  try { await fs.access(source); } catch (error) { if (error.code !== "ENOENT") throw error; source = backupFile; }
  try { await fs.access(source); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const legacyRows = await readCsv(source);
  const grouped = groupRowsByModeAndDate(legacyRows);
  for (const [key, rows] of grouped) { const [mode, day] = key.split("|"); const target = dataFile(day, mode); const existing = await readCsv(target); const merged = new Map(existing.map((row) => [recordKey(row), row])); rows.forEach((row) => merged.set(recordKey(row), row)); await fs.mkdir(path.dirname(target), { recursive: true }); await writeCsv(target, [...merged.values()]); }
  await writeIndex();
  if (source === LEGACY_CSV_FILE) await fs.rename(LEGACY_CSV_FILE, backupFile);
  console.log(`기존 notices.csv를 ${grouped.size}개 일자별 파일로 분할했습니다.`);
}
async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return { completedJobs: state.completedJobs || [], migrations: new Set(state.migrations || []) };
  } catch (error) {
    if (error.code === "ENOENT") return { completedJobs: [], migrations: new Set(MIGRATIONS) }; // 새 데이터 디렉터리는 이관할 대상이 없다
    throw error;
  }
}
async function saveState(state) { await fs.writeFile(STATE_FILE, JSON.stringify({ completedJobs: [...new Set(state.completedJobs)], migrations: [...state.migrations] }, null, 2), "utf8"); }

// resume:false일 때 해당 작업 구간의 기존 레코드를 비운다. 버킷 단위라 구간 밖은 건드리지 않는다.
function clearJobRange(store, job, changed) {
  for (const [key, bucket] of store.buckets) {
    const [mode, day] = key.split("|");
    if (mode !== job.mode || !isInRange(day, job.range)) continue;
    for (const [recordId, record] of bucket) {
      if (record.bsnsDivNm !== job.type) continue;
      bucket.delete(recordId);
      store.location.delete(recordId);
      changed.add(key);
    }
  }
}
async function readConfig() { try { return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch (error) { if (error.code === "ENOENT") throw new Error("sync.config.example.json을 복사해 sync.config.json을 만드세요."); throw error; } }
function parseCsv(text) { const rows = parseLines(text.replace(/^\uFEFF/, "")); if (rows.length < 2) return []; const header = rows[0]; return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, i) => [key, fromTextCell(cells[i] || "")]))); }
function fromTextCell(value) { const match = /^="([\s\S]*)"$/.exec(value); if (match) return match[1]; return value.startsWith("=") ? value.slice(1) : value; }
async function removeGeneratedColumns() {
  const generated = new Set(["id", "mode", "noticeType", "announcementNumber", "institution", "businessType", "title", "publishedAt", "closeAt", "files", "updatedAt"]);
  for (const file of await dailyFiles()) {
    const target = path.join(DATA_DIR, file.path);
    const rows = await readCsv(target);
    if (!rows.some((row) => Object.keys(row).some((key) => generated.has(key)))) continue;
    await writeCsv(target, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !generated.has(key)))));
  }
}
async function legacyDailyFiles() {
  const years = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const result = [];
  for (const yearEntry of years) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
    const yearPath = path.join(DATA_DIR, yearEntry.name);
    const months = await fs.readdir(yearPath, { withFileTypes: true });
    for (const monthEntry of months) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) continue;
      const monthPath = path.join(yearPath, monthEntry.name);
      const days = await fs.readdir(monthPath, { withFileTypes: true });
      for (const dayEntry of days) {
        if (!dayEntry.isFile() || !/^\d{2}\.csv$/.test(dayEntry.name)) continue;
        result.push({ date: `${yearEntry.name}-${monthEntry.name}-${dayEntry.name.slice(0, 2)}`, path: `${yearEntry.name}/${monthEntry.name}/${dayEntry.name}` });
      }
    }
  }
  return result;
}
function groupRowsByModeAndDate(rows) { const grouped = new Map(); for (const row of rows) { const mode = recordMode(row); const day = recordDate(row); if (!mode || day === "undated") continue; const key = `${mode}|${day}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); } return grouped; }
async function migrateModeDirectories() {
  const legacyFiles = await legacyDailyFiles();
  if (!legacyFiles.length) return;
  let migratedRows = 0;
  for (const file of legacyFiles) {
    const grouped = groupRowsByModeAndDate(await readCsv(path.join(DATA_DIR, file.path)));
    if (!grouped.size) throw new Error(`기존 CSV를 분류할 수 없습니다: ${file.path}`);
    for (const [key, rows] of grouped) {
      const [mode, day] = key.split("|");
      const target = dataFile(day, mode);
      const merged = new Map((await readCsv(target)).map((row) => [recordKey(row), row]));
      rows.forEach((row) => merged.set(recordKey(row), row));
      migratedRows += rows.length;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeCsv(target, [...merged.values()]);
    }
  }
  if (!migratedRows) throw new Error("기존 CSV에서 이관할 행을 찾지 못했습니다.");
  for (const year of new Set(legacyFiles.map((file) => file.path.split("/")[0]))) await fs.rm(path.join(DATA_DIR, year), { recursive: true, force: true });
  await writeIndex();
  console.log(`기존 날짜별 CSV ${legacyFiles.length}개를 사전공고/본공고 폴더로 분리했습니다.`);
}
async function rebalanceModeDirectories() {
  const files = await dailyFiles();
  const rowsByTarget = new Map();
  for (const file of files) {
    for (const row of await readCsv(path.join(DATA_DIR, file.path))) {
      const mode = recordMode(row);
      const day = recordDate(row);
      if (!mode || day === "undated") continue;
      const target = dataFile(day, mode);
      if (!rowsByTarget.has(target)) rowsByTarget.set(target, new Map());
      rowsByTarget.get(target).set(recordKey(row), row);
    }
  }
  if (!rowsByTarget.size) return;
  for (const [target, rows] of rowsByTarget) { await fs.mkdir(path.dirname(target), { recursive: true }); await writeCsv(target, [...rows.values()]); }
  const targets = new Set(rowsByTarget.keys());
  for (const file of files) { const source = path.join(DATA_DIR, file.path); if (!targets.has(source)) await fs.rm(source, { force: true }); }
  await writeIndex(new Set(files.map((file) => file.date)));
}
function parseLines(text) { const rows = []; let row = [], cell = "", quoted = false; for (let i = 0; i < text.length; i += 1) { const char = text[i]; if (quoted && char === '"' && text[i + 1] === '"') { cell += char; i += 1; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(cell); cell = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[i + 1] === "\n") i += 1; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; } else cell += char; } if (cell || row.length) rows.push([...row, cell]); return rows; }
function chunks(begin, end) { const result = []; for (let cursor = new Date(begin); cursor <= end;) { const finish = new Date(Math.min(addDays(cursor, RANGE_DAYS - 1), end)); result.push({ begin: iso(cursor), end: iso(finish) }); cursor = addDays(finish, 1); } return result; }
function parseDate(value) { const result = new Date(`${value}T00:00:00`); return Number.isNaN(result.valueOf()) ? null : result; }
function addDays(value, days) { const result = new Date(value); result.setDate(result.getDate() + days); return result; }
function iso(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function ymd(value) { return String(value).replaceAll("-", ""); }
function today() { return iso(new Date()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function loadEnv(file) { try { fsSync.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => { const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ""); }); } catch (error) { if (error.code !== "ENOENT") throw error; } }
