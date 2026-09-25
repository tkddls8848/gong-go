(function (root) {
  const fields = {
    서버: ["용도", "수량", "도입구분", "CPU", "메모리", "로컬 디스크", "NIC/HBA", "이중화", "유지보수", "라이선스", "기타 조건"],
    스토리지: ["종류", "수량", "도입구분", "Raw 용량", "Usable 용량", "디스크 구성", "프로토콜", "컨트롤러", "성능", "이중화", "복제", "라이선스", "유지보수", "기타 조건"],
    스위치: ["용도", "수량", "도입구분", "포트 수", "포트 속도", "스위칭 용량", "프로토콜", "트랜시버·케이블", "이중화", "라이선스", "유지보수", "기타 조건"],
  };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
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
    if (!(data.schemaVersion >= 2) || items.some((item) => !Array.isArray(item.장비요약))) return `${dropped}<p class="hint">서버·스토리지 요약을 보려면 새 형식으로 재분석해야 합니다. 기존 ECR 원문은 아래에서 확인할 수 있습니다.</p>`;
    const groups = Object.entries(fields).map(([kind, columns]) => ({ kind, columns, found: entriesOf(items, kind) }));
    const sections = groups.map(({ kind, columns, found }) => {
      if (!found.length) return `<section class="equipment-summary"><h3>${kind} 요구사항</h3><p class="hint">추출된 ${kind} 항목이 없습니다.${data.verified ? "" : " 분석이 미검증 상태이므로 원문 확인이 필요합니다."}</p></section>`;
      return `<section class="equipment-summary"><h3>${kind} 요구사항</h3>${found.map(({ item, entry }) => {
        const specs = specsOf(entry);
        const checks = specs.filter(needsCheck).length;
        const allFields = [...new Set([...columns, ...specs.map((fact) => fact.항목)])];
        return `<article class="equipment-card"><h4>${escape(entry.명칭 || "장비명 확인 필요")} <small>${escape(item.id)}</small></h4><p class="hint">출처: ${escape(entry.출처 || item.출처 || "확인 필요")}</p><p class="equipment-tally"><span class="spec-mark ok">원문 확인 ${specs.length - checks}</span><span class="spec-mark warn">확인 필요 ${checks}</span></p><div class="ecr-scroll"><table class="nested-spec"><thead><tr><th>항목</th><th>요구사항 · 적용 조건</th><th>근거</th></tr></thead><tbody>${allFields.map((field) => {
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
    return `<div class="equipment-summaries">${countsBlock(groups)}<p class="hint">원문 표현과 조건을 그대로 표시합니다. 미기재는 추출값이 없다는 뜻이며, 근거 대조는 규격 해석의 정확성을 보증하지 않습니다.</p>${dropped}${(data.verification?.warnings || []).map((warning) => `<p class="warning-text">${escape(warning)}</p>`).join("")}${sections.join("")}</div>`;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { render };
  else root.EquipmentSummary = { render };
})(typeof globalThis !== "undefined" ? globalThis : this);
