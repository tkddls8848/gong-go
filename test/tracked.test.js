const test = require("node:test");
const assert = require("node:assert/strict");
const { createTracked } = require("../public/tracked.js");
const { html } = require("../public/format.js");
const KEY = "gong-go:tracked-businesses";
const NOW = Date.parse("2026-11-26T10:00:00+09:00");
const bidRow = { mode: "bid", announcementNumber: "R26BK01779016", title: "직장어린이집", institution: "국방연", closeAt: "2026-10-28 10:00:00", bidSchedule: { bidClseDt: "2026-10-28 10:00:00", opengDt: "2026-10-30 11:00:00" } };
const preRow = { mode: "pre", announcementNumber: "R26BD00278954", businessType: "용역", title: "직장어린이집", institution: "국방연", closeAt: "2026-10-04 23:59:00" };
function memory(initial) { const map = new Map(initial ? [[KEY, initial]] : []); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; }
function result(no = bidRow.announcementNumber, state = "failed", extra = {}) { return { stage: "bid", businessType: "용역", chainKey: null, notices: [{ bidNtceNo: no, state }], current: { bidNtceNo: no, state, bidders: [], biddersTruncated: false }, partial: "", ...extra }; }
function make(options = {}) { return createTracked({ storage: memory(), html, now: () => NOW, ...options }); }

test("본공고·사전공고 저장 및 해제와 스냅숏 재저장", () => {
  const storage = memory(), tracked = make({ storage });
  assert.equal(tracked.toggle(bidRow).saved, true);
  assert.equal(tracked.toggle(preRow).item.chainKey.no, preRow.announcementNumber);
  assert.deepEqual(tracked.toggle({ ...bidRow, mode: "plan" }), { saved: false, item: null });
  assert.equal(tracked.count(), 2);
  assert.equal(tracked.toggle(bidRow).saved, false);
  assert.equal(tracked.toggle({ ...bidRow, title: "수정" }).item.title, "수정");
  assert.equal(make({ storage }).items()[1].title, "수정");
});

test("깨진 저장값·다른 버전·필드 빠진 항목은 버린다", () => {
  for (const initial of ["{", '{"version":2,"items":[]}', JSON.stringify({ version: 1, items: [null, { savedNo: 1 }, "x"] })]) assert.equal(make({ storage: memory(initial) }).count(), 0);
  const storage = memory(), tracked = make({ storage }); tracked.toggle(bidRow);
  const saved = JSON.parse(storage.getItem(KEY)); saved.items.push(null); saved.items[0].result = { current: "invalid" };
  const reloaded = make({ storage: memory(JSON.stringify(saved)) });
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.items()[0].result, null);
});

test("저장소 읽기·쓰기 실패는 성공으로 처리하지 않고 안전한 오류를 준다", () => {
  const unavailable = make({ storage: { getItem() { throw new Error("private"); }, setItem() {} } });
  assert.equal(unavailable.count(), 0);
  assert.throws(() => unavailable.toggle(bidRow), error => error.code === "storage" && !error.message.includes("private"));
  const storage = memory(), tracked = make({ storage }); tracked.toggle(bidRow);
  storage.setItem = () => { throw new Error("quota internal"); };
  assert.throws(() => tracked.remove(tracked.items()[0].id), error => error.code === "storage");
  assert.equal(tracked.count(), 1);
  assert.throws(() => tracked.applyResult(tracked.items()[0].id, result(), NOW), error => error.code === "storage");
  assert.equal(tracked.items()[0].result, null);
});

test("결과로 연결된 본공고는 같은 사업이며 같은 사슬의 중복 저장은 합친다", () => {
  const tracked = make(), first = tracked.toggle(preRow).item;
  const second = tracked.toggle(bidRow).item;
  tracked.applyResult(second.id, result(undefined, "failed", { chainKey: first.chainKey }), NOW);
  assert.equal(tracked.count(), 1);
  assert.equal(tracked.items()[0].id, first.id);
  assert.equal(tracked.isSaved(bidRow), true);
  assert.equal(tracked.toggle(bidRow).saved, false);
  assert.equal(tracked.count(), 0);
});

test("getter·반환 객체·외부 응답 수정은 내부 상태를 바꾸지 않는다", () => {
  const tracked = make(); const saved = tracked.toggle(bidRow).item;
  saved.schedule.opengDt = "corrupt";
  const body = result(); tracked.applyResult(saved.id, body, NOW);
  body.current.state = "opened";
  const copy = tracked.items(); copy[0].result.current.state = "opened";
  tracked.dueItems()[0].schedule.opengDt = "corrupt";
  assert.equal(tracked.items()[0].result.current.state, "failed");
  assert.equal(tracked.items()[0].schedule.opengDt, bidRow.bidSchedule.opengDt);
});

