// 나라장터 공고를 현재 저장 형식(data/{pre,bid}/YYYY/MM/DD.csv.gz)으로 수집한다.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const gzip = promisify(zlib.gzip);
const { serializeCsv, parseCsv } = require("../shared/csv-record");
const { ROOT, DATA_DIR, loadEnv, mapPool, sleep, buildIndexEntries } = require("../shared/pipeline-utils");
const { project } = require("../shared/service-columns");

const CONFIG_FILE = path.join(__dirname, "sync.config.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");
const PAGE_SIZE = 999;
const RANGE_DAYS = 28;
const RETRIES = 3;
// 요청 하나의 전체 시한. 본문을 다 받는 시간까지 포함한다. 본공고 한 페이지가 5~6MB라
// 동시 8요청에서는 정상 응답도 15~30초가 걸려, 30초로는 멀쩡한 페이지가 시한에 잘렸다.
const REQUEST_TIMEOUT_MS = 90_000;
const FILE_CONCURRENCY = 16;
const WRITE_CONCURRENCY = 8;
// 재개용 중간 저장 주기(완료 작업 수). 저장 자체는 수집을 멈추지 않으므로 자주 해도 싸다.
const FLUSH_EVERY = 8;
const TYPES = ["물품", "외자", "용역", "공사"];
const SOURCE_ENDPOINT = "__sourceEndpoint";
const MODE_ALIASES = { 사전공고: "pre", 본공고: "bid", 발주계획: "plan" };
const MODE_LABELS = { pre: "사전공고", bid: "본공고", plan: "발주계획" };

loadEnv(path.join(ROOT, ".env"));
const SERVICE_KEY = process.env.SERVICE_KEY || "";
// 요청이 나가는 곳. 기본은 공공데이터포털 직접 호출이다.
// GitHub Actions 러너에서는 apis.data.go.kr로 TCP 연결이 성립하지 않으므로(차단이 국가가 아니라
// IP 대역 기준이다) API_BASE에 Worker의 중계 주소를 넣어 우회한다. 예:
//   API_BASE=https://gong-go.<계정>.workers.dev/api/relay
//   RELAY_TOKEN=<Worker에 등록한 것과 같은 값>
// 경로와 쿼리는 그대로 유지되므로 아래 정의는 어느 쪽이든 바뀌지 않는다.
// (docs/프로젝트-통합-문서.md 2부)
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

