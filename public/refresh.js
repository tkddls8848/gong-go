// 수집 시작·상태 복구·폴링과 완료 후 목록 갱신.
(function (scope) {
  "use strict";
  function createRefresh({
    model, $, document = scope.document, GongHttp = scope.GongHttp,
    getJson, totalCount, dataRange, loadIndex, format, resetPage, applyFilters,
    state: session = { refreshRunId: null, refreshRange: null, refreshSince: null, refreshRevision: 0 },
    REFRESH_API = "/api/refresh", REFRESH_WAIT_LIMIT_MS = 120000
  } = {}) {
    const POLL_SLOW_MS = 5000, POLL_FAST_MS = 2000;
    // 로컬은 수집기를 직접 실행하고, 배포본은 Worker가 GitHub Actions 수집 작업을 시작한다.
    async function startRefresh() {
      if ($("#refresh-btn").disabled) return;
      session.refreshRevision++;
      setRefresh(true, "갱신을 시작하는 중입니다.");
      let received = false;
      try {
        const { response, data: state } = await GongHttp.requestJson(REFRESH_API, { method: "POST" }, 30000, "data");
        received = true;
        // 404는 두 가지다 — Worker에 /api/refresh가 없거나(구 배포본), Worker가 GitHub이 준 404를
        // 그대로 전달한 것(워크플로 미등록·저장소 접근 실패). 뒤쪽은 message가 실려 오므로 그것을
        // 먼저 보여준다. 404를 무조건 "API 없음"으로 덮으면 진짜 원인이 가려진다.
        if (!response.ok && response.status !== 409) {
          throw new Error(state.message || (response.status === 404 ? "갱신 API가 없습니다." : `갱신 요청이 실패했습니다 (${response.status}).`));
        }
        session.refreshRunId = state.runId || null;
        // dispatch 시각. 상태 조회가 이 뒤에 만들어진 실행만 보게 해서, 아직 등록되지 않은 내
        // 실행 대신 직전 실행(크론이나 앞선 버튼)의 결과를 받아 오는 일을 막는다.
        session.refreshSince = state.dispatchedAt || null;
        // 범위는 시작 응답에만 실려 온다. 상태 조회는 GitHub의 실행 정보만 되돌려주므로,
        // 여기서 붙들지 않으면 진행·완료 문구의 구간이 계속 "-"로 남는다.
        session.refreshRange = state.range || null;
      } catch (error) { setRefresh(false, `${error.message}${received ? "" : " 서버 작업은 이미 시작됐을 수 있습니다. 다시 갱신을 요청하기 전에 새로고침하여 진행 상태를 확인하세요."}`, "error"); return; }
      pollRefresh();
    }
    function refreshUrl() {
      if (session.refreshRunId) return `${REFRESH_API}?runId=${session.refreshRunId}`;
      return session.refreshSince ? `${REFRESH_API}?since=${encodeURIComponent(session.refreshSince)}` : REFRESH_API;
    }
    function checkRefreshState(state) {
      if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.running !== "boolean" ||
          (state.waiting !== undefined && typeof state.waiting !== "boolean") ||
          (state.waiting === true && state.running !== true) ||
          (state.runId != null && typeof state.runId !== "string" && !(typeof state.runId === "number" && Number.isSafeInteger(state.runId)))) {
        throw new Error("갱신 상태 응답 형식이 올바르지 않습니다. 완료 여부를 확인할 수 없습니다.");
      }
      return state;
    }
    function withRange(state) { return state.range || !session.refreshRange ? state : { ...state, range: session.refreshRange }; }
    function resumeRefresh() {
      const revision = session.refreshRevision;
      return getJson(REFRESH_API).then((state) => {
        if (revision !== session.refreshRevision || $("#refresh-btn").disabled) return;
        checkRefreshState(state);
        if (state.running) {
          session.refreshRevision++;
          session.refreshRunId = state.runId || null;
          setRefresh(true, refreshText(state)); pollRefresh();
        }
      }).catch(() => {});
    }
    async function pollRefresh() {
      const revision = session.refreshRevision;
      const startedAt = Date.now();
      for (;;) {
        if (revision !== session.refreshRevision) return;
        let state;
        try { state = withRange(checkRefreshState(await getJson(refreshUrl()))); } catch (error) { if (revision === session.refreshRevision) setRefresh(false, `갱신 상태를 확인하지 못했습니다: ${error.message}`, "error"); return; }
        if (revision !== session.refreshRevision) return;
        // 실행 id를 처음 본 순간 거기에 고정한다. 이후 폴링은 그 실행만 보므로, 도중에 매시
        // 크론이 새 실행을 걸어도 대상이 갈아타지 않는다.
        if (state.runId && !session.refreshRunId) session.refreshRunId = String(state.runId);
        // waiting은 "dispatch는 됐는데 실행이 아직 목록에 없다"는 뜻이다. 보통 몇 초면 끝나지만
        // 끝내 뜨지 않으면(워크플로 미등록 등) 여기서 끊는다.
        if (state.waiting && Date.now() - startedAt > REFRESH_WAIT_LIMIT_MS) {
          setRefresh(false, "갱신을 요청했지만 GitHub Actions 실행이 등록되지 않았습니다. Actions 탭에서 확인하세요.", "error");
          return;
        }
        if (!state.running) return finishRefresh(state);
        setRefresh(true, refreshText(state));
        await new Promise((resolve) => setTimeout(resolve, pollDelay(state)));
      }
    }
    async function finishRefresh(state) {
      const revision = session.refreshRevision;
      // state.range는 pollRefresh가 이미 채워 넘겼으므로 여기서 비워도 아래 문구는 온전하다.
      session.refreshRunId = null; session.refreshRange = null; session.refreshSince = null;
      if (state.error) { setRefresh(false, `갱신 실패: ${state.error}`, "error"); return; }
      const beforePaths = new Set(model.fileIndex.map((file) => file.path)), beforeTotal = totalCount(), beforeLast = dataRange().end;
      let loaded;
      try { loaded = await loadIndex(false); } catch (error) { if (revision === session.refreshRevision) setRefresh(false, `갱신은 끝났지만 목록을 다시 읽지 못했습니다: ${error.message}`, "error"); return; }
      if (revision !== session.refreshRevision) return;
      if (loaded?.stale) { setRefresh(false, "갱신 작업은 끝났지만 다른 목록 조회가 진행되어 이 완료 응답을 적용하지 않았습니다."); return; }
      const added = model.fileIndex.filter((file) => !beforePaths.has(file.path)).length, diff = totalCount() - beforeTotal, last = dataRange().end;
      // 새로 들어온 날짜가 현재 조회 종료일보다 뒤라면, 갱신 결과가 바로 보이도록 종료일을 늘린다.
      if (last && last > ($("#end").value || "")) $("#end").value = last;
      setRefresh(false, `갱신 완료 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"} · 새 파일 ${format(added)}개 · 총 ${format(totalCount())}건 (${diff >= 0 ? "+" : ""}${format(diff)})${last > beforeLast ? ` · 최신 ${last}` : ""}`, "done");
      resetPage(); applyFilters({ revalidateRecent: true });
    }
    // 초반을 촘촘히 보고, 길어진 실행만 느슨하게 본다. 예전에는 이게 뒤집혀 있어 60초를 넘겨야
    // 촘촘해졌는데, 버튼 실행(어제~오늘)은 30초대에 끝나므로 사실상 언제나 5초 간격만 썼다 —
    // 이미 끝난 실행을 최대 5초 늦게 봤다. 60초를 넘기는 것은 35일 재수집이거나 큐에 걸린 쪽이라
    // 그때는 느슨해도 된다. startedAt이 아직 없는 동안(dispatch 직후 실행 등록 대기)도 촘촘한
    // 쪽으로 떨어진다 — 그 구간이야말로 빨리 찾아야 하는 자리다.
    function pollDelay(state) { const started = Date.parse(state.startedAt || ""); return !Number.isNaN(started) && Date.now() - started >= 60000 ? POLL_SLOW_MS : POLL_FAST_MS; }
    function refreshText(state) { return `수집 중입니다 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"}${state.lastLine ? ` · ${state.lastLine}` : ""}`; }
    function setRefresh(busy, text, kind = "") {
      const button = $("#refresh-btn"), box = $("#refresh-status");
      button.disabled = busy;
      button.setAttribute("aria-busy", String(busy));
      button.textContent = busy ? "\uAC31\uC2E0 \uC911\u2026" : "\uBCF4\uC720\uB370\uC774\uD130 \uAC31\uC2E0";
      box.hidden = !text;
      box.className = `refresh-status ${kind}`.trim();
      box.textContent = text || "";
      document.querySelectorAll(".empty-refresh, #menu-refresh").forEach((other) => {
        other.disabled = busy;
        other.textContent = button.textContent;
      });
    }
    return { startRefresh, resumeRefresh, pollRefresh, finishRefresh, refreshUrl, pollDelay };
  }
  const api = { createRefresh };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongRefresh = api;
})(typeof self === "undefined" ? globalThis : self);
