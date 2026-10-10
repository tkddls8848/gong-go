const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("./api");

test("수집 실행마다 인증·기간·동시 요청 한도를 유지하며 모든 페이지를 합친다", async (t) => {
  t.mock.method(console, "log", () => {});
  function client(name, concurrency, mode) {
    let active = 0, peak = 0;
    const calls = [];
    const api = createClient({
      DATA_GO_KR_SERVICE_KEY: name, API_BASE: "https://" + name + ".test", DATA_GO_KR_RELAY_TOKEN: "relay-" + name, concurrency,
      async fetch(value, options) {
        const url = new URL(value);
        assert.equal(url.hostname, name + ".test");
        assert.equal(url.searchParams.get("ServiceKey"), name);
        assert.equal(options.headers.Authorization, "Bearer relay-" + name);
        assert.ok(options.signal);
        if (mode === "plan") {
          assert.equal(url.searchParams.get("orderBgnYm"), "202609");
          assert.equal(url.searchParams.get("orderEndYm"), "202610");
        } else {
          assert.equal(url.searchParams.get("inqryBgnDt"), "202609010000");
          assert.equal(url.searchParams.get("inqryEndDt"), "202610022359");
        }
        const page = Number(url.searchParams.get("pageNo"));
        calls.push(page);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return Response.json({ response: { body: { items: [{ name, page }], numOfRows: 1, totalCount: 3 } } });
      },
    });
    return { run: () => api.fetchJob({ mode, type: "물품", range: { begin: "2026-09-01", end: "2026-10-02" } }), calls, peak: () => peak };
  }
  const serial = client("serial", 1, "bid"), parallel = client("parallel", 2, "plan");
  const results = await Promise.all([serial.run(), parallel.run()]);
  assert.equal(serial.peak(), 1);
  assert.equal(parallel.peak(), 2);
  for (const [index, name] of ["serial", "parallel"].entries()) {
    assert.deepEqual(results[index], [1, 2, 3].map((page) => ({ name, page })));
  }
  assert.deepEqual(serial.calls, [1, 2, 3]);
  assert.deepEqual(parallel.calls, [1, 2, 3]);
});
