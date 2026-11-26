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
