// 누락 번호 재분석의 대상 고르기와, 재분석 응답을 직전 결과에 합치기.
// 서버는 결과를 저장하지 않으므로 직전 결과는 이 화면에만 있다. 서버가 문서 전체 기준으로 다시 대조한
// 번호 목록(coverage)을 그대로 쓰고, 여기서는 장비 항목만 합친다.
(function (scope) {
  "use strict";
  const key = (id) => String(id).replace(/–/g, "-").replace(/\s/g, "").toUpperCase();
  const MAX_FOCUS = 66;
  // 서버(src/ecr.js requirementIdOK)가 받는 번호 형태. 모델이 번호를 못 준 항목은 "확인 필요 (3)" 같은
  // 자리표시 ID로 불일치 목록에 들어가는데, 그대로 보내면 재분석 전체가 거절된다.
  const SENDABLE = /^[0-9A-Za-z가-힣–-][0-9A-Za-z가-힣– -]{0,38}[0-9A-Za-z]$/;
  // 다시 물을 번호와 함께 보낼 이어받기 목록. 번호 대조가 끝난 결과에서만 만든다.
  function retryPlan(analysis) {
    const coverage = analysis?.coverage;
    // 이미 다시 물었는데도 비는 번호는 또 묻지 않는다 — 같은 번호를 같은 지시로 물으면 같은 답이 온다.
    const asked = new Set((analysis?.retried || []).map(key));
    const missing = [...new Set([...(analysis?.누락 || []), ...(coverage?.missingIds || [])])].filter((id) => !asked.has(key(id)));
    if (!coverage || !Array.isArray(coverage.expectedIds) || !missing.length || missing.length > MAX_FOCUS) return null;
    const focus = missing.filter((id) => SENDABLE.test(id));
    if (!focus.length) return null;
    return { focus, matched: (coverage.matchedIds || []).filter((id) => SENDABLE.test(id)), unexpected: (coverage.unexpectedIds || []).filter((id) => SENDABLE.test(id)).slice(0, MAX_FOCUS) };
  }
  // asked는 화면이 실제로 다시 물은 번호다. 응답이 대상 목록을 빠뜨려도 되풀이 방지는 이것으로 한다.
  function mergeRetry(previous, retry, asked = retry.retry?.focus || []) {
    const focus = new Set(asked.map(key));
    const recovered = new Set((retry.retry?.recovered || []).map(key));
    const before = new Set(previous.ecr.map((item) => key(item.id)));
    // 되찾은 번호는 새 결과로 바꾼다. 여전히 비는 번호는 직전 항목(불확실 사유 포함)을 남기고,
    // 직전에 항목조차 없던 번호만 새 항목을 더한다. 대상 밖 번호는 직전 결과 그대로다.
    const ecr = [
      ...previous.ecr.filter((item) => !recovered.has(key(item.id))),
      ...retry.ecr.filter((item) => focus.has(key(item.id)) && (recovered.has(key(item.id)) || !before.has(key(item.id)))),
    ];
    const errors = ecr.flatMap((item) => (item.불확실 || []).map((message) => `${item.id}: ${message}`));
    const note = `누락 번호 ${asked.length}개를 다시 분석해 ${recovered.size}개의 규격을 찾아 합쳤습니다.${recovered.size < asked.length ? " 나머지는 원문 확인이 필요합니다." : ""}`;
    return {
      ...previous,
      analyzedAt: retry.analyzedAt || previous.analyzedAt,
      ecr,
      verified: false,
      coverage: retry.coverage,
      누락: retry.누락 || [],
      verification: { errors, warnings: [...new Set([...(retry.verification?.warnings || []), note])] },
      // 다시 물은 번호. retryPlan이 되풀이를 막는 데 쓴다.
      retried: [...new Set([...(previous.retried || []), ...asked])],
    };
  }
  const api = { retryPlan, mergeRetry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcrRetry = api;
})(typeof self === "undefined" ? globalThis : self);
