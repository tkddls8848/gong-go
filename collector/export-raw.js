// data/raw의 일자별 원본을 단일 CSV 하나로 합친다(백업용).
// 컬럼 합집합을 먼저 구한 뒤 한 번에 쓰므로 열이 어긋나지 않는다.
// 스트리밍으로 쓰기 때문에 수 GB여도 메모리에 다 올리지 않는다.
//
// 사용: node collector/export-raw.js [--out=data/backup/raw-full.csv.gz] [--plain]
const zlib = require("node:zlib");
const fsSync = require("node:fs");
const { fs, path, DATA_DIR } = require("../shared/pipeline-utils");
const { parseCsv } = require("../shared/csv-record");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const PLAIN = "plain" in args;
const OUT = path.join(DATA_DIR, "..", args.out || `data/backup/raw-full.csv${PLAIN ? "" : ".gz"}`);

main().catch((error) => { console.error(`실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const files = await rawFiles();
  if (!files.length) throw new Error("data/raw 가 비어 있습니다. 먼저 node collector/slim.js 를 실행하세요.");
  console.log(`원본 ${files.length}개 파일에서 컬럼 합집합을 구하는 중입니다.`);

  const columns = [];
  const known = new Set();
  let rowTotal = 0;
  for (const [index, file] of files.entries()) {
    for (const row of await read(file)) { rowTotal += 1; for (const key of Object.keys(row)) if (!known.has(key)) { known.add(key); columns.push(key); } }
    if ((index + 1) % 800 === 0) console.log(`  스캔 ${index + 1}/${files.length} · 컬럼 ${columns.length}개`);
  }
  console.log(`컬럼 ${columns.length}개 · 행 ${rowTotal.toLocaleString("ko-KR")}건. 내보내는 중입니다.`);

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const sink = fsSync.createWriteStream(OUT);
  const out = PLAIN ? sink : zlib.createGzip();
  if (!PLAIN) out.pipe(sink);
  await write(out, `﻿${columns.join(",")}\n`);
  let done = 0;
  for (const file of files) {
    const lines = (await read(file)).map((row) => columns.map((key) => cell(row[key])).join(",")).join("\n");
    if (lines) await write(out, `${lines}\n`);
    done += 1;
    if (done % 800 === 0) console.log(`  기록 ${done}/${files.length}`);
  }
  await new Promise((resolve, reject) => { out.end(); sink.on("finish", resolve); sink.on("error", reject); });
  console.log(`\n완료: ${OUT} (${((await fs.stat(OUT)).size / 1048576).toFixed(1)}MB)`);
}

function write(stream, text) { return stream.write(text) ? Promise.resolve() : new Promise((resolve) => stream.once("drain", resolve)); }
function cell(value) { const text = String(value ?? ""); return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function read(file) { try { return parseCsv(zlib.gunzipSync(await fs.readFile(file)).toString("utf8")); } catch { return []; } }

async function rawFiles() {
  const base = path.join(DATA_DIR, "raw");
  const result = [];
  for (const mode of ["pre", "bid"]) {
    for (const year of await list(path.join(base, mode))) {
      for (const month of await list(path.join(base, mode, year))) {
        for (const name of await list(path.join(base, mode, year, month))) {
          if (/^\d{2}\.csv\.gz$/.test(name)) result.push(path.join(base, mode, year, month, name));
        }
      }
    }
  }
  return result.sort();
}
async function list(dir) { try { return (await fs.readdir(dir)).sort(); } catch { return []; } }
