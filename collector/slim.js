// 이미 수집한 일자별 파일을 서비스 컬럼만 남기도록 줄인다(1회성).
// 원본은 먼저 data/raw 아래로 옮겨 보존한 뒤에 줄이므로 손실이 없다.
// 이미 data/raw에 원본이 있으면 그것을 원본으로 삼고 덮어쓰지 않는다.
//
// 사용: node collector/slim.js [--dry-run]
const zlib = require("node:zlib");
const { fs, path, DATA_DIR } = require("../shared/pipeline-utils");
const { parseCsv, serializeCsv } = require("../shared/csv-record");
const { project } = require("../shared/service-columns");

const DRY = process.argv.includes("--dry-run");

main().catch((error) => { console.error(`실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const files = await dailyFiles();
  console.log(`대상 ${files.length}개 파일${DRY ? " (모의 실행)" : ""}`);
  let before = 0, after = 0, done = 0, skipped = 0;

  for (const relative of files) {
    const target = path.join(DATA_DIR, relative);
    const rawFile = path.join(DATA_DIR, "raw", relative);
    const original = await fs.readFile(target);
    before += original.length;

    // 원본 보존이 먼저다. 백업이 없으면 지금 파일이 원본이므로 그대로 복사한다.
    let rawExists = true;
    try { await fs.access(rawFile); } catch { rawExists = false; }
    if (!rawExists && !DRY) { await fs.mkdir(path.dirname(rawFile), { recursive: true }); await fs.writeFile(rawFile, original); }

    const rows = parseCsv(zlib.gunzipSync(original).toString("utf8"));
    const slim = rows.map((row) => project(row));
    if (!rows.length || sameColumns(rows[0], slim[0])) { after += original.length; skipped += 1; done += 1; continue; }
    const output = zlib.gzipSync(Buffer.from(`﻿${serializeCsv(slim)}\n`, "utf8"));
    after += output.length;
    if (!DRY) await fs.writeFile(target, output);
    done += 1;
    if (done % 400 === 0) console.log(`  ${done}/${files.length} · ${(before / 1048576).toFixed(0)}MB → ${(after / 1048576).toFixed(0)}MB`);
  }

  console.log(`\n완료: ${done}개 처리(이미 슬림 ${skipped}개)`);
  console.log(`서비스 데이터: ${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB (${(100 - after / before * 100).toFixed(0)}% 감소)`);
  console.log(`원본 백업: data/raw/ (${DRY ? "모의 실행이라 기록하지 않음" : "보존됨"})`);
  if (!DRY) console.log("단일 파일 백업이 필요하면: node collector/export-raw.js");
}

function sameColumns(a, b) { const x = Object.keys(a || {}), y = Object.keys(b || {}); return x.length === y.length; }

// data/{pre,bid}/YYYY/MM/DD.csv.gz 만 훑는다. data/raw 는 대상이 아니다.
async function dailyFiles() {
  const result = [];
  for (const mode of ["pre", "bid"]) {
    for (const year of await list(path.join(DATA_DIR, mode))) {
      for (const month of await list(path.join(DATA_DIR, mode, year))) {
        for (const name of await list(path.join(DATA_DIR, mode, year, month))) {
          if (/^\d{2}\.csv\.gz$/.test(name)) result.push(`${mode}/${year}/${month}/${name}`);
        }
      }
    }
  }
  return result.sort();
}
async function list(dir) { try { return (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name); } catch { return []; } }
