(function (scope) {
  "use strict";
  function createHttp({
    fetch = (...args) => scope.fetch(...args),
    setTimeout = (...args) => scope.setTimeout(...args),
    clearTimeout = (...args) => scope.clearTimeout(...args)
  } = {}) {
    // 응답 헤더뿐 아니라 본문 수신까지 제한한다. 시간 초과는 서버 작업 취소를 뜻하지 않는다.
    async function requestJson(url, options = {}, timeoutMs = 210000, purpose = "ecr") {
      const search = purpose === "search";
      const access = purpose === "access";
      const read = purpose === "read";
      const listing = purpose === "data";
      const label = listing ? "데이터" : access ? "잠금" : search ? "검색" : "분석";
      const retry = listing ? "연결을 확인한 후 잠시 뒤 새로고침하세요." : read ? "잠시 후 저장 결과를 다시 조회하세요. 재분석할 필요는 없습니다." : access ? "잠금 상태를 확인한 후 다시 시도하세요." : search ? "잠시 후 다시 시도하거나 일반 검색을 이용하세요." : "잠시 후 같은 파일로 다시 시작하세요.";
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(search || access || read || listing ? `응답 대기 시간이 초과되었습니다. 서버 처리는 계속될 수 있습니다. ${retry}` : "응답 대기 시간이 초과되었습니다. 서버 처리는 계속될 수 있습니다. 잠시 후 같은 파일로 다시 시작하면 저장된 구간을 재사용합니다."));
          controller.abort();
        }, timeoutMs);
      });
      const work = async () => {
        let response;
        try { response = await fetch(url, { ...options, signal: controller.signal }); }
        catch { throw new Error(`서버 응답을 받지 못했습니다. 처리 여부는 확인되지 않았습니다. 연결을 확인하세요. ${retry}`); }
        let data;
        try { data = await response.json(); }
        catch {
          throw new Error(response.status === 401 ? (access || read || listing ? "로그인이 만료되었습니다. 다시 로그인하세요." : search ? "로그인이 만료되었습니다. 다시 로그인한 후 검색하세요." : "로그인이 만료되었습니다. 다시 로그인한 후 같은 파일로 분석을 이어가세요.") : `${label} 응답을 읽지 못했습니다 (HTTP ${response.status}). 서버 처리 여부는 확인되지 않았습니다. ${retry}`);
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${label} 응답 형식이 올바르지 않습니다. ${retry}`);
        return { response, data };
      };
      try { return await Promise.race([work(), timeout]); }
      finally { clearTimeout(timer); }
    }
    async function getJson(url) {
      const { response, data } = await requestJson(url, {}, 30000, "data");
      if (!response.ok) throw new Error(response.status === 401 ? "로그인이 만료되었습니다. 다시 로그인하세요." : `데이터 조회에 실패했습니다 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`);
      return data;
    }
    return { requestJson, getJson };
  }
  scope.GongHttp = createHttp();
  if (typeof module !== "undefined" && module.exports) module.exports = { createHttp, ...scope.GongHttp };
})(typeof self === "undefined" ? globalThis : self);