if (require.main === module) main().catch((error) => { console.error(`수집 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const state = await readState();
  if (!SERVICE_KEY) throw new Error(".env에 SERVICE_KEY를 설정하세요.");
  // 스킴이 빠진 API_BASE는 작업마다 ERR_INVALID_URL을 낼 뿐 원인을 드러내지 않는다.
  // 값은 찍지 않는다 — Actions 로그에서 마스킹을 우회해 시크릿 일부가 노출된다.
  if (process.env.API_BASE && !/^https?:\/\//i.test(API_BASE)) {
    throw new Error("API_BASE는 스킴을 포함한 절대 URL이어야 합니다. 예: https://<worker>.workers.dev/api/relay");
  }
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
  const succeeded = new Set();
  console.log(`전체 공고 수집 시작: ${jobs.length}개 작업(대상 ${pending.length}개), 기존 ${store.location.size}건, 동시 요청 ${httpLimit}`);

  // 작업을 배치로 끊지 않고 한 풀에서 흘려보낸다. 예전에는 httpLimit개씩 묶어 배치가 통째로
  // 끝나야 다음이 시작됐고, 페이지가 수십 장인 작업 하나가 나머지 슬롯을 그동안 놀렸다.
  // 나라장터에 동시에 나가는 요청 수는 어차피 아래 세마포어가 통제하므로 배치 경계는
  // 대기 시간만 만들었다. 저장도 배치 경계마다 멈춰 서서 기다릴 이유가 없다.
  let changed = new Set();
  let flushing = Promise.resolve();
  let finished = 0;
  // flush는 바뀐 버킷 집합을 통째로 넘겨받고 새 집합을 연다. 저장이 도는 동안 다른 작업이
  // 같은 버킷을 또 건드리면 그 버킷은 새 집합에 들어가 다음 flush가 다시 쓴다.
  // 저장끼리는 순서대로 이어 붙여 같은 파일을 두 번 겹쳐 쓰지 않는다. 재개 상태도 같은
  // 시점에 스냅샷한다. 파일 쓰기를 기다리는 동안 끝난 후속 작업까지 이전 체크포인트에
  // 섞이면, 그 파일을 쓰기 전에 프로세스가 끝났을 때 재개가 해당 작업을 잘못 건너뛴다.
  const flush = (saveResume) => {
    const batch = changed;
    const checkpoint = saveResume ? checkpointState(state) : null;
    changed = new Set();
    flushing = flushing.then(async () => {
      if (batch.size) await writeRecords(store, batch);
      await writeIndexFromStore(store);
      if (checkpoint) await saveState(checkpoint);
    });
    return flushing;
  };

  await mapPool(pending, httpLimit, async (entry) => {
    const label = `[${entry.index + 1}/${jobs.length}] ${MODE_LABELS[entry.job.mode]}/${entry.job.type}/${entry.job.range.begin}`;
    let items;
    try { items = await fetchJob(entry.job); }
    catch (error) { errors.push({ job: entry.job, error: error.message }); console.error(`${label} 실패: ${error.message}`); return; }
    succeeded.add(entry.id);
    // 아래 병합은 await 없이 한 번에 끝난다. 중간에 다른 작업이 끼어들지 않는다는 것이
    // clearJobRange와 applyItems가 같은 store를 안전하게 고칠 수 있는 근거다.
    //
    // 스냅샷 모드는 절대 비우지 않는다. 응답이 최근 며칠치뿐인데 --no-resume이 수집 구간
    // (크론은 35일)을 비워 버리면, 그 앞에 쌓아 둔 발주계획이 매 실행마다 사라진다.
    if (resume === false && !MODES[entry.job.mode].snapshot) clearJobRange(store, entry.job, changed);
    applyItems(store, items, changed, entry.job);
    if (resume !== false) state.completedJobs.push(entry.id);
    console.log(`${label}~${entry.job.range.end}: ${items.length}건`);
    finished += 1;
    // 중간 저장은 재개(resume)를 위한 것이다. 저장을 기다리지 않고 다음 작업으로 넘어가
    // gzip·디스크 쓰기가 다음 요청의 대기 시간에 겹쳐 돌게 둔다.
    if (finished % FLUSH_EVERY === 0) flush(resume !== false);
  });

  // 이 필드를 도입하기 전에 저장된 본공고에는 업무구분이 없어 어느 endpoint의 행인지
  // 안전하게 가려낼 수 없다. 같은 모드·범위의 네 endpoint가 모두 성공한 경우에만, 이번
  // 응답으로 교체되지 않은 무표식 행을 지워 한 번의 정상 실행으로 원천 정보를 이관한다.
  if (resume === false) {
    const migrated = clearLegacySources(store, entries, succeeded, types, changed);
    if (migrated) console.log(`원천 endpoint가 없던 기존 레코드 ${migrated}건 정리`);
  }
  await flush(resume !== false);
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
  const data = await requestJson(`${API_BASE}${definition.base}/${definition.ops[job.type]}?${params}`, {
    mode: job.mode,
    type: job.type,
    range: `${job.range.begin}~${job.range.end}`,
    page: pageNo,
  });
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

async function requestJson(url, meta) {
  let lastError;
  for (let retry = 0; retry <= RETRIES; retry += 1) {
    const queuedAt = performance.now();
    await acquireHttp();
    const startedAt = performance.now();
    let status = 0;
    let bytes = 0;
    let upstreamMs = null;
    let error = null;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...(RELAY_TOKEN ? { Authorization: `Bearer ${RELAY_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      upstreamMs = serverTimingDuration(response.headers.get("Server-Timing"), "upstream");
      const body = await response.text();
      bytes = Buffer.byteLength(body);
      if (!response.ok) {
        error = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
        error.httpStatus = response.status;
        error.retryAfterMs = retryAfterMs(response.headers.get("Retry-After"));
        throw error;
      }
      const data = JSON.parse(body);
      logRequest(meta, { queueWaitMs: startedAt - queuedAt, fetchMs: performance.now() - startedAt, status, bytes, retry, upstreamMs });
      return data;
    } catch (caught) {
      error = withCause(caught);
      lastError = error;
      logRequest(meta, {
        queueWaitMs: startedAt - queuedAt,
        fetchMs: performance.now() - startedAt,
        status,
        bytes,
        retry,
        upstreamMs,
        error: errorClass(error),
      }, true);
    } finally {
      // 재시도 backoff 중에는 HTTP permit을 잡고 있지 않는다. 느린 한 페이지가 다른 페이지의
      // 첫 시도까지 줄 세우지 않게 attempt 하나만 세마포어로 센다.
      releaseHttp();
    }
    if (retry >= RETRIES || !isRetryable(error)) throw lastError;
    await sleep(Math.max(error?.retryAfterMs || 0, retryDelay(retry)));
  }
  throw lastError;
}

function logRequest(meta, timing, failed = false) {
  const value = { ...meta, ...roundTiming(timing) };
  // URL에는 ServiceKey가 있으므로 어떤 경우에도 URL 자체는 로그에 넣지 않는다.
  (failed ? console.warn : console.log)(`HTTP ${JSON.stringify(value)}`);
}
function roundTiming(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, typeof item === "number" && !Number.isInteger(item) ? Number(item.toFixed(1)) : item]));
}
function serverTimingDuration(header, name) {
  const match = String(header || "").match(new RegExp(`(?:^|,)\\s*${name}\\s*;\\s*dur=([0-9.]+)`, "i"));
  return match ? Number(match[1]) : null;
}
function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}
function retryDelay(retry) { return 800 * 2 ** retry * (0.75 + Math.random() * 0.5); }
// 재시도 여부는 응답 상태가 아니라 오류 자체로 가린다. 상태로 가리면 본문을 받는 도중
// 끊긴 요청이 재시도에서 빠진다 — 그때는 헤더에서 읽은 200이 이미 기록돼 있어 "성공한
// 응답"으로 보이기 때문이다. 6MB짜리 본공고 페이지 세 장이 이렇게 한 번의 timeout으로
// 재시도 없이 실패해 수집 전체가 멈췄다. 상태가 실제 실패 사유인 것은 !response.ok로
// 던진 오류뿐이고, 그것만 httpStatus를 달고 온다. 나머지(timeout, 연결 끊김, 잘린 JSON)는
// 모두 전송·해석 단계의 일시적 실패이므로 재시도한다.
function isRetryable(error) {
  const status = error?.httpStatus;
  return status ? status === 408 || status === 429 || status >= 500 : true;
}
function errorClass(error) { return error?.cause?.code || error?.code || error?.name || "Error"; }

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