test("조회 대상: 미확인·오류·부분결과·사전규격·유찰·지난 일정", () => {
  const tracked = make(), expected = [];
  for (const [suffix, state, date, partial, due] of [
    ["01", null, "2026-12-01 11:00:00", "", true],
    ["02", "before", "2026-11-20 11:00:00", "", true],
    ["03", "before", "2026-12-01 11:00:00", "", false],
    ["04", "before", "", "", true], ["05", "opened", "", "", false],
    ["06", "failed", "", "", true], ["07", "opened", "", "limit", true],
    ["08", "rebid", "", "", true], ["09", "other", "", "", true],
  ]) {
    const no = "R26BK000000" + suffix;
    const item = tracked.toggle({ ...bidRow, announcementNumber: no, bidSchedule: { opengDt: date } }).item;
    if (state) tracked.applyResult(item.id, result(no, state, { partial }), NOW);
    if (due) expected.push(item.id);
  }
  const pre = tracked.toggle(preRow).item;
  tracked.applyResult(pre.id, { stage: "spec", businessType: "용역", chainKey: pre.chainKey, notices: [], current: null, partial: "" }, NOW);
  expected.push(pre.id);
  assert.deepEqual(tracked.dueItems().map(item => item.id), expected);
});

test("KST 일정 경계와 다른 현재 공고에는 저장 일정 미적용", () => {
  const tracked = make(), item = tracked.toggle({ ...bidRow, bidSchedule: { opengDt: "2026-11-26 10:00:00" } }).item;
  tracked.applyResult(item.id, result(undefined, "before"), NOW - 1);
  assert.equal(tracked.dueItems(NOW - 1).length, 0);
  assert.equal(tracked.dueItems(NOW).length, 1);
  tracked.applyResult(item.id, result("R26BK00000099", "before"), NOW);
  assert.equal(tracked.dueItems(NOW - 1).length, 1);
});

test("응답 검증 실패와 조회 권한 오류는 직전 결과를 보존한다", async () => {
  let body = result(), failure;
  const tracked = make({ fetchJson: async () => { if (failure) throw failure; return body; } }); tracked.toggle(bidRow);
  await tracked.refresh();
  for (const bad of [{}, { ...result(), current: null }, { ...result(), current: { ...result().current, bidders: [null] } }, { ...result(), partial: "invalid" }]) {
    body = bad; await tracked.refresh({ all: true });
    assert.equal(tracked.items()[0].result.current.state, "failed");
    assert.equal(tracked.items()[0].error.code, "upstream");
  }
  failure = Object.assign(new Error("private"), { code: "not_authorized" });
  await tracked.refresh({ all: true });
  assert.equal(tracked.items()[0].error.code, "not_authorized");
  assert.ok(!tracked.items()[0].error.message.includes("private"));
});

test("동시 조회는 3개이며 겹친 호출은 같은 Promise를 반환한다", async () => {
  let active = 0, max = 0, calls = 0;
  const release = [];
  const tracked = make({ fetchJson: async url => { calls++; active++; max = Math.max(max, active); await new Promise(resolve => release.push(resolve)); active--; return result(new URL(url, "https://test").searchParams.get("bidNtceNo")); } });
  for (let i = 0; i < 5; i++) tracked.toggle({ ...bidRow, announcementNumber: "R26BK0000000" + i });
  const first = tracked.refresh(), second = tracked.refresh(); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(active, 3);
  release.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve)); release.splice(0).forEach(resolve => resolve());
  await first; assert.equal(calls, 5); assert.equal(max, 3);
});

test("해제 후 같은 번호 재저장 중 도착한 오래된 응답은 무시한다", async () => {
  let release;
  const tracked = make({ fetchJson: () => new Promise(resolve => { release = resolve; }) });
  tracked.toggle(bidRow); const work = tracked.refresh(); await new Promise(resolve => setImmediate(resolve));
  tracked.toggle(bidRow); tracked.toggle({ ...bidRow, title: "다시 저장" });
  release(result()); await work;
  assert.equal(tracked.items()[0].result, null);
  assert.equal(tracked.items()[0].title, "다시 저장");
});

