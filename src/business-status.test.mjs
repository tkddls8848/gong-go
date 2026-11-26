import assert from "node:assert/strict";
import test from "node:test";
import { handleBusinessStatus, MAX_UPSTREAM_CALLS } from "./business-status.js";

const NO = "R26BK01779016", SPEC = "R26BD00278954";
const wrap = (items = [], totalCount = items.length) => Response.json({ response: { header: { resultCode: "00" }, body: { items, totalCount } } });
const chain = (no = NO, extra = {}) => ({ bidNtceNo: no, bidNtceOrd: "000", bidNtceDt: "2026-11-20 10:00:00", bidNtceNm: "사업", ...extra });
const status = (state = "개찰완료", extra = {}) => ({ bidNtceNo: NO, bidNtceOrd: "000", bidClsfcNo: "0", rbidNo: "000", progrsDivCdNm: state, opengDt: "2026-11-23 11:00:00", prtcptCnum: "2", ...extra });
const bidder = (rank = 1) => ({ opengRank: String(rank), prcbdrNm: `업체${rank}`, prcbdrBizno: "1234567890", bidprcAmt: "1000", bidprcrt: "88.1" });
function stub(t, handler) {
  const old = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init) => { const url = new URL(input); calls.push(url); return handler(url.pathname.split("/").at(-1), url.searchParams, init); };
  t.after(() => { globalThis.fetch = old; }); return calls;
}
function call(query = `bidNtceNo=${NO}`, options = {}, env = { DATA_GO_KR_SERVICE_KEY: "key" }) {
  const url = new URL(`https://test.example/api/business-status?${query}`);
  return handleBusinessStatus(new Request(url, options), env, url);
}

test("사전규격 사슬의 현재 수의계약과 업체 결과", async (t) => {
  stub(t, (op, p) => {
    if (op.startsWith("getCntrct")) return wrap([chain(NO), chain("R26BK01847773", { bidNtceDt: "2026-11-23 10:00:00", cntrctCnclsMthdNm: "수의계약" })]);
    if (op.endsWith("OpengCompt")) return wrap([bidder()]);
    return wrap([status(p.get("bidNtceNo") === NO ? "유찰" : "개찰완료", { bidNtceNo: p.get("bidNtceNo") })]);
  });
  const response = await call(`specNo=${SPEC}&businessType=용역`), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.current.bidNtceNo, "R26BK01847773");
  assert.deepEqual(body.notices.map(n => n.state), ["failed", "opened"]);
  assert.equal(body.current.bidders[0].name, "업체1"); assert.equal(body.partial, "");
});

test("업무 탐색은 첫 적중에서 멈추고 유찰 사유를 조회한다", async (t) => {
  const calls = stub(t, op => op.startsWith("getCntrct") ? wrap([chain()]) : op.endsWith("Failing") ? wrap([{ nobidRsn: "단독응찰" }]) : wrap([status("유찰")]));
  const body = await (await call()).json();
  assert.equal(body.businessType, "용역"); assert.equal(body.current.reason, "단독응찰");
  assert.ok(calls.every(u => !u.pathname.endsWith("Thng")));
});

test("통합공개에 없더라도 낙찰정보를 탐색한다", async (t) => {
  stub(t, op => op.startsWith("getCntrct") ? wrap() : op.endsWith("Thng") ? wrap([status("유찰")]) : op.endsWith("Failing") ? wrap([{ nobidRsn: "무응찰" }]) : wrap());
  const body = await (await call()).json();
  assert.equal(body.businessType, "물품"); assert.equal(body.current.state, "failed");
});

test("권한 오류와 비정상 응답은 502이며 원문을 노출하지 않는다", async (t) => {
  let response = new Response("<SERVICE_KEY_IS_NOT_REGISTERED_ERROR>secret");
  stub(t, () => response.clone());
  let result = await call(); assert.equal(result.status, 502); assert.equal((await result.json()).code, "not_authorized");
  response = wrap([{ unexpected: true }]); result = await call(); assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /secret|unexpected/);
  response = wrap([], 4); assert.equal((await call()).status, 502);
});

test("사슬 실패는 저장 공고로만 대체하며 사전규격만 있으면 실패한다", async (t) => {
  stub(t, (op, p) => op.startsWith("getCntrct") ? p.get("inqryDiv") === "1" ? wrap([chain(NO, { bfSpecRgstNo: SPEC })]) : new Response("bad", { status: 503 }) : op.endsWith("Failing") ? wrap([{ nobidRsn: "무응찰" }]) : wrap([status("유찰")]));
  const body = await (await call()).json(); assert.equal(body.partial, "chain"); assert.equal(body.current.reason, "무응찰");
  assert.equal((await call(`specNo=${SPEC}`)).status, 502);
});

