(function (scope) {
  "use strict";
  function numberOf(row) { return row.announcementNumber || ""; }
  function dateKey(value) { return scope.GongRows.dateKey(value); }
  function dateFormat(value) { const v = dateKey(value); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "-"; }
  function format(value) { return new Intl.NumberFormat("ko-KR").format(value); }
  function localDate(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
  function html(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  const api = { numberOf, dateKey, dateFormat, format, localDate, html };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongFormat = api;
})(typeof self === "undefined" ? globalThis : self);
