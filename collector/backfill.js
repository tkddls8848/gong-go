// 장기간 소급 수집 드라이버. collector.js를 분기 단위로 "순차" 실행한다.
//
// 왜 쪼개는가: collector.js의 store(buckets/location)는 수집 범위의 모든 레코드를
// 메모리에 누적하고 중간에 비우지 않는다. 몇 년치를 한 프로세스로 돌리면 힙이 터진다.
//
// 왜 순차인가: collector.js는 배치마다 data/index.json을 자기 store 기준으로 통째로
// 다시 쓴다. 서로 다른 기간을 병렬로 돌리면 각 프로세스가 상대 기간의 인덱스 항목을
// 지워버린다. sync-state.json도 마찬가지다. 절대 병렬로 실행하지 말 것.
//
// 사용: node collector/backfill.js [--from=2020-01-01] [--to=YYYY-MM-DD] [--heap=4096]
// 중단 후 다시 실행해도 안전하다. collector의 resume이 이미 끝난 작업을 건너뛴다.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const INDEX_FILE = path.join(ROOT, "data", "index.json");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const FROM = args.from || "2020-01-01";
const TO = args.to || today();
const HEAP = Number(args.heap) || 4096;

main();

function main() {
  const slices = quarters(FROM, TO);
  console.log(`소급 수집 시작: ${FROM} ~ ${TO}, 분기 ${slices.length}개, 힙 ${HEAP}MB`);
  console.log(`시작 시점 보유: ${describeIndex()}`);
  const failed = [];
  const jobErrors = [];
  const startedAt = Date.now();

  slices.forEach((slice, i) => {
    const label = `[${i + 1}/${slices.length}] ${slice.begin} ~ ${slice.end}`;
    console.log(`\n===== ${label} =====`);
    const began = Date.now();
    let code = run(slice);
    if (code !== 0) {
      console.log(`${label} 실패(code ${code}). 60초 후 1회 재시도합니다.`);
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
      code = run(slice);
    }
    const mins = ((Date.now() - began) / 60000).toFixed(1);
    // collector는 개별 작업이 실패해도 종료 코드 0으로 끝난다. 종료 코드만 보면
    // 데이터가 빠진 채로 성공했다고 착각한다. 매 분기 sync-errors.json을 반드시 확인한다.
    const errors = readSyncErrors();
    if (errors.length) { jobErrors.push({ slice, errors }); console.log(`${label} 작업 실패 ${errors.length}건: ${summarize(errors)}`); }
    if (code !== 0) { failed.push({ ...slice, code }); console.log(`${label} 최종 실패(code ${code}, ${mins}분)`); }
    else console.log(`${label} 완료 (${mins}분) · 누적 ${describeIndex()}`);
  });

  console.log(`\n===== 전체 종료 (${((Date.now() - startedAt) / 3600000).toFixed(2)}시간) =====`);
  console.log(`최종 보유: ${describeIndex()}`);
  if (failed.length) {
    console.log(`프로세스 실패 분기 ${failed.length}개: ${failed.map((slice) => `${slice.begin}~${slice.end}(code ${slice.code})`).join(", ")}`);
    process.exitCode = 1;
  } else console.log("프로세스 실패 분기 없음");

  const total = jobErrors.reduce((sum, entry) => sum + entry.errors.length, 0);
  if (total) {
    // sync-errors.json은 collector 실행마다 덮어써지므로 여기서 전 구간을 모아 남긴다.
    const file = path.join(ROOT, "data", "backfill-errors.json");
    fs.writeFileSync(file, JSON.stringify(jobErrors, null, 2), "utf8");
    console.log(`\n*** 작업 단위 실패 ${total}건 (${jobErrors.length}개 분기) — 데이터가 불완전하다 ***`);
    for (const entry of jobErrors) console.log(`  ${entry.slice.begin}~${entry.slice.end}: ${entry.errors.length}건 · ${summarize(entry.errors)}`);
    console.log(`상세: ${file}`);
    if (jobErrors.some((entry) => entry.errors.some((error) => /429|quota/i.test(error.error || "")))) {
      console.log("429/쿼터 초과가 포함되어 있다. 일일 한도가 초기화된 뒤 같은 명령을 다시 실행하라.");
      console.log("실패한 작업은 sync-state.json에 완료로 기록되지 않으므로, 재실행하면 실패분만 다시 받는다.");
    }
    process.exitCode = 1;
  } else console.log("작업 단위 실패 없음");
}

function readSyncErrors() { try { const value = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sync-errors.json"), "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
function summarize(errors) {
  const counts = new Map();
  for (const error of errors) { const key = String(error.error || "").split("\n")[0].slice(0, 60); counts.set(key, (counts.get(key) || 0) + 1); }
  return [...counts].map(([key, count]) => `${key} x${count}`).join(" / ");
}

function run(slice) {
  const result = spawnSync(process.execPath, [`--max-old-space-size=${HEAP}`, "collector/collector.js", `--begin=${slice.begin}`, `--end=${slice.end}`], { cwd: ROOT, stdio: "inherit" });
  if (result.error) { console.log(`실행 오류: ${result.error.message}`); return -1; }
  return result.status ?? -1;
}

function quarters(from, to) {
  const result = [];
  let cursor = new Date(`${from}T00:00:00`);
  const limit = new Date(`${to}T00:00:00`);
  while (cursor <= limit) {
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 0);
    result.push({ begin: iso(cursor), end: iso(end < limit ? end : limit) });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1);
  }
  return result;
}

function describeIndex() {
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    // 인덱스 항목은 구간이라 "일수"를 셀 수 없다(월별 봉인 항목 하나가 한 달을 덮는다).
    const begins = index.files.map((file) => file.begin || file.date).sort();
    const ends = index.files.map((file) => file.end || file.date).sort();
    const rows = index.files.reduce((sum, file) => sum + (Number(file.count) || 0), 0);
    return `${begins[0]} ~ ${ends.at(-1)} · ${index.files.length}파일 · ${rows.toLocaleString("ko-KR")}건`;
  } catch { return "index.json 없음"; }
}

function iso(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function today() { return iso(new Date()); }
