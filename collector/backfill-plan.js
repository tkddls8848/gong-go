// 긴 과거 구간을 GitHub Actions의 짧은 작업 여러 개로 나눈다.
// 달력 월 단위로 자르므로 각 작업이 만든 서비스 CSV를 compact.js가 온전한 월 파일로 봉인할 수 있다.
function parseIso(value, name = "날짜") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${name}는 YYYY-MM-DD 형식이어야 합니다.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (iso(date) !== value) throw new Error(`${name}가 달력에 없는 날짜입니다: ${value}`);
  return date;
}

function iso(value) { return value.toISOString().slice(0, 10); }

function backfillChunks(beginValue, endValue, monthsPerJob = 3) {
  const begin = parseIso(beginValue, "시작일");
  const end = parseIso(endValue, "종료일");
  const months = Number(monthsPerJob);
  if (begin > end) throw new Error("시작일이 종료일보다 늦습니다.");
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new Error("작업당 개월 수는 1~12의 정수여야 합니다.");

  const include = [];
  for (let cursor = begin; cursor <= end;) {
    const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + months, 0));
    const finish = last < end ? last : end;
    include.push({ begin: iso(cursor), end: iso(finish), label: `${iso(cursor)}_${iso(finish)}` });
    cursor = new Date(finish.getTime() + 86400000);
  }
  return { include };
}

function argsOf(values) {
  const result = { months: 3 };
  for (const value of values) {
    const match = value.match(/^--(begin|end|months)=(.+)$/);
    if (!match) throw new Error(`알 수 없는 인자: ${value}`);
    result[match[1]] = match[2];
  }
  if (!result.begin || !result.end) throw new Error("--begin과 --end가 필요합니다.");
  return result;
}

if (require.main === module) {
  try {
    const args = argsOf(process.argv.slice(2));
    process.stdout.write(JSON.stringify(backfillChunks(args.begin, args.end, args.months)));
  } catch (error) {
    console.error(`백필 계획 생성 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { backfillChunks, parseIso, argsOf };