test("사슬 병합으로 결과를 넘겨받은 항목의 기존 응답·오류는 무시한다", async () => {
  for (const rejectOld of [false, true]) {
    let resolvePre, rejectPre, resolveBid;
    const tracked = make({ fetchJson: url => new URL(url, "https://test").searchParams.has("specNo")
      ? new Promise((resolve, reject) => { resolvePre = resolve; rejectPre = reject; })
      : new Promise(resolve => { resolveBid = resolve; }) });
    const pre = tracked.toggle(preRow).item;
    tracked.toggle(bidRow);
    const work = tracked.refresh();
    await new Promise(resolve => setImmediate(resolve));
    resolveBid(result(undefined, "opened", { chainKey: pre.chainKey }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracked.count(), 1);
    assert.equal(tracked.items()[0].id, pre.id);
    if (rejectOld) rejectPre(new Error("old request failure"));
    else resolvePre({ stage: "spec", businessType: "용역", chainKey: pre.chainKey, notices: [], current: null, partial: "" });
    await work;
    assert.equal(tracked.items()[0].result.current.state, "opened");
    assert.equal(tracked.items()[0].error, null);
  }
});

test("저장 실패가 있어도 나머지 요청이 끝나기 전에는 중복 조회하지 않는다", async () => {
  const storage = memory(); let release;
  const tracked = make({ storage, fetchJson: async url => {
    const no = new URL(url, "https://test").searchParams.get("bidNtceNo");
    if (no !== bidRow.announcementNumber) await new Promise(resolve => { release = resolve; });
    return result(no);
  } });
  tracked.toggle(bidRow); tracked.toggle({ ...bidRow, announcementNumber: "R26BK00000001" });
  storage.setItem = () => { throw new Error("private"); };
  const work = tracked.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracked.refresh(), work);
  release();
  await assert.rejects(work, error => error.code === "storage");
  assert.equal(tracked.items().every(item => item.result === null), true);
});

test("사전규격·발주계획 연결 키와 본공고 번호를 요청에 보존한다", async () => {
  const urls = [];
  const tracked = make({ fetchJson: async url => { urls.push(new URL(url, "https://test")); return result(); } });
  const item = tracked.toggle(bidRow).item;
  tracked.applyResult(item.id, result(undefined, "failed", { chainKey: { kind: "plan", no: "R26DD00000001" } }), NOW);
  await tracked.refresh(); assert.equal(urls[0].searchParams.get("planNo"), "R26DD00000001"); assert.equal(urls[0].searchParams.get("bidNtceNo"), bidRow.announcementNumber);
  const preOnly = make({ fetchJson: async url => { urls.push(new URL(url, "https://test")); return { stage: "spec", businessType: "용역", chainKey: { kind: "spec", no: preRow.announcementNumber }, current: null, notices: [], partial: "" }; } });
  preOnly.toggle(preRow); await preOnly.refresh();
  assert.equal(urls[1].searchParams.get("specNo"), preRow.announcementNumber);
  assert.equal(urls[1].searchParams.get("businessType"), "용역");
  assert.equal(urls[1].searchParams.has("bidNtceNo"), false);
});

function viewItem(state, extra = {}) {
  return { savedNo: bidRow.announcementNumber, schedule: {}, checkedAt: NOW, error: null, chainKey: null,
    result: result(undefined, state), ...extra };
}

test("상태 문구는 KST 일정·결과·오류를 구분한다", () => {
  const tracked = make();
  const before = schedule => viewItem("before", { schedule });
  for (const [item, label, tone] of [
    [{ result: null }, "확인 전", "wait"],
    [{ error: { code: "not_authorized" } }, "조회 권한 없음(서비스 키 활용신청 확인)", "error"],
    [{ error: { code: "upstream" } }, "결과를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.", "error"],
    [before({ bidClseDt: "2026-11-29 09:00:00" }), "입찰 마감 D-3", "wait"],
    [before({ bidClseDt: "2026-11-26 10:00:01" }), "입찰 마감 D-day", "wait"],
    [before({ bidClseDt: "2026-11-26 09:00:00", opengDt: "2026-11-26 11:00:00" }), "개찰 대기", "wait"],
    [before({}), "일정 정보 없음", "wait"],
    [before({ opengDt: "2026-11-26 10:00:00" }), "개찰 결과 대기", "wait"],
    [viewItem("failed", { chainKey: { kind: "spec", no: "PRE" } }), "유찰 · 재공고 대기", "fail"],
    [viewItem("failed"), "유찰", "fail"],
    [viewItem("rebid"), "재입찰", "wait"],
  ]) assert.deepEqual(tracked.statusLine(item), { label, tone });
  const opened = viewItem("opened"); opened.result.current.openedAt = "2026-11-25T15:30:00Z";
  assert.equal(tracked.statusLine(opened).label, "개찰완료 11/26");
  opened.result.current.method = "수의계약";
  assert.equal(tracked.statusLine(opened).label, "수의계약 · 개찰완료 11/26");
  opened.result.current.winners = [{ name: "확인된 낙찰자" }];
  assert.equal(tracked.statusLine(opened).label, "수의계약 · 낙찰 11/26");
  opened.error = { code: "upstream" };
  assert.deepEqual(tracked.statusLine(opened), { label: "수의계약 · 낙찰 11/26 · 최근 확인 실패", tone: "error" });
  const other = viewItem("other"); other.result.current.stateLabel = "확인하지 못함";
  assert.equal(tracked.statusLine(other).label, "확인하지 못함");
  const replacement = before({ bidClseDt: "2026-12-01 10:00:00" }); replacement.result.current.bidNtceNo = "OTHER";
  assert.equal(tracked.statusLine(replacement).label, "일정 정보 없음");
});

