(function (root) {
  // 의미/정확도 검증이 아니라 화면과 CSV 소비에 필요한 구조 검증이다. 구형 선택 필드는 허용한다.
  function validate(data) {
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const strings = (value) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
    const objects = (value) => value === undefined || (Array.isArray(value) && value.every(object));
    const textFields = (value, keys) => keys.every((key) => value[key] === undefined || typeof value[key] === "string");
    const presentText = (value) => typeof value === "string" && value.trim().length > 0;
    const fail = () => { throw new Error("ECR 결과 형식이 올바르지 않습니다. 운영자에게 문의하세요."); };
    if (!object(data) || !Array.isArray(data.ecr) || !data.ecr.every(object)) fail();
    if (data.verified !== undefined && typeof data.verified !== "boolean") fail();
    if (!textFields(data, ["provider", "model", "analyzedAt"])) fail();
    if (data.schemaVersion !== undefined && (!Number.isSafeInteger(data.schemaVersion) || data.schemaVersion < 1)) fail();
    for (const key of ["누락", "sourceFiles"]) if (!strings(data[key])) fail();
    if (data.verification !== undefined) {
      if (!object(data.verification) || !strings(data.verification.errors) || !strings(data.verification.warnings)) fail();
    }
    if (data.coverage !== undefined) {
      if (!object(data.coverage)) fail();
      if (!textFields(data.coverage, ["status"])) fail();
      for (const key of ["expectedIds", "matchedIds", "missingIds"]) if (!strings(data.coverage[key])) fail();
    }
    for (const item of data.ecr) {
      if (!textFields(item, ["id", "분류", "명칭", "세부내용_원문", "출처"])) fail();
      if (!strings(item.산출물) || !strings(item.불확실) || !objects(item.기본규격) || !objects(item.장비요약)) fail();
      for (const spec of item.기본규격 || []) {
        if (!textFields(spec, ["구분", "항목", "요구사항"])) fail();
        // 구형 수량의 숫자 표기는 보존하되 객체나 배열의 암묵적 문자열 변환은 막는다.
        if (spec.수량 !== undefined && typeof spec.수량 !== "string" && !(typeof spec.수량 === "number" && Number.isFinite(spec.수량))) fail();
      }
      for (const entry of item.장비요약 || []) {
        if (!textFields(entry, ["종류", "명칭", "출처"])) fail();
        if (!Array.isArray(entry.규격) || !entry.규격.every(object)) fail();
        for (const fact of entry.규격) {
          for (const key of ["항목", "값", "근거", "검증"]) if (fact[key] !== undefined && typeof fact[key] !== "string") fail();
          if (fact.검증 === "원문 확인" && ![fact.항목, fact.값, fact.근거].every(presentText)) fail();
        }
      }
    }
    return data;
  }
  const fields = {
    서버: ["용도", "수량", "도입구분", "CPU", "메모리", "로컬 디스크", "NIC/HBA", "이중화", "유지보수", "라이선스", "기타 조건"],
    스토리지: ["종류", "수량", "도입구분", "Raw 용량", "Usable 용량", "디스크 구성", "프로토콜", "컨트롤러", "성능", "이중화", "복제", "라이선스", "유지보수", "기타 조건"],
    스위치: ["용도", "수량", "도입구분", "포트 수", "포트 속도", "스위칭 용량", "프로토콜", "트랜시버·케이블", "이중화", "라이선스", "유지보수", "기타 조건"],
  };
  // 저장 플래그가 있어도 명시적인 미추출·오류·불확실 정보가 우선한다.
  // 이 함수는 표시 기준이며 원문을 재검증하거나 저장 값을 수정하지 않는다.
  function isVerified(data) {
    return data.verified === true && Array.isArray(data.ecr) && data.ecr.length > 0
      && !(data.누락 || []).length && !(data.verification?.errors || []).length
      && !(data.coverage?.missingIds || []).length
      && (!data.coverage || data.coverage.status === "matched")
      && data.ecr.every((item) => !(item.불확실 || []).length);
  }
  // HTML 이스케이프는 format.js 하나를 쓴다. index.html에서 format.js가 이 파일보다 늦게 로드되므로 그리는 시점에 찾는다.
  const format = typeof module !== "undefined" && module.exports ? require("./format.js") : null;
  const escape = (value) => (format || root.GongFormat).html(value);
  // 머리의 건수와 아래 카드가 어긋나면 둘 다 믿을 수 없다. 카드로 그릴 항목만 세도록 한 군데서 고른다.
  const entriesOf = (items, kind) => items.flatMap((item) => (item.장비요약 || []).filter((entry) => entry && entry.종류 === kind && Array.isArray(entry.규격)).map((entry) => ({ item, entry })));
  const specsOf = (entry) => entry.규격.filter((fact) => fact && typeof fact === "object");
  const needsCheck = (fact) => fact.검증 !== "원문 확인";
  // 불확실 메시지 중 "제외함"이 든 것만 모은다. 표에서 무엇을 뺐는지 모르면 표 자체를 믿을 수 없다.
  const droppedOf = (items) => items.flatMap((item) => (item.불확실 || []).filter((text) => typeof text === "string" && text.includes("제외함")).map((text) => ({ id: item.id, text })));
  function droppedBlock(items) {
    const dropped = droppedOf(items);
    if (!dropped.length) return "";
    return `<section class="excluded-specs"><h3>확인 불가로 제외된 규격 ${dropped.length}건</h3><ul>${dropped.map(({ id, text }) => `<li><strong>${escape(id || "ID 없음")}</strong> ${escape(text)}</li>`).join("")}</ul><p class="excluded-note">원문에서 값을 확인하지 못해 아래 표에 싣지 않은 항목입니다. 제안요청서 원문으로 직접 확인하세요.</p></section>`;
  }
  // 0건인 종류도 0으로 적는다. "없다"도 읽어야 하는 정보다 — 빠뜨린 것인지 없는 것인지 갈린다.
  function countsBlock(groups) {
    const checks = groups.reduce((sum, { found }) => sum + found.reduce((inner, { entry }) => inner + specsOf(entry).filter(needsCheck).length, 0), 0);
    const chips = groups.map(({ kind, found }) => `<span class="equipment-count${found.length ? "" : " zero"}">${kind} <strong>${found.length}</strong></span>`);
    return `<div class="equipment-counts">${chips.join("")}<span class="equipment-count check${checks ? "" : " zero"}">확인 필요 <strong>${checks}</strong></span></div>`;
  }
  function render(data) {
    const items = Array.isArray(data.ecr) ? data.ecr : [];
    // 제외 사유는 요약을 못 그리는 구형 결과에서도 보여야 한다. 그래야 app.js가 경고 묶음에서 빼도 안전하다.
    const dropped = droppedBlock(items);
    const coverage = data.coverage;
    const coverageText = coverage && Array.isArray(coverage.expectedIds) && coverage.expectedIds.length
      ? `분석 대상 번호 ${coverage.expectedIds.length}개 중 유효 규격 추출 ${(coverage.matchedIds || []).length}개 · 미추출 ${(coverage.missingIds || []).length}개. 번호 대조이며 규격 전체의 완전성을 보증하지 않습니다.`
      : "분석 대상 번호의 누락 여부는 확인되지 않았습니다. 추출 0건은 장비 요구사항이 없다는 뜻이 아닙니다.";
    const legacyItems = items.filter((item) => !Array.isArray(item.장비요약));
    const legacyWarning = legacyItems.length ? `<section class="excluded-specs"><h3>장비 요약 형식이 없는 요구사항 ${legacyItems.length}건</h3><p>아래 장비 건수는 요약 가능한 항목만 집계합니다. 다음 항목은 장비 없음으로 판단하지 말고 아래 ECR 상세의 원문·기본규격을 확인하세요.</p><ul>${legacyItems.map((item) => `<li>${escape(item.id || "ID 없음")} · ${escape(item.명칭 || "명칭 없음")}</li>`).join("")}</ul></section>` : "";
    if (!(data.schemaVersion >= 2) || (items.length && legacyItems.length === items.length)) return `${dropped}${legacyWarning}<p class="hint">서버·스토리지 요약을 보려면 새 형식으로 재분석해야 합니다. 기존 ECR 원문은 아래에서 확인할 수 있습니다.</p>`;
    const groups = Object.entries(fields).map(([kind, columns]) => ({ kind, columns, found: entriesOf(items, kind) }));
    // 저장 형식이 확장되거나 구형 분류명이 섞여도 이미 추출된 규격을 조용히 버리지 않는다.
    // 서버 등으로 추측해 재분류하지 않고 원래 종류와 함께 별도 표시한다.
    const unclassified = items.flatMap((item) => (item.장비요약 || [])
      .filter((entry) => entry && !Object.prototype.hasOwnProperty.call(fields, entry.종류) && Array.isArray(entry.규격))
      .map((entry) => ({ item, entry })));
    if (unclassified.length) groups.push({ kind: "분류 확인 필요", columns: [], found: unclassified, unclassified: true });
    const sections = groups.map(({ kind, columns, found, unclassified }) => {
      if (!found.length) return `<section class="equipment-summary"><h3>${kind} 요구사항</h3><p class="hint">추출된 ${kind} 항목이 없습니다.${isVerified(data) && !legacyItems.length ? "" : " 분석이 미검증 상태이므로 원문 확인이 필요합니다."}</p></section>`;
      return `<section class="equipment-summary"><h3>${kind} 요구사항</h3>${unclassified ? '<p class="warning-text">지원 분류와 일치하지 않는 저장 항목입니다. 장비 종류와 적용 대상을 원문으로 확인하세요. 자동 재분류하지 않았습니다.</p>' : ""}${found.map(({ item, entry }) => {
        const specs = specsOf(entry);
        const checks = specs.filter(needsCheck).length;
        const allFields = [...new Set([...columns, ...specs.map((fact) => fact.항목)])];
        const kindNotice = unclassified ? `<p class="warning-text">저장된 종류: ${escape(entry.종류 || "미기재")}</p>` : "";
        return `<article class="equipment-card"><h4>${escape(entry.명칭 || "장비명 확인 필요")} <small>${escape(item.id)}</small></h4>${kindNotice}<p class="hint">출처: ${escape(entry.출처 || item.출처 || "확인 필요")}</p><p class="equipment-tally"><span class="spec-mark ok">원문 확인 ${specs.length - checks}</span><span class="spec-mark warn">확인 필요 ${checks}</span></p><div class="ecr-scroll"><table class="nested-spec"><thead><tr><th>항목</th><th>요구사항 · 적용 조건</th><th>근거</th></tr></thead><tbody>${allFields.map((field) => {
          const facts = specs.filter((fact) => fact.항목 === field);
          if (!facts.length) return `<tr class="spec-row missing"><th scope="row">${escape(field)}</th><td>미기재</td><td>—</td></tr>`;
          return facts.map((fact) => {
            // 검증 상태를 값 뒤 작은 글씨 하나로만 두면 훑을 때 놓친다. 줄 표식·배지·줄 바탕 셋으로 가른다.
            const warn = needsCheck(fact);
            return `<tr class="spec-row ${warn ? "unverified" : "verified"}"><th scope="row">${escape(field)}</th><td><span class="spec-value">${escape(fact.값 || "미기재")}</span><span class="spec-mark ${warn ? "warn" : "ok"}">${warn ? "확인 필요" : "원문 확인"}</span></td><td><details><summary>${warn ? "추출 근거 확인" : "대조된 근거 보기"}</summary><div class="detail-text">${escape(fact.근거 || "근거 없음")}</div></details></td></tr>`;
          }).join("");
        }).join("")}</tbody></table></div><details><summary>ECR 원문 보기 · ${escape(item.id)}</summary><div class="detail-text">${escape(item.세부내용_원문 || "원문 없음")}</div></details></article>`;
      }).join("")}</section>`;
    });
    return `<div class="equipment-summaries">${legacyWarning}${countsBlock(groups)}<p class="hint">${escape(coverageText)}</p><p class="hint">원문 표현과 조건을 그대로 표시합니다. 미기재는 추출값이 없다는 뜻이며, 근거 대조는 규격 해석의 정확성을 보증하지 않습니다.</p>${dropped}${(data.verification?.warnings || []).map((warning) => `<p class="warning-text">${escape(warning)}</p>`).join("")}${sections.join("")}</div>`;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { render, validate, isVerified };
  else root.EquipmentSummary = { render, validate, isVerified };
})(typeof globalThis !== "undefined" ? globalThis : this);
