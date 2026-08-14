// 재수집 창 밖으로 완전히 나간 완료 월을 하나의 gzip으로 봉인한다.
// (docs/배포계획-R2.md R2-6)
//
// 목적은 압축률이 아니라 "파일 수 = 조회 1회당 Function 호출 수"를 줄이는 것이다.
// 한 달치를 이어붙여 재압축해도 용량은 1% 남짓밖에 줄지 않는다 — DEFLATE의 사전 창이
// 32KB뿐이라 파일을 붙여도 압축기가 멀리 있는 반복을 보지 못한다.
//
// 최근 SEAL_LAG일 안쪽은 크론이 하루 두 번 덮어쓰므로 묶지 않는다. 묶으면 82KB를 받던
// 사용자가 당월 4.5MB를 갱신될 때마다 새로 받게 되어 오히려 손해다. 창 밖으로 나간 월만 봉인한다.
//
// 사용: node collector/compact.js [--dry-run] [--prune] [--reseal] [--lag=40]
//   --dry-run  대상만 출력하고 아무것도 쓰지 않는다
//   --prune    봉인이 끝난 월의 일별 파일을 지운다(봉인 결과를 확인한 뒤 따로 실행)
//   --reseal   이미 봉인된 월도 일별 파일에서 다시 만든다(봉인 뒤 그 달을 재수집한 경우)
const zlib = require("node:zlib");
const { DATA_DIR, fs, path, mapPool, readJson, buildIndexEntries, lastDayOfMonth } = require("../shared/pipeline-utils");
const { serializeCsv, parseCsv } = require("../shared/csv-record");

const INDEX_FILE = path.join(DATA_DIR, "index.json");
const MODES = ["pre", "bid", "plan"];
// 크론 재수집 창(35일)보다 넉넉히. functions/data/[[path]].js의 RECENT_DAYS와 같은 값이다.
const SEAL_LAG = 40;
const READ_CONCURRENCY = 16;
const BOM = "\uFEFF";

