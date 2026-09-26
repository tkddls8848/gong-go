// 원격 바인딩 없이 실제 Worker 번들을 workerd + 로컬 R2에서 실행한다.
const assert = require("node:assert/strict");
const path = require("node:path");
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const EquipmentSummary = require("../public/equipment.js");

async function browserAuth(runtime) {
  const { chromium } = require("playwright-core");
  const origin = (await runtime.ready).origin;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const external = [];
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin + "/api/ai-access");
    await page.evaluate(async () => {
      const login = await fetch("/__gate/login", { method: "POST", body: new URLSearchParams({ password: "runtime-test-gate" }), redirect: "manual" });
      await login.text();
    });
    assert.equal(await page.evaluate(async () => (await fetch("/api/ai-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "runtime-test-ai-secret" }) })).status), 200);
    const cookies = await context.cookies(origin + "/api/ai-access");
    const ai = cookies.find((cookie) => cookie.name === "gong_ai_access");
    assert.ok(ai); assert.equal(ai.path, "/api"); assert.equal(ai.httpOnly, true); assert.equal(ai.sameSite, "Strict");
    assert.ok(!(await context.cookies(origin + "/__gate/logout")).some((cookie) => cookie.name === "gong_ai_access"));
    assert.ok(!(await page.evaluate(() => document.cookie)).includes("gong_ai_access"));
    const copied = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const unlocked = await page.evaluate(async () => (await (await fetch("/api/ai-access")).json()).unlocked);
    assert.equal(unlocked, true);
    // 실제 HTTP 서버와 브라우저가 리다이렉트 및 두 Set-Cookie 헤더를 처리한다.
    await page.evaluate(async () => { await (await fetch("/__gate/logout")).text(); });
    assert.ok(!(await context.cookies()).some((cookie) => ["gong_gate", "gong_ai_access"].includes(cookie.name)));
    const replay = await runtime.dispatchFetch(origin + "/api/ai-access", { headers: { Cookie: copied } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).unlocked, false);
    assert.deepEqual(external, []);
    console.log("PASS browser + local HTTP Worker: cookie Path/HttpOnly/SameSite, legacy logout redirect, cookie deletion, copied AI token revoked");
  } finally { await browser.close(); }
}

async function main() {
  const bundle = await build({
    stdin: { resolveDir: path.resolve(__dirname, ".."), contents: `
      import worker from "./src/worker.js";
      export default {
        fetch(request, env, ctx) {
          const AI = {
            async run() {
              // 동시 호출의 read-modify-write 손실로 중복 추론을 숨기지 않도록 호출마다 별도 키를 쓴다.
              await env.DATA.put("_test/calls/" + crypto.randomUUID(), "called");
              return { response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", from: 2, to: 2 }] }] } };
            },
            toMarkdown() { throw new Error("PDF conversion is not enabled in runtime smoke"); }
          };
          return worker.fetch(request, { ...env, AI }, ctx);
        }
      };` },
    bundle: true, write: false, format: "esm", platform: "browser",
  });
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-08",
    bindings: { GATE_PASSWORD: "runtime-test-gate", AI_ANALYSIS_PASSWORD: "runtime-test-ai-secret" },
    r2Buckets: ["DATA"], r2Persist: false,
    outboundService: () => { outbound++; return new Response("External network disabled", { status: 502 }); },
  }));
  try {
    const origin = "https://runtime.test";
    const send = (route, options = {}) => runtime.dispatchFetch(origin + route, { ...options, redirect: "manual" });
    const locked = await send("/api/ecr?action=upload", { method: "POST", headers: { Origin: origin }, body: "not authorized" });
    assert.equal(locked.status, 401);
    await locked.text();
    const login = await send("/__gate/login", { method: "POST", body: new URLSearchParams({ password: "runtime-test-gate" }) });
    assert.equal(login.status, 302);
    const gate = login.headers.get("Set-Cookie").split(";")[0];
    await login.text();
    const denied = await send("/api/ecr?action=upload", { method: "POST", headers: { Origin: origin, Cookie: gate }, body: "locked" });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).locked, true);
    const bucket = await runtime.getR2Bucket("DATA");
    const callCount = async () => (await bucket.list({ prefix: "_test/calls/" })).objects.length;
    assert.equal(await callCount(), 0, "unauthorized requests must not reach model");
    const access = await send("/api/ai-access", { method: "POST", headers: { Origin: origin, Cookie: gate }, body: JSON.stringify({ password: "runtime-test-ai-secret" }) });
    assert.equal(access.status, 200);
    const cookies = `${gate}; ${access.headers.get("Set-Cookie").split(";")[0]}`;
    assert.equal((await access.json()).unlocked, true);
    const headers = { Origin: origin, Cookie: cookies };
    const upload = await send("/api/ecr?action=upload&notice=runtime-canary&name=rfp.md", { method: "POST", headers, body: "ECR-001 업무 서버\n메모리 256GB 이상\n" });
    assert.equal(upload.status, 200);
    const job = await upload.json();
    const step = () => send(`/api/ecr?action=step&id=${job.id}&index=0`, { method: "POST", headers });
    const completed = await step();
    assert.equal(completed.status, 200);
    const { analysis } = await completed.json();
    assert.equal(analysis.ecr[0].장비요약[0].규격[0].값, "메모리 256GB 이상");
    assert.equal(analysis.coverage.status, "matched");
    assert.equal(EquipmentSummary.validate(analysis), analysis);
    const summary = EquipmentSummary.render(analysis);
    assert.match(summary, /메모리 256GB 이상/);
    assert.match(summary, /규격 전체의 완전성을 보증하지 않습니다/);
    const saved = await send("/api/ecr?notice=runtime-canary", { headers: { Cookie: gate } });
    assert.equal(saved.status, 200);
    const savedAnalysis = await saved.json();
    EquipmentSummary.validate(savedAnalysis);
    assert.deepEqual(savedAnalysis, analysis, "persisted result must retain frontend-compatible fields");
    assert.equal(EquipmentSummary.render(savedAnalysis), summary);
    const cached = await step();
    assert.equal(cached.status, 200);
    const cachedAnalysis = (await cached.json()).analysis;
    EquipmentSummary.validate(cachedAnalysis);
    const { analyzedAt: firstTime, ...firstContent } = analysis;
    const { analyzedAt: cachedTime, ...cachedContent } = cachedAnalysis;
    assert.deepEqual(cachedContent, firstContent, "cached merge must retain content without additional inference");
    assert.ok(Number.isFinite(Date.parse(firstTime)) && Number.isFinite(Date.parse(cachedTime)));
    assert.equal(EquipmentSummary.render(cachedAnalysis), summary);
    assert.equal(await callCount(), 1);
    const parallelUpload = await send("/api/ecr?action=upload&notice=runtime-parallel&name=rfp.md", { method: "POST", headers, body: "ECR-001 업무 서버\n메모리 256GB 이상\n" });
    const parallelJob = await parallelUpload.json();
    const simultaneous = await Promise.all([0, 1].map(() => send(`/api/ecr?action=step&id=${parallelJob.id}&index=0`, { method: "POST", headers })));
    for (const result of simultaneous) assert.equal(result.status, 200);
    const bodies = await Promise.all(simultaneous.map((result) => result.json()));
    assert.ok(bodies.some((body) => body.analysis));
    assert.equal(await callCount(), 2, "parallel requests must share one additional inference");
    const relock = await send("/api/ai-access", { method: "DELETE", headers });
    assert.equal(relock.status, 200); await relock.json();
    const replay = await step();
    assert.equal(replay.status, 403, "revoked cookie must not authorize even cached step");
    await replay.json();
    assert.equal(await callCount(), 2);
    const freshAccess = await send("/api/ai-access", { method: "POST", headers: { Origin: origin, Cookie: gate }, body: JSON.stringify({ password: "runtime-test-ai-secret" }) });
    assert.equal(freshAccess.status, 200);
    const freshCookies = `${gate}; ${freshAccess.headers.get("Set-Cookie").split(";")[0]}`;
    await freshAccess.json();
    // 기존 링크에는 /api 쿠키가 전달되지 않는 실제 브라우저 경로를 재현한다.
    const legacyLogout = await send("/__gate/logout", { headers: { Cookie: gate } });
    assert.equal(legacyLogout.status, 302);
    assert.equal(legacyLogout.headers.get("Location"), "/api/logout");
    assert.equal(legacyLogout.headers.get("Set-Cookie"), null);
    await legacyLogout.text();
    const logout = await send("/api/logout", { headers: { Cookie: freshCookies } });
    assert.equal(logout.status, 302);
    assert.match(logout.headers.get("Set-Cookie"), /gong_ai_access=;/);
    await logout.text();
    const logoutReplay = await send(`/api/ecr?action=step&id=${job.id}&index=0`, { method: "POST", headers: { Origin: origin, Cookie: freshCookies } });
    assert.equal(logoutReplay.status, 403, "site logout must revoke copied AI cookie");
    await logoutReplay.json();
    assert.equal(await callCount(), 2);
    // 모형 Map이 아니라 런타임 R2의 실제 조건부 쓰기 계약을 확인한다.
    const initial = await bucket.put("_test/cas", "one", { onlyIf: { etagDoesNotMatch: "*" } });
    assert.ok(initial);
    assert.equal(await bucket.put("_test/cas", "duplicate", { onlyIf: { etagDoesNotMatch: "*" } }), null);
    assert.ok(await bucket.put("_test/cas", "two", { onlyIf: { etagMatches: initial.etag } }));
    assert.equal(await bucket.put("_test/cas", "stale", { onlyIf: { etagMatches: initial.etag } }), null);
    assert.equal(await (await bucket.get("_test/cas")).text(), "two");
    if (process.argv.includes("--browser-auth")) {
      await browserAuth(runtime);
      assert.equal(await callCount(), 2, "browser auth must not invoke AI");
    }
    assert.equal(outbound, 0);
    console.log("PASS workerd + local R2: gate, AI lock/revocation, site logout/replay rejection, upload, extraction, persistence, cache reuse, concurrent step, CAS; external requests=0");
  } finally { await runtime.dispose(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
