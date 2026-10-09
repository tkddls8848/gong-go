// Modal selection, focus restoration and ECR cancellation share one lifecycle.
(function (scope) {
  "use strict";
  function createModal({
    model, $, modal, html, normalizeFiles, modalSubtitle, detailLink,
    attachmentWarnings, planLinks, renderBidSchedule, stopEcrAnalysis,
    refreshAiAccess, loadEcr, document = scope.document
  } = {}) {
    let modalOpener = null;
    function activateModalFocus() {
      if (!modal.contains(document.activeElement)) modalOpener = document.activeElement;
      $(".app").inert = true;
      $("#modal-close").focus();
    }
    function restoreModalFocus() {
      $(".app").inert = false;
      if (!modalOpener) return;
      const target = modalOpener.isConnected ? modalOpener : $(".mode-toggle-btn.active");
      modalOpener = null;
      target?.focus();
    }
    function modalKeydown(event) {
      if (modal.style.display === "none") return;
      if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
      if (event.key !== "Tab") return;
      const controls = [...modal.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")]
        .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); $(".modal").focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    function openModal(row, initialTab = "files") {
      stopEcrAnalysis();
      model.currentRow = row;
      model.currentAnalysis = null;
      const files = normalizeFiles(row.files);
      $("#modal-title").textContent = row.title || "(\uC0AC\uC5C5\uBA85 \uC5C6\uC74C)";
      $("#modal-subtitle").textContent = modalSubtitle(row, files);
      $("#modal-file-list").innerHTML = detailLink(row) + attachmentWarnings(row.files) + (files.length ? files.map((file, i) => `<li><span class="file-no">${i + 1}.</span><a href="${html(file.url)}" target="_blank" rel="noopener noreferrer">${html(file.name)}</a>${file.source ? ` <span class="file-tag">${html(file.kind ? `${file.source}·${file.kind}` : file.source)}</span>` : ""}</li>`).join("") : row.mode === "plan" ? planLinks(row) : '<li><span class="empty-msg">\uC774 \uACF5\uACE0\uC5D0\uB294 API\uB85C \uC81C\uACF5\uB418\uB294 \uCCA8\uBD80\uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</span></li>');
      $("#download-all-btn").disabled = !files.length;
      $("#download-all-btn").textContent = files.length ? `\uC804\uCCB4 \uB2E4\uC6B4\uB85C\uB4DC (${files.length}\uAC74)` : "\uC804\uCCB4 \uB2E4\uC6B4\uB85C\uB4DC";
      $("#schedule-tab").disabled = row.mode !== "bid";
      $("#schedule-content").innerHTML = row.mode === "bid" ? renderBidSchedule(row) : "";
      $("#ecr-tab").disabled = row.mode !== "bid";
      $("#ecr-tab").textContent = "ECR \uBD84\uC11D";
      $("#ecr-content").innerHTML = "";
      $("#download-ecr-btn").disabled = true;
      $("#ecr-file").value = "";
      $("#ecr-progress").textContent = "";
      selectTab(initialTab);
      modal.style.display = "flex";
      activateModalFocus();
    }
    function closeModal() {
      stopEcrAnalysis();
      modal.style.display = "none";
      model.currentRow = null;
      model.currentAnalysis = null;
      restoreModalFocus();
    }
    function selectTab(tab) {
      if (tab !== "ecr") stopEcrAnalysis();
      document.querySelectorAll(".modal-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
      $("#files-content").hidden = tab !== "files";
      $("#schedule-content").hidden = tab !== "schedule";
      $("#ecr-content").hidden = tab !== "ecr";
      $("#ecr-tab").disabled = model.currentRow?.mode !== "bid";
      $("#ecr-upload-form").hidden = tab !== "ecr";
      $("#ai-access-panel").hidden = tab !== "ecr";
      if (tab === "ecr") {
        refreshAiAccess();
        loadEcr();
      }
    }
    return { openModal, closeModal, selectTab, modalKeydown };
  }
  const api = { createModal };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongModal = api;
})(typeof self === "undefined" ? globalThis : self);
