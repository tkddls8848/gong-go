// 공고·ECR 인덱스 검증과 최신 요청의 목록 반영.
(function (scope) {
  "use strict";
  function createIndex({
    model, analyses, $, getJson, renderDataStatus, defaultRange,
    GongDates = scope.GongDates, localStorage = scope.localStorage,
    DATA_BASE = "/data", INDEX_STORAGE_KEY = "gong-go:index-updated-at"
  } = {}) {
    let indexRevision = 0;
    // index.json은 갱신 직후에도 최신이어야 하므로 매번 캐시를 우회한다. 파일 1개라 호출량에
    // 영향이 없다. 일반 수집 시각은 CSV URL에 붙이지 않는다 — 매시 모든 과거 캐시가 날아간다.
    // 대신 과거 백필처럼 봉인 파일의 스키마 자체가 바뀐 때만 schemaVersion이 한 번 바뀐다.
    async function loadIndex(initial) {
      const revision = ++indexRevision;
      let index, analysis;
      try { [index, analysis] = await Promise.all([getJson(`${DATA_BASE}/index.json?t=${Date.now()}`), getJson(`${DATA_BASE}/analysis-index.json`).catch(() => null)]); }
      catch (error) { if (revision !== indexRevision) return { stale: true, changed: false }; throw error; }
      if (revision !== indexRevision) return { stale: true, changed: false };
      const paths = new Set();
      if (!index || !Array.isArray(index.files) || index.files.some((file) => {
        if (!file || typeof file.path !== "string" || !/^(pre|bid|plan)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.csv\.gz$/.test(file.path)) return true;
        if (paths.has(file.path)) return true;
        paths.add(file.path);
        if (file.mode !== undefined && file.mode !== file.path.split("/")[0]) return true;
        if (file.count !== undefined && (!Number.isSafeInteger(file.count) || file.count < 0)) return true;
        try { GongDates.shiftDay(file.begin, 0); GongDates.shiftDay(file.end, 0); } catch { return true; }
        return file.begin > file.end;
      })) throw new Error("공고 데이터 목록 형식이 올바르지 않습니다. 기존 목록을 유지합니다. 잠시 후 다시 시도하세요.");
      const notices = new Set();
      const analysisValid = analysis && Array.isArray(analysis.entries) && analysis.entries.every((entry) => {
        if (!entry || typeof entry.notice !== "string" || !entry.notice.trim() || typeof entry.path !== "string" || !entry.path.trim() || notices.has(entry.notice)) return false;
        if (entry.verified !== undefined && typeof entry.verified !== "boolean") return false;
        if (entry.ecrCount !== undefined && (!Number.isSafeInteger(entry.ecrCount) || entry.ecrCount < 0)) return false;
        // 인덱스는 저장 결과만 가리켜야 한다. 다른 API·URL·경로 정규화 우회는 허용하지 않는다.
        let cloudPath;
        try { cloudPath = `/api/ecr?notice=${encodeURIComponent(entry.notice)}`; } catch { return false; }
        const storedPath = entry.path.startsWith("analysis/") && entry.path.endsWith(".json")
          && entry.path === entry.path.trim() && !/[\\%?#:\x00-\x1f\x7f]/.test(entry.path)
          && entry.path.split("/").every((part) => part && part !== "." && part !== "..");
        if (entry.path !== cloudPath && !storedPath) return false;
        notices.add(entry.notice);
        return true;
      });
      let previous = "";
      try { previous = localStorage.getItem(INDEX_STORAGE_KEY) || ""; localStorage.setItem(INDEX_STORAGE_KEY, index.updatedAt || ""); } catch {}
      model.fileIndex = index.files || [];
      model.dataSchemaVersion = String(index.schemaVersion || "");
      if (analysisValid) { analyses.clear(); analysis.entries.forEach((entry) => analyses.set(entry.notice, entry)); }
      renderDataStatus(index);
      if (!analysisValid) $("#data-count").textContent += " · ECR 저장 목록 확인 실패";
      if (initial) { defaultRange(); $("#status").textContent = `${model.fileIndex.length}개 CSV를 찾았습니다.${analysisValid ? "" : " ECR 저장 목록은 확인하지 못했습니다. 공고에서 저장 결과를 직접 조회할 수 있습니다."}`; }
      return { index, analysisUnavailable: !analysisValid, changed: Boolean(previous && index.updatedAt && previous !== index.updatedAt) };
    }
    return { loadIndex };
  }
  const api = { createIndex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongIndex = api;
})(typeof self === "undefined" ? globalThis : self);
