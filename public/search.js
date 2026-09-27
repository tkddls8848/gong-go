// 조회 조건 적용, 저장 결과 표시와 최신 공고 병합.
(function (scope) {
  "use strict";
  function createSearch({
    model, $, scanner, renderRows, collectInstitutions, todayFile, MODE_NAMES, format, numberOf,
    GongDates = scope.GongDates, Rows = scope.GongRows, today = () => GongDates.kstDate(),
    MAX_ROWS = 200000, LIVE_API = "/api/live", fetch = scope.fetch.bind(scope)
  } = {}) {
    const LIVE_TYPES = ["물품", "외자", "용역", "공사"], LIVE_CONCURRENCY = 4, LIVE_MAX_PAGE = 200;
    const PREVIEW_LIMIT = 30000, PREVIEW_MS = 700;
    let liveController = null;
    const todayKey = () => today().replaceAll("-", "");
    function isRecentDaily(file) { const cutoff = GongDates.shiftDay(today(), -40); return /^(pre|bid|plan)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/.test(file.path || "") && file.end >= cutoff; }
    // 보유 데이터가 수천 개 파일로 늘어난 뒤로는 전체를 한꺼번에 fetch할 수 없다.
    // (1) 동시 요청을 묶고 (2) 파일을 읽는 즉시 필터링해 일치 행만 남긴다.
    // 전부 메모리에 올린 뒤 거르면 수백만 행에서 브라우저가 죽는다.
    //
    // 그 일을 메인 스레드에서 하면 1년 조회 동안 화면이 통째로 멈춘다. 그래서 내려받기부터
    // 조건 검사까지는 search-worker.js가 맡고, 여기서는 조건을 만들어 넘기고 결과만 그린다.
    function modeOf(file) { return file.mode || String(file.path || "").split("/")[0]; }
    // localeCompare를 쓰지 않는다. 게시일은 고정 형식의 숫자·구분자 문자열이라 코드유닛 비교와
    // 결과가 같은데, localeCompare는 호출마다 ICU 대조를 타 20만 행 정렬에서 377ms가 걸렸다
    // (같은 입력에 일반 비교는 119ms, 정렬 결과는 동일).
    function byPublishedDesc(a, b) { const x = a.publishedAt, y = b.publishedAt; return x < y ? 1 : x > y ? -1 : 0; }

    async function applyFilters({ revalidateRecent = false } = {}) {
      const version = ++model.searchVersion;
      scanner.cancel();
      if (liveController) liveController.abort();
      const mode = model.viewMode;
      const begin = $("#begin").value || "0000-01-01", end = $("#end").value || "9999-12-31";
      // 지금 보고 있는 모드의 파일만 받는다. 예전에는 날짜만 보고 골라 사전공고·본공고·발주계획을
      // 모두 내려받아 gzip을 풀고 파싱한 뒤 버렸다 — 한 모드를 보는데 세 모드를 읽은 셈이다.
      // 항목의 구간과 조회 구간이 겹치면 받는다. 월별 봉인 항목은 한 달을 통째로 끌어오지만,
      // 워커가 행 단위로 다시 거르므로 결과는 정확하다 — 오버페치는 전송량 문제일 뿐이다.
      const files = model.fileIndex
        .filter((file) => modeOf(file) === mode && file.end >= begin && file.begin <= end)
        // 갱신 직후에는 지금 조회할 최근 일별 파일만 같은 URL로 조건부 재검증한다. 쿼리 토큰을
        // 붙이면 과거 파일까지 전부 새 캐시 키가 되지만 cache:no-cache는 기존 ETag를 써 304를 받을 수 있다.
        .map((file) => revalidateRecent && isRecentDaily(file) ? { ...file, revalidate: true } : file);
      const institutions = collectInstitutions();
      const criteria = { q: $("#q").value.trim().toLowerCase(), type: $("#business-type").value, institutions, from: begin.replaceAll("-", ""), to: end.replaceAll("-", ""), loose: $("#inst-loose").checked };

      const progress = (state) => { $("#status").textContent = `${format(files.length)}개 CSV 중 ${format(state.done)}개 처리 · ${format(state.rows.length)}건 일치`; };
      let painted = 0;
      const onProgress = (state) => {
        progress(state);
        if (state.rows.length > PREVIEW_LIMIT || Date.now() - painted < PREVIEW_MS) return;
        painted = Date.now();
        model.filtered = state.rows.slice().sort(byPublishedDesc);
        renderRows(model.filtered);
      };

      progress({ done: 0, rows: [] });
      const state = await scanner.scanFiles(files, criteria, { begin, end }, version, onProgress);
      if (version !== model.searchVersion) return;

      model.filtered = state.rows.sort(byPublishedDesc);
      const parts = [`${format(files.length)}개 CSV에서 ${format(state.scanned)}건을 읽어 ${format(model.filtered.length)}건이 조건에 맞습니다.`];
      parts.push(institutions.length ? `관심 기관 ${institutions.length}곳으로 좁혔습니다${criteria.loose ? "(부분일치)" : ""}.` : "기관 목록이 비어 있어 전체 기관을 조회했습니다.");
      // 오늘 하루만 보는데 그 모드의 오늘 파일이 아직 없으면 0건이 나온다. 조건을 잘못 준 것으로
      // 오해하지 않도록 사유를 밝힌다.
      if (criteria.from === criteria.to && criteria.from === todayKey() && !todayFile(mode)) parts.push(`오늘(${today()}) ${MODE_NAMES[mode]} 데이터가 아직 없습니다. 수집은 09~18시 매시(KST)에 돕니다.`);
      if (state.capped) parts.push(`저장 결과 표시 한도 ${format(MAX_ROWS)}건에 도달해 일부 결과가 생략될 수 있습니다. 기간을 좁히거나 관심 기관을 지정하세요.`);
      if (state.failures) parts.push(`${format(state.failures)}개 파일을 읽지 못했습니다.`);
      const storedStatus = parts.join(" ");
      $("#status").textContent = storedStatus;
      renderRows(model.filtered);
      // 저장 데이터는 여기까지 기다린 즉시 확정해서 보여 준다. 최신 조회는 별도 요청으로 흘려
      // 보내므로 나라장터가 느리거나 실패해도 이미 보이는 결과를 지우거나 막지 않는다.
      void mergeLiveResults({ mode, begin, end, criteria, version, storedRows: model.filtered.slice(), storedStatus });
    }

    function recentLiveSpan(begin, end) {
      const now = today(), yesterday = GongDates.shiftDay(now, -1);
      const first = begin > yesterday ? begin : yesterday;
      const last = end < now ? end : now;
      return first <= last ? { begin: first, end: last } : null;
    }

    function liveItems(data) {
      const body = data?.response?.body;
      if (!body) throw new Error(data?.response?.header?.resultMsg || "공공 API 응답에 본문이 없습니다.");
      const value = body.items;
      const items = Array.isArray(value) ? value : Array.isArray(value?.item) ? value.item : value?.item ? [value.item] : [];
      const size = Math.max(1, Number(body.numOfRows) || 100);
      return { items, totalPages: Math.min(LIVE_MAX_PAGE, Math.max(1, Math.ceil((Number(body.totalCount) || 0) / size))) };
    }

    async function fetchLivePage(mode, businessType, span, pageNo, signal) {
      const params = new URLSearchParams({ mode, businessType, begin: span.begin, end: span.end, pageNo: String(pageNo) });
      const response = await fetch(`${LIVE_API}?${params}`, { signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `최신 정보 응답 오류 (${response.status})`);
      return liveItems(data);
    }

    function mergeRows(storedRows, liveRows) {
      const rows = new Map(storedRows.map((row) => [`${row.mode}:${numberOf(row)}`, row]));
      for (const row of liveRows) rows.set(`${row.mode}:${numberOf(row)}`, { ...row, live: true });
      return [...rows.values()].sort(byPublishedDesc);
    }

    async function mergeLiveResults({ mode, begin, end, criteria, version, storedRows, storedStatus }) {
      const span = recentLiveSpan(begin, end);
      if (!span) return;
      const controller = new AbortController();
      liveController = controller;
      const parsed = Rows.makeCriteria(criteria);
      const types = criteria.type ? [criteria.type] : LIVE_TYPES;
      const liveRows = [];
      let pagesDone = 0, pagesTotal = types.length, failures = 0, scanned = 0, firstError = "";

      const paint = () => {
        if (version !== model.searchVersion || controller.signal.aborted) return;
        model.filtered = mergeRows(storedRows, liveRows);
        $("#status").textContent = `${storedStatus} 저장 결과를 먼저 표시했습니다. 최신 정보 확인 중 ${format(pagesDone)}/${format(pagesTotal)}페이지…`;
        renderRows(model.filtered);
      };
      paint();

      const first = await Promise.all(types.map(async (businessType) => {
        try {
          const result = await fetchLivePage(mode, businessType, span, 1, controller.signal);
          const found = Rows.scanObjects(result.items, mode, parsed, true);
          scanned += found.scanned;
          for (const row of found.matched) liveRows.push(row);
          pagesDone += 1;
          pagesTotal += result.totalPages - 1;
          paint();
          return Array.from({ length: result.totalPages - 1 }, (_, index) => ({ businessType, pageNo: index + 2 }));
        } catch (error) {
          if (error.name === "AbortError") return [];
          if (!firstError) firstError = error.message;
          failures += 1; pagesDone += 1; paint();
          return [];
        }
      }));

      const pending = first.flat();
      let cursor = 0;
      const scan = async () => {
        while (cursor < pending.length && !controller.signal.aborted) {
          const task = pending[cursor++];
          try {
            const result = await fetchLivePage(mode, task.businessType, span, task.pageNo, controller.signal);
            const found = Rows.scanObjects(result.items, mode, parsed, true);
            scanned += found.scanned;
            for (const row of found.matched) liveRows.push(row);
          } catch (error) {
            if (error.name === "AbortError") return;
            if (!firstError) firstError = error.message;
            failures += 1;
          }
          pagesDone += 1; paint();
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, pending.length || 1) }, scan));
      if (version !== model.searchVersion || controller.signal.aborted) return;
      model.filtered = mergeRows(storedRows, liveRows);
      const storedIds = new Set(storedRows.map((row) => `${row.mode}:${numberOf(row)}`));
      const liveIds = new Set(liveRows.map((row) => `${row.mode}:${numberOf(row)}`));
      const added = [...liveIds].filter((id) => !storedIds.has(id)).length;
      const note = failures
        ? `최신 정보 일부만 반영 · 새 공고 ${format(added)}건, 실패 ${format(failures)}페이지 (${firstError}).`
        : `최신 정보 확인 완료 · ${format(scanned)}건 확인, 조건 일치 ${format(liveIds.size)}건 중 새 공고 ${format(added)}건.`;
      $("#status").textContent = `${storedStatus} ${note}`;
      renderRows(model.filtered);
      if (liveController === controller) liveController = null;
    }
    return { applyFilters, recentLiveSpan };
  }
  const api = { createSearch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongSearch = api;
})(typeof self === "undefined" ? globalThis : self);
