// 파일 분석 진행·중단, 공고 첨부에서 바로 분석, 누락 번호 재분석과 이번 분석 결과 표시.
(function (scope) {
  "use strict";
  const LIMIT = 8 * 1024 * 1024;
  function createEcr({
    model, state = { ecrBusy: false, aiUnlocked: false, ecrRun: 0 },
    $, numberOf, renderEcr, showAiAccess,
    GongHttp = scope.GongHttp, EquipmentSummary = scope.EquipmentSummary,
    EcrRetry = scope.GongEcrRetry, html = scope.GongFormat?.html,
    converter = null, attachments = null
  } = {}) {
    // 재분석에 다시 보낼 업로드 본문. 서버는 끝난 작업을 지우므로 이 화면이 가진 사본이 유일하다.
    // 공고를 바꾸면 쓰지 않는다(row 비교). HWP는 변환한 PDF를 들고 있어 다시 변환하지 않는다.
    let lastUpload = null, sourcesFor = null, sourceList = [], download = null;
    function renderSources() {
      const row = model.currentRow, select = $("#ecr-attachment");
      if (!select || !row || sourcesFor === row) return;
      sourcesFor = row;
      sourceList = attachments ? attachments.candidates(row.files) : [];
      const options = sourceList.map((file, index) => `<option value="${index}">${html(file.name)}</option>`);
      select.innerHTML = `${options.join("")}<option value="">내 PC의 파일을 직접 선택</option>`;
      select.value = sourceList.length ? "0" : "";
      $("#ecr-source-hint").textContent = sourceList.length
        ? "분석 가능한 첨부를 제안요청서 순으로 정렬했습니다. 파일을 직접 고르면 그 파일을 먼저 씁니다."
        : "이 공고에는 바로 분석할 수 있는 첨부(PDF·HWP·HWPX)가 없습니다. 파일을 직접 선택하세요.";
    }
    function renderRetry() {
      const button = $("#ecr-retry-btn");
      if (!button) return;
      const plan = model.currentAnalysis && lastUpload?.row === model.currentRow ? EcrRetry?.retryPlan(model.currentAnalysis) : null;
      button.hidden = !plan;
      button.disabled = !plan || state.ecrBusy || !state.aiUnlocked;
      if (plan) button.textContent = `누락 번호 다시 분석 (${plan.focus.length}개)`;
    }
    function showAnalysis(data) {
      model.currentAnalysis = data;
      $("#download-ecr-btn").disabled = false;
      $("#ecr-tab").textContent = `ECR 규격 (${data.ecr.length})`;
      renderEcr(data);
      $("#ecr-content").insertAdjacentHTML("afterbegin", EquipmentSummary.render(data));
      renderRetry();
    }
    // 분석 결과는 서버에 저장하지 않는다. 이번 분석 응답만 화면에 보여 준다.
    function loadEcr() {
      if (!model.currentRow) return;
      renderSources();
      renderRetry();
      if (!model.currentAnalysis) {
        $("#ecr-content").innerHTML = '<p class="hint">공고 첨부를 고르거나 제안요청서 파일을 올려 서버·스토리지 요구사항을 분석하세요.</p>';
        return;
      }
      renderEcr(model.currentAnalysis);
      $("#ecr-content").insertAdjacentHTML("afterbegin", EquipmentSummary.render(model.currentAnalysis));
    }
    function stopEcrAnalysis() {
      state.ecrRun++;
      converter?.cancel();
      download?.abort();
      if (!state.ecrBusy) return;
      $("#ecr-stop-btn").disabled = true;
      $("#ecr-progress").textContent = "추가 분석을 중지했습니다. 이미 전송한 요청은 완료될 수 있으며 사용량이 발생할 수 있습니다. 요청 종료 후 같은 파일로 다시 시작하면 완료된 구간을 재사용합니다.";
    }
    function begin() {
      state.ecrBusy = true;
      $("#ecr-stop-btn").hidden = false;
      $("#ecr-stop-btn").disabled = false;
      $("#ecr-file").disabled = true;
      $("#ecr-analyze-btn").disabled = true;
      if ($("#ecr-attachment")) $("#ecr-attachment").disabled = true;
      renderRetry();
    }
    function finish() {
      state.ecrBusy = false;
      download = null;
      $("#ecr-stop-btn").hidden = true;
      $("#ecr-analyze-btn").disabled = !state.aiUnlocked;
      $("#ecr-file").disabled = !state.aiUnlocked;
      if ($("#ecr-attachment")) $("#ecr-attachment").disabled = !state.aiUnlocked;
      renderRetry();
    }
    // 업로드 한 번과 구간 요청들. 중지·공고 이동·잠금이면 null을 돌려준다.
    async function runJob(params, body, { row, run, progress, label, onStep }) {
      const live = () => model.currentRow === row && state.aiUnlocked && run === state.ecrRun;
      const send = async (query, payload) => {
        const { response, data } = await GongHttp.requestJson(`/api/ecr?${new URLSearchParams(query)}`, { method: "POST", body: payload });
        if (data.locked) showAiAccess(false, data.message);
        if (!response.ok) throw new Error(data.message || "분석 요청 실패");
        return data;
      };
      const job = await send(params, body);
      const order = job.order || Array.from({ length: job.total }, (_, index) => index);
      for (let position = 0; position < order.length; position++) {
        const index = order[position];
        // 다른 공고로 이동하면 추가 뉴런을 쓰지 않는다. 이미 완료된 구간은 서버에 남는다.
        if (!live()) return null;
        progress(`${label(job)} 중 · ${position + 1} / ${job.total} 구간`);
        const result = await send({ action: "step", id: job.id, index: String(index), finalize: position === order.length - 1 ? "1" : "0" });
        if (result.retry) {
          progress(result.message);
          // 다른 탭이 같은 구간을 처리하는 동안 R2를 연속 호출하지 않는다.
          const delay = Number(result.retryAfterMs);
          await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(500, Number.isFinite(delay) ? delay : 500))));
          position--; continue;
        }
        onStep(position + 1);
        if (result.analysis) return EquipmentSummary.validate(result.analysis);
      }
      return null;
    }
    // 고른 원본: 직접 고른 파일이 먼저, 없으면 고른 공고 첨부.
    function chosenSource() {
      const file = $("#ecr-file").files?.[0];
      if (file) return { file };
      const value = $("#ecr-attachment")?.value;
      const attachment = value !== undefined && value !== "" ? sourceList[Number(value)] : null;
      return attachment ? { attachment } : null;
    }
    async function startEcrAnalysis(event) {
      event.preventDefault();
      if (state.ecrBusy || !state.aiUnlocked) return;
      const row = model.currentRow, source = chosenSource();
      if (row?.mode !== "bid") return;
      if (!source) { $("#ecr-progress").textContent = "분석할 공고 첨부를 고르거나 파일을 선택하세요."; return; }
      const run = ++state.ecrRun;
      const progress = (message) => { if (model.currentRow === row && run === state.ecrRun) $("#ecr-progress").textContent = message; };
      const live = () => model.currentRow === row && state.aiUnlocked && run === state.ecrRun;
      if (source.file && !/\.hwpx?$/i.test(source.file.name) && source.file.size > LIMIT) { progress("파일은 8MB까지 지원합니다."); return; }
      begin();
      let completedParts = 0;
      try {
        let file = source.file;
        if (source.attachment) {
          progress(`나라장터에서 ${source.attachment.name} 파일을 받고 있습니다.`);
          download = new AbortController();
          file = await attachments.download(source.attachment, { signal: download.signal });
          if (!live()) return;
          if (!/\.hwpx?$/i.test(file.name) && file.size > LIMIT) throw new Error("첨부가 분석 제한(8MB)을 넘습니다. 나라장터에서 내려받아 문서를 나누어 올려 주세요.");
        }
        progress("문서를 변환하고 있습니다.");
        let upload = file, uploadName = file.name;
        if (/\.hwpx?$/i.test(file.name)) {
          if (!converter) throw new Error("한글 변환기를 불러오지 못했습니다. 화면을 새로고침해 주세요.");
          const result = await converter.convert(file, { onProgress: progress });
          if (!live()) return;
          upload = result.blob; uploadName = result.name;
          if (upload.size > LIMIT) throw new Error("변환된 PDF가 분석 제한(8MB)을 초과했습니다. PDF 변환 화면에서 내려받아 문서를 나누어 주세요.");
          progress("PDF 변환 완료. 장비 규격 분석을 요청합니다.");
        }
        const data = await runJob({ action: "upload", notice: numberOf(row), name: uploadName }, upload, {
          row, run, progress, onStep: (count) => { completedParts = count; },
          label: (job) => job.focused ? "ECR·장비 상세 표 분석" : "장비 요구사항 우선 분석",
        });
        if (data && model.currentRow === row && run === state.ecrRun) {
          lastUpload = { row, blob: upload, name: uploadName };
          showAnalysis(data);
          progress(EcrRetry?.retryPlan(data) ? "분석이 완료되었습니다. 규격을 찾지 못한 번호는 ‘누락 번호 다시 분석’으로 그 표만 다시 물을 수 있습니다." : "분석이 완료되었습니다. 근거와 원문을 확인하세요.");
        }
      } catch (error) { progress(`${error.message}${completedParts > 0 ? ` 완료된 ${completedParts}개 구간은 저장되었습니다. 같은 파일로 다시 시작할 수 있습니다.` : ""}`); }
      finally { finish(); }
    }
    // 누락 번호의 표만 대상 번호를 못박아 다시 묻는다. 끝나면 직전 결과에 합친다.
    async function retryMissing() {
      if (state.ecrBusy || !state.aiUnlocked) return;
      const row = model.currentRow, previous = model.currentAnalysis, upload = lastUpload;
      const plan = previous && upload?.row === row ? EcrRetry?.retryPlan(previous) : null;
      if (!plan) return;
      const run = ++state.ecrRun;
      const progress = (message) => { if (model.currentRow === row && run === state.ecrRun) $("#ecr-progress").textContent = message; };
      begin();
      try {
        progress(`규격을 찾지 못한 ${plan.focus.length}개 번호의 표를 다시 분석합니다.`);
        const params = { action: "upload", notice: numberOf(row), name: upload.name, focus: plan.focus.join(","), matched: plan.matched.join(","), unexpected: plan.unexpected.join(",") };
        const data = await runJob(params, upload.blob, { row, run, progress, onStep() {}, label: () => "누락 번호 재분석" });
        if (data && model.currentRow === row && run === state.ecrRun && model.currentAnalysis === previous) {
          const merged = EquipmentSummary.validate(EcrRetry.mergeRetry(previous, data, plan.focus));
          showAnalysis(merged);
          const found = data.retry?.recovered?.length || 0;
          progress(found ? `누락 번호 ${plan.focus.length}개 중 ${found}개의 규격을 찾아 합쳤습니다. 근거와 원문을 확인하세요.` : "다시 분석해도 규격을 찾지 못했습니다. 해당 번호는 원문을 직접 확인하세요.");
        }
      } catch (error) { progress(`${error.message} 직전 분석 결과는 그대로 둡니다.`); }
      finally { finish(); }
    }
    return { loadEcr, stopEcrAnalysis, startEcrAnalysis, retryMissing };
  }
  const api = { createEcr };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcr = api;
})(typeof self === "undefined" ? globalThis : self);
