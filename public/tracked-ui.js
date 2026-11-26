(function (scope) {
  "use strict";
  function createTrackedUi({ $, document = scope.document, tracked, model, html, modeSubtitles, closeModal = () => {}, closeRail = () => {} } = {}) {
    let active = false, visibleRows = [], running = null, queuedSave = false;
    const expanded = new Set();
    const canTrack = row => row && ["bid", "pre"].includes(row.mode);
    function rowButton(row, index) {
      if (!canTrack(row)) return "";
      const saved = tracked.isSaved(row);
      return `<button type="button" class="track-btn" data-track-index="${index}" aria-pressed="${saved}" aria-label="${html(row.title || "공고")} 관심사업 ${saved ? "해제" : "저장"}">${saved ? "★" : "☆"}</button>`;
    }
    function syncModal() {
      const row = model.currentRow, button = $("#modal-track-btn");
      button.hidden = !canTrack(row);
      button.setAttribute("aria-pressed", String(canTrack(row) && tracked.isSaved(row)));
      button.textContent = `${canTrack(row) && tracked.isSaved(row) ? "★" : "☆"} 관심사업`;
    }
    function modalOpened() { $("#modal-track-status").textContent = ""; syncModal(); }
    function sync() {
      $("#tracked-count").textContent = String(tracked.count());
      document.querySelectorAll("#results [data-track-index]").forEach(button => {
        const row = visibleRows[Number(button.dataset.trackIndex)], saved = tracked.isSaved(row);
        button.textContent = saved ? "★" : "☆";
        button.setAttribute("aria-pressed", String(saved));
        button.setAttribute("aria-label", `${row?.title || "공고"} 관심사업 ${saved ? "해제" : "저장"}`);
      });
      syncModal();
      if (active) {
        $("#results-heading").textContent = "관심사업";
        $("#result-summary").textContent = `${tracked.count()}건`;
      }
    }
    function render() {
      const container = $("#tracked-list"), focused = document.activeElement;
      let focus = null;
      if (focused && container.contains?.(focused)) {
        const row = focused.closest("[data-tracked-row], [data-tracked-detail]");
        if (row) {
          const id = row.dataset.trackedRow || row.dataset.trackedDetail;
          const oldTitles = [...container.querySelectorAll("[data-tracked-id]")];
          focus = { id, index: oldTitles.findIndex(button => button.dataset.trackedId === id),
            kind: focused.dataset.untrackId ? "remove" : row.dataset.trackedDetail ? "detail" : "title",
            control: [...row.querySelectorAll("a, button, input, select, textarea")].indexOf(focused) };
        }
      }
      $("#tracked-list").innerHTML = tracked.renderList();
      for (const button of $("#tracked-list").querySelectorAll("[data-tracked-id]")) {
        if (!expanded.has(button.dataset.trackedId)) continue;
        button.setAttribute("aria-expanded", "true");
        const row = document.createElement("tr"), cell = document.createElement("td");
        row.className = "tracked-expanded"; row.dataset.trackedDetail = button.dataset.trackedId; cell.colSpan = 6;
        cell.innerHTML = tracked.renderDetail(button.dataset.trackedId);
        row.append(cell); button.closest("tr").after(row);
      }
      sync();
      if (focus) {
        const titles = [...container.querySelectorAll("[data-tracked-id]")];
        const title = titles.find(button => button.dataset.trackedId === focus.id);
        let target = title;
        if (title && focus.kind === "remove") target = [...container.querySelectorAll("[data-untrack-id]")].find(button => button.dataset.untrackId === focus.id);
        if (title && focus.kind === "detail") {
          const detail = [...container.querySelectorAll("[data-tracked-detail]")].find(row => row.dataset.trackedDetail === focus.id);
          target = detail?.querySelectorAll("a, button, input, select, textarea")[focus.control] || title;
        }
        const fallback = $("#tracked-refresh").disabled ? $("#results-heading") : $("#tracked-refresh");
        (target || titles[Math.min(Math.max(0, focus.index), titles.length - 1)] || fallback).focus();
      }
    }
    function report(text) {
      $("#tracked-status").textContent = text;
      if (!active) $("#status").textContent = text;
      if (model.currentRow) $("#modal-track-status").textContent = text;
    }
    function refresh({ all = false, saved = false } = {}) {
      if (running) { if (saved) queuedSave = true; return running; }
      $("#tracked-refresh").disabled = true;
      running = Promise.resolve().then(async () => {
        do {
          queuedSave = false;
          $("#tracked-status").textContent = `${all ? tracked.count() : tracked.dueItems().length}건 확인 중입니다.`;
          await tracked.refresh({ all });
          all = false;
          render();
        } while (queuedSave);
        const failures = tracked.items().filter(item => item.error).length;
        if (failures) report(`${failures}건을 확인하지 못했습니다. 관심사업에서 각 사업의 안내를 확인하세요.`);
        else $("#tracked-status").textContent = "";
      }).catch(error => {
        report(error?.code === "storage" ? "관심사업을 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인하세요." : "관심사업을 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.");
      }).finally(() => { running = null; $("#tracked-refresh").disabled = false; sync(); });
      return running;
    }
    function toggle(row) {
      try {
        const result = tracked.toggle(row);
        report(result.saved ? "관심사업을 저장했습니다." : "관심사업 저장을 해제했습니다.");
        render();
        if (result.saved) return refresh({ saved: true });
      } catch {
        report("관심사업을 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인하세요.");
      }
      return Promise.resolve();
    }
    function show() {
      closeModal(); active = true;
      $("#tracked-view").hidden = false; $(".table-scroll").hidden = true; $(".pagination").hidden = true;
      $("#tracked-toggle").setAttribute("aria-pressed", "true");
      $("#app-subtitle").textContent = "이 브라우저에 저장한 사업의 진행 상태와 개찰결과입니다.";
      document.querySelectorAll(".mode-toggle-btn").forEach(button => {
        button.classList.remove("active"); button.parentElement.classList.remove("active"); button.setAttribute("aria-pressed", "false");
      });
      render(); closeRail(); return refresh();
    }
    function leave() {
      if (!active) return;
      active = false;
      $("#tracked-view").hidden = true; $(".table-scroll").hidden = false; $(".pagination").hidden = false;
      $("#tracked-toggle").setAttribute("aria-pressed", "false");
      $("#results-heading").textContent = "조회 결과";
      $("#result-summary").textContent = `${model.filtered.length}건`;
      $("#app-subtitle").textContent = modeSubtitles[model.viewMode];
      document.querySelectorAll(".mode-toggle-btn").forEach(button => {
        const selected = button.dataset.mode === model.viewMode;
        button.classList.toggle("active", selected); button.parentElement.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected));
      });
    }
    $("#tracked-toggle").onclick = show;
    $("#tracked-refresh").onclick = () => refresh({ all: true });
    $("#modal-track-btn").onclick = () => toggle(model.currentRow);
    $("#results").addEventListener("click", event => {
      const button = event.target.closest("[data-track-index]");
      if (button) toggle(visibleRows[Number(button.dataset.trackIndex)]);
    });
    $("#tracked-list").onclick = event => {
      const remove = event.target.closest("[data-untrack-id]"), detail = event.target.closest("[data-tracked-id]");
      if (remove) {
        try { tracked.remove(remove.dataset.untrackId); expanded.delete(remove.dataset.untrackId); render(); }
        catch { report("관심사업을 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인하세요."); }
      } else if (detail) {
        const id = detail.dataset.trackedId;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
        [...$("#tracked-list").querySelectorAll("[data-tracked-id]")].find(button => button.dataset.trackedId === id)?.focus();
      }
    };
    sync();
    return { isActive: () => active, rowButton, syncRows(rows) { visibleRows = rows; sync(); }, modalOpened, show, leave, refresh, toggle };
  }
  const api = { createTrackedUi };
  scope.GongTrackedUi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self === "undefined" ? globalThis : self);
