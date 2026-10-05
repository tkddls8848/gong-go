// 실제 브라우저 + 실제 WASM. 원본은 samples에서 명시적으로 선택하고 결과는 gitignore 아래에 둔다.
const { chromium } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../public");
const output = process.env.HWP_TEST_OUTPUT ? path.resolve(process.env.HWP_TEST_OUTPUT) : path.resolve(__dirname, "../test-results/hwp-browser");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".ttf": "font/ttf", ".txt": "text/plain" };
async function main() {
  const names = process.argv.slice(2);
  assert.ok(names.length, "Usage: node tools/browser-convert.cjs samples/<file.hwp> [samples/<file.hwpx> ...]");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
    if (req.method !== "GET" || !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try { const body = await fs.readFile(file); res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "public, max-age=3600" }); res.end(body); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [], external = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => { if (!req.url().startsWith(origin) && !req.url().startsWith("blob:")) external.push(req.url()); });
    await page.goto(origin + "/convert.html");
    assert.equal(requests.some((r) => /vendor|hwp-worker/.test(r.url)), false, "idle page must not load WASM/fonts");
    await page.evaluate(() => { window.beats = 0; setInterval(() => window.beats++, 20); });
    await fs.mkdir(output, { recursive: true });
    const results = [];
    for (const [index, name] of names.entries()) {
      await page.locator("#convert-file").setInputFiles(path.resolve(name));
      const beats = await page.evaluate(() => window.beats);
      const start = performance.now();
      await page.locator("#convert-start").click();
      await page.waitForFunction(() => !document.querySelector("#convert-start").disabled, { }, { timeout: 100000 });
      const status = await page.locator("#convert-status").textContent();
      assert.ok(await page.locator("#pdf-download").isVisible(), status);
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#pdf-download").click();
      const download = await downloadEvent;
      const target = path.join(output, `sample-${index + 1}.pdf`);
      await download.saveAs(target);
      assert.equal((await fs.readFile(target)).subarray(0, 5).toString(), "%PDF-");
      const record = { input: path.basename(name), output: target, status, wallMs: Math.round(performance.now() - start), heartbeat: (await page.evaluate(() => window.beats)) - beats };
      assert.ok(record.heartbeat > 0, "main thread remains responsive");
      results.push(record); console.log(JSON.stringify(record));
    }
    // 취소는 동기 WASM 변환도 즉시 중단할 수 있어야 한다. 재시작은 위의 실제 변환과 같은 API를 쓴다.
    await page.locator("#convert-file").setInputFiles(path.resolve(names[0]));
    const cancelled = await page.evaluate(async () => {
      const c = GongHwp.createConverter();
      const p = c.convert(document.querySelector("#convert-file").files[0]);
      c.cancel(); try { await p; return false; } catch (e) { return /취소/.test(e.message); }
    });
    assert.ok(cancelled);
    // 잘못된 파일 후에도 화면은 재시도 가능한 상태로 돌아온다.
    await page.locator("#convert-file").setInputFiles({ name: "broken.hwp", mimeType: "application/octet-stream", buffer: Buffer.from("not a document") });
    await page.locator("#convert-start").click();
    await page.waitForFunction(() => !document.querySelector("#convert-start").disabled);
    assert.equal(await page.locator("#pdf-download").isVisible(), false);
    assert.match(await page.locator("#convert-status").textContent(), /형식이 아닙니다/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.ok(requests.every((r) => r.method === "GET" && !r.url.startsWith("/api/")));
    await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({ results, requests, external, errors }, null, 2));
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
