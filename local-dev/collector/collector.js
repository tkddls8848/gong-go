// 로컬 전용 전체 공고 수집기. Cloudflare Pages/Functions와 무관하게 실행된다.
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LEGACY_CSV_FILE = path.join(DATA_DIR, "notices.csv");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");
const CONFIG_FILE = path.join(ROOT, "sync.config.json");
const PAGE_SIZE = 999;
const RANGE_DAYS = 28;
const RETRIES = 3;
const TYPES = ["물품", "외자", "용역", "공사"];
const MODE_ALIASES = { 사전공고: "pre", 본공고: "bid", pre: "pre", bid: "bid" };
const MODE_LABELS = { pre: "사전공고", bid: "본공고" };

loadEnv(path.join(ROOT, ".env"));
const SERVICE_KEY = process.env.SERVICE_KEY || "";
const MODES = {
  pre: {
    base: "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService",
    ops: { 물품: "getPublicPrcureThngInfoThngPPSSrch", 외자: "getPublicPrcureThngInfoFrgcptPPSSrch", 용역: "getPublicPrcureThngInfoServcPPSSrch", 공사: "getPublicPrcureThngInfoCnstwkPPSSrch" },
    announcementNumber: (item) => String(item.bfSpecRgstNo || "").trim(),
    row: (item, type) => ({ institution: item.rlDminsttNm || item.dminsttNm || "", businessType: type, title: item.prdctClsfcNoNm || "", publishedAt: item.rgstDt || "", closeAt: item.opninRgstClseDt || "", files: fileUrls(item, "specDocFileUrl", 5) }),
  },
  bid: {
    base: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService",
    ops: { 물품: "getBidPblancListInfoThngPPSSrch", 외자: "getBidPblancListInfoFrgcptPPSSrch", 용역: "getBidPblancListInfoServcPPSSrch", 공사: "getBidPblancListInfoCnstwkPPSSrch" },
    announcementNumber: (item) => String(item.bidNtceNo || "").trim(),
    row: (item, type) => ({ institution: item.dminsttNm || "", businessType: type, title: item.bidNtceNm || "", publishedAt: item.bidNtceDt || "", closeAt: item.bidClseDt || "", files: fileUrls(item, "ntceSpecDocUrl", 10) }),
  },
};

