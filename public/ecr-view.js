// ECR 요구사항 표·경고·원문 상세 표시.
(function (scope) {
  "use strict";
  function createEcrView({
    $, html, document = scope.document, EquipmentSummary = scope.EquipmentSummary
  } = {}) {
    // 제외 사유("… 제외함")는 EquipmentSummary가 결과 머리의 전용 상자에 모아 그린다. 여기 경고 묶음에
    // 또 넣으면 같은 문장이 화면에 두 번 나오고, 정작 다른 불확실 메시지가 그 사이에 묻힌다.
    function renderEcr(data) {
      const hasItems = Array.isArray(data.ecr) && data.ecr.length > 0;
      const verified = EquipmentSummary.isVerified(data);
      const alerts = [...new Set([...(data.누락 || []), ...(data.coverage?.missingIds || [])])].map((id) => `누락: ${id}`).concat(data.verification?.errors || [], ...(data.ecr || []).map((item) => (item.불확실 || []).filter((text) => !String(text).includes("제외함")).map((text) => `${item.id}: ${text}`)));
      const rows = (data.ecr || []).map((item, i) => `<tr class="ecr-row" data-index="${i}"><td><button type="button" class="ecr-detail-toggle" aria-expanded="false" aria-controls="detail-${i}" aria-label="${html(`${item.id || "ECR"} ${item.명칭 || ""} 원문 상세`)}">${html(item.id || "상세")}</button></td><td>${html(item.분류)}</td><td>${html(item.명칭)}</td><td>${html((item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", ") || "-")}</td><td>${html((item.산출물 || []).join(", ") || "-")}</td></tr><tr id="detail-${i}" class="ecr-detail" hidden><td colspan="5"><p><strong>세부내용 원문</strong></p><div class="detail-text">${html(item.세부내용_원문 || "-")}</div>${specTable(item.기본규격 || [])}</td></tr>`).join("");
      $("#ecr-content").innerHTML = `${alerts.length ? `<div class="ecr-alert">${alerts.map(html).join("<br>")}</div>` : ""}<p class="ecr-status ${verified ? "verified" : "unverified"}">${!hasItems ? "추출 결과 없음 — 요구사항이 없다는 뜻은 아닙니다. 원문 확인 필요" : verified ? "자동 검증 통과" : "자동 검증 미통과 — 원문 확인 필요"}</p><div class="ecr-scroll"><table class="ecr-table"><thead><tr><th>ID</th><th>분류</th><th>명칭</th><th>수량</th><th>산출물</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">추출된 ECR이 없습니다.</td></tr>'}</tbody></table></div>`;
      document.querySelectorAll(".ecr-row").forEach((row) => row.onclick = () => {
        const detail = $(`#detail-${row.dataset.index}`);
        detail.hidden = !detail.hidden;
        row.classList.toggle("expanded", !detail.hidden);
        row.querySelector(".ecr-detail-toggle").setAttribute("aria-expanded", String(!detail.hidden));
      });
    }
    function specTable(specs) { return specs.length ? `<p><strong>기본규격</strong></p><div class="ecr-scroll"><table class="nested-spec"><thead><tr><th>구분</th><th>항목</th><th>요구사항</th><th>수량</th></tr></thead><tbody>${specs.map((spec) => `<tr><td>${html(spec.구분)}</td><td>${html(spec.항목)}</td><td>${html(spec.요구사항)}</td><td>${html(spec.수량)}</td></tr>`).join("")}</tbody></table></div>` : ""; }
    return { renderEcr, specTable };
  }
  const api = { createEcrView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcrView = api;
})(typeof self === "undefined" ? globalThis : self);
