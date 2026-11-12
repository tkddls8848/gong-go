const test = require("node:test");
const assert = require("node:assert/strict");
const { createConverter, MAX_INPUT } = require("../public/hwp-converter.js");
const pdf = () => new TextEncoder().encode("%PDF-1.7\nfixture").buffer;
const file = (name = "규격.hwpx") => ({ name, size: 10, arrayBuffer: async () => new ArrayBuffer(10) });
function setup(options = {}) {
  const workers = []; let expired, waited;
  const converter = createConverter({
    workerFactory: () => { const w = { postMessage(...args) { this.sent = args; }, terminate() { this.terminated = true; } }; workers.push(w); return w; },
    setTimer: (fn, ms) => { expired = fn; waited = ms; return 1; }, clearTimer() {}, ...options
  });
  return { converter, workers, expire: () => expired(), waited: () => waited };
}
test("크기·형식·중복 실행을 거부하고 제한 시간이 지나면 Worker를 종료한다", async () => {
  const { converter, workers, expire, waited } = setup();
  await assert.rejects(converter.convert(file("x.pdf")), /HWP/);
  await assert.rejects(converter.convert({ ...file(), size: MAX_INPUT + 1 }), /32MB/);
  assert.equal(workers.length, 0);
  const run = converter.convert(file());
  await assert.rejects(converter.convert(file()), /이미/);
  assert.equal(waited(), 5 * 60 * 1000, "기본 제한은 5분이다");
  const rejected = assert.rejects(run, /제한 시간\(5분\)/, "안내하는 시간이 실제 제한과 같다"); expire(); await rejected;
  assert.ok(workers[0].terminated);
});
