// AI 잠금 조회·해제·재잠금과 지연 응답 무효화.
(function (scope) {
  "use strict";
  function createAiAccess({
    $, state = { ecrBusy: false, aiUnlocked: false }, GongHttp = scope.GongHttp
  } = {}) {
    let aiAccessRevision = 0, aiAccessChanging = false;
    function setAiAccessChanging(changing) {
      aiAccessChanging = changing;
      $("#ai-unlock-form").querySelectorAll("input, button").forEach((control) => { control.disabled = changing; });
      $("#ai-lock-btn").disabled = changing;
    }
    function showAiAccess(unlocked, message) {
      aiAccessRevision++;
      state.aiUnlocked = unlocked;
      $("#ai-unlock-form").hidden = unlocked;
      $("#ai-lock-btn").hidden = !unlocked;
      $("#ai-lock-btn").textContent = "AI 분석 다시 잠그기";
      $("#ecr-file").disabled = !unlocked || state.ecrBusy;
      $("#ecr-analyze-btn").disabled = !unlocked || state.ecrBusy;
      $("#ai-access-status").textContent = message || (unlocked ? "AI 분석 잠금이 해제되었습니다. 30분 후 자동으로 잠깁니다." : "AI 분석이 잠겨 있습니다. 전용 비밀번호를 입력하세요.");
    }
    async function refreshAiAccess() {
      if (aiAccessChanging) return;
      showAiAccess(false, "분석 잠금 상태를 확인하고 있습니다.");
      const revision = aiAccessRevision;
      try {
        const { response, data } = await GongHttp.requestJson("/api/ai-access", { cache: "no-store" }, 30000, "access");
        if (!response.ok) throw new Error("잠금 상태 조회 실패");
        if (revision !== aiAccessRevision) return;
        showAiAccess(data.unlocked === true, !data.configured ? data.message || "AI 분석이 비활성화되어 있습니다. 운영자의 전용 비밀번호 설정이 필요합니다." : "");
      } catch { if (revision === aiAccessRevision) showAiAccess(false, "분석 잠금 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요."); }
    }
    async function unlockAiAccess(event) {
      event.preventDefault();
      if (aiAccessChanging) return;
      const password = $("#ai-password").value;
      $("#ai-password").value = "";
      setAiAccessChanging(true);
      showAiAccess(false, "AI 분석 잠금을 해제하고 있습니다.");
      const revision = aiAccessRevision;
      try {
        const { response, data } = await GongHttp.requestJson("/api/ai-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }, 30000, "access");
        if (revision !== aiAccessRevision) return;
        showAiAccess(response.ok && data.unlocked === true, data.message);
      } catch {
        if (revision === aiAccessRevision) {
          showAiAccess(false, "잠금 해제 응답을 확인하지 못했습니다. 추가 분석은 중지했습니다. 잠금 상태를 다시 확인하거나 서버 잠금을 시도하세요.");
          $("#ai-lock-btn").hidden = false;
          $("#ai-lock-btn").textContent = "서버 잠금 다시 시도";
        }
      }
      finally { setAiAccessChanging(false); }
    }
    async function lockAiAccess() {
      if (aiAccessChanging) return;
      setAiAccessChanging(true);
      showAiAccess(false, "AI 분석을 잠그고 있습니다. 진행 중인 요청 이후의 추가 분석은 중지됩니다.");
      const revision = aiAccessRevision;
      try {
        const { response, data } = await GongHttp.requestJson("/api/ai-access", { method: "DELETE" }, 30000, "access");
        if (!response.ok || data.unlocked !== false) throw new Error("lock");
        if (revision === aiAccessRevision) showAiAccess(false);
      } catch {
        if (revision === aiAccessRevision) {
          showAiAccess(false, "서버 잠금 요청에 실패했습니다. 추가 분석은 중지했습니다. 서버 잠금을 다시 시도하세요.");
          $("#ai-lock-btn").hidden = false;
          $("#ai-lock-btn").textContent = "서버 잠금 다시 시도";
        }
      }
      finally { setAiAccessChanging(false); }
    }
    return { showAiAccess, refreshAiAccess, unlockAiAccess, lockAiAccess };
  }
  const api = { createAiAccess };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongAiAccess = api;
})(typeof self === "undefined" ? globalThis : self);
