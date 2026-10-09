// 공고 첨부에서 분석할 파일 고르기와 브라우저 직접 다운로드.
// 나라장터 첨부 다운로드는 Access-Control-Allow-Origin: *로 응답하므로 브라우저가 바로 받는다.
// Worker가 대신 받지 않는다 — 임의 URL을 받아 주는 중계는 공개 프록시가 된다.
(function (scope) {
  "use strict";
  const ANALYZABLE = /\.(pdf|hwpx?|md|txt)$/i;
  // HWP 변환기 상한(32MB)과 같다. 변환하지 않는 파일은 업로드 단계가 8MB로 다시 막는다.
  const MAX_BYTES = 32 * 1024 * 1024;
  const TIMEOUT_MS = 60000;
  // 파일명으로 제안요청서를 앞에 둔다. 공고문·서식·청렴서약서에는 장비 규격 표가 없다.
  const RANK = [
    [/제안\s*요청서|RFP/i, 40],
    [/과업\s*(?:지시|내용)서|요구\s*사항|규격서|사양서|시방서/, 30],
    [/붙임|별첨|첨부/, 5],
    [/공고문|공고서|서식|서약|확약|계약\s*(?:일반|특수)?\s*조건|입찰\s*유의서|평가\s*기준/, -30],
  ];
  // 나라장터가 "제안요청정보"로 따로 받은 첨부는 문서 구분이 붙어 온다. 기관이 제안요청서라고
  // 직접 지정한 것이라 파일명보다 확실하다 — 이름에 "제안요청서"가 없어도 맨 앞에 둔다.
  const KIND = { 제안요청서: 45 };
  // 같은 문서의 PDF가 함께 올라오면 그쪽을 먼저 쓴다. 브라우저 HWP 변환은 표 배치가 달라질 수 있다.
  const FORMAT = { pdf: 3, hwpx: 2, hwp: 1, md: 0, txt: 0 };
  const SIGNATURE = {
    pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
    hwp: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    hwpx: [[0x50, 0x4b, 0x03, 0x04]],
  };
  const extensionOf = (name) => (String(name).match(ANALYZABLE) || [])[1]?.toLowerCase() || "";
  // 공공데이터 API가 내려 준 나라장터 주소만 받는다. 다른 호스트는 새 창으로 열기만 한다.
  function allowed(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && (parsed.hostname === "g2b.go.kr" || parsed.hostname.endsWith(".g2b.go.kr"));
    } catch { return false; }
  }
  function createAttachmentSource({
    fetch = (...args) => scope.fetch(...args),
    setTimeout = (...args) => scope.setTimeout(...args),
    clearTimeout = (...args) => scope.clearTimeout(...args),
    File = scope.File
  } = {}) {
    // 분석 가능한 첨부를 점수순으로. 점수가 같으면 공고의 첨부 순서를 지킨다.
    function candidates(files) {
      return (Array.isArray(files) ? files : [])
        .map((file, index) => ({ ...file, index, extension: extensionOf(file?.name) }))
        .filter((file) => file.extension && typeof file.url === "string" && allowed(file.url))
        .map((file) => ({ ...file, score: RANK.reduce((sum, [pattern, value]) => sum + (pattern.test(file.name) ? value : 0), 0) + (file.source ? KIND[file.kind] || 0 : 0) + FORMAT[file.extension] }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
    }
    async function download(file, { signal } = {}) {
      if (!allowed(file?.url)) throw new Error("나라장터 첨부 주소가 아니어서 직접 받을 수 없습니다. 파일을 내려받아 올려 주세요.");
      const controller = new AbortController();
      const forward = () => controller.abort();
      if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", forward, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      try {
        let response;
        try { response = await fetch(file.url, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal }); }
        catch (error) {
          if (signal?.aborted) throw error;
          throw new Error(timedOut ? "나라장터 첨부 응답이 늦어 중단했습니다. 잠시 후 다시 시도하거나 파일을 내려받아 올려 주세요." : "나라장터에서 첨부를 받지 못했습니다. 파일을 내려받아 올려 주세요.");
        }
        if (!response.ok) throw new Error(`나라장터가 첨부를 내주지 않았습니다 (HTTP ${response.status}). 파일을 내려받아 올려 주세요.`);
        if (/^text\/html\b/i.test(response.headers.get("content-type") || "")) throw new Error("나라장터가 파일 대신 안내 화면을 돌려주었습니다. 파일을 내려받아 올려 주세요.");
        if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("첨부가 32MB를 넘어 브라우저에서 처리하지 않습니다. 문서를 나누어 올려 주세요.");
        let buffer;
        try { buffer = await response.arrayBuffer(); }
        catch (error) {
          if (signal?.aborted) throw error;
          throw new Error(timedOut ? "나라장터 첨부 응답이 늦어 중단했습니다. 잠시 후 다시 시도하거나 파일을 내려받아 올려 주세요." : "나라장터 첨부를 끝까지 받지 못했습니다. 다시 시도해 주세요.");
        }
        if (!buffer.byteLength) throw new Error("나라장터 첨부가 비어 있습니다. 원문을 확인해 주세요.");
        if (buffer.byteLength > MAX_BYTES) throw new Error("첨부가 32MB를 넘어 브라우저에서 처리하지 않습니다. 문서를 나누어 올려 주세요.");
        // 이름은 PDF인데 내용이 다른 파일이면 변환·분석이 엉뚱한 오류를 낸다. 머리 바이트로 먼저 거른다.
        const extension = extensionOf(file.name), head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
        const signatures = SIGNATURE[extension];
        if (signatures && !signatures.some((bytes) => bytes.every((byte, index) => head[index] === byte))) throw new Error("첨부 내용이 파일 이름의 형식과 다릅니다. 나라장터에서 내려받아 확인해 주세요.");
        return new File([buffer], file.name, { type: extension === "pdf" ? "application/pdf" : "" });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forward);
      }
    }
    return { candidates, download };
  }
  const api = { createAttachmentSource };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongEcrAttachments = api;
})(typeof self === "undefined" ? globalThis : self);
