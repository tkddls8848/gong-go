const test = require("node:test");
const assert = require("node:assert/strict");
const { createConverter, MAX_INPUT } = require("../public/hwp-converter.js");
const { createConversionUi } = require("../public/convert-ui.js");
const flush = () => new Promise(setImmediate);
const pdf = () => new TextEncoder().encode("%PDF-1.7\nfixture").buffer;
const file = (name = "규격.hwpx") => ({ name, size: 10, arrayBuffer: async () => new ArrayBuffer(10) });
function setup(options = {}) {
  const workers = []; let expired;
  const converter = createConverter({
    workerFactory: () => { const w = { postMessage(...args) { this.sent = args; }, terminate() { this.terminated = true; } }; workers.push(w); return w; },
    setTimer: (fn) => { expired = fn; return 1; }, clearTimer() {}, ...options
  });
  return { converter, workers, expire: () => expired() };
}
test("엔진은 변환 시에만 생성하고 파일 버퍼를 복사 없이 전달한다", async () => {
  const { converter, workers } = setup(); assert.equal(workers.length, 0);
  const messages = [], run = converter.convert(file(), { onProgress: (m) => messages.push(m) });
  await flush(); const w = workers[0]; assert.equal(w.sent[0].buffer, w.sent[1][0]);
  w.onmessage({ data: { type: "progress", message: "페이지 변환" } });
  w.onmessage({ data: { type: "done", pdf: pdf(), pages: 2, elapsedMs: 5 } });
  const result = await run;
  assert.equal(result.name, "규격.pdf"); assert.equal(result.blob.type, "application/pdf");
  assert.equal(result.pages, 2); assert.ok(w.terminated); assert.ok(messages.includes("페이지 변환"));
});
test("취소는 파일 읽기 중에도 적용하며 이전 작업이 새 작업에 영향을 주지 않는다", async () => {
  const { converter, workers } = setup(); let read;
  const first = converter.convert({ ...file(), arrayBuffer: () => new Promise((r) => { read = r; }) });
  const rejected = assert.rejects(first, /취소/); converter.cancel(); await rejected;
  const second = converter.convert(file("second.HWP")); await flush();
  read(new ArrayBuffer(2)); await flush(); assert.equal(workers[0].sent, undefined);
  workers[0].onmessage({ data: { type: "done", pdf: pdf() } });
  workers[1].onmessage({ data: { type: "done", pdf: pdf() } });
  assert.equal((await second).name, "second.pdf");
});
test("크기·형식·중복 실행을 거부하고 제한 시간이 지나면 Worker를 종료한다", async () => {
  const { converter, workers, expire } = setup();
  await assert.rejects(converter.convert(file("x.pdf")), /HWP/);
  await assert.rejects(converter.convert({ ...file(), size: MAX_INPUT + 1 }), /32MB/);
  assert.equal(workers.length, 0);
  const run = converter.convert(file());
  await assert.rejects(converter.convert(file()), /이미/);
  const rejected = assert.rejects(run, /제한 시간/); expire(); await rejected;
  assert.ok(workers[0].terminated);
});
test("깨진 결과와 Worker 실패는 오류로 반환하고 재시작할 수 있다", async () => {
  const { converter, workers } = setup();
  const first = converter.convert(file()); const rejected = assert.rejects(first, /유효한 PDF/);
  workers[0].onmessage({ data: { type: "done", pdf: new ArrayBuffer(2) } }); await rejected;
  const second = converter.convert(file()); const failed = assert.rejects(second, /실행하지 못/);
  workers[1].onerror({ preventDefault() {} }); await failed;
  assert.ok(workers.every((w) => w.terminated));
});
test("변환 화면은 다운로드 URL을 교체·해제하며 실패 후 재시도를 허용한다", async () => {
  const nodes = new Map(); const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { files: [file()], removeAttribute(key) { delete this[key]; } }); return nodes.get(id); };
  const revoked = []; let count = 0, fail = false;
  const ui = createConversionUi({ $, converter: { cancel() {}, async convert() { if (fail) throw new Error("실패"); return { blob: { size: 1000 }, name: "규격.pdf", pages: 1, elapsedMs: 100 }; } }, urls: { createObjectURL: () => `blob:${++count}`, revokeObjectURL: (url) => revoked.push(url) } });
  const event = { preventDefault() {} }; await ui.start(event);
  assert.equal($("#pdf-download").download, "규격.pdf");
  await ui.start(event); assert.deepEqual(revoked, ["blob:1"]);
  fail = true; await ui.start(event); assert.equal($("#convert-start").disabled, false);
  assert.equal($("#pdf-download").hidden, true); assert.equal($("#convert-status").textContent, "실패");
  ui.dispose(); assert.deepEqual(revoked, ["blob:1", "blob:2"]);
});
