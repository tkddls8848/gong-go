// 브라우저 전용 변환기. 문서 바이트는 네트워크로 보내지 않고 Worker로 이전한다.
(function (scope) {
  "use strict";
  const MAX_INPUT = 32 * 1024 * 1024;
  const MAX_OUTPUT = 64 * 1024 * 1024;
  const isHwp = (file) => /\.hwpx?$/i.test(file?.name || "");
  function createConverter({
    workerFactory = () => new scope.Worker("/hwp-worker.js"),
    setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 90000,
    makeBlob = (bytes) => new Blob([bytes], { type: "application/pdf" })
  } = {}) {
    let active = null;
    function cancel() {
      active?.finish(new Error("변환을 취소했습니다."));
    }
    function convert(file, { onProgress = () => {} } = {}) {
      if (active) return Promise.reject(new Error("이미 변환 중입니다."));
      if (!isHwp(file)) return Promise.reject(new Error("HWP 또는 HWPX 파일을 선택해 주세요."));
      if (!file.size || file.size > MAX_INPUT) return Promise.reject(new Error("변환할 파일은 0바이트보다 크고 32MB 이하여야 합니다."));
      return new Promise((resolve, reject) => {
        let worker, timer;
        const job = { finish(error, result) {
          if (active !== job) return;
          active = null;
          clearTimer(timer);
          worker?.terminate(); // 문서·폰트·WASM 메모리를 작업마다 반환한다.
          if (error) reject(error); else resolve(result);
        } };
        active = job;
        timer = setTimer(() => job.finish(new Error("변환 제한 시간(90초)을 초과했습니다. 작은 문서로 나누어 다시 시도해 주세요.")), timeoutMs);
        try {
          worker = workerFactory();
          worker.onerror = (event) => { event.preventDefault?.(); job.finish(new Error("변환 엔진을 실행하지 못했습니다. 브라우저를 업데이트하거나 다시 시도해 주세요.")); };
          worker.onmessageerror = () => job.finish(new Error("변환 결과를 받지 못했습니다."));
          worker.onmessage = ({ data }) => {
            if (active !== job) return;
            try {
              if (data.type === "progress") onProgress(data.message);
              else if (data.type === "error") job.finish(new Error(data.message));
              else if (data.type === "done") {
                const bytes = new Uint8Array(data.pdf);
                if (bytes.length < 5 || bytes.length > MAX_OUTPUT || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new Error("유효한 PDF가 생성되지 않았습니다.");
                job.finish(null, { blob: makeBlob(bytes), name: file.name.replace(/\.hwpx?$/i, ".pdf"), pages: data.pages, elapsedMs: data.elapsedMs });
              }
            } catch (error) { job.finish(error); }
          };
          onProgress("파일을 읽고 있습니다.");
          file.arrayBuffer().then((buffer) => {
            if (active === job) worker.postMessage({ buffer }, [buffer]);
          }).catch((error) => job.finish(error));
        } catch (error) { job.finish(error); }
      });
    }
    return { convert, cancel };
  }
  const api = { createConverter, isHwp, MAX_INPUT, MAX_OUTPUT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongHwp = api;
})(typeof self === "undefined" ? globalThis : self);
