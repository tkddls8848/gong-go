/* rhwptopdf v0.2.2 (Rust/WASM). 라이선스: vendor/hwp-v0.2.2/NOTICE.txt */
"use strict";
const BASE = "/vendor/hwp-v0.2.2/";
const progress = (message) => self.postMessage({ type: "progress", message });
self.onmessage = async ({ data }) => {
  const start = performance.now();
  try {
    const bytes = new Uint8Array(data.buffer);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("파일 크기 제한은 32MB입니다.");
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
    if (!ole && !zip) throw new Error("HWP 5 또는 HWPX 형식이 아닙니다. 암호·배포용 문서는 한글에서 일반 문서로 저장해 주세요.");
    progress("변환 엔진과 한글 글꼴을 준비하고 있습니다. 첫 실행은 다운로드 시간이 필요합니다.");
    importScripts(BASE + "rhwptopdf.umd.js");
    const load = async (name) => {
      const response = await fetch(BASE + name);
      if (!response.ok) throw new Error("변환 파일을 받지 못했습니다. 로그인 상태와 연결을 확인해 주세요.");
      return new Uint8Array(await response.arrayBuffer());
    };
    const [wasm, gothic, myeongjo] = await Promise.all([
      load("rhwptopdf.umd_bg.wasm"), load("NanumGothic-Regular.ttf"), load("NanumMyeongjo-Regular.ttf")
    ]);
    await RhwpToPdf({ module_or_path: wasm });
    RhwpToPdf.registerPdfFont(gothic);
    RhwpToPdf.registerPdfFont(myeongjo);
    progress("문서 구조와 페이지를 확인하고 있습니다.");
    const info = RhwpToPdf.analyzeHwp(bytes);
    let pages;
    try { pages = info.pageCount; } finally { info.free(); }
    if (!pages || pages > 400) throw new Error("1~400페이지 문서를 지원합니다. 문서를 나누어 다시 시도해 주세요.");
    progress(`${pages}페이지를 PDF로 변환하고 있습니다.`);
    const pdf = RhwpToPdf.hwpToPdf(bytes);
    if (pdf.byteLength > 64 * 1024 * 1024) throw new Error("생성된 PDF가 64MB를 초과했습니다. 문서를 나누어 주세요.");
    self.postMessage({ type: "done", pdf: pdf.buffer, pages, elapsedMs: Math.round(performance.now() - start) }, [pdf.buffer]);
  } catch (error) {
    // 엔진 오류가 문서 내용을 포함할 수 있으므로 알려진 사용자 안내만 노출한다.
    const message = /^(파일 크기|HWP 5|변환 파일|1~400|생성된 PDF)/.test(error.message || "")
      ? error.message : "문서를 변환하지 못했습니다. 손상·암호 설정 또는 지원하지 않는 한글 기능을 확인해 주세요.";
    self.postMessage({ type: "error", message });
  }
};