function applyItems(store, items, changed, job) {
  for (const item of items) {
    const record = job ? { ...item, [SOURCE_ENDPOINT]: sourceEndpoint(job) } : item;
    const key = recordKey(record);
    if (!key) continue;
    const target = bucketKeyOf(record);
    const source = store.location.get(key);
    // 등록일이 바뀐 공고는 이전 일자 파일에서 빼야 중복이 남지 않는다.
    if (source && source !== target) { store.buckets.get(source)?.delete(key); changed.add(source); }
    bucketFor(store, target).set(key, record);
    store.location.set(key, target);
    changed.add(target);
  }
}

// 버킷마다 gzip 두 번(서비스용·원본)이라 파일 수가 늘면 여기가 그대로 대기 시간이 된다.
// 순서대로 하나씩 돌리지 않고 풀로 묶어, 압축은 libuv 스레드에서 겹쳐 돌게 한다.
async function writeRecords(store, changed) {
  await mapPool([...changed], WRITE_CONCURRENCY, async (key) => {
    const [mode, day] = key.split("|");
    if (!mode || day === "undated") return;
    const file = dataFile(day, mode);
    const rows = recordsForWrite(store.buckets.get(key));
    if (!rows.length) {
      await fs.rm(file, { force: true });
      await fs.rm(path.join(DATA_DIR, "raw", path.relative(DATA_DIR, file)), { force: true });
      // 지우는 사이에 다른 작업이 같은 버킷을 채웠으면 삭제로 덮지 않는다. 그 버킷은 이미
      // 새 changed 집합에 들어가 있어 다음 flush가 파일을 다시 쓴다.
      if (!store.buckets.get(key)?.size) { store.buckets.delete(key); store.counts.delete(relativePath(mode, day)); }
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeCsv(file, rows);
    store.counts.set(relativePath(mode, day), rows.length);
  });
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
// gzipSync는 이벤트 루프를 잡고 있어 동시에 쓸 수가 없다. 비동기 gzip은 libuv 스레드풀에서
// 돌아 여러 파일이 실제로 겹쳐 압축된다. 결정적이라 같은 입력이면 바이트도 같으므로,
// 업로더가 ETag(=MD5)로 "안 바뀐 파일"을 걸러 내는 판정은 그대로 성립한다.
async function writeCsv(file, rows) {
  const rawFile = path.join(DATA_DIR, "raw", path.relative(DATA_DIR, file));
  await fs.mkdir(path.dirname(rawFile), { recursive: true });
  const [service, raw] = await Promise.all([
    gzip(Buffer.from(`\uFEFF${serializeCsv(rows.map((row) => project(row)))}\n`, "utf8")),
    gzip(Buffer.from(`\uFEFF${serializeCsv(rows)}\n`, "utf8")),
  ]);
  await Promise.all([fs.writeFile(file, service), fs.writeFile(rawFile, raw)]);
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
function checkpointState(state) { return { completedJobs: [...new Set(state.completedJobs)] }; }
async function saveState(state) { await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }

// resume:false일 때 해당 작업 구간의 기존 레코드를 비운다. 버킷 단위라 구간 밖은 건드리지 않는다.
function clearJobRange(store, job, changed) {
  const endpoint = sourceEndpoint(job);
  for (const [key, bucket] of store.buckets) {
    const [mode, day] = key.split("|");
    if (mode !== job.mode || !isInRange(day, job.range)) continue;
    for (const [recordId, record] of bucket) {
      const source = record[SOURCE_ENDPOINT];
      if (source ? source !== endpoint : legacyBusinessType(record) !== job.type) continue;
      bucket.delete(recordId);
      store.location.delete(recordId);
      changed.add(key);
    }
  }
}
function clearLegacySources(store, entries, succeeded, types, changed) {
  if (!TYPES.every((type) => types.includes(type))) return 0;
  const groups = new Map();
  for (const entry of entries) {
    if (MODES[entry.job.mode].snapshot) continue;
    const key = `${entry.job.mode}|${entry.job.range.begin}|${entry.job.range.end}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length !== TYPES.length || !group.every((entry) => succeeded.has(entry.id))) continue;
    const { mode, range } = group[0].job;
    for (const [key, bucket] of store.buckets) {
      const [bucketMode, day] = key.split("|");
      if (bucketMode !== mode || !isInRange(day, range)) continue;
      for (const [recordId, record] of bucket) {
        if (record[SOURCE_ENDPOINT]) continue;
        bucket.delete(recordId);
        store.location.delete(recordId);
        changed.add(key);
        removed += 1;
      }
    }
  }
  return removed;
}
function sourceEndpoint(job) { return `${MODES[job.mode].base}/${MODES[job.mode].ops[job.type]}`; }
function legacyBusinessType(record) { return TYPES.find((type) => String(record.bsnsDivNm || "").includes(type)) || ""; }
function recordsForWrite(bucket) {
  return [...(bucket?.values() ?? [])].sort((left, right) => {
    const a = recordKey(left), b = recordKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
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

module.exports = { applyItems, checkpointState, clearJobRange, clearLegacySources, recordsForWrite, sourceEndpoint, serverTimingDuration, isRetryable };