if (require.main === module) main().catch((error) => { console.error(`봉인 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const prune = process.argv.includes("--prune");
  const reseal = process.argv.includes("--reseal");
  const lag = numberFlag("--lag", SEAL_LAG);
  const daily = await dailyFiles();
  const sealed = new Set((await sealedFiles()).map((file) => monthKey(file)));
  const previous = new Map((await readJson(INDEX_FILE, { files: [] })).files.map((file) => [file.path, Number(file.count) || 0]));

  const targets = [];
  let alreadySealed = 0;
  for (const group of groupByMonth(daily)) {
    if (!sealable(group.month, lag)) continue;
    // 이미 봉인된 월은 건너뛴다 — 두 번 돌려도 대상이 0개월이어야 한다(멱등).
    // 봉인 뒤에 그 달을 다시 수집했다면 --reseal로 명시해서 다시 만든다.
    if (sealed.has(monthKey(group)) && !reseal) { alreadySealed += 1; continue; }
    targets.push(group);
  }

  // 파일 수는 인덱스(=R2에 올라가는 키) 기준이다. --prune 전이라도 봉인된 달의 일별 항목은
  // 인덱스에서 빠지므로, 아래 "봉인 후"가 조회 1회당 최대 호출 수와 같다.
  const afterMonths = new Set([...sealed, ...targets.map(monthKey)]);
  const afterDaily = daily.filter((file) => !afterMonths.has(monthKey(file))).length;
  console.log(`디스크 일별 ${daily.length}개 · 봉인됨 ${sealed.size}개월 · 대상 ${targets.length}개월${alreadySealed ? ` · 이미 봉인 ${alreadySealed}개월 건너뜀` : ""}`);
  console.log(`파일 수(인덱스 기준): ${previous.size || daily.length + sealed.size} → ${afterMonths.size + afterDaily}${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) { for (const group of targets) console.log(`  ${group.mode}/${group.month} · 일별 ${group.files.length}개`); return; }

  let done = 0;
  for (const group of targets) {
    const result = await seal(group, previous);
    if (!result) continue;
    done += 1;
    console.log(`${group.mode}/${group.month}: 일별 ${group.files.length}개 → ${result.path} (${result.rows.toLocaleString("ko-KR")}건, ${(result.bytes / 1024).toFixed(0)}KB${result.rebuilt ? ", 헤더 통합 재작성" : ""})`);
  }
  const pruned = prune ? await pruneSealed(lag) : 0;
  if (done || pruned) await writeIndex();
  console.log(`완료: ${done}개월 봉인${prune ? `, 일별 ${pruned}개 정리` : ""}`);
  if (!prune && done) console.log("결과를 확인한 뒤 node collector/compact.js --prune 으로 일별 파일을 정리하세요.");
}

// 한 달치 일별 파일을 BOM 1회 + 헤더 1회 + 각 본문 순서대로 이어붙여 gzip으로 쓴다.
async function seal(group, previous) {
  const texts = await mapPool(group.files, READ_CONCURRENCY, async (file) => stripBom(zlib.gunzipSync(await fs.readFile(path.join(DATA_DIR, file.path))).toString("utf8")));
  const headers = new Set(texts.map((text) => text.slice(0, newlineAt(text))));
  // 헤더가 다르면 이어붙이기가 조용히 어긋난 CSV를 만든다. 그게 최악이므로 그 달만
  // 파싱해서 컬럼 합집합으로 다시 쓴다. project()가 원본에 없는 컬럼을 만들지 않으므로
  // (shared/service-columns.js) 같은 모드 안에서도 헤더가 갈릴 수 있다.
  const merged = headers.size > 1 ? rebuild(texts) : { text: texts.map(body).join(""), header: [...headers][0] };
  const expected = headers.size > 1 ? merged.rows : texts.reduce((sum, text) => sum + countRows(body(text)), 0);
  const rows = countRows(merged.text);
  // 이어붙이기가 어긋나면 여기서 걸린다. 걸리면 아무것도 쓰지 않고 그 달을 포기한다.
  if (rows !== expected) { console.warn(`경고: ${group.mode}/${group.month} 행 수가 맞지 않아 건너뜁니다 (일별 합계 ${expected} ≠ 병합 ${rows}).`); return null; }

  const relative = `${group.mode}/${group.month.replace("-", "/")}.csv.gz`;
  const target = path.join(DATA_DIR, relative);
  // --reseal로 다시 만들 때, 새 봉인이 기존 봉인보다 행이 적으면 되돌릴 수 없는 손실이다.
  // 일별 파일을 --prune으로 지운 뒤 그 달의 일부만 재수집한 경우가 여기에 해당한다.
  const before = previous.has(relative) ? previous.get(relative) : await rowCountOf(target);
  if (before !== null && rows < before) { console.warn(`경고: ${group.mode}/${group.month} 재봉인이 행을 잃습니다 (${before} → ${rows}). 건너뜁니다.`); return null; }

  const buffer = zlib.gzipSync(Buffer.from(`${BOM}${merged.header}\n${merged.text}`, "utf8"));
  await fs.writeFile(target, buffer);
  return { path: relative, rows, bytes: buffer.length, rebuilt: headers.size > 1 };
}

// 헤더가 갈린 달의 복구 경로. 전부 파싱해 컬럼 합집합으로 다시 직렬화한다.
// 이어붙이기보다 훨씬 비싸므로 헤더가 다를 때만 쓴다.
function rebuild(texts) {
  const records = texts.flatMap((text) => parseCsv(text));
  const serialized = serializeCsv(records);
  const header = serialized.slice(0, newlineAt(serialized));
  return { header, text: `${serialized.slice(newlineAt(serialized) + 1)}\n`, rows: records.length };
}

// 봉인된 월의 일별 파일을 지운다. data/raw의 170컬럼 원본은 최후 복구 경로라 남긴다.
async function pruneSealed(lag) {
  const sealed = new Set((await sealedFiles()).map((file) => monthKey(file)));
  const targets = (await dailyFiles()).filter((file) => sealed.has(monthKey(file)) && sealable(monthOf(file), lag));
  for (const file of targets) await fs.rm(path.join(DATA_DIR, file.path), { force: true });
  // 비워진 월 디렉터리만 정리한다. 남은 파일이 있으면 ENOTEMPTY로 실패하고 그대로 둔다.
  for (const dir of new Set(targets.map((file) => file.path.split("/").slice(0, 3).join("/")))) {
    try { await fs.rmdir(path.join(DATA_DIR, dir)); } catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
  }
  return targets.length;
}

// 봉인·정리 뒤 index.json을 다시 쓴다. 건수는 기존 인덱스에서 승계하고, 없는 것만 읽어 센다.
// buildIndexEntries가 같은 달의 일별 항목을 월 항목으로 덮으므로 여기서 걸러내지 않는다.
async function writeIndex() {
  const files = [...await dailyFiles(), ...await sealedFiles()];
  const previous = new Map((await readJson(INDEX_FILE, { files: [] })).files.map((file) => [file.path, Number(file.count) || 0]));
  const counts = await mapPool(files, READ_CONCURRENCY, async (file) => [file.path, previous.has(file.path) ? previous.get(file.path) : (await rowCountOf(path.join(DATA_DIR, file.path))) || 0]);
  await fs.writeFile(INDEX_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: buildIndexEntries(new Map(counts)) }, null, 2), "utf8");
}

