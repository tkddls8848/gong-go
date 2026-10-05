(function (scope) {
  "use strict";
  function createConversionUi({ $, converter, urls = URL } = {}) {
    let resultUrl = null;
    function clearResult() {
      if (resultUrl) urls.revokeObjectURL(resultUrl);
      resultUrl = null;
      $("#pdf-download").hidden = true;
      $("#pdf-download").removeAttribute("href");
    }
    async function start(event) {
      event.preventDefault();
      const file = $("#convert-file").files[0];
      if (!file || $("#convert-start").disabled) return;
      clearResult();
      $("#convert-start").disabled = true;
      $("#convert-file").disabled = true;
      $("#convert-cancel").hidden = false;
      try {
        const result = await converter.convert(file, { onProgress: (message) => { $("#convert-status").textContent = message; } });
        resultUrl = urls.createObjectURL(result.blob);
        const link = $("#pdf-download");
        link.href = resultUrl; link.download = result.name; link.hidden = false;
        $("#convert-status").textContent = `${result.name} · ${result.pages}페이지 · ${(result.blob.size / 1024 / 1024).toFixed(2)}MB · ${(result.elapsedMs / 1000).toFixed(1)}초. PDF를 내려받아 표와 페이지를 확인해 주세요.`;
      } catch (error) { $("#convert-status").textContent = error.message; }
      finally {
        $("#convert-start").disabled = false;
        $("#convert-file").disabled = false;
        $("#convert-cancel").hidden = true;
      }
    }
    return { start, cancel: converter.cancel, clearResult, dispose() { converter.cancel(); clearResult(); } };
  }
  const api = { createConversionUi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongConvertUi = api;
})(typeof self === "undefined" ? globalThis : self);
