const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("../public/http.js");

test("응답이 없어도 제한 시간 뒤 반환하고 자동 재전송하지 않는다", async (t) => {
  let signal, calls = 0;
  t.mock.method(globalThis, "fetch", (_, options) => { signal = options.signal; calls++; return new Promise(() => {}); });
  await assert.rejects(GongHttp.requestJson("/api/ecr", { method: "POST" }, 5), /대기 시간이 초과/);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test("응답 헤더를 받아도 본문이 끝나지 않으면 시간 제한이 적용된다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, json: () => new Promise(() => {}) }));
  await assert.rejects(GongHttp.requestJson("/api/ecr", {}, 5), /대기 시간이 초과/);
});

test("HTML 오류 페이지의 원문 대신 상태와 재개 안내를 제공한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>private gateway details</html>", { status: 502 }));
  await assert.rejects(GongHttp.requestJson("/api/ecr"), (error) => /HTTP 502/.test(error.message) && !error.message.includes("private") && error.message.includes("같은 파일"));
});

test("비정상 JSON 응답과 로그인 만료를 구분한다", async (t) => {
  for (const data of [null, [], "invalid"]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    await assert.rejects(GongHttp.requestJson("/api/ecr"), /형식/);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("login", { status: 401 }));
  await assert.rejects(GongHttp.requestJson("/api/ecr"), /로그인이 만료/);
});

test("구조화된 서버 오류와 요청 본문을 그대로 보존한다", async (t) => {
  const body = new Blob(["document"]);
  t.mock.method(globalThis, "fetch", async (_, options) => {
    assert.equal(options.body, body);
    assert.equal(options.method, "POST");
    return Response.json({ locked: true, message: "분석 잠김", reference: "ref" }, { status: 403 });
  });
  const { response, data } = await GongHttp.requestJson("/api/ecr", { method: "POST", body });
  assert.equal(response.status, 403);
  assert.equal(data.reference, "ref");
  assert.equal(data.locked, true);
});

test("HTTP 모듈을 화면 스크립트보다 먼저 로드한다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.ok(html.indexOf('src="http.js"') >= 0);
  assert.ok(html.indexOf('src="http.js"') < html.indexOf('src="app.js"'));
});

test("검색 응답 본문 지연은 자동 재전송 없이 종료하며 파일 안내를 하지 않는다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { status: 200, json: () => new Promise(() => {}) }; });
  await assert.rejects(GongHttp.requestJson("/api/ask", {}, 5, "search"), (error) => /일반 검색/.test(error.message) && !/같은 파일/.test(error.message));
  assert.equal(calls, 1);
});

test("검색 HTML 오류와 로그인 만료는 검색용 안내로 표시한다", async (t) => {
  for (const status of [401, 502]) {
    t.mock.method(globalThis, "fetch", async () => new Response("private upstream error", { status }));
    await assert.rejects(GongHttp.requestJson("/api/ask", {}, 100, "search"), (error) => !/private|같은 파일/.test(error.message) && (status === 401 ? /로그인/.test(error.message) : /일반 검색/.test(error.message)));
  }
});

test("인덱스 데이터 조회 시간 초과는 재분석이 아닌 새로고침을 안내한다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { status: 200, json: () => new Promise(() => {}) }; });
  await assert.rejects(GongHttp.requestJson("/data/index.json", {}, 5, "data"), (error) => /새로고침/.test(error.message) && !/같은 파일|재분석/.test(error.message));
  assert.equal(calls, 1);
});

test("공통 데이터 조회는 30초 제한을 사용하고 HTTP 실패를 성공 데이터로 반환하지 않는다", async () => {
  for (const status of [200, 401, 503]) {
    const { getJson: read } = require("../public/http.js").createHttp({
      setTimeout(fn, timeout) { assert.equal(timeout, 30000); return setTimeout(fn, timeout); },
      fetch: async () => ({ ok: status === 200, status, json: async () => ({ files: [] }) })
    });
    if (status === 200) assert.deepEqual(await read("/data/index.json"), { files: [] });
    else await assert.rejects(read("/data/index.json"), status === 401 ? /로그인이 만료/ : /HTTP 503/);
  }
});

test("호출자 signal 취소는 요청을 중단하고 원래 AbortError를 그대로 돌려준다", async () => {
  let seen;
  const { requestJson } = require("../public/http.js").createHttp({
    fetch: (_, options) => new Promise((_, reject) => {
      seen = options.signal;
      // 실제 fetch처럼 이미 취소된 signal은 즉시 거부한다.
      if (options.signal.aborted) return reject(new DOMException("aborted", "AbortError"));
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    setTimeout: () => 0, clearTimeout() {}
  });
  const caller = new AbortController();
  const pending = requestJson("/api/live", { signal: caller.signal }, 30000, "search");
  caller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(seen.aborted, true);
  const already = new AbortController(); already.abort();
  await assert.rejects(requestJson("/api/live", { signal: already.signal }, 30000, "search"), (error) => error.name === "AbortError");
});

test("호출자 signal을 넘겨도 시간 제한은 그대로 적용된다", async () => {
  let seen;
  const { requestJson } = require("../public/http.js").createHttp({
    fetch: (_, options) => { seen = options.signal; return new Promise(() => {}); },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout
  });
  const caller = new AbortController();
  await assert.rejects(requestJson("/api/live", { signal: caller.signal }, 30000, "search"), /대기 시간이 초과/);
  assert.equal(seen.aborted, true);
  assert.equal(caller.signal.aborted, false, "시간 초과가 호출자 signal을 건드리면 안 된다");
});
