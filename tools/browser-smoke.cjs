// 실제 화면/스크립트를 실행하되 모든 통신은 로컬 fixture로 대체한다. 원격 AI 비용 없음.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
// 테스트에서만 별도 수집기 파서로 실제 다운로드 형식을 교차 확인한다.
const { parseCsv } = require("../collector/csv-record.js");
const root = path.resolve(__dirname, "../public");
const csvFixture = gzipSync([
  "bidNtceNo,ntceKindNm,bidNtceNm,bidNtceDt,dminsttNm",
  'MATCH-001,물품,"서버 ""이중화"", 도입",2026-09-10 09:00:00,검증기관',
  "WRONG-TYPE,용역,서버 유지보수,2026-09-10 09:00:00,검증기관",
  "OUTSIDE-DATE,물품,서버 도입,2026-09-25 09:00:00,검증기관",
  "WRONG-TITLE,물품,노트북 도입,2026-09-10 09:00:00,검증기관",
].join("\r\n"));
const analysis = { schemaVersion: 2, verified: false, ecr: [], 누락: ["ECR-001"], coverage: { expectedIds: ["ECR-001"], matchedIds: [], missingIds: ["ECR-001"] }, verification: { errors: [], warnings: ["원문 확인 필요"] } };

async function main() {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const timezoneId = viewport.width === 390 ? "America/Los_Angeles" : "UTC";
      const context = await browser.newContext({ viewport, timezoneId, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-09-25T15:30:00Z"));
      page.setDefaultTimeout(10000);
      const errors = [], unknown = [], searchWorkers = [];
      let csvRequests = 0, csvUnavailable = false, csvMalformed = false;
      page.on("worker", (worker) => searchWorkers.push(worker.url()));
      page.on("pageerror", (error) => errors.push(error.message));
      let unlocked = false, stepCalls = 0, release, askCalls = 0, ecrReads = 0;
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (url.hostname !== "gong-go.test") { unknown.push(url.href); return route.abort(); }
        if (url.pathname === "/data/index.json") return json({ files: [{ path: "bid/2026/09.csv.gz", mode: "bid", begin: "2026-09-01", end: "2026-09-30", count: 4 }], updatedAt: "2026-09-25T00:00:00Z" });
        if (url.pathname === "/data/bid/2026/09.csv.gz") { csvRequests++; return csvUnavailable ? route.fulfill({ status: 503, body: "fixture unavailable" }) : route.fulfill({ body: csvMalformed ? gzipSync("<html>invalid CSV source</html>") : csvFixture, contentType: "application/gzip" }); }
        if (url.pathname.startsWith("/data/analysis")) { ecrReads++; return route.fulfill({ status: 404, body: "Not found" }); }
        if (url.pathname === "/api/refresh") return json({ running: false });
        if (url.pathname === "/api/live") return json({ rows: [] });
        if (url.pathname === "/api/ask") {
          askCalls++;
          return json({ filter: { mode: "bid", q: "서버", type: "물품", begin: askCalls === 1 ? "2026-09-01" : "2026-02-30", end: "2026-09-24", institutions: [], looseInstitution: false }, notes: [], explain: "서버 물품 검색" });
        }
        if (url.pathname === "/api/ai-access") {
          if (route.request().method() === "POST") unlocked = true;
          if (route.request().method() === "DELETE") unlocked = false;
          return json({ configured: true, unlocked });
        }
        if (url.pathname === "/api/ecr") {
          if (route.request().method() === "GET") { ecrReads++; return json({ message: "POST만 지원합니다." }, 405); }
          assert.ok(unlocked, "locked screen must not send AI work");
          if (url.searchParams.get("action") === "upload") return json({ id: "fixture-job", total: 2, order: [0, 1], focused: true });
          stepCalls++;
          if (stepCalls === 1) await new Promise((resolve) => { release = resolve; });
          return json(url.searchParams.get("finalize") === "1" ? { analysis, completed: 2, total: 2 } : { completed: 1, total: 2 });
        }
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^(?:[a-z-]+\.(?:html|js|css)|assets\/[a-z-]+\.svg)$/.test(file)) { unknown.push(url.href); return route.abort(); }
        try { return await route.fulfill({ body: await fs.readFile(path.join(root, file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html" }); }
        catch { unknown.push(url.href); return route.abort(); }
      });
      try {
        await page.goto("http://gong-go.test/");
        await page.waitForFunction(() => document.querySelector("#status").textContent !== "");
        assert.equal(await page.evaluate(() => today()), "2026-09-26", `KST date in ${timezoneId}`);
        assert.deepEqual(await page.evaluate(() => GongSearch.createSearch().recentLiveSpan("2026-09-01", "2026-09-30")), { begin: "2026-09-25", end: "2026-09-26" });
        // 저장 프리셋과 무관한 전체 기관 조건에서 실제 압축 CSV 검색 파이프라인을 검증한다.
        await page.evaluate(() => { institutionList = []; renderInstitutions(); });
        await page.locator("#menu-btn").click();
        await page.locator("#advanced-toggle").click();
        await page.getByRole("textbox", { name: "자연어 검색 질의", exact: true }).fill("서버 물품 공고");
        for (const id of ["status", "nl-status", "refresh-status"]) {
          assert.equal(await page.locator(`#${id}`).getAttribute("role"), "status");
          assert.equal(await page.locator(`#${id}`).getAttribute("aria-live"), "polite");
        }
        await page.locator("#nl-run").click();
        await page.waitForFunction(() => document.querySelector("#nl-status").textContent.includes("해석:"));
        assert.equal(await page.locator("#q").inputValue(), "서버");
        assert.equal(await page.locator("#business-type").inputValue(), "물품");
        assert.equal(await page.locator("#begin").inputValue(), "2026-09-01");
        await page.waitForFunction(() => document.querySelector("#status").textContent.includes("4건을 읽어 1건"));
        assert.equal(await page.locator("#results .title-link").count(), 1);
        assert.equal(await page.locator("#results .title-link").textContent(), '서버 "이중화", 도입');
        assert.match(await page.locator("#results").textContent(), /MATCH-001/);
        assert.ok(searchWorkers.some((url) => url.endsWith("/search-worker.js")), "must use actual search Worker");
        assert.ok(csvRequests > 0, "must fetch actual gzip fixture");
        await page.locator("#q").fill("기존 검색어");
        await page.locator("#nl-run").click();
        await page.waitForFunction(() => document.querySelector("#nl-status").textContent.includes("형식이 올바르지"));
        assert.equal(await page.locator("#q").inputValue(), "기존 검색어");
        assert.equal(await page.locator("#begin").inputValue(), "2026-09-01");
        assert.equal(askCalls, 2);
        csvUnavailable = true;
        await page.locator("#q").fill("서버");
        await page.locator("#search").click();
        await page.waitForFunction(() => document.querySelector("#status").textContent.includes("1개 파일을 읽지 못했습니다"));
        assert.equal(await page.locator("#results .title-link").count(), 0);
        csvUnavailable = false;
        csvMalformed = true;
        await page.locator("#search").click();
        await page.waitForFunction(() => document.querySelector("#status").textContent.includes("1개 파일을 읽지 못했습니다"));
        assert.equal(await page.locator("#results .title-link").count(), 0);
        csvMalformed = false;
        // Worker 생성 실패를 주입해 실제 pool()의 복구 경로로 대체 검색에 진입한다.
        await page.evaluate(() => {
          scanner.dispose();
          window.benchmarkNativeWorker = window.Worker;
          window.Worker = class { constructor() { throw new Error("fixture Worker construction failure"); } };
        });
        await page.locator("#search").click();
        await page.waitForFunction(() => document.querySelector("#status").textContent.includes("4건을 읽어 1건"));
        assert.equal(await page.locator("#results .title-link").count(), 1);
        assert.doesNotMatch(await page.locator("#status").textContent(), /읽지 못했습니다/);
        assert.equal(await page.evaluate(() => scanner.pool().length), 0);
        await page.evaluate(() => { window.Worker = window.benchmarkNativeWorker; delete window.benchmarkNativeWorker; });
        await page.locator("#menu-btn").click();
        await page.locator("#advanced-toggle").click();
        // 검색 데이터 파이프라인이 아니라 실제 ECR 진입 동선 검증용 공고 fixture다.
        await page.evaluate(() => {
          setMode("bid");
          model.filtered = [{ mode: "bid", announcementNumber: "R26-test", title: "테스트 서버 도입 제안요청", institution: "검증기관", detailUrl: "javascript:alert(1)", files: [null, { name: "실행 불가", url: "javascript:alert(1)" }, { name: "제안요청서.pdf", url: "https://example.go.kr/rfp.pdf" }] }];
          renderRows(model.filtered);
        });
        await page.locator(".ecr-entry-btn").click();
        assert.match(await page.locator("#modal-file-list").textContent(), /첨부 링크 2건을 제외/);
        assert.match(await page.locator("#modal-file-list").textContent(), /상세 링크 형식/);
        assert.equal(await page.locator("#modal-file-list a").count(), 1);
        assert.equal(await page.locator("#modal-file-list a").getAttribute("href"), "https://example.go.kr/rfp.pdf");
        await page.waitForFunction(() => document.querySelector("#ai-access-status").textContent.includes("전용 비밀번호"));
        assert.equal(await page.locator(".modal").getAttribute("role"), "dialog");
        assert.equal(await page.evaluate(() => document.activeElement.id), "modal-close");
        assert.equal(await page.locator(".app").evaluate((node) => node.inert), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.evaluate(() => document.querySelector("#file-modal").contains(document.activeElement)), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement.id), "modal-close");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".app").evaluate((node) => node.inert), false);
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains("ecr-entry-btn")), true);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#ai-access-status").textContent.includes("전용 비밀번호"));
        assert.equal(await page.locator("#ecr-analyze-btn").isDisabled(), true);
        await page.locator("#ai-password").fill("test-password-only");
        await page.locator('#ai-unlock-form button[type="submit"]').click();
        await page.waitForFunction(() => !document.querySelector("#ecr-file").disabled);
        await page.locator("#ecr-file").setInputFiles({ name: "rfp.md", mimeType: "text/markdown", buffer: Buffer.from("ECR-001 서버 메모리 256GB") });
        await page.locator("#ecr-analyze-btn").click();
        await page.waitForFunction(() => document.querySelector("#ecr-progress").textContent.includes("1 / 2"));
        // fetch 발행과 route 진입 사이의 짧은 간격도 기다린다.
        const deadline = Date.now() + 10000;
        while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(release, "analysis step request must reach fixture");
        await page.locator("#ecr-stop-btn").click();
        release();
        await page.waitForFunction(() => !document.querySelector("#ecr-analyze-btn").disabled);
        assert.equal(stepCalls, 1);
        assert.match(await page.locator("#ecr-progress").textContent(), /추가 분석을 중지/);
        await page.locator("#ecr-analyze-btn").click();
        await page.waitForFunction(() => document.querySelector("#ecr-progress").textContent.includes("분석이 완료"));
        assert.match(await page.locator("#ecr-content").textContent(), /미추출 1개/);
        await page.locator("#ai-lock-btn").click();
        await page.waitForFunction(() => document.querySelector("#ai-access-status").textContent.includes("전용 비밀번호"));
        assert.equal(await page.locator("#ecr-analyze-btn").isDisabled(), true);
        await page.evaluate(() => renderEcr({ verified: false, ecr: [{ id: "ECR-KEY", 명칭: "키보드 검증 서버", 세부내용_원문: "메모리 256GB 이상" }] }));
        const detailToggle = page.getByRole("button", { name: "ECR-KEY 키보드 검증 서버 원문 상세", exact: true });
        await detailToggle.focus();
        await page.keyboard.press("Enter");
        assert.equal(await detailToggle.getAttribute("aria-expanded"), "true");
        assert.equal(await page.locator("#detail-0").isVisible(), true);
        await page.keyboard.press("Space");
        assert.equal(await detailToggle.getAttribute("aria-expanded"), "false");
        assert.equal(await page.locator("#detail-0").isVisible(), false);
        await page.locator(".ecr-row td").nth(2).click();
        assert.equal(await detailToggle.getAttribute("aria-expanded"), "true");
        const longLayout = await page.evaluate(() => {
          const longText = "공백없는긴장비규격조건".repeat(80);
          const data = { schemaVersion: 2, verified: false, ecr: Array.from({ length: 100 }, (_, i) => ({
            id: `ECR-LONG-${i}`, 명칭: `검증 서버 ${i}`, 세부내용_원문: longText,
            장비요약: [{ 종류: i === 99 ? "분류미정장비" : i % 2 ? "스토리지" : "서버", 명칭: i === 0 ? longText : `장비 ${i}`, 출처: "합성 문서 1쪽", 규격: [
              { 항목: "수량", 값: "2대", 근거: "2대", 검증: "원문 확인" },
              { 항목: "메모리", 값: longText, 근거: longText, 검증: "확인 필요" },
            ] }],
          })) };
          data.ecr.push({ id: "ECR-LEGACY", 명칭: "구형 저장 장비", 세부내용_원문: "기존 서버 2대", 기본규격: [{ 수량: "2대" }] });
          EquipmentSummary.validate(data);
          const started = performance.now();
          renderEcr(data);
          document.querySelector("#ecr-content").insertAdjacentHTML("afterbegin", EquipmentSummary.render(data));
          const modal = document.querySelector(".modal");
          return { cards: document.querySelectorAll(".equipment-card").length, width: modal.clientWidth, scrollWidth: modal.scrollWidth, renderMs: Math.round(performance.now() - started) };
        });
        assert.equal(longLayout.cards, 100);
        assert.equal(await page.getByRole("heading", { name: "장비 요약 형식이 없는 요구사항 1건" }).count(), 1);
        assert.equal(await page.getByRole("button", { name: "ECR-LEGACY 구형 저장 장비 원문 상세", exact: true }).count(), 1);
        assert.match(await page.locator(".equipment-count").filter({ hasText: "분류 확인 필요" }).innerText(), /^분류 확인 필요\s+1$/);
        assert.ok((await page.locator(".equipment-card").last().innerText()).includes("저장된 종류: 분류미정장비"));
        assert.ok(longLayout.scrollWidth <= longLayout.width + 1, `long result must not overflow modal: ${JSON.stringify(longLayout)}`);
        const longEvidence = page.locator(".equipment-card details summary").nth(1);
        await longEvidence.focus();
        await page.keyboard.press("Enter");
        assert.equal(await longEvidence.locator("..").getAttribute("open"), "");
        assert.equal(await page.locator(".modal").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
        console.log(`PASS long ECR ${viewport.width}: 100 cards, render+layout ${longLayout.renderMs}ms, no modal horizontal overflow`);
        await fs.mkdir(path.resolve(__dirname, "../test-results"), { recursive: true });
        await page.screenshot({ path: path.resolve(__dirname, `../test-results/ecr-long-${viewport.width}.png`), fullPage: true });
        await page.evaluate(() => renderEcr(model.currentAnalysis));
        const bounds = await page.locator(".modal").boundingBox();
        assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "modal must fit viewport width");
        await fs.mkdir(path.resolve(__dirname, "../test-results"), { recursive: true });
        await page.screenshot({ path: path.resolve(__dirname, `../test-results/ecr-${viewport.width}.png`), fullPage: true });
        // 결과는 서버에 없다. 분석을 마친 모달의 버튼이 이번 결과만 내려받는다.
        const downloading = page.waitForEvent("download");
        await page.locator("#download-ecr-btn").click();
        const download = await downloading;
        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        const csv = Buffer.concat(chunks).toString("utf8");
        assert.match(csv, /ECR-001,,,미추출 — 원문 확인 필요/);
        assert.match(csv, /ECR-001/);
        assert.match(csv, /추출된 ECR 없음/);
        assert.match(csv, /원문 확인 필요/);
        // 값의 존재만 검색하면 열 밀림이나 장비별 근거의 뒤바뀜을 놓친다.
        // 다운로드 클릭 → UTF-8 CSV 파싱까지 확인한다.
        const detailed = { schemaVersion: 2, verified: false, ecr: [{ id: "ECR-MULTI", 명칭: "복수 장비", 장비요약: [
          { 종류: "서버", 명칭: '웹 "이중화", 서버', 출처: "문서 1쪽", 규격: [{ 항목: "수량", 값: "2대", 근거: '웹 "이중화", 서버\r\n2대 이상', 검증: "원문 확인" }] },
          { 종류: "스토리지", 명칭: "공유 스토리지", 출처: "문서 2쪽", 규격: [{ 항목: "수량", 값: "1식", 근거: "공유 스토리지 1식", 검증: "원문 확인" }] },
          { 종류: "미분류", 명칭: "추가 장비", 규격: [] },
        ] }, { id: "ECR-LEGACY", 명칭: "=1+1", 기본규격: [{ 구분: "서버", 항목: "메모리", 요구사항: '256GB, "이상"\n조건 유지', 수량: 0 }] }] };
        await page.evaluate((data) => { model.currentAnalysis = data; }, detailed);
        const [detailedDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#download-ecr-btn").click()]);
        const detailedChunks = [];
        for await (const chunk of await detailedDownload.createReadStream()) detailedChunks.push(chunk);
        const detailedCsv = Buffer.concat(detailedChunks).toString("utf8");
        assert.equal(detailedCsv.charCodeAt(0), 0xfeff, "Excel UTF-8 BOM must be present");
        const records = parseCsv(detailedCsv);
        assert.equal(records.length, 2);
        for (const record of records) assert.deepEqual(Object.keys(record), ["규격번호", "요청내용", "스펙", "비고"]);
        assert.equal(records[0]["스펙"], '[웹 "이중화", 서버]\n수량: 2대\n\n[공유 스토리지]\n수량: 1식\n\n[추가 장비]\n추출 규격 없음');
        assert.equal(records[0]["비고"], "원문 확인 필요");
        assert.equal(records[1]["요청내용"], "'=1+1", "spreadsheet formula must remain text");
        assert.equal(records[1]["스펙"], '메모리: 256GB, "이상"\n조건 유지 (수량 0)');
        console.log(`PASS ECR CSV ${viewport.width}: actual download, 4 columns, multi-equipment ownership, newlines/quotes, legacy specs, formula protection`);
        await page.locator("#modal-close").click();
        await page.evaluate(() => loadIndex(false));
        assert.doesNotMatch(await page.locator("#data-count").innerText(), /ECR/);
        assert.equal(ecrReads, 0, "saved ECR results must never be requested");
        assert.deepEqual(errors, []);
        assert.deepEqual(unknown, []);
        console.log(`PASS ${viewport.width}x${viewport.height} ${timezoneId}: gzip CSV Worker + inline search, filters, KST date, entry, lock, upload, stop, resume, coverage; no page errors`);
      } catch (error) {
        // 실패 위치에서도 증거를 남기되 캡처 실패로 원래 오류를 가리지 않는다.
        try {
          await fs.mkdir(path.resolve(__dirname, "../test-results"), { recursive: true });
          await page.screenshot({ path: path.resolve(__dirname, `../test-results/failure-${viewport.width}.png`), fullPage: true });
        } catch {}
        throw error;
      } finally { release?.(); await context.close(); }
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
