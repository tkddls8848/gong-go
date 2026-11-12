const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/http.js");

test("응답이 없어도 제한 시간 뒤 반환하고 자동 재전송하지 않는다", async (t) => {
  let signal, calls = 0;
  t.mock.method(globalThis, "fetch", (_, options) => { signal = options.signal; calls++; return new Promise(() => {}); });
  await assert.rejects(GongHttp.requestJson("/api/ecr", { method: "POST" }, 5), /대기 시간이 초과/);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
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

