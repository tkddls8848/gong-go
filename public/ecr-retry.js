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
  // 장비 종류마다 그 장비를 고를 때 보는 핵심 규격. 이 중 하나도 없는 장비는 규격을 못 찾은 것과 같다.
  const CORE = {
    서버: ["CPU", "메모리", "로컬 디스크", "GPU"],
    스토리지: ["Raw 용량", "Usable 용량", "디스크 구성", "컨트롤러"],
    스위치: ["포트 수", "포트 속도", "스위칭 용량", "성능"],
  };
  const deviceKey = (device) => `${device.종류}|${String(device.명칭 || "").replace(/\s/g, "").toUpperCase()}`;
  const strong = (device) => (device.규격 || []).some((fact) => (CORE[device.종류] || []).includes(fact.항목));
  // 서버(src/ecr-merge.js)가 유효 규격이 없는 장비를 장비 요약에서 뺄 때 남기는 사유.
  const DROPPED = /^장비 "(.+)": 유효한 원문 규격이 없어/;
  // 장비 요약에서 뺀 모든 사유. 다시 물어 그 장비를 핵심 규격과 함께 되찾으면 사유를 지운다.
  const REMOVED = /^장비 "(.+)": (?:유효한 원문 규격이 없어|서버·스토리지·스위치가 아닌 )/;
  // 번호는 대조됐지만 장비가 핵심 규격 없이 왔거나, 장비가 통째로 빠졌거나, 남은 장비가 하나도 없는 번호.
  // 큰 문서에서 실행마다 갈리는 쪽이다(노후 인프라 L3 스위치는 인용 검증에 실패해 품목 목록으로 모두 빠졌다).
  function thin(item) {
    const devices = item.장비요약 || [];
    return !devices.length || devices.some((device) => CORE[device.종류] && !strong(device)) || (item.불확실 || []).some((message) => DROPPED.test(message));
  }
  // 다시 물을 번호와 함께 보낼 이어받기 목록. 번호 대조가 끝난 결과에서만 만든다.
  // 규격이 빈 번호는 이어받는 번호에도 그대로 둔다 — 다시 물어 못 찾아도 직전 결과로 대조된 번호다.
  function retryPlan(analysis) {
    const coverage = analysis?.coverage;
    if (!coverage || !Array.isArray(coverage.expectedIds)) return null;
    // 이미 다시 물었는데도 비는 번호는 또 묻지 않는다 — 같은 번호를 같은 지시로 물으면 같은 답이 온다.
    const asked = new Set((analysis.retried || []).map(key));
    const missing = [...new Set([...(analysis.누락 || []), ...(coverage.missingIds || [])])].filter((id) => !asked.has(key(id)));
    if (missing.length > MAX_FOCUS) return null;
    const matched = (coverage.matchedIds || []).filter((id) => SENDABLE.test(id));
    const matchedKeys = new Set(matched.map(key));
    const weak = [...new Set((analysis.ecr || []).filter((item) => matchedKeys.has(key(item.id)) && !asked.has(key(item.id)) && thin(item)).map((item) => item.id))];
    const focus = missing.filter((id) => SENDABLE.test(id));
    const extra = weak.filter((id) => !focus.some((other) => key(other) === key(id))).slice(0, MAX_FOCUS - focus.length);
    if (!focus.length && !extra.length) return null;
    return { focus: [...focus, ...extra], thin: extra, matched, unexpected: (coverage.unexpectedIds || []).filter((id) => SENDABLE.test(id)).slice(0, MAX_FOCUS) };
  }
  // 규격이 빈 번호: 다시 물어 핵심 규격을 가진 장비가 새로 나오면 그 장비를 더한다. 새 장비와 이름이 같은 빈 장비만 뺀다.
  // 이름이 다른 장비는 종류가 같아도 두고, 직전에 핵심 규격이 있던 장비도 그대로 둔다 — 다시 물은 응답이 본체 대신
  // 딸린 품번(노후 인프라 L3 스위치 아래의 전원 품번 C9K-PWR-650WAC-R/2)을 장비로 낸 일이 있다.
  // 새로 나온 장비가 없으면 null(직전 항목 유지)이다.
  function strengthen(before, after) {
    const kept = (before.장비요약 || []).filter(strong);
    const known = new Set(kept.map(deviceKey));
    const added = (after?.장비요약 || []).filter((device) => strong(device) && !known.has(deviceKey(device)));
    if (!added.length) return null;
    const replaced = new Set(added.map(deviceKey));
    const squash = (name) => String(name || "").replace(/\s/g, "").toUpperCase();
    const names = new Set(added.map((device) => squash(device.명칭)));
    const devices = (before.장비요약 || []).filter((device) => strong(device) || !replaced.has(deviceKey(device))).concat(added);
    // 빠졌던 장비를 되찾았으면 "장비 요약에서 제외함" 사유는 더 맞지 않는다.
    const 불확실 = (before.불확실 || []).filter((message) => { const removed = REMOVED.exec(message); return !removed || !names.has(squash(removed[1])); });
    return { ...before, 장비요약: devices, 불확실 };
  }
  // asked는 화면이 실제로 다시 물은 번호, weak는 그중 규격이 빈 채로 대조됐던 번호다.
  // 응답이 대상 목록을 빠뜨려도 되풀이 방지는 asked로 한다.
  function mergeRetry(previous, retry, asked = retry.retry?.focus || [], weak = []) {
    const focus = new Set(asked.map(key));
    const weakKeys = new Set(weak.map(key));
    const recovered = new Set((retry.retry?.recovered || []).map(key).filter((id) => !weakKeys.has(id)));
    const before = new Set(previous.ecr.map((item) => key(item.id)));
    const improved = new Map();
    for (const item of previous.ecr) {
      if (!weakKeys.has(key(item.id))) continue;
      const better = strengthen(item, retry.ecr.find((other) => key(other.id) === key(item.id)));
      if (better) improved.set(item, better);
    }
    // 되찾은 번호는 새 결과로 바꾼다. 여전히 비는 번호는 직전 항목(불확실 사유 포함)을 남기고,
    // 직전에 항목조차 없던 번호만 새 항목을 더한다. 대상 밖 번호는 직전 결과 그대로다.
    const ecr = [
      ...previous.ecr.filter((item) => !recovered.has(key(item.id))).map((item) => improved.get(item) || item),
      ...retry.ecr.filter((item) => focus.has(key(item.id)) && !weakKeys.has(key(item.id)) && (recovered.has(key(item.id)) || !before.has(key(item.id)))),
    ];
    const found = [...asked.filter((id) => recovered.has(key(id))), ...[...improved.keys()].map((item) => item.id)];
    const errors = ecr.flatMap((item) => (item.불확실 || []).map((message) => `${item.id}: ${message}`));
    const note = `규격을 찾지 못한 번호 ${asked.length}개를 다시 분석해 ${found.length}개의 규격을 찾아 합쳤습니다.${found.length < asked.length ? " 나머지는 원문 확인이 필요합니다." : ""}`;
    return {
      ...previous,
      analyzedAt: retry.analyzedAt || previous.analyzedAt,
      ecr,
      verified: false,
      coverage: retry.coverage,
      누락: retry.누락 || [],
      verification: { errors, warnings: [...new Set([...(retry.verification?.warnings || []), note])] },
      // 이번 재분석에서 다시 물은 번호와 규격을 찾은 번호.
      retry: { focus: [...asked], recovered: found },
      // 다시 물은 번호. retryPlan이 되풀이를 막는 데 쓴다.
      retried: [...new Set([...(previous.retried || []), ...asked])],
    };
  }
  const api = { retryPlan, mergeRetry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcrRetry = api;
})(typeof self === "undefined" ? globalThis : self);
