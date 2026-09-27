// 자연어 검색 응답 검증과 변경된 조회 조건 보호.
(function (scope) {
  "use strict";
  function createNlQuery({
    model, $, collectInstitutions, setNl, applyNlFilter, applyFilters, resetPage,
    GongHttp = scope.GongHttp, GongDates = scope.GongDates, ASK_API = "/api/ask"
  } = {}) {
    let nlPending = false;
    function validNlResponse(state) {
      const filter = state?.filter;
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
      if (state.explain !== undefined && typeof state.explain !== "string") return false;
      if (state.notes !== undefined && (!Array.isArray(state.notes) || state.notes.some((note) => typeof note !== "string"))) return false;
      if (filter.mode !== undefined && !["pre", "bid", "plan"].includes(filter.mode)) return false;
      if (filter.type !== undefined && !["", "물품", "외자", "용역", "공사"].includes(filter.type)) return false;
      if (filter.q !== undefined && typeof filter.q !== "string") return false;
      if (filter.looseInstitution !== undefined && typeof filter.looseInstitution !== "boolean") return false;
      if (filter.institutions !== undefined && (!Array.isArray(filter.institutions) || filter.institutions.some((name) => typeof name !== "string"))) return false;
      for (const key of ["begin", "end"]) {
        if (filter[key] === undefined || filter[key] === "") continue;
        if (typeof filter[key] !== "string") return false;
        try { GongDates.shiftDay(filter[key], 0); } catch { return false; }
      }
      // 서버는 기간을 양쪽 모두 반환하거나 둘 다 비운다. 일부 날짜만 적용하면 기존 날짜와 섞인다.
      return Boolean(filter.begin) === Boolean(filter.end) && (!filter.begin || filter.begin <= filter.end);
    }
    function nlSearchContext() {
      return JSON.stringify([model.searchVersion, model.viewMode, ...["#nl-query", "#q", "#begin", "#end", "#business-type"].map((id) => $(id).value), $("#inst-loose").checked, collectInstitutions()]);
    }
    async function runNlQuery() {
      // Enter 이벤트는 disabled 버튼을 우회하므로 요청 자체를 직렬화한다.
      if (nlPending) return;
      const query = $("#nl-query").value.trim();
      if (query.length < 2) { setNl(false, "찾고 싶은 내용을 한 문장으로 적어 주세요.", "error"); return; }
      const context = nlSearchContext();
      nlPending = true;
      setNl(true, "질의를 해석하는 중입니다.");
      let state;
      try {
        const { response, data } = await GongHttp.requestJson(ASK_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: query, mode: model.viewMode }) }, 60000, "search");
        state = data;
        // 서버가 준 message를 항상 먼저 보여준다(startRefresh와 같은 규칙). 404는 구 배포본이다.
        if (!response.ok) throw new Error(state.message || (response.status === 404 ? "고급검색 API가 없습니다. 배포본이 오래된 것 같습니다." : `고급검색이 실패했습니다 (${response.status}).`));
        if (!validNlResponse(state)) {
          throw new Error("검색 조건 응답 형식이 올바르지 않습니다. 일반 검색을 이용하거나 잠시 후 다시 시도하세요.");
        }
      } catch (error) {
        setNl(false, context === nlSearchContext() ? error.message : "검색 조건이 변경되어 이전 해석 응답을 적용하지 않았습니다.", context === nlSearchContext() ? "error" : "");
        return;
      } finally { nlPending = false; }
      if (context !== nlSearchContext()) { setNl(false, "검색 조건이 변경되어 이전 해석 응답을 적용하지 않았습니다."); return; }
      applyNlFilter(state);
      resetPage(); applyFilters();
    }
    return { runNlQuery };
  }
  const api = { createNlQuery };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongNlQuery = api;
})(typeof self === "undefined" ? globalThis : self);