test("사전규격 단계와 KST 자정의 D-day를 표시한다", () => {
  const tracked = make();
  const item = { result: { stage: "spec" }, schedule: { opninRgstClseDt: "2026-11-27 00:00:00" } };
  assert.equal(tracked.statusLine(item, Date.parse("2026-11-26T23:59:00+09:00")).label, "사전규격 · 의견등록 마감 D-1");
  assert.equal(tracked.statusLine(item, Date.parse("2026-11-27T00:00:00+09:00")).label, "본공고 대기");
});

test("공고 이력과 결과 요약은 실제 순위와 0점·0%를 보존한다", () => {
  const tracked = make(), item = viewItem("opened");
  item.result.notices = [{ state: "failed" }, { state: "failed" }, { state: "opened", method: "수의계약", winners: [{ name: "업체" }] }];
  assert.equal(tracked.historyLine(item), "1차 유찰 → 2차 유찰 → 수의계약 낙찰");
  item.result.current.bidders = [{ rank: 2, name: "업체B", totalScore: 0 }]; item.result.current.participants = 4;
  assert.equal(tracked.resultSummary(item), "2위 업체B 0점 · 4개사");
  item.result.current.bidders = [{ rank: null, name: "순위미상", rate: 0 }];
  assert.equal(tracked.resultSummary(item), "순위 미기재 순위미상(0%) · 4개사");
  item.result.current.bidders = []; item.result.current.winners = [{ name: "낙찰업체", rate: null }];
  assert.equal(tracked.resultSummary(item), "낙찰업체");
});

test("점수·금액 열은 있는 값만 표시하고 제한·직전 확인시각을 안내한다", () => {
  const tracked = make(), item = tracked.toggle(bidRow).item;
  const body = result(undefined, "opened", { partial: "limit" });
  body.current.bidders = [{ rank: 1, name: "업체", totalScore: 0 }];
  body.current.biddersTruncated = true;
  tracked.applyResult(item.id, body, NOW);
  let detail = tracked.renderDetail(item.id);
  assert.match(detail, /종합/); assert.doesNotMatch(detail, /투찰금액|투찰률/);
  assert.match(detail, /상위 1곳만 표시/);
  assert.match(detail, /일부만 확인/); assert.match(tracked.renderList(), /일부만 확인/);
  body.current.bidders = [{ rank: 1, name: "업체", amount: 0, rate: 0 }];
  tracked.applyResult(item.id, body, NOW);
  detail = tracked.renderDetail(item.id);
  assert.match(detail, /투찰금액/); assert.match(detail, /투찰률/); assert.doesNotMatch(detail, /종합/);
  tracked.applyError(item.id, { code: "upstream" });
  assert.match(tracked.renderList(), /최근 확인 실패/);
  assert.match(tracked.renderDetail(item.id), /2026-11-26 10:00/);
  body.current.bidders = []; tracked.applyResult(item.id, body, NOW);
  assert.match(tracked.renderDetail(item.id), /참여업체 결과를 확인하지 못했습니다/);
  assert.doesNotMatch(tracked.renderDetail(item.id), /공개된 참여업체 결과가 없습니다|상위 0곳/);
});

test("보기의 모든 상류 문자열과 속성은 escape하며 위험한 링크는 내보내지 않는다", () => {
  const tracked = make(), attack = '<img src=x onerror="alert(1)">';
  const item = tracked.toggle({ ...bidRow, title: attack, institution: attack, detailUrl: "javascript:alert(1)" }).item;
  const body = result(undefined, "other"); body.current.stateLabel = attack;
  body.notices[0].reason = attack; body.notices[0].method = attack;
  body.current.bidders = [{ rank: 1, name: attack, remark: attack }];
  tracked.applyResult(item.id, body, NOW);
  for (const output of [tracked.renderList(), tracked.renderDetail(item.id)]) {
    assert.doesNotMatch(output, /<img|javascript:/);
    assert.match(output, /&lt;img/);
  }
  assert.match(tracked.renderDetail(item.id), /연결 정보가 없어/);
  body.partial = "chain"; tracked.applyResult(item.id, body, NOW);
  assert.match(tracked.renderDetail(item.id), /이어진 공고를 확인하지 못했습니다/);
  tracked.remove(item.id);
  assert.match(tracked.renderList(), /저장한 관심사업이 없습니다/);
  assert.equal(tracked.renderDetail(item.id), "");
});
