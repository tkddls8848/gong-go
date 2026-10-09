const test = require("node:test");
const assert = require("node:assert/strict");
const { createAttachmentSource } = require("../public/ecr-attachments.js");

const g2b = (seq) => `https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK1&bidPbancOrd=000&fileType=&fileSeq=${seq}&prcmBsneSeCd=03`;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const HWP = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
function source(respond) {
  const calls = [];
  const api = createAttachmentSource({
    fetch: async (url, options) => { calls.push({ url, options }); return respond(url, options); },
    setTimeout: () => 0, clearTimeout() {},
  });
  return { api, calls };
}
const reply = (bytes, headers = {}, status = 200) => ({ ok: status < 400, status, headers: new Headers(headers), arrayBuffer: async () => bytes.buffer.slice(0) });

test("제안요청서를 앞에 두고 같은 문서는 PDF를 HWP보다 먼저 고른다", () => {
  const { api } = source();
  const names = api.candidates([
    { name: "입찰공고문.hwp", url: g2b(1) },
    { name: "제안요청서_20260922.hwp", url: g2b(2) },
    { name: "입찰공고문.pdf", url: g2b(3) },
    { name: "제안요청서_20260922.pdf", url: g2b(4) },
    { name: "붙임문서.zip", url: g2b(5) },
    { name: "과업지시서.hwpx", url: g2b(6) },
  ]).map((file) => file.name);
  assert.deepEqual(names, ["제안요청서_20260922.pdf", "제안요청서_20260922.hwp", "과업지시서.hwpx", "입찰공고문.pdf", "입찰공고문.hwp"], "ZIP은 분석 대상이 아니다");
});

test("제안요청정보로 올린 제안요청서는 이름에 표시가 없어도 공고 첨부보다 앞에 둔다", () => {
  const { api } = source();
  const rfp = (seq) => `https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadRfpFile.do?rfpNo=R26DH1&rfpOrd=000&rfpUntyAtchFileNo=${seq}`;
  const names = api.candidates([
    { name: "제안요청서.pdf", url: g2b(1) },
    { name: "과업지시서.hwp", url: rfp(5), source: "제안요청정보", kind: "기타문서" },
    { name: "2026 통합유지관리 사업.hwp", url: rfp(6), source: "제안요청정보", kind: "제안요청서" },
  ]).map((file) => file.name);
  assert.deepEqual(names, ["2026 통합유지관리 사업.hwp", "제안요청서.pdf", "과업지시서.hwp"]);
  // 문서 구분은 제안요청정보 출처에서만 믿는다.
  const forged = api.candidates([{ name: "공고문.pdf", url: g2b(1), kind: "제안요청서" }, { name: "과업지시서.pdf", url: g2b(2) }]).map((file) => file.name);
  assert.deepEqual(forged, ["과업지시서.pdf", "공고문.pdf"]);
});

test("나라장터가 아닌 주소와 http 주소는 직접 받지 않는다", async () => {
  const { api, calls } = source();
  assert.deepEqual(api.candidates([{ name: "제안요청서.pdf", url: "https://example.com/rfp.pdf" }, { name: "제안요청서.pdf", url: "http://www.g2b.go.kr/x" }, { name: "제안요청서.pdf", url: "https://g2b.go.kr.evil.example/x" }]), []);
  await assert.rejects(api.download({ name: "제안요청서.pdf", url: "https://example.com/rfp.pdf" }), /나라장터 첨부 주소가 아니어서/);
  assert.equal(calls.length, 0);
});

test("쿠키·리퍼러 없이 받아 이름과 형식을 지킨 파일로 돌려준다", async () => {
  const { api, calls } = source(() => reply(PDF, { "content-type": "application/octet-stream" }));
  const file = await api.download({ name: "제안요청서.pdf", url: g2b(1) });
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  assert.equal(file.name, "제안요청서.pdf");
  assert.equal(file.type, "application/pdf");
  assert.equal(file.size, PDF.length);
});

test("안내 화면·오류 상태·빈 응답·형식이 다른 내용은 파일로 넘기지 않는다", async () => {
  const cases = [
    [reply(PDF, { "content-type": "text/html; charset=utf-8" }), /안내 화면/],
    [reply(PDF, {}, 404), /HTTP 404/],
    [reply(new Uint8Array(0)), /비어 있습니다/],
    [reply(HWP), /형식과 다릅니다/],
    [reply(PDF, { "content-length": String(33 * 1024 * 1024) }), /32MB/],
  ];
  for (const [response, message] of cases) {
    const { api } = source(() => response);
    await assert.rejects(api.download({ name: "제안요청서.pdf", url: g2b(1) }), message);
  }
  const { api } = source(() => reply(HWP));
  assert.equal((await api.download({ name: "제안요청서.hwp", url: g2b(2) })).name, "제안요청서.hwp");
});

test("호출자가 중지하면 원래 중단 오류를 그대로 돌려준다", async () => {
  const controller = new AbortController();
  const { api } = source((url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
  const pending = api.download({ name: "제안요청서.pdf", url: g2b(1) }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("응답이 늦으면 시간 제한으로 끊고 직접 올리라고 안내한다", async () => {
  let fire;
  const api = createAttachmentSource({
    fetch: (url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    setTimeout: (callback) => { fire = callback; return 1; }, clearTimeout() {},
  });
  const pending = api.download({ name: "제안요청서.pdf", url: g2b(1) });
  fire();
  await assert.rejects(pending, /응답이 늦어/);
});
