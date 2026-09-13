// collector 모듈 안에서만 공유하는 저장소 헬퍼. collector.js(수집)와 compact.js(봉인)가
// 같은 data/ 트리와 같은 index.json을 쓰기 때문에 두 파일 사이에서만 공유한다.
//
// 다른 모듈은 이 파일을 require하지 않는다. uploader도 index.json을 만들지만 그쪽은
// 제 모듈 안에 같은 규칙을 따로 갖고 있다 — 인덱스 항목 모양은 저장된 데이터의 계약이지
// 코드의 계약이 아니고, 여기 한 줄이 업로드까지 멈추게 두지 않는다(README 모듈 경계).
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

// ROOT는 저장소 루트이고, 수집 산출물은 전부 ROOT/data 아래에 모인다.
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// index.json 항목 스키마는 {mode, begin, end, path, count}로 통일한다. 일별 파일은
// begin === end이고, compact.js가 만든 월별 봉인 파일은 그 달 전체를 덮는다.
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

module.exports = { ROOT, DATA_DIR, loadEnv, mapPool, readJson, sleep, SEALED_PATH, lastDayOfMonth, buildIndexEntries };
