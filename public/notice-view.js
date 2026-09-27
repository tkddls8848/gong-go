// 공고 링크·첨부·입찰 일정의 표시와 URL 검증.
(function (scope) {
  "use strict";
  function createNoticeView({
    html, numberOf, format, document = scope.document, openModal
  } = {}) {
    function modalSubtitle(row, files) {
      if (row.mode !== "plan") return `${row.institution || "-"} · ${row.businessType || "-"} · 번호 ${numberOf(row) || "-"} · 첨부 ${files.length}건`;
      const parts = [row.institution || "-", row.businessType || "-", `계획번호 ${numberOf(row) || "-"}`];
      if (row.orderMonth) parts.push(`발주예정 ${row.orderMonth}`);
      if (row.amount && Number(row.amount)) parts.push(`발주금액 ${format(Number(row.amount))}원`);
      if (row.contractMethod) parts.push(row.contractMethod);
      if (row.procureMethod) parts.push(row.procureMethod);
      return parts.join(" · ");
    }
    // 본공고와 발주계획은 나라장터 상세화면 링크를 API가 필드로 준다(bidNtceDtlUrl/orderPlanDtlUrl).
    // 사전규격정보서비스에는 그 필드가 없어 사전공고에서는 늘 빈 문자열이 된다.
    // 번호를 매기지 않는 이유: 본공고는 첨부 1..N과 한 목록에 서므로 "1."이 두 번 나온다.
    function detailLink(row) {
      if (!row.detailUrl) return "";
      const url = safeExternalUrl(row.detailUrl);
      if (!url) return '<li><span class="warning-text">상세 링크 형식이 올바르지 않아 비활성화했습니다.</span></li>';
      const label = row.mode === "plan" ? "나라장터 발주계획 상세 열기" : "나라장터 공고 상세 열기";
      return `<li><span class="file-no">&#8599;</span><a href="${html(url)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
    }
    function safeExternalUrl(value) {
      if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return "";
      const text = value.trim();
      if (!/^https?:\/\//i.test(text)) return "";
      try {
        const url = new URL(text);
        return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? text : "";
      } catch { return ""; }
    }
    function attachmentWarnings(files) {
      const rejected = Array.isArray(files) ? files.length - normalizeFiles(files).length : 0;
      return rejected ? `<li><span class="warning-text">사용할 수 없는 첨부 링크 ${rejected}건을 제외했습니다. 나라장터 원문에서 확인하세요.</span></li>` : "";
    }
    // 발주계획은 첨부 URL이 없으므로 이어진 공고번호와 첨부 유무만 덧붙인다(상세 링크는 detailLink가 그린다).
    function planLinks(row) {
      const items = [];
      const notices = String(row.linkedNotices || "").split(/[,\s]+/).filter(Boolean);
      if (notices.length) items.push(`<li><span class="empty-msg">연계 공고번호: ${notices.map(html).join(", ")}</span></li>`);
      items.push(`<li><span class="empty-msg">${row.hasAttachment ? "첨부파일이 있지만 API로는 제공되지 않습니다. 상세 페이지에서 받으세요." : "이 계획에는 첨부파일이 없습니다."}</span></li>`);
      return items.join("");
    }
    // 발주계획 API는 첨부파일 URL을 주지 않고 "첨부가 있는지"(atchFileExistnceYn)만 알려준다.
    // 실제 파일은 상세 페이지에서 받아야 하므로 건수 대신 유무를 표시한다.
    function fileBadge(row, files) {
      if (row.mode === "plan") return `<span class="file-badge ${row.hasAttachment ? "" : "empty"}">${row.hasAttachment ? "첨부 있음" : "첨부 없음"}</span>`;
      return `<span class="file-badge ${files.length ? "" : "empty"}">${files.length ? `첨부 ${files.length}` : "첨부 0"}</span>`;
    }
    function scheduleItems(row) {
      const schedule = row.bidSchedule || {};
      return [
        ["공고 게시", schedule.bidNtceDt],
        ["입찰참가자격 등록 마감", schedule.bidQlfctRgstDt],
        ["공동수급협정 마감", schedule.cmmnSpldmdAgrmntClseDt],
        ["입찰서 제출 시작", schedule.bidBeginDt],
        ["입찰서 제출 마감", schedule.bidClseDt || row.closeAt],
        ["개찰 예정", schedule.opengDt],
      ].filter((item) => item[1]);
    }
    function renderBidSchedule(row) {
      const items = scheduleItems(row);
      if (!items.length) return '<p class="schedule-empty">저장된 입찰 일정이 없습니다. 다음 데이터 갱신부터 공공 API의 일정 정보가 함께 저장됩니다.</p>';
      return `<ol class="schedule-list">${items.map(([label, value]) => `<li class="schedule-item"><span class="schedule-dot" aria-hidden="true"></span><span class="schedule-label">${html(label)}</span><time class="schedule-time">${html(value)}</time></li>`).join("")}</ol><p class="schedule-note">개찰 예정은 실제 개찰 처리 시각이 아니라 개찰을 시작할 수 있는 최초 시각입니다.</p>`;
    }
    function normalizeFiles(files) { return Array.isArray(files) ? files.filter((file) => file && typeof file === "object" && safeExternalUrl(file.url)).map((file) => ({ ...file, name: typeof file.name === "string" ? file.name : "첨부파일", url: safeExternalUrl(file.url) })) : []; }
    function wireEcrEntrypoints(rows) {
      document.querySelectorAll(".title-link").forEach((title) => {
        const row = rows[Number(title.dataset.index)];
        if (row?.mode !== "bid") return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ecr-entry-btn";
        button.textContent = "ECR 분석";
        button.setAttribute("aria-label", `${row.title || "이 공고"} ECR 분석 열기`);
        button.onclick = () => openModal(row, "ecr");
        title.parentElement.append(button);
      });
    }
    return { modalSubtitle, detailLink, safeExternalUrl, attachmentWarnings, planLinks, fileBadge, scheduleItems, renderBidSchedule, normalizeFiles, wireEcrEntrypoints };
  }
  const api = { createNoticeView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongNoticeView = api;
})(typeof self === "undefined" ? globalThis : self);