test("사전규격 정상 빈 결과는 본공고 대기다", async (t) => {
  stub(t, () => wrap([{ bidNtceNo: "", bfSpecRgstNo: SPEC }]));
  const body = await (await call(`specNo=${SPEC}&businessType=용역`)).json();
  assert.equal(body.stage, "spec"); assert.equal(body.current, null);
});

test("469개 업체는 300개까지만 받고 제한을 표시한다", async (t) => {
  const calls = stub(t, (op, p) => op.startsWith("getCntrct") ? wrap([chain()]) : op.endsWith("OpengCompt") ? wrap(Array.from({ length: 100 }, (_, i) => bidder((Number(p.get("pageNo")) - 1) * 100 + i + 1)), 469) : wrap([status()]));
  const body = await (await call()).json(); assert.equal(body.current.bidders.length, 300); assert.equal(body.current.biddersTruncated, true);
  assert.ok(calls.length <= MAX_UPSTREAM_CALLS);
});

test("최신 정정 차수와 재입찰 회차를 분리하고 업체 조회에 전달한다", async (t) => {
  const calls = stub(t, op => op.startsWith("getCntrct") ? wrap([chain(NO, { bidNtceOrd: "001" })]) : op.endsWith("OpengCompt") ? wrap([bidder()]) : wrap([status("유찰", { rbidNo: "999" }), status("개찰완료", { bidNtceOrd: "001", rbidNo: "002" })]));
  const body = await (await call()).json(); assert.equal(body.current.state, "opened");
  const p = calls.find(u => u.pathname.endsWith("OpengCompt")).searchParams;
  assert.equal(p.get("bidNtceOrd"), "001"); assert.equal(p.get("rbidNo"), "002"); assert.equal(p.get("bidClsfcNo"), "0");
});

test("최대 8개 사슬과 상류 호출 예산을 지킨다", async (t) => {
  const calls = stub(t, op => op.startsWith("getCntrct") ? wrap(Array.from({ length: 20 }, (_, i) => chain(`R26BK${String(i).padStart(7, "0")}`, { bidNtceDt: `2026-11-${String(i + 1).padStart(2, "0")} 10:00:00` }))) : wrap());
  const body = await (await call(`specNo=${SPEC}`)).json(); assert.equal(body.notices.length, 8); assert.equal(body.partial, "limit"); assert.ok(calls.length <= 40);
});

test("상태 목록이 잘려 최신 차수를 못 찾았으면 개찰 전으로 확정하지 않는다", async (t) => {
  stub(t, op => op.startsWith("getCntrct") ? wrap([chain(NO, { bidNtceOrd: "001" })]) : wrap(Array.from({ length: 100 }, () => status()), 400));
  const body = await (await call()).json();
  assert.equal(body.partial, "limit"); assert.equal(body.current.state, "other");
  assert.equal(body.current.stateLabel, "확인하지 못함");
});

test("입력·메서드·키 검증은 상류를 부르지 않는다", async (t) => {
  const calls = stub(t, () => { throw new Error("unexpected"); });
  for (const query of ["", "bidNtceNo=abc", `bidNtceNo=${NO}&businessType=기타`, `bidNtceNo=${NO}&specNo=bad`]) assert.equal((await call(query)).status, 400);
  assert.equal((await call(undefined, { method: "POST" })).status, 405);
  assert.equal((await call(undefined, {}, {})).status, 501); assert.equal(calls.length, 0);
});

test("캐시는 검증된 인자만 쓰며 성공을 5분 보관하고 클라이언트는 no-store다", async (t) => {
  const old = globalThis.caches, saved = new Map();
  globalThis.caches = { default: { match: async req => saved.get(req.url)?.clone(), put: async (req, response) => saved.set(req.url, response.clone()) } };
  t.after(() => { if (old === undefined) delete globalThis.caches; else globalThis.caches = old; });
  const calls = stub(t, () => wrap());
  const first = await call(`specNo=${SPEC}&businessType=용역&ignored=x`); assert.equal(first.headers.get("Cache-Control"), "no-store");
  const count = calls.length; const second = await call(`businessType=용역&specNo=${SPEC}`);
  assert.equal(second.status, 200); assert.equal(calls.length, count);
  assert.equal([...saved.values()][0].headers.get("Cache-Control"), "public, max-age=300");
});
