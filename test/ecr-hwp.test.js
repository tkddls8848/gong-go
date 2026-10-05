const test = require("node:test");
const assert = require("node:assert/strict");
const { createEcr } = require("../public/ecr-ui.js");
function setup() {
  const nodes = new Map(), requests = []; let finish, cancelCount = 0;
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { files: [{ name: "rfp.hwp", size: 12 }] }); return nodes.get(id); };
  const model = { currentRow: { mode: "bid" } }, state = { aiUnlocked: true, ecrRun: 0 };
  const ui = createEcr({ model, state, $, numberOf: () => "notice", converter: { convert: () => new Promise((r) => { finish = r; }), cancel: () => cancelCount++ }, GongHttp: { async requestJson(url, options) { requests.push({ url, ...options }); return { response: { ok: true }, data: { total: 0 } }; } } });
  return { $, model, state, ui, requests, finish: (size = 10) => finish({ name: "rfp.pdf", blob: new Blob([new Uint8Array(size)], { type: "application/pdf" }) }), cancelled: () => cancelCount, start: () => ui.startEcrAnalysis({ preventDefault() {} }) };
}
test("HWP 원본은 전송하지 않고 변환된 PDF 이름·바이트만 업로드한다", async () => {
  const s = setup(), run = s.start(); assert.equal(s.requests.length, 0);
  s.finish(); await run; assert.equal(s.requests.length, 1);
  assert.match(s.requests[0].url, /name=rfp.pdf/); assert.equal(s.requests[0].body.type, "application/pdf");
});
for (const reason of ["stop", "row", "lock", "size"]) test(`변환 중 ${reason}이면 분석 요청을 보내지 않는다`, async () => {
  const s = setup(), run = s.start();
  if (reason === "stop") { s.ui.stopEcrAnalysis(); assert.equal(s.cancelled(), 1); }
  if (reason === "row") s.model.currentRow = { mode: "bid" };
  if (reason === "lock") s.state.aiUnlocked = false;
  s.finish(reason === "size" ? 8 * 1024 * 1024 + 1 : 10); await run;
  assert.equal(s.requests.length, 0); assert.equal(s.state.ecrBusy, false);
  if (reason === "size") assert.match(s.$("#ecr-progress").textContent, /8MB/);
});