main().catch((error) => { console.error(`수집 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await migrateLegacyCsv();
  if (!SERVICE_KEY) throw new Error(".env에 SERVICE_KEY를 설정하세요.");
  const config = await readConfig();
  const begin = parseDate(config.begin || "2015-01-01");
  const end = parseDate(config.end || today());
  if (!begin || !end || begin > end) throw new Error("sync.config.json의 기간을 확인하세요.");
  const modes = (config.modes || ["사전공고", "본공고"]).map((mode) => MODE_ALIASES[mode]).filter((mode) => MODES[mode]);
  const types = (config.businessTypes || TYPES).filter((type) => TYPES.includes(type));
  const jobs = [];
  for (const range of chunks(begin, end)) for (const mode of modes) for (const type of types) jobs.push({ range, mode, type });
  const state = await readState();
  const records = new Map((await readRecords(begin, end)).map((row) => [row.id, row]));
  const errors = [];
  console.log(`전체 공고 수집 시작: ${jobs.length}개 작업, 기존 ${records.size}건`);

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const id = JSON.stringify(job);
    if (config.resume !== false && state.completedJobs.includes(id)) {
      console.log(`[${index + 1}/${jobs.length}] 완료 구간 건너뜀 ${MODE_LABELS[job.mode]}/${job.type}/${job.range.begin}`);
      continue;
    }
    try {
      const items = await fetchJob(job);
      const definition = MODES[job.mode];
      const changedDates = new Set();
      if (config.resume === false) {
        for (const [recordId, record] of records) {
          if (record.mode !== job.mode || record.businessType !== job.type || !isInRange(recordDate(record), job.range)) continue;
          changedDates.add(recordDate(record));
          records.delete(recordId);
        }
      }
      for (const item of items) {
        const announcementNumber = definition.announcementNumber(item);
        if (!announcementNumber) continue;
        const id = `${job.mode}:${announcementNumber}`;
        const previous = records.get(id);
        if (previous) changedDates.add(recordDate(previous));
        const row = { id, mode: job.mode, noticeType: MODE_LABELS[job.mode], announcementNumber, ...definition.row(item, job.type), updatedAt: new Date().toISOString() };
        records.set(id, row);
        changedDates.add(recordDate(row));
      }
      state.completedJobs.push(id);
      await writeRecords([...records.values()], changedDates);
      await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
      console.log(`[${index + 1}/${jobs.length}] ${MODE_LABELS[job.mode]}/${job.type}/${job.range.begin}~${job.range.end}: ${items.length}건`);
    } catch (error) {
      errors.push({ job, error: error.message });
      console.error(`[${index + 1}/${jobs.length}] 실패 ${MODE_LABELS[job.mode]}/${job.type}/${job.range.begin}: ${error.message}`);
    }
  }
  await fs.writeFile(path.join(DATA_DIR, "sync-errors.json"), JSON.stringify(errors, null, 2), "utf8");
  console.log(`완료: ${records.size}건 저장, 실패 ${errors.length}건`);
}

async function fetchJob(job) {
  const definition = MODES[job.mode];
  const result = [];
  let pageNo = 1;
  let totalPages = 1;
  while (pageNo <= totalPages) {
    const params = new URLSearchParams({ type: "json", pageNo: String(pageNo), numOfRows: String(PAGE_SIZE), inqryDiv: "1", inqryBgnDt: `${ymd(job.range.begin)}0000`, inqryEndDt: `${ymd(job.range.end)}2359`, ServiceKey: SERVICE_KEY });
    const data = await requestJson(`${definition.base}/${definition.ops[job.type]}?${params}`);
    const body = data?.response?.body;
    if (!body) throw new Error(data?.response?.header?.resultMsg || JSON.stringify(data));
    const items = Array.isArray(body.items) ? body.items : body.items?.item ? (Array.isArray(body.items.item) ? body.items.item : [body.items.item]) : [];
    result.push(...items);
    totalPages = Math.max(1, Math.ceil(Number(body.totalCount || 0) / Number(body.numOfRows || PAGE_SIZE)));
    pageNo += 1;
  }
  return result;
}

async function requestJson(url) {
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
}
const COLUMNS = ["id", "mode", "noticeType", "announcementNumber", "institution", "businessType", "title", "publishedAt", "closeAt", "files", "updatedAt"];
async function readRecords(begin, end) {
  const files = await dailyFiles();
  const beginDate = iso(begin);
  const endDate = iso(end);
  const selected = files.filter((file) => file.date >= beginDate && file.date <= endDate);
  const groups = await Promise.all(selected.map((file) => readCsv(path.join(DATA_DIR, file.path))));
  return groups.flat();
}
async function writeRecords(rows, changedDates) {
  for (const day of changedDates) {
    const dailyRows = rows.filter((row) => recordDate(row) === day);
    const file = dataFile(day);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeCsv(file, dailyRows);
  }
  await writeIndex(changedDates);
}
async function readCsv(file) { try { return parseCsv(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
async function writeCsv(file, rows) { const content = [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((key) => csv(row[key])).join(","))].join("\n"); await fs.writeFile(file, `\uFEFF${content}\n`, "utf8"); }
function dataFile(day) { const [year, month, date] = day.split("-"); return path.join(DATA_DIR, year, month, `${date}.csv`); }
async function dailyFiles() {
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
        const date = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name.slice(0, 2)}`;
        result.push({ date, path: `${yearEntry.name}/${monthEntry.name}/${dayEntry.name}` });
      }
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
async function writeIndex(changedDates) {
  const files = await dailyFiles();
  let previous = new Map();
  try { previous = new Map(JSON.parse(await fs.readFile(INDEX_FILE, "utf8")).files.map((file) => [file.date, file.count])); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const entries = await Promise.all(files.map(async (file) => ({ ...file, count: changedDates?.has(file.date) || !previous.has(file.date) ? (await readCsv(path.join(DATA_DIR, file.path))).length : previous.get(file.date) })));
  await fs.writeFile(INDEX_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: entries }, null, 2), "utf8");
}
function recordDate(row) { const match = String(row.publishedAt || "").match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/); return match ? `${match[1]}-${match[2]}-${match[3]}` : "undated"; }
function isInRange(value, range) { return value >= range.begin && value <= range.end; }
async function migrateLegacyCsv() {
  const existingDailyFiles = await dailyFiles();
  if (existingDailyFiles.length) return;
  const backupFile = path.join(DATA_DIR, "notices.legacy.csv");
  let source = LEGACY_CSV_FILE;
  try { await fs.access(source); } catch (error) { if (error.code !== "ENOENT") throw error; source = backupFile; }
  try { await fs.access(source); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const legacyRows = await readCsv(source);
  const grouped = new Map();
  for (const row of legacyRows) { const day = recordDate(row); if (!grouped.has(day)) grouped.set(day, []); grouped.get(day).push(row); }
  for (const [day, rows] of grouped) { const target = dataFile(day); const existing = await readCsv(target); const merged = new Map(existing.map((row) => [row.id, row])); rows.forEach((row) => merged.set(row.id, row)); await fs.mkdir(path.dirname(target), { recursive: true }); await writeCsv(target, [...merged.values()]); }
  await writeIndex();
  if (source === LEGACY_CSV_FILE) await fs.rename(LEGACY_CSV_FILE, backupFile);
  console.log(`기존 notices.csv를 ${grouped.size}개 일자별 파일로 분할했습니다.`);
}
async function readState() { try { const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); return { completedJobs: state.completedJobs || [] }; } catch (error) { if (error.code === "ENOENT") return { completedJobs: [] }; throw error; } }
async function readConfig() { try { return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch (error) { if (error.code === "ENOENT") throw new Error("sync.config.example.json을 복사해 sync.config.json을 만드세요."); throw error; } }
function csv(value) { const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function parseCsv(text) { const rows = parseLines(text.replace(/^\uFEFF/, "")); if (rows.length < 2) return []; const header = rows[0]; return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i] || ""]))).map((row) => ({ ...row, noticeType: row.noticeType || MODE_LABELS[row.mode] || "", announcementNumber: row.announcementNumber || "", files: json(row.files, []) })); }
function parseLines(text) { const rows = []; let row = [], cell = "", quoted = false; for (let i = 0; i < text.length; i += 1) { const char = text[i]; if (quoted && char === '"' && text[i + 1] === '"') { cell += char; i += 1; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(cell); cell = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[i + 1] === "\n") i += 1; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; } else cell += char; } if (cell || row.length) rows.push([...row, cell]); return rows; }
function chunks(begin, end) { const result = []; for (let cursor = new Date(begin); cursor <= end;) { const finish = new Date(Math.min(addDays(cursor, RANGE_DAYS - 1), end)); result.push({ begin: iso(cursor), end: iso(finish) }); cursor = addDays(finish, 1); } return result; }
function parseDate(value) { const result = new Date(`${value}T00:00:00`); return Number.isNaN(result.valueOf()) ? null : result; }
function addDays(value, days) { const result = new Date(value); result.setDate(result.getDate() + days); return result; }
function iso(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function ymd(value) { return String(value).replaceAll("-", ""); }
function today() { return iso(new Date()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fileUrls(item, prefix, count) { return Array.from({ length: count }, (_, index) => String(item[`${prefix}${index + 1}`] || "").trim()).filter((url) => /^https?:/i.test(url)); }
function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function loadEnv(file) { try { fsSync.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => { const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ""); }); } catch (error) { if (error.code !== "ENOENT") throw error; } }
