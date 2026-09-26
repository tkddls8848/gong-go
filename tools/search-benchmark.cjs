// 합성 데이터만 사용한다. 실제 검색 Worker의 gzip/CSV/필터/메시지 전송을 측정한다.
const { chromium } = require("playwright-core");
const { gzipSync } = require("node:zlib");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

async function main() {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
  try {
    for (const count of [10000, 100000, 250000]) {
      const csv = ["bidNtceNo,ntceKindNm,bidNtceNm,bidNtceDt,dminsttNm"];
      for (let i = 0; i < count; i++) csv.push(`TEST-${i},물품,${i % 2 ? "노트북" : '"서버 ""이중화"", 도입"'},2026-09-10 09:00:00,검증기관`);
      const body = gzipSync(csv.join("\r\n"));
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const unknown = [], errors = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== "http://search-benchmark.test") { unknown.push(url.href); return route.abort(); }
          if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local search benchmark</title>" });
          if (url.pathname === "/fixture.gz") return route.fulfill({ contentType: "application/gzip", body });
          if (["/rows.js", "/search-worker.js"].includes(url.pathname)) return route.fulfill({ contentType: "text/javascript", body: await fs.readFile(path.join(__dirname, "../public", url.pathname.slice(1))) });
          unknown.push(url.href); return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("http://search-benchmark.test/");
        const result = await page.evaluate((count) => new Promise((resolve, reject) => {
          const started = performance.now(), worker = new Worker("/search-worker.js");
          let scanned = 0, failures = 0, matched = 0, maxId = -1, maxBatchRows = 0, ticks = 0, maxGapMs = 0, lastTick = started;
          const ids = new Set();
          const heartbeat = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastTick); lastTick = now; ticks++; }, 16);
          const cleanup = () => { clearInterval(heartbeat); clearTimeout(deadline); worker.terminate(); };
          const deadline = setTimeout(() => { cleanup(); reject(new Error("Worker benchmark exceeded 60 seconds")); }, 60000);
          worker.onerror = (event) => { cleanup(); reject(new Error(event.message)); };
          worker.onmessage = ({ data }) => {
            if (data.type === "rows") {
              maxBatchRows = Math.max(maxBatchRows, data.rows.length);
              scanned += data.scanned; failures += data.failures;
              for (const row of data.rows) {
                const index = Number(row.announcementNumber.replace("TEST-", ""));
                if (!Number.isInteger(index) || index < 0 || index >= count || index % 2 || row.title !== '서버 "이중화", 도입') {
                  cleanup(); reject(new Error("Incorrect result row")); return;
                }
                ids.add(index); maxId = Math.max(maxId, index); matched++;
              }
            }
            if (data.type === "done") {
              const elapsedMs = performance.now() - started;
              maxGapMs = Math.max(maxGapMs, performance.now() - lastTick);
              cleanup(); resolve({ scanned, failures, matched, unique: ids.size, maxId, maxBatchRows, elapsedMs: Math.round(elapsedMs), mainThreadTicks: ticks, maxMainThreadGapMs: Math.round(maxGapMs) });
            }
          };
          worker.postMessage({ type: "search", version: 1, base: "", files: [{ path: "fixture.gz", mode: "bid", begin: "2026-09-01", end: "2026-09-30" }], criteria: { q: "서버", type: "물품", from: "20260901", to: "20260924" }, span: { begin: "2026-09-01", end: "2026-09-24" }, concurrency: 1 });
        }), count);
        assert.equal(result.scanned, count);
        assert.equal(result.failures, 0);
        assert.equal(result.matched, count / 2);
        assert.equal(result.unique, count / 2);
        assert.equal(result.maxId, count - 2);
        assert.ok(result.maxBatchRows <= 4000);
        assert.deepEqual(unknown, []); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ inputRows: count, gzipBytes: body.length, ...result }));
      } finally { await context.close(); }
    }
    console.log("PASS synthetic search benchmark; no external requests. Timings are observations, not production SLOs or peak memory measurements.");
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
