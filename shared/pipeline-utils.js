const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseCsv } = require("./csv-record");

// 모든 단계(collector/downloader/converter/analyzer)가 공유하는 경로.
// ROOT는 저장소 루트이고, 산출물은 전부 ROOT/data 아래에 모인다.
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

function loadEnv(file = path.join(ROOT, ".env")) {
  try {
    for (const line of fsSync.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index], index); }
  }));
  return results;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8"); }
async function readGzipText(file) { return zlib.gunzipSync(await fs.readFile(file)).toString("utf8"); }
async function writeGzipText(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, zlib.gzipSync(Buffer.from(text, "utf8"))); }
async function readCsvGz(file) { try { return parseCsv(await readGzipText(file)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }

// index.json 항목 스키마는 {mode, begin, end, path, count}로 통일한다. 일별 파일은
// begin === end이고, collector/compact.js가 만든 월별 봉인 파일은 그 달 전체를 덮는다.
// 프런트(public/app.js)는 이 구간이 조회 구간과 겹치는 항목만 받으므로, 일별과 월별을
// 같은 모양으로 두면 양쪽을 구분하지 않고 고를 수 있다.
const SEALED_PATH = /^(pre|bid|plan)\/(\d{4})\/(\d{2})\.csv\.gz$/;
function lastDayOfMonth(year, month) { return String(new Date(Number(year), Number(month), 0).getDate()).padStart(2, "0"); }
function indexEntry(relative, count) {
  const sealed = relative.match(SEALED_PATH);
  if (sealed) { const [, mode, year, month] = sealed; return { mode, begin: `${year}-${month}-01`, end: `${year}-${month}-${lastDayOfMonth(year, month)}`, path: relative, count }; }
  const [mode, year, month, name] = relative.split("/");
  const date = `${year}-${month}-${name.slice(0, 2)}`;
  return { mode, begin: date, end: date, path: relative, count };
}
// 같은 달에 월별 봉인 파일과 일별 파일이 함께 있으면(봉인 직후 --prune 전) 월 파일만 남긴다.
// 둘 다 두면 프런트가 같은 행을 두 번 읽는다.
function buildIndexEntries(counts) {
  const entries = [...counts].map(([relative, count]) => indexEntry(relative, count));
  const sealed = new Set(entries.filter((entry) => SEALED_PATH.test(entry.path)).map((entry) => `${entry.mode}|${entry.begin.slice(0, 7)}`));
  return entries
    .filter((entry) => SEALED_PATH.test(entry.path) || !sealed.has(`${entry.mode}|${entry.begin.slice(0, 7)}`))
    .sort((a, b) => a.begin.localeCompare(b.begin) || a.mode.localeCompare(b.mode));
}

function noticeNumber(row) { return String(row.bidNtceNo || row.bfSpecRgstNo || row.orderPlanUntyNo || "").trim(); }
function rowDate(row) { return String(row.rgstDt || row.bidNtceDt || row.nticeDt || "").replace(/\D/g, "").slice(0, 8); }
function institution(row) { return String(row.rlDminsttNm || row.dminsttNm || row.orderInsttNm || ""); }
function title(row) { return String(row.bizNm || row.prdctClsfcNoNm || row.bidNtceNm || ""); }
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
function safeFileName(name, fallback = "attachment") {
  const base = path.basename(String(name || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_").trim();
  return base.slice(0, 180) || fallback;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { ROOT, DATA_DIR, fs, path, loadEnv, mapPool, readJson, writeJson, readGzipText, writeGzipText, readCsvGz, SEALED_PATH, lastDayOfMonth, buildIndexEntries, noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName, sleep };
