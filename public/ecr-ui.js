// 파일 분석 진행·중단과 이번 분석 결과 표시.
(function (scope) {
  "use strict";
  function createEcr({
    model, state = { ecrBusy: false, aiUnlocked: false, ecrRun: 0 },
    $, numberOf, renderEcr, showAiAccess,
    GongHttp = scope.GongHttp, EquipmentSummary = scope.EquipmentSummary
  } = {}) {
    // 분석 결과는 서버에 저장하지 않는다. 이번 분석 응답만 화면에 보여 준다.
    function loadEcr() {
      if (!model.currentRow) return;
      if (!model.currentAnalysis) {
        $("#ecr-content").innerHTML = '<p class="hint">제안요청서 파일을 올려 서버·스토리지 요구사항을 분석하세요.</p>';
        return;
      }
      renderEcr(model.currentAnalysis);
      $("#ecr-content").insertAdjacentHTML("afterbegin", EquipmentSummary.render(model.currentAnalysis));
    }
    function stopEcrAnalysis() {
      state.ecrRun++;
      if (!state.ecrBusy) return;
      $("#ecr-stop-btn").disabled = true;
      $("#ecr-progress").textContent = "추가 분석을 중지했습니다. 이미 전송한 요청은 완료될 수 있으며 사용량이 발생할 수 있습니다. 요청 종료 후 같은 파일로 다시 시작하면 완료된 구간을 재사용합니다.";
    }
    async function startEcrAnalysis(event) {
      event.preventDefault();
      if (state.ecrBusy || !state.aiUnlocked) return;
      const row = model.currentRow, file = $("#ecr-file").files[0];
      if (!file || row?.mode !== "bid") return;
      const run = ++state.ecrRun;
      const progress = (message) => { if (model.currentRow === row && run === state.ecrRun) $("#ecr-progress").textContent = message; };
      if (file.size > 8 * 1024 * 1024) { progress("파일은 8MB까지 지원합니다."); return; }
      state.ecrBusy = true;
      $("#ecr-stop-btn").hidden = false;
      $("#ecr-stop-btn").disabled = false;
      $("#ecr-file").disabled = true;
      $("#ecr-analyze-btn").disabled = true;
      let completedParts = 0;
      try {
        progress("문서를 변환하고 있습니다.");
        const send = async (params, body) => {
          const { response, data } = await GongHttp.requestJson(`/api/ecr?${new URLSearchParams(params)}`, { method: "POST", body });
          if (data.locked) showAiAccess(false, data.message);
          if (!response.ok) throw new Error(data.message || "분석 요청 실패");
          return data;
        };
        const job = await send({ action: "upload", notice: numberOf(row), name: file.name }, file);
        const order = job.order || Array.from({ length: job.total }, (_, index) => index);
        for (let position = 0; position < order.length; position++) {
          const index = order[position];
          // 다른 공고로 이동하면 추가 뉴런을 쓰지 않는다. 이미 완료된 구간은 서버에 남는다.
          if (model.currentRow !== row || !state.aiUnlocked || run !== state.ecrRun) break;
          progress(`${job.focused ? "ECR·장비 상세 표 분석" : "장비 요구사항 우선 분석"} 중 · ${position + 1} / ${job.total} 구간`);
          const result = await send({ action: "step", id: job.id, index: String(index), finalize: position === order.length - 1 ? "1" : "0" });
          if (result.retry) {
            progress(result.message);
            // 다른 탭이 같은 구간을 처리하는 동안 R2를 연속 호출하지 않는다.
            const delay = Number(result.retryAfterMs);
            await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(500, Number.isFinite(delay) ? delay : 500))));
            position--; continue;
          }
          completedParts = position + 1;
          if (result.analysis) {
            const data = result.analysis;
            EquipmentSummary.validate(data);
            if (model.currentRow === row && run === state.ecrRun) {
              model.currentAnalysis = data;
              $("#download-ecr-btn").disabled = false;
              $("#ecr-tab").textContent = `ECR 규격 (${data.ecr.length})`;
              renderEcr(data);
              $("#ecr-content").insertAdjacentHTML("afterbegin", EquipmentSummary.render(data));
              progress("분석이 완료되었습니다. 근거와 원문을 확인하세요.");
            }
          }
        }
      } catch (error) { progress(`${error.message}${completedParts > 0 ? ` 완료된 ${completedParts}개 구간은 저장되었습니다. 같은 파일로 다시 시작할 수 있습니다.` : ""}`); }
      finally { state.ecrBusy = false; $("#ecr-stop-btn").hidden = true; $("#ecr-analyze-btn").disabled = !state.aiUnlocked; $("#ecr-file").disabled = !state.aiUnlocked; }
    }
    return { loadEcr, stopEcrAnalysis, startEcrAnalysis };
  }
  const api = { createEcr };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcr = api;
})(typeof self === "undefined" ? globalThis : self);
