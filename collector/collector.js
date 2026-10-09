// 나라장터 공고를 현재 저장 형식(data/{pre,bid}/YYYY/MM/DD.csv.gz)으로 수집한다.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const gzip = promisify(zlib.gzip);
const { serializeCsv, parseCsv } = require("./csv-record");
const { ROOT, DATA_DIR, loadEnv, mapPool, buildIndexEntries } = require("./store");
const { project } = require("./service-columns");
const { MODES, EORDER_TYPE, sourceEndpoint, createClient } = require("./api");
const { groupEorderFiles, mergeGroups, withEorderFiles, eorderFilesOf } = require("./eorder-files");

const CONFIG_FILE = path.join(__dirname, "sync.config.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");
const RANGE_DAYS = 28;
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
  // CLI에서 수집 기간을 지정할 때 사용한다.
  const args = parseArgs();
  const resume = args.resume === false ? false : config.resume;
  // 우선순위는 CLI 인자 > GitHub Actions 환경변수 > sync.config.json 순이다.
  const begin = parseDate(args.begin || process.env.SYNC_BEGIN || config.begin);
  const end = parseDate(args.end || process.env.SYNC_END || config.end || today());
  if (!begin || !end || begin > end) throw new Error("수집 기간을 확인하세요(sync.config.json 또는 --begin/--end).");
  const modes = args.modes || config.modes.map((mode) => MODE_ALIASES[mode]).filter((mode) => MODES[mode]);
  const types = config.businessTypes.filter((type) => TYPES.includes(type));
  const jobs = [];
  // 스냅샷 모드(plan)는 범위를 나눠 봐야 매번 같은 응답이 온다. 업무구분당 한 번만 부른다.
  for (const mode of modes) {
    const ranges = MODES[mode].snapshot ? [{ begin: iso(begin), end: iso(end) }] : chunks(begin, end);
    for (const range of ranges) {
      for (const type of types) jobs.push({ range, mode, type });
      // 본공고 구간마다 제안요청정보 첨부를 한 번 받는다. 업무구분과 무관한 오퍼레이션 하나다.
      if (mode === "bid") jobs.push({ range, mode, type: EORDER_TYPE });
    }
  }
  const httpLimit = Math.max(1, Number(config.concurrency));
  const { fetchJob } = createClient({ SERVICE_KEY, API_BASE, RELAY_TOKEN, concurrency: httpLimit });
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
    if (entry.job.type === EORDER_TYPE) {
      const attached = applyEorder(store, items, changed);
      if (resume !== false) state.completedJobs.push(entry.id);
      console.log(`${label}~${entry.job.range.end}: 파일 ${items.length}건, 공고 ${attached}건에 붙임`);
      finished += 1;
      if (finished % FLUSH_EVERY === 0) flush(resume !== false);
      return;
    }
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
  // 공고 목록보다 먼저 끝난 제안요청정보는 applyItems가 붙였다. 그래도 남는 것은 이번 수집 범위에
  // 공고 행이 없는 파일이다(범위 경계의 정정공고 등). 붙일 곳이 없으므로 건수만 남긴다.
  const orphaned = [...store.eorder.keys()].filter((number) => !store.location.has(`bid:${number}`)).length;
  if (orphaned) console.log(`공고 행을 찾지 못한 제안요청정보 ${orphaned}건`);
  const truncated = [...store.eorder.values()].filter((group) => group.truncated).length;
  if (truncated) console.warn(`제안요청정보 첨부가 저장 슬롯을 넘친 공고 ${truncated}건(앞 슬롯만 저장)`);
  await flush(resume !== false);
  await fs.writeFile(path.join(DATA_DIR, "sync-errors.json"), JSON.stringify(errors, null, 2), "utf8");
  console.log(`완료: ${store.location.size}건 저장, 실패 ${errors.length}건`);
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
  const store = { buckets: new Map(), location: new Map(), counts: new Map(), eorder: new Map() };
  let previous = new Map();
  try { previous = new Map(JSON.parse(await fs.readFile(INDEX_FILE, "utf8")).files.map((file) => [file.path, file.count])); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = (await dailyFiles(path.join(DATA_DIR, "raw"))).filter((file) => file.date >= beginDate && file.date <= endDate);
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

// 제안요청정보 응답을 공고번호별로 묶어 두고, 이미 받은 공고 행에는 바로 붙인다. 아직 받지 않은
// 공고는 applyItems가 들어올 때 store.eorder에서 꺼내 붙인다. 붙인 공고 수를 돌려준다.
function applyEorder(store, items, changed) {
  const groups = groupEorderFiles(items);
  mergeGroups(store.eorder, groups);
  let attached = 0;
  for (const number of groups.keys()) {
    const key = `bid:${number}`, bucketKey = store.location.get(key);
    const record = bucketKey ? store.buckets.get(bucketKey)?.get(key) : null;
    if (!record) continue;
    store.buckets.get(bucketKey).set(key, withEorderFiles(record, store.eorder.get(number).files));
    changed.add(bucketKey);
    attached += 1;
  }
  return attached;
}

function bucketFor(store, key) { let bucket = store.buckets.get(key); if (!bucket) { bucket = new Map(); store.buckets.set(key, bucket); } return bucket; }

function applyItems(store, items, changed, job) {
  for (const item of items) {
    let record = job ? { ...item, [SOURCE_ENDPOINT]: sourceEndpoint(job) } : item;
    const key = recordKey(record);
    if (!key) continue;
    const target = bucketKeyOf(record);
    const source = store.location.get(key);
    // 공고 목록 응답에는 제안요청정보가 없다. 이번 실행이 받은 목록이 있으면 그것을, 없으면 이전
    // 레코드의 값을 이어 붙인다 — 재개 실행이 공고만 다시 받아 첨부를 지우지 않게 한다.
    if (recordMode(record) === "bid") {
      const group = store.eorder?.get(String(record.bidNtceNo).trim());
      const previous = source ? store.buckets.get(source)?.get(key) : null;
      const files = group ? group.files : previous ? eorderFilesOf(previous) : [];
      if (files.length) record = withEorderFiles(record, files);
    }
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
async function dailyFiles(root = DATA_DIR) {
  const result = [];
  for (const mode of Object.keys(MODES)) {
    const modePath = path.join(root, mode);
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
// 본공고는 공고번호로만 묶는다. 본공고 응답에도 사전규격등록번호(bfSpecRgstNo)가 실려 오는데,
// 예전에는 그것을 먼저 써서 같은 사전규격에서 나온 재공고·분리공고가 한 행으로 덮였다
// (2026-05-13 하루 본공고 2,152건 중 29건이 사라졌다). 같은 공고의 정정 차수는 계속 한 행이다.
const NUMBER_FIELD = { bid: "bidNtceNo", pre: "bfSpecRgstNo", plan: "orderPlanUntyNo" };
function recordKey(row) { const mode = recordMode(row), number = mode ? String(row[NUMBER_FIELD[mode]] || "").trim() : ""; return number ? `${mode}:${number}` : ""; }
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
    if (MODES[entry.job.mode].snapshot || entry.job.type === EORDER_TYPE) continue;
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
function legacyBusinessType(record) { return TYPES.find((type) => String(record.bsnsDivNm || "").includes(type)) || ""; }
function recordsForWrite(bucket) {
  return [...(bucket?.values() ?? [])].sort((left, right) => {
    const a = recordKey(left), b = recordKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
async function readConfig() { try { return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch (error) { if (error.code === "ENOENT") throw new Error("collector/sync.config.json을 찾지 못했습니다."); throw error; } }
function chunks(begin, end) { const result = []; for (let cursor = new Date(begin); cursor <= end;) { const finish = new Date(Math.min(addDays(cursor, RANGE_DAYS - 1), end)); result.push({ begin: iso(cursor), end: iso(finish) }); cursor = addDays(finish, 1); } return result; }
function parseArgs(values = process.argv.slice(2)) {
  const args = {};
  for (const arg of values) {
    if (arg === "--no-resume") { args.resume = false; continue; }
    const date = arg.match(/^--(begin|end)=(\d{4}-\d{2}-\d{2})$/);
    if (date) { args[date[1]] = date[2]; continue; }
    const modes = arg.match(/^--modes=([a-z,]+)$/);
    if (modes) {
      args.modes = [...new Set(modes[1].split(","))];
      const invalid = args.modes.filter((mode) => !MODES[mode]);
      if (invalid.length) throw new Error(`지원하지 않는 수집 모드: ${invalid.join(", ")}`);
      continue;
    }
    throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return args;
}
function parseDate(value) { const result = new Date(`${value}T00:00:00`); return Number.isNaN(result.valueOf()) ? null : result; }
function addDays(value, days) { const result = new Date(value); result.setDate(result.getDate() + days); return result; }
function iso(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function today() { return iso(new Date()); }

module.exports = { applyItems, applyEorder, checkpointState, clearJobRange, clearLegacySources, recordsForWrite, sourceEndpoint, parseArgs };
