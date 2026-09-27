// 검색 Worker 풀, 결과 한도, 취소와 메인 스레드 대체 실행.
(function (scope) {
  "use strict";
  function createScanner({
    model, Rows = scope.GongRows, modeOf = (file) => file.mode || String(file.path || "").split("/")[0],
    createWorker = (url) => new Worker(url), workerUrl = new URL("search-worker.js", scope.location.href),
    POOL_SIZE = Math.max(1, Math.min(4, (scope.navigator.hardwareConcurrency || 4) - 1)),
    FETCH_CONCURRENCY = 12, MAX_ROWS = 200000, DATA_BASE = "/data"
  } = {}) {
    // 워커는 처음 검색할 때 만들어 두고 계속 쓴다. 만들지 못하는 환경에서는 빈 배열이 되고
    // scanFiles가 메인 스레드 경로로 되돌아간다 — 느리지만 결과는 같다.
    let workerPool = null, abortScan = () => {};
    function pool() {
      if (workerPool) return workerPool;
      const created = [];
      try {
        const url = workerUrl;
        for (let i = 0; i < POOL_SIZE; i++) created.push(createWorker(url));
        workerPool = created;
      } catch {
        // 배열 대입 완료 전에 두 번째 이후 생성이 실패해도 이미 생성한 Worker를 정리한다.
        for (const worker of created) worker.terminate();
        workerPool = [];
      }
      return workerPool;
    }

    function scanFiles(files, criteria, span, version, onProgress) {
      const workers = pool();
      if (!workers.length) return scanInline(files, criteria, span, version, onProgress);
      const state = { rows: [], done: 0, scanned: 0, failures: 0, capped: false };
      const share = Math.max(1, Math.ceil(FETCH_CONCURRENCY / workers.length));
      return new Promise((resolve) => {
        let pending = 0;
        const detach = () => { for (const worker of workers) { worker.onmessage = null; worker.onerror = null; } abortScan = () => {}; };
        const finish = () => { detach(); resolve(state); };
        abortScan = () => { for (const worker of workers) worker.postMessage({ type: "cancel", version }); finish(); };
        // 워커 스크립트를 못 읽으면(구 배포본에 search-worker.js가 없는 경우 등) 아무 메시지도
        // 오지 않아 화면이 "0개 처리"에서 멈춘다. 그때는 풀을 버리고 메인 스레드로 되돌아간다.
        const fallback = () => { detach(); for (const worker of workers) worker.terminate(); workerPool = []; resolve(scanInline(files, criteria, span, version, onProgress)); };
        workers.forEach((worker, slot) => {
          // 날짜순 목록을 그대로 잘라 주면 한쪽 워커에만 큰 파일이 몰린다. 번갈아 나눠 준다.
          const mine = files.filter((_, index) => index % workers.length === slot);
          if (!mine.length) return;
          pending += 1;
          worker.onerror = fallback;
          worker.onmessage = (event) => {
            const message = event.data;
            if (message.version !== version) return;
            if (message.type === "done") { pending -= 1; if (!pending) finish(); return; }
            state.done += message.done; state.scanned += message.scanned; state.failures += message.failures;
            for (const row of message.rows) { if (state.rows.length >= MAX_ROWS) break; state.rows.push(row); }
            if (state.rows.length >= MAX_ROWS) { state.capped = true; onProgress(state); abortScan(); return; }
            onProgress(state);
          };
          worker.postMessage({ type: "search", version, base: DATA_BASE, dataSchemaVersion: model.dataSchemaVersion, files: mine, criteria, span, concurrency: share });
        });
        if (!pending) finish();
      });
    }

    // 워커를 못 쓰는 환경의 폴백. 예전 경로와 같지만 파싱·조건 검사는 rows.js를 쓴다.
    async function scanInline(files, criteria, span, version, onProgress) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      abortScan = cancel;
      const parsed = Rows.makeCriteria(criteria);
      const state = { rows: [], done: 0, scanned: 0, failures: 0, capped: false };
      let cursor = 0;
      const scan = async () => {
        while (cursor < files.length && !state.capped) {
          if (version !== model.searchVersion || controller.signal.aborted) return;
          const file = files[cursor++];
          try {
            const suffix = model.dataSchemaVersion ? `?v=${encodeURIComponent(model.dataSchemaVersion)}` : "";
            const text = await Rows.fetchCsvText(`${DATA_BASE}/${file.path}${suffix}`, { ...(file.revalidate ? { cache: "no-cache" } : {}), signal: controller.signal });
            if (version !== model.searchVersion || controller.signal.aborted) return;
            const result = Rows.scanText(text, modeOf(file), parsed, !(file.begin >= span.begin && file.end <= span.end));
            state.scanned += result.scanned;
            for (const row of result.matched) { if (state.rows.length >= MAX_ROWS) break; state.rows.push(row); }
          } catch { if (version !== model.searchVersion || controller.signal.aborted) return; state.failures += 1; }
          state.done += 1;
          if (state.rows.length >= MAX_ROWS) { state.capped = true; cancel(); }
          if (state.done % 16 === 0) { onProgress(state); await new Promise((resolve) => setTimeout(resolve, 0)); }
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length || 1) }, scan)); }
      finally { if (abortScan === cancel) abortScan = () => {}; }
      return state;
    }
    function dispose() {
      abortScan();
      for (const worker of workerPool || []) worker.terminate();
      workerPool = null;
    }
    return { pool, scanFiles, scanInline, cancel: () => abortScan(), dispose };
  }
  const api = { createScanner };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongScan = api;
})(typeof self === "undefined" ? globalThis : self);
