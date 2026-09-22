(function (root) {
  const fields = {
    서버: ["용도", "수량", "도입구분", "CPU", "메모리", "로컬 디스크", "NIC/HBA", "이중화", "유지보수", "라이선스", "기타 조건"],
    스토리지: ["종류", "수량", "도입구분", "Raw 용량", "Usable 용량", "디스크 구성", "프로토콜", "컨트롤러", "성능", "이중화", "복제", "라이선스", "유지보수", "기타 조건"],
  };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function render(data) {
    const items = Array.isArray(data.ecr) ? data.ecr : [];
    if (!(data.schemaVersion >= 2) || items.some((item) => !Array.isArray(item.장비요약))) return '<p class="hint">서버·스토리지 요약을 보려면 새 형식으로 재분석해야 합니다. 기존 ECR 원문은 아래에서 확인할 수 있습니다.</p>';
    const sections = Object.entries(fields).map(([kind, columns]) => {
      const equipment = items.flatMap((item) => (item.장비요약 || []).filter((entry) => entry && entry.종류 === kind && Array.isArray(entry.규격)).map((entry) => ({ item, entry })));
      if (!equipment.length) return `<section class="equipment-summary"><h3>${kind} 요구사항</h3><p class="hint">추출된 ${kind} 항목이 없습니다.${data.verified ? "" : " 분석이 미검증 상태이므로 원문 확인이 필요합니다."}</p></section>`;
      return `<section class="equipment-summary"><h3>${kind} 요구사항</h3>${equipment.map(({ item, entry }) => {
        const specs = entry.규격.filter((fact) => fact && typeof fact === "object");
        const present = specs.map((fact) => fact.항목);
        const allFields = [...new Set([...columns, ...present])];
        return `<article class="equipment-card"><h4>${escape(entry.명칭 || "장비명 확인 필요")} <small>${escape(item.id)}</small></h4><p class="hint">출처: ${escape(entry.출처 || item.출처 || "확인 필요")}</p><div class="ecr-scroll"><table class="nested-spec"><thead><tr><th>항목</th><th>요구사항 · 적용 조건</th><th>근거</th></tr></thead><tbody>${allFields.map((field) => {
          const facts = specs.filter((fact) => fact.항목 === field);
          if (!facts.length) return `<tr><th scope="row">${escape(field)}</th><td>미기재</td><td>—</td></tr>`;
          return facts.map((fact) => `<tr><th scope="row">${escape(field)}</th><td>${escape(fact.값 || "확인 필요")}${fact.검증 !== "원문 확인" ? '<span class="warning-text">확인 필요</span>' : ""}</td><td><details><summary>${fact.검증 === "원문 확인" ? "대조된 근거 보기" : "추출 근거 확인"}</summary><div class="detail-text">${escape(fact.근거 || "근거 없음")}</div></details></td></tr>`).join("");
        }).join("")}</tbody></table></div><details><summary>ECR 원문 보기 · ${escape(item.id)}</summary><div class="detail-text">${escape(item.세부내용_원문 || "원문 없음")}</div></details></article>`;
      }).join("")}</section>`;
    });
    return `<div class="equipment-summaries"><p class="hint">원문 표현과 조건을 그대로 표시합니다. 미기재는 추출값이 없다는 뜻이며, 근거 대조는 규격 해석의 정확성을 보증하지 않습니다.</p>${(data.verification?.warnings || []).map((warning) => `<p class="warning-text">${escape(warning)}</p>`).join("")}${sections.join("")}</div>`;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { render };
  else root.EquipmentSummary = { render };
})(typeof globalThis !== "undefined" ? globalThis : this);
