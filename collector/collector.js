// 나라장터 공고를 현재 저장 형식(data/{pre,bid}/YYYY/MM/DD.csv.gz)으로 수집한다.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { serializeCsv, parseCsv } = require("../shared/csv-record");
const { ROOT, DATA_DIR, loadEnv, mapPool, sleep, buildIndexEntries } = require("../shared/pipeline-utils");
const { project } = require("../shared/service-columns");

const CONFIG_FILE = path.join(__dirname, "sync.config.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");
const PAGE_SIZE = 999;
const RANGE_DAYS = 28;
const RETRIES = 3;
const FILE_CONCURRENCY = 16;
const TYPES = ["물품", "외자", "용역", "공사"];
const MODE_ALIASES = { 사전공고: "pre", 본공고: "bid", 발주계획: "plan" };
const MODE_LABELS = { pre: "사전공고", bid: "본공고", plan: "발주계획" };

loadEnv(path.join(ROOT, ".env"));
const SERVICE_KEY = process.env.SERVICE_KEY || "";
// 요청이 나가는 곳. 기본은 공공데이터포털 직접 호출이다.
// GitHub Actions 러너에서는 apis.data.go.kr로 TCP 연결이 성립하지 않으므로(차단이 국가가 아니라
// IP 대역 기준이다) API_BASE에 Worker의 중계 주소를 넣어 우회한다. 예:
//   API_BASE=https://gong-go-dev.<계정>.workers.dev/api/relay
//   RELAY_TOKEN=<Worker에 등록한 것과 같은 값>
// 경로와 쿼리는 그대로 유지되므로 아래 정의는 어느 쪽이든 바뀌지 않는다.
// (docs/이슈-Actions-수집-차단.md)
const API_BASE = (process.env.API_BASE || "https://apis.data.go.kr").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const MODES = {
  pre: {
    base: "/1230000/ao/HrcspSsstndrdInfoService",
    ops: { 물품: "getPublicPrcureThngInfoThngPPSSrch", 외자: "getPublicPrcureThngInfoFrgcptPPSSrch", 용역: "getPublicPrcureThngInfoServcPPSSrch", 공사: "getPublicPrcureThngInfoCnstwkPPSSrch" },
  },
  bid: {
    base: "/1230000/ad/BidPublicInfoService",
    ops: { 물품: "getBidPblancListInfoThngPPSSrch", 외자: "getBidPblancListInfoFrgcptPPSSrch", 용역: "getBidPblancListInfoServcPPSSrch", 공사: "getBidPblancListInfoCnstwkPPSSrch" },
  },
  // 발주계획현황(15129462). 앞의 둘과 달리 조회 범위를 지정할 수 없다 — orderBgnYm/orderEndYm과
  // inqryBgnDt/inqryEndDt를 모두 받아 형식까지 검증하면서도(잘못된 포맷은 "DATE Format 에러")
  // 어떤 값을 넣든 결과가 바뀌지 않는다. 실제로 돌아오는 것은 최근 며칠 안에 게시된 계획뿐이다.
  //
  // 그래서 이 모드는 snapshot으로 둔다. 과거를 소급해 받을 수 없고, 매 실행이 "지금 열려 있는
  // 창"을 한 번 떠 오는 것이다. 보유 데이터는 그 스냅샷이 nticeDt(게시일시) 기준으로 쌓여 만들어진다.
  plan: {
    base: "/1230000/ao/OrderPlanSttusService",
    ops: { 물품: "getOrderPlanSttusListThngPPSSrch", 외자: "getOrderPlanSttusListFrgcptPPSSrch", 용역: "getOrderPlanSttusListServcPPSSrch", 공사: "getOrderPlanSttusListCnstwkPPSSrch" },
    snapshot: true,
  },
};

