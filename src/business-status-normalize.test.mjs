import assert from "node:assert/strict";
import test from "node:test";
import { readItems, readUpstream, readUpstreamPage, UpstreamError, num, noticeState, chainNotices, parseWinners, bidders } from "./business-status-normalize.js";

const wrap = (items, resultCode = "00") => ({ response: { header: { resultCode, resultMsg: "정상" }, body: { items, totalCount: 1 } } });

test("페이지 메타데이터는 전체 건수와 빈 응답의 불일치를 검사한다", async () => {
  const json = wrap([{ bidNtceNo: "R26BK01832601" }]);
  json.response.body.totalCount = "469";
  assert.deepEqual(await readUpstreamPage(Response.json(json)), { rows: json.response.body.items, totalCount: 469 });
  for (const invalid of [-1, 1.5, "oops", {}]) {
    json.response.body.totalCount = invalid;
    await assert.rejects(readUpstreamPage(Response.json(json)), error => error.code === "upstream");
  }
  json.response.body.totalCount = 4; json.response.body.items = [];
  await assert.rejects(readUpstreamPage(Response.json(json)), error => error.code === "upstream");
});

test("상류 items의 배열·단건·item 감싸기·빈 응답", () => {
  const row = { bidNtceNo: "R26BK01832601" };
  for (const items of [[row], row, { item: row }, { item: [row] }]) assert.deepEqual(readItems(wrap(items)), [row]);
  for (const items of ["", null, []]) assert.deepEqual(readItems(wrap(items)), []);
  assert.deepEqual(readItems({ response: { header: { resultCode: "00" }, body: { totalCount: 0 } } }), []);
});

test("키 미승인과 상류 실패를 구분하고 원문 오류를 노출하지 않는다", async () => {
  for (const code of ["20", "30", "31", "32"]) assert.throws(() => readItems(wrap([], code)), (e) => e instanceof UpstreamError && e.code === "not_authorized");
  assert.throws(() => readItems(wrap([], "99")), (e) => e.code === "upstream");
  for (const [text, status, code] of [["<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR secret</returnAuthMsg>", 200, "not_authorized"], ["Unauthorized secret", 401, "not_authorized"], ["busy secret", 503, "upstream"], ["<xml />", 200, "upstream"]]) {
    await assert.rejects(readUpstream(new Response(text, { status })), (e) => e.code === code && !e.message.includes("secret"));
  }
  const row = { bidNtceNo: "R26BK01832601" };
  assert.deepEqual(await readUpstream(Response.json(wrap([row]))), [row]);
});

test("잘못된 응답 구조는 정상 빈 결과가 되지 않는다", () => {
  for (const bad of [null, {}, [], { response: { body: { items: [] } } }, { response: { header: { resultCode: "00" } } }, wrap(7), wrap("oops"), wrap([null]), wrap(["bad"]), wrap({ item: 42 })]) {
    assert.throws(() => readItems(bad), (e) => e.code === "upstream");
  }
});

test("공고 사슬은 공고일 순으로 정렬하고 최신 정정 차수만 남긴다", () => {
  const notices = chainNotices([
    { bidNtceNo: "R26BK01779016", bidNtceOrd: "000", bidNtceDt: "2026-10-19 16:23:29", cntrctCnclsMthdNm: "일반경쟁" },
    { bidNtceNo: "R26BK01756351", bidNtceOrd: "000", bidNtceDt: "2026-10-07 07:06:18" },
    { bidNtceNo: "R26BK01847773", bidNtceOrd: "000", bidNtceNm: "직장어린이집", bidNtceDt: "2026-11-23 10:56:31", cntrctCnclsMthdNm: "수의계약", bidMthdNm: "전자시담", bidwinrInfoList: "[1^모아맘보육재단^2208264545^김광자^830575896^97.001^1^2026-11-23 12:30:00]" },
    { bidNtceNo: "R26BK01779016", bidNtceOrd: "001", bidNtceDt: "2026-10-20 16:23:29" },
    { bidNtceNo: "" },
  ]);
  assert.deepEqual(notices.map((n) => n.bidNtceNo), ["R26BK01756351", "R26BK01779016", "R26BK01847773"]);
  assert.equal(notices[1].ord, "001");
  assert.equal(notices[2].method, "수의계약");
  assert.equal(notices[2].state, "before");
  assert.deepEqual(notices[2].winners, [{ rank: 1, name: "모아맘보육재단", bizno: "2208264545", amount: 830575896, rate: 97.001 }]);
  const rows = Array.from({ length: 10 }, (_, i) => ({ bidNtceNo: String(i), bidNtceDt: `2026-11-${String(i + 1).padStart(2, "0")}` }));
  assert.deepEqual(chainNotices(rows).map((n) => n.bidNtceNo), ["2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.deepEqual(chainNotices(rows, 0), []);
});

test("협상 점수와 투찰 금액·투찰률을 숫자로 읽고 미기재 순위는 뒤로 둔다", () => {
  const result = bidders([
    { opengRank: "", prcbdrNm: "무순위" },
    { opengRank: "2", prcbdrNm: "주식회사 넷마루", totalEvlAmtVal: "92.0667" },
    { opengRank: "1", prcbdrNm: "(주)휴넷", prcbdrBizno: "2148638356", bidprcAmt: "", bidprcrt: "", rmrk: "정상", techEvlVal: "83.7333", bidPrceEvlVal: "9.9366", totalEvlAmtVal: "93.6699" },
  ]);
  assert.deepEqual(result[0], { rank: 1, name: "(주)휴넷", bizno: "2148638356", amount: null, rate: null, remark: "정상", techScore: 83.7333, priceScore: 9.9366, totalScore: 93.6699 });
  assert.equal(result[2].name, "무순위");
  const priced = bidders([{ opengRank: "1", prcbdrNm: "주식회사 에스엔에스", bidprcAmt: "72915000", bidprcrt: "88.27" }])[0];
  assert.equal(priced.amount, 72915000);
  assert.equal(priced.rate, 88.27);
  assert.equal(priced.totalScore, null);
});

test("진행 구분·낙찰자 목록·수치를 방어적으로 읽는다", () => {
  for (const [label, state] of [["개찰완료", "opened"], ["유찰", "failed"], ["재입찰", "rebid"], ["기타", "other"]]) assert.equal(noticeState(label), state);
  for (const separator of [",", ""]) assert.equal(parseWinners(`[1^A^1^C^100^90.1^1^x]${separator}[2^B^2^D^200^91^1^y]`).length, 2);
  for (const bad of ["", "[1^A^2]", null, {}]) assert.deepEqual(parseWinners(bad), []);
  for (const bad of ["", " ", null, undefined, "foo", true, [], {}, Infinity]) assert.equal(num(bad), null);
  assert.equal(num("12.5"), 12.5);
  assert.equal(num("0"), 0);
});
