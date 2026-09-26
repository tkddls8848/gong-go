// 공고·업로드 문서의 외부 문자열은 스프레드시트 수식으로 실행하지 않는다.
(function (scope) {
  "use strict";
  function cell(value) {
    let text = String(value ?? "");
    // 공백/제어문자 뒤의 수식 시작 문자도 보호한다. 원본 데이터는 바꾸지 않는다.
    if (/^[\s\u0000-\u001f]*[=+@\-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }
  scope.GongCsv = { cell, serialize: (rows) => rows.map((row) => row.map(cell).join(",")).join("\r\n") };
})(typeof self === "undefined" ? globalThis : self);
