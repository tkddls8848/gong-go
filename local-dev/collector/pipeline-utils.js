const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseCsv } = require("./csv-record");

const ROOT = __dirname;
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

function noticeNumber(row) { return String(row.bidNtceNo || row.bfSpecRgstNo || row.announcementNumber || "").trim(); }
function rowDate(row) { return String(row.rgstDt || row.bidNtceDt || row.publishedAt || "").replace(/\D/g, "").slice(0, 8); }
function institution(row) { return String(row.rlDminsttNm || row.dminsttNm || row.institution || ""); }
function title(row) { return String(row.prdctClsfcNoNm || row.bidNtceNm || row.title || ""); }
function normalizeFiles(row) {
  if (Array.isArray(row.files)) return row.files.map((file, index) => typeof file === "string" ? { url: file, name: guessName(file, index) } : { url: file.url || "", name: file.name || guessName(file.url, index) });
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

module.exports = { ROOT, DATA_DIR, fs, path, loadEnv, mapPool, readJson, writeJson, readGzipText, writeGzipText, readCsvGz, noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName, sleep };