main().catch((error) => { console.error(`수집 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const state = await readState();
  if (!SERVICE_KEY) throw new Error(".env에 SERVICE_KEY를 설정하세요.");
  const config = await readConfig();
  // --begin/--end/--no-resume은 sync.config.json을 건드리지 않고 이번 실행에만 적용된다.
  // 갱신 버튼(devserver)이 최근 구간만 다시 받을 때 사용한다.
  const args = parseArgs();
  const resume = args.resume === false ? false : config.resume;
  // 우선순위는 CLI 인자 > GitHub Actions 환경변수 > sync.config.json 순이다.
  const begin = parseDate(args.begin || process.env.SYNC_BEGIN || config.begin);
  const end = parseDate(args.end || process.env.SYNC_END || config.end || today());
  if (!begin || !end || begin > end) throw new Error("수집 기간을 확인하세요(sync.config.json 또는 --begin/--end).");
  const modes = config.modes.map((mode) => MODE_ALIASES[mode]).filter((mode) => MODES[mode]);
  const types = config.businessTypes.filter((type) => TYPES.includes(type));
  const jobs = [];
  // 스냅샷 모드(plan)는 범위를 나눠 봐야 매번 같은 응답이 온다. 업무구분당 한 번만 부른다.
  for (const mode of modes) {
    const ranges = MODES[mode].snapshot ? [{ begin: iso(begin), end: iso(end) }] : chunks(begin, end);
    for (const range of ranges) for (const type of types) jobs.push({ range, mode, type });
  }
  httpLimit = Math.max(1, Number(config.concurrency));
  const store = await readStore(begin, end);
  const errors = [];
  const completed = new Set(state.completedJobs);
  const entries = jobs.map((job, index) => ({ job, index, id: JSON.stringify(job) }));
  const pending = resume === false ? entries : entries.filter((entry) => !completed.has(entry.id));
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
      // 스냅샷 모드는 절대 비우지 않는다. 응답이 최근 며칠치뿐인데 --no-resume이 수집 구간
      // (크론은 35일)을 비워 버리면, 그 앞에 쌓아 둔 발주계획이 매 실행마다 사라진다.
      if (resume === false && !MODES[entry.job.mode].snapshot) clearJobRange(store, entry.job, changed);
      applyItems(store, items, changed);
      if (resume !== false) state.completedJobs.push(entry.id);
      console.log(`${label}~${entry.job.range.end}: ${items.length}건`);
    }
    await writeRecords(store, changed);
    if (resume !== false) await saveState(state);
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
  const params = new URLSearchParams({ type: "json", pageNo: String(pageNo), numOfRows: String(PAGE_SIZE), inqryDiv: "1", ...rangeParams(job), ServiceKey: SERVICE_KEY });
  const data = await requestJson(`${API_BASE}${definition.base}/${definition.ops[job.type]}?${params}`);
  const body = data?.response?.body;
  if (!body) throw new Error(data?.response?.header?.resultMsg || JSON.stringify(data));
  const items = Array.isArray(body.items) ? body.items : body.items?.item ? (Array.isArray(body.items.item) ? body.items.item : [body.items.item]) : [];
  return { items, totalPages: Math.max(1, Math.ceil(Number(body.totalCount || 0) / Number(body.numOfRows || PAGE_SIZE))) };
}

// 조회 범위 파라미터는 서비스마다 이름이 다르다. 발주계획은 일시(inqryBgnDt)가 아니라
// 발주년월(orderBgnYm)을 받는다 — 지금은 어느 쪽도 결과를 거르지 않지만, 포털이 필터를
// 고치면 그때는 요청한 구간만 오는 것이 맞으므로 명세대로 실어 보낸다.
function rangeParams(job) {
  if (MODES[job.mode].snapshot) return { orderBgnYm: ym(job.range.begin), orderEndYm: ym(job.range.end) };
  return { inqryBgnDt: `${ymd(job.range.begin)}0000`, inqryEndDt: `${ymd(job.range.end)}2359` };
}

// 전역 HTTP 동시 실행 제한. 작업·페이지 병렬을 모두 이 세마포어 하나로 묶어
// 나라장터 API에 동시에 나가는 요청 수를 한 값으로 통제한다.
let httpLimit = 1;
let httpActive = 0;
const httpQueue = [];
function acquireHttp() { if (httpActive < httpLimit) { httpActive += 1; return Promise.resolve(); } return new Promise((resolve) => httpQueue.push(resolve)); }
function releaseHttp() { const next = httpQueue.shift(); if (next) next(); else httpActive -= 1; }

async function requestJson(url) {
  await acquireHttp();
  try {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, { headers: { Accept: "application/json", ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}) } });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
      } catch (error) {
        lastError = withCause(error);
        if (attempt < RETRIES) await sleep(800 * 2 ** attempt);
      }
    }
    throw lastError;
  } finally {
    releaseHttp();
  }
}

// fetch가 네트워크 단계에서 실패하면 message는 "fetch failed" 한 줄뿐이고 실제 사유는
// cause에 들어간다. 로컬에서는 재현되지 않고 GitHub Actions에서만 터지는 경우가 있어,
// DNS(ENOTFOUND)·연결 거부(ECONNREFUSED)·타임아웃·인증서 오류를 구분할 수 있어야 한다.
function withCause(error) {
  const cause = error?.cause;
  if (!cause) return error;
  const detail = [cause.code, cause.message].filter(Boolean).join(": ");
  return detail ? new Error(`${error.message} (${detail})`, { cause }) : error;
}
// 레코드를 (공고구분|일자) 버킷으로 나눠 들고 있어, 저장할 때 전체 배열을 다시
// 훑지 않고 바뀐 버킷의 파일만 건드린다. counts는 index.json을 매번 다시 만들지
// 않기 위한 메모리 상의 파일별 건수 캐시다.
function bucketKeyOf(row) { return `${recordMode(row)}|${recordDate(row)}`; }
function relativePath(mode, day) { const [year, month, date] = day.split("-"); return `${mode}/${year}/${month}/${date}.csv.gz`; }

async function readStore(begin, end) {
  const files = await dailyFiles();
  const sealed = await sealedFiles();
  const beginDate = iso(begin);
  const endDate = iso(end);
  // 봉인된 월(compact.js)로 다시 수집하면, 새로 받은 행은 일별 파일에 쓰이지만 인덱스는
  // 월 파일만 가리키므로 뷰어에 보이지 않는다. 되살리려면 그 달을 다시 봉인해야 한다.
  const overlap = sealed.filter((file) => file.month >= beginDate.slice(0, 7) && file.month <= endDate.slice(0, 7));
  if (overlap.length) console.warn(`경고: 수집 범위가 봉인된 월 ${overlap.length}개(${overlap[0].month}~${overlap.at(-1).month})와 겹칩니다. 수집 후 node collector/compact.js로 다시 봉인하세요.`);
  const store = { buckets: new Map(), location: new Map(), counts: new Map() };
  let previous = new Map();
  try { previous = new Map(JSON.parse(await fs.readFile(INDEX_FILE, "utf8")).files.map((file) => [file.path, file.count])); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = files.filter((file) => file.date >= beginDate && file.date <= endDate);
  await mapPool(selected, FILE_CONCURRENCY, async (file) => {
    for (const row of await readSourceCsv(file.path)) {
      const key = recordKey(row);
      if (!key) continue;
      bucketFor(store, bucketKeyOf(row)).set(key, row);
      store.location.set(key, bucketKeyOf(row));
    }
  });
  for (const [key, bucket] of store.buckets) { const [mode, day] = key.split("|"); store.counts.set(relativePath(mode, day), bucket.size); }
  // 수집 범위 밖 파일은 읽지 않고 기존 index.json 건수를 그대로 승계한다.
  // compact.js가 만든 월별 봉인 파일도 여기서 건수만 승계한다. 일별로 되풀지 않는 이유는
  // 되풀면 writeRecords가 봉인을 일별 파일로 되돌려 놓기 때문이다.
  //
  // 봉인된 달의 일별 파일은 세지 않는다. 그 달은 인덱스에 월 항목 하나로만 오르므로
  // (buildIndexEntries) 건수가 쓰이지 않는데, 인덱스에 없다는 이유로 승계에 실패해
  // --prune 전에는 4,700여 개를 전부 다시 파싱하게 된다.
  const sealedMonths = new Set(sealed.map((file) => `${file.mode}|${file.month}`));
  const countable = files.filter((file) => !sealedMonths.has(`${file.mode}|${file.date.slice(0, 7)}`));
  const missing = [...countable, ...sealed].filter((file) => !store.counts.has(file.path));
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
    if (!rows.length) { await fs.rm(file, { force: true }); await fs.rm(path.join(DATA_DIR, "raw", path.relative(DATA_DIR, file)), { force: true }); store.buckets.delete(key); store.counts.delete(relativePath(mode, day)); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeCsv(file, rows);
    store.counts.set(relativePath(mode, day), rows.length);
  }
  await writeIndexFromStore(store);
}

// 디렉터리를 다시 훑거나 CSV를 다시 파싱하지 않고 메모리 건수로 index.json을 쓴다.
async function writeIndexFromStore(store) {
  await fs.writeFile(INDEX_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: buildIndexEntries(store.counts) }, null, 2), "utf8");
}
async function readCsv(file) { try { return parseCsv(zlib.gunzipSync(await fs.readFile(file)).toString("utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
async function readSourceCsv(relative) { return readCsv(path.join(DATA_DIR, "raw", relative)); }
// 서비스용 일자별 파일에는 필요한 컬럼만, 원본 전체는 data/raw 아래 같은 구조로 따로 보관한다.
// 원본을 일자별로 두는 이유는 증분 병합·중복 제거가 그대로 성립하기 때문이다. 단일 CSV에
// append만 하면 배치마다 컬럼 집합이 달라져 열이 어긋나고, 갱신분이 중복으로 쌓인다.
// 원본을 하나로 묶어 주던 collector/export-raw.js는 삭제됐다. data/raw가 서비스 파일과
// 1:1로 대응하는 일자별 미러이므로 그 자체가 백업이고, 별도로 묶는 단계는 없다.
async function writeCsv(file, rows) {
  await fs.writeFile(file, zlib.gzipSync(Buffer.from(`\uFEFF${serializeCsv(rows.map((row) => project(row)))}\n`, "utf8")));
  const rawFile = path.join(DATA_DIR, "raw", path.relative(DATA_DIR, file));
  await fs.mkdir(path.dirname(rawFile), { recursive: true });
  await fs.writeFile(rawFile, zlib.gzipSync(Buffer.from(`\uFEFF${serializeCsv(rows)}\n`, "utf8")));
}
function dataFile(day, mode) { const [year, month, date] = day.split("-"); return path.join(DATA_DIR, mode, year, month, `${date}.csv.gz`); }
async function dailyFiles() {
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
        if (!dayEntry.isFile() || !/^\d{2}\.csv\.gz$/.test(dayEntry.name)) continue;
        const date = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name.slice(0, 2)}`;
        result.push({ mode, date, path: `${mode}/${yearEntry.name}/${monthEntry.name}/${dayEntry.name}` });
      }
    }
  }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.mode.localeCompare(b.mode));
}
// collector/compact.js가 만든 월별 봉인 파일. 일별 파일과 달리 YYYY 아래에 바로 놓인다
// ({pre,bid}/YYYY/MM.csv.gz). 수집기는 이 파일을 읽지 않고 index.json 건수만 승계한다.
async function sealedFiles() {
  const result = [];
  for (const mode of Object.keys(MODES)) {
    let years;
    try { years = await fs.readdir(path.join(DATA_DIR, mode), { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const yearEntry of years) {
      if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
      for (const entry of await fs.readdir(path.join(DATA_DIR, mode, yearEntry.name), { withFileTypes: true })) {
        if (!entry.isFile() || !/^\d{2}\.csv\.gz$/.test(entry.name)) continue;
        result.push({ mode, month: `${yearEntry.name}-${entry.name.slice(0, 2)}`, path: `${mode}/${yearEntry.name}/${entry.name}` });
      }
    }
  }
  return result.sort((a, b) => a.month.localeCompare(b.month) || a.mode.localeCompare(b.mode));
}
function recordKey(row) { const number = String(row.bfSpecRgstNo || row.bidNtceNo || row.orderPlanUntyNo || "").trim(); return number ? `${recordMode(row)}:${number}` : ""; }
function recordMode(row) { return row.bidNtceNo ? "bid" : row.bfSpecRgstNo ? "pre" : row.orderPlanUntyNo ? "plan" : ""; }
// 발주계획에는 등록일자가 없다. 대신 게시일시(nticeDt)가 레코드마다 고정된 값으로 들어오므로
// 그것을 일자로 쓴다. 발주년월(orderYear/orderMnth)은 "언제 발주할 예정인가"라서 일자가 없고,
// 그대로 쓰면 미래 날짜 파일이 생겨 조회 구간과 어긋난다.
function recordDate(row) { const match = String(row.rgstDt || row.bidNtceDt || row.nticeDt || "").match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/); return match ? `${match[1]}-${match[2]}-${match[3]}` : "undated"; }
function isInRange(value, range) { return value >= range.begin && value <= range.end; }
async function readState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return { completedJobs: state.completedJobs || [] };
  } catch (error) {
    if (error.code === "ENOENT") return { completedJobs: [] };
    throw error;
  }
}
async function saveState(state) { await fs.writeFile(STATE_FILE, JSON.stringify({ completedJobs: [...new Set(state.completedJobs)] }, null, 2), "utf8"); }

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
async function readConfig() { try { return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch (error) { if (error.code === "ENOENT") throw new Error("collector/sync.config.json을 찾지 못했습니다."); throw error; } }
function chunks(begin, end) { const result = []; for (let cursor = new Date(begin); cursor <= end;) { const finish = new Date(Math.min(addDays(cursor, RANGE_DAYS - 1), end)); result.push({ begin: iso(cursor), end: iso(finish) }); cursor = addDays(finish, 1); } return result; }
function parseArgs() { const args = {}; for (const arg of process.argv.slice(2)) { if (arg === "--no-resume") { args.resume = false; continue; } const match = arg.match(/^--(begin|end)=(\d{4}-\d{2}-\d{2})$/); if (match) args[match[1]] = match[2]; } return args; }
function parseDate(value) { const result = new Date(`${value}T00:00:00`); return Number.isNaN(result.valueOf()) ? null : result; }
function addDays(value, days) { const result = new Date(value); result.setDate(result.getDate() + days); return result; }
function iso(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function ymd(value) { return String(value).replaceAll("-", ""); }
function ym(value) { return ymd(value).slice(0, 6); }
function today() { return iso(new Date()); }
