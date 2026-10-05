(function (scope) {
  "use strict";
  function numberOf(row) { return row.announcementNumber || ""; }
  // rows.js의 dateKey와 같은 규칙이다. 로드 순서에 기대는 전역 조회 대신 직접 둔다.
  function dateKey(value) { return String(value || "").replace(/\D/g, "").slice(0, 8); }
  function dateFormat(value) { const v = dateKey(value); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "-"; }
  function format(value) { return new Intl.NumberFormat("ko-KR").format(value); }
  function localDate(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
  // 0과 false도 값이므로 지우지 않는다. null·undefined만 빈 문자열이다.
  function html(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  const api = { numberOf, dateKey, dateFormat, format, localDate, html };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongFormat = api;
})(typeof self === "undefined" ? globalThis : self);
