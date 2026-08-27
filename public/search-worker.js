// 조회 스캔(내려받기 → gzip 해제 → CSV 파싱 → 조건 검사)을 메인 스레드 밖에서 돌린다.
// 예전에는 이 전부가 UI 스레드에서 돌아, 1년 조회를 걸면 화면이 끝날 때까지 멈춰 있었다.
// 결과는 조건을 통과한 행만 묶음으로 돌려보낸다.
importScripts("rows.js");

const Rows = self.GongRows;
// 진행 중인 검색의 version. 새 검색이 오거나 취소되면 바뀌고, 루프는 그걸 보고 빠져나온다.
let active = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "cancel") { active = null; return; }
  if (message.type === "search") { active = message.version; run(message); }
};

async function run({ version, base, dataSchemaVersion, files, criteria, span, concurrency }) {
  const parsed = Rows.makeCriteria(criteria);
  let cursor = 0, rows = [], done = 0, scanned = 0, failures = 0;

  // 누적값이 아니라 증분을 보낸다. 메인 스레드가 워커 여러 개의 결과를 그냥 더하면 된다.
  const flush = () => {
    if (!rows.length && !done) return;
    self.postMessage({ type: "rows", version, rows, done, scanned, failures });
    rows = []; done = 0; scanned = 0; failures = 0;
  };

  const scan = async () => {
    while (cursor < files.length) {
      if (active !== version) return;
      const file = files[cursor++];
      try {
        const suffix = dataSchemaVersion ? `?v=${encodeURIComponent(dataSchemaVersion)}` : "";
        const text = await Rows.fetchCsvText(`${base}/${file.path}${suffix}`, file.revalidate ? { cache: "no-cache" } : undefined);
        if (active !== version) return;
        // 파일 구간이 조회 구간 안에 통째로 들어오면 행마다 날짜를 볼 필요가 없다.
        // 월별 봉인 파일이 구간 끝에 걸릴 때만 행 단위 검사가 남는다.
        const result = Rows.scanText(text, file.mode, parsed, !(file.begin >= span.begin && file.end <= span.end));
        scanned += result.scanned;
        // push(...matched)는 행이 많으면 스택을 넘기고, concat은 묶음마다 배열을 새로 만든다.
        for (const row of result.matched) rows.push(row);
      } catch { failures += 1; }
      done += 1;
      if (rows.length >= 4000 || done >= 16) flush();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, scan));
  if (active !== version) return;
  flush();
  self.postMessage({ type: "done", version });
}