async function rowCountOf(file) {
  try { return countRows(body(stripBom(zlib.gunzipSync(await fs.readFile(file)).toString("utf8")))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// 값 안에 개행이 들어 있을 수 있으므로 줄 수를 세지 않는다. shared/csv-record.js의 파서와
// 같은 규칙으로 따옴표 구간을 건너뛰며 세되, 셀 문자열을 만들지 않아 메모리를 쓰지 않는다.
const QUOTE = 34, COMMA = 44, LF = 10, CR = 13;
function countRows(text) {
  const length = text.length;
  let index = 0, rows = 0, filled = false, pending = false;
  while (index < length) {
    let empty = true;
    if (text.charCodeAt(index) === QUOTE) {
      index += 1;
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote === -1) { index = length; empty = false; break; }
        if (text.charCodeAt(quote + 1) === QUOTE) { index = quote + 2; empty = false; continue; }
        if (quote > index) empty = false;
        index = quote + 1;
        break;
      }
    } else {
      let end = index;
      while (end < length) { const code = text.charCodeAt(end); if (code === COMMA || code === LF || code === CR) break; end += 1; }
      empty = end === index;
      index = end;
    }
    if (!empty) filled = true;
    pending = true;
    const code = text.charCodeAt(index);
    if (code === COMMA) { index += 1; continue; }
    if (code === LF || code === CR) {
      if (code === CR && text.charCodeAt(index + 1) === LF) index += 1;
      index += 1;
      if (filled) rows += 1;
      filled = false;
      pending = false;
    }
  }
  return pending ? rows + 1 : rows;
}

function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function newlineAt(text) { const index = text.indexOf("\n"); return index === -1 ? text.length : index; }
// 헤더를 뗀 본문. 끝 개행이 없으면 다음 파일의 첫 행과 붙어 한 행이 되므로 보정한다.
function body(text) { const rest = text.slice(newlineAt(text) + 1); return !rest || rest.endsWith("\n") ? rest : `${rest}\n`; }

// 월의 마지막 날 + lag일이 오늘보다 앞이어야 봉인한다. 재수집 창 안쪽은 매일 바뀐다.
function sealable(month, lag) {
  const [year, mm] = month.split("-");
  const last = new Date(Number(year), Number(mm) - 1, Number(lastDayOfMonth(year, mm)));
  const now = new Date();
  return last.getTime() + lag * 86400000 < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function monthOf(file) { return file.month || file.date.slice(0, 7); }
function monthKey(file) { return `${file.mode}|${monthOf(file)}`; }

function groupByMonth(files) {
  const groups = new Map();
  for (const file of files) {
    if (!groups.has(monthKey(file))) groups.set(monthKey(file), { mode: file.mode, month: monthOf(file), files: [] });
    groups.get(monthKey(file)).files.push(file);
  }
  // 병합은 날짜 오름차순이어야 한다. dailyFiles가 이미 정렬해 주지만 여기서도 보장해 둔다.
  for (const group of groups.values()) group.files.sort((a, b) => a.date.localeCompare(b.date));
  return [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.mode.localeCompare(b.mode));
}

async function dailyFiles() {
  const result = [];
  for (const mode of MODES) {
    for (const year of await subdirectories(path.join(DATA_DIR, mode), /^\d{4}$/)) {
      for (const month of await subdirectories(path.join(DATA_DIR, mode, year), /^\d{2}$/)) {
        for (const entry of await fs.readdir(path.join(DATA_DIR, mode, year, month), { withFileTypes: true })) {
          if (!entry.isFile() || !/^\d{2}\.csv\.gz$/.test(entry.name)) continue;
          result.push({ mode, date: `${year}-${month}-${entry.name.slice(0, 2)}`, path: `${mode}/${year}/${month}/${entry.name}` });
        }
      }
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.mode.localeCompare(b.mode));
}

async function sealedFiles() {
  const result = [];
  for (const mode of MODES) {
    for (const year of await subdirectories(path.join(DATA_DIR, mode), /^\d{4}$/)) {
      for (const entry of await fs.readdir(path.join(DATA_DIR, mode, year), { withFileTypes: true })) {
        if (!entry.isFile() || !/^\d{2}\.csv\.gz$/.test(entry.name)) continue;
        result.push({ mode, month: `${year}-${entry.name.slice(0, 2)}`, path: `${mode}/${year}/${entry.name}` });
      }
    }
  }
  return result.sort((a, b) => a.month.localeCompare(b.month) || a.mode.localeCompare(b.mode));
}

async function subdirectories(dir, pattern) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function numberFlag(name, fallback) { const arg = process.argv.find((value) => value.startsWith(`${name}=`)); const parsed = Number(arg?.split("=")[1]); return Number.isFinite(parsed) ? parsed : fallback; }

// 행 수 대조가 봉인의 유일한 안전장치다. 세는 규칙은 compact.test.js가 검증한다.
module.exports = { countRows, body, sealable, groupByMonth };
