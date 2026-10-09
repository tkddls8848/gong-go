const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/rows.js");
require("../public/dates.js");
const { createHttp } = require("../public/http.js");
const { createSearch } = require("../public/search.js");

const TODAY = "2026-10-05";
function screen(requestJson) {
  const fields = { "#begin": { value: TODAY }, "#end": { value: TODAY }, "#q": { value: "" }, "#business-type": { value: "물품" }, "#inst-loose": { checked: false }, "#status": { textContent: "" } };
  const model = { searchVersion: 0, viewMode: "bid", fileIndex: [] };
  const search = createSearch({
    model, $: (selector) => fields[selector], renderRows() {}, collectInstitutions: () => [], todayFile: () => true,
    MODE_NAMES: { bid: "본공고" }, format: String, numberOf: (row) => row.announcementNumber || "",
    scanner: { cancel() {}, scanFiles: async () => ({ rows: [], scanned: 0, failures: 0 }) },
    today: () => TODAY, requestJson
  });
  return { search, status: () => fields["#status"].textContent };
}
async function settled(ui, pattern) {
  const deadline = Date.now() + 2000;
  while (!pattern.test(ui.status()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(ui.status(), pattern);
}

test("최신 공고 조회는 공용 요청 함수를 30초 제한과 검색 안내로 부른다", async () => {
  const calls = [];
  const ui = screen(async (url, options, timeoutMs, purpose) => {
    calls.push({ url, options, timeoutMs, purpose });
    return { response: { ok: true, status: 200 }, data: { response: { body: { items: [], totalCount: 0, numOfRows: 100 } } } };
  });
  await ui.search.applyFilters();
  await settled(ui, /최신 정보 확인 완료/);
  // 본공고는 공고 목록과 함께 제안요청정보 첨부를 한 번 더 묻는다.
  assert.deepEqual(calls.map((call) => new URLSearchParams(call.url.split("?")[1]).get("businessType")).sort(), ["물품", "제안요청정보"]);
  for (const call of calls) {
    assert.match(call.url, /^\/api\/live\?/);
    assert.equal(call.timeoutMs, 30000);
    assert.equal(call.purpose, "search");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("상류가 응답하지 않으면 30초 제한으로 실패를 표시하고 저장 결과는 유지한다", async () => {
  const delays = [];
  const { requestJson } = createHttp({
    fetch: () => new Promise(() => {}),
    setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
    clearTimeout
  });
  const ui = screen(requestJson);
  await ui.search.applyFilters();
  await settled(ui, /최신 정보 일부만 반영 .*실패 1페이지 \(응답 대기 시간이 초과/);
  // 제안요청정보 요청도 같은 제한으로 끝나지만 보조 정보라 실패 페이지로 세지 않는다.
  assert.deepEqual(delays, [30000, 30000]);
  assert.match(ui.status(), /^0개 CSV에서 0건을 읽어/, "저장 결과 안내가 사라졌다");
});

test("새 조회가 진행 중인 최신 조회를 취소하면 실패로 집계하지 않는다", async () => {
  const signals = [];
  const { requestJson } = createHttp({
    fetch: (_url, options) => new Promise((_, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    setTimeout: () => 0, clearTimeout() {}
  });
  const ui = screen(requestJson);
  await ui.search.applyFilters();
  await ui.search.applyFilters();
  // 조회마다 공고 목록과 제안요청정보 두 요청이 나간다.
  assert.equal(signals.length, 4);
  assert.ok(signals.slice(0, 2).every((signal) => signal.aborted), "이전 최신 조회 요청이 취소되지 않았다");
  assert.ok(signals.slice(2).every((signal) => !signal.aborted));
  assert.doesNotMatch(ui.status(), /실패/);
  await ui.search.applyFilters();
  assert.ok(signals.slice(2, 4).every((signal) => signal.aborted));
});

function liveReply(items) { return { response: { ok: true, status: 200 }, data: { response: { body: { items, totalCount: items.length, numOfRows: 100 } } } }; }

test("실시간 공고가 저장 행을 바꿔도 제안요청정보 첨부는 남고, 새 공고에는 실시간 제안요청정보가 붙는다", async () => {
  const rendered = [];
  const fields = { "#begin": { value: TODAY }, "#end": { value: TODAY }, "#q": { value: "" }, "#business-type": { value: "" }, "#inst-loose": { checked: false }, "#status": { textContent: "" } };
  const model = { searchVersion: 0, viewMode: "bid", fileIndex: [] };
  const stored = { mode: "bid", announcementNumber: "R26BK1", publishedAt: `${TODAY} 09:00:00`, files: [{ name: "공고문.hwp", url: "https://www.g2b.go.kr/a" }, { name: "제안요청서(저장).hwp", url: "https://www.g2b.go.kr/rfp/1", source: "제안요청정보", kind: "제안요청서" }] };
  const notice = (no) => ({ bidNtceNo: no, bidNtceNm: "서버", bidNtceDt: `${TODAY} 10:00:00`, rgstDt: `${TODAY} 10:00:00`, ntceKindNm: "등록공고", ntceSpecDocUrl1: "https://www.g2b.go.kr/a", ntceSpecFileNm1: "공고문.hwp" });
  const search = createSearch({
    model, $: (selector) => fields[selector], renderRows(rows) { rendered.push(rows); }, collectInstitutions: () => [], todayFile: () => true,
    MODE_NAMES: { bid: "본공고" }, format: String, numberOf: (row) => row.announcementNumber || "",
    scanner: { cancel() {}, scanFiles: async () => ({ rows: [stored], scanned: 1, failures: 0 }) },
    today: () => TODAY,
    requestJson: async (url) => {
      const type = new URLSearchParams(url.split("?")[1]).get("businessType");
      if (type === "제안요청정보") return liveReply([
        { bidNtceNo: "R26BK2", bidNtceOrd: "000", atchSno: "2", eorderDocDivNm: "기타문서", eorderAtchFileNm: "과업지시서.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/22" },
        { bidNtceNo: "R26BK2", bidNtceOrd: "000", atchSno: "3", eorderDocDivNm: "제안요청서", eorderAtchFileNm: "제안요청서.hwpx", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/23" },
      ]);
      return liveReply(type === "용역" ? [notice("R26BK1"), notice("R26BK2")] : []);
    },
  });
  await search.applyFilters();
  await settled({ status: () => fields["#status"].textContent }, /최신 정보 확인 완료/);
  const rows = new Map(model.filtered.map((row) => [row.announcementNumber, row]));
  assert.equal(rows.get("R26BK1").live, true);
  assert.deepEqual(rows.get("R26BK1").files.map((file) => file.name), ["공고문.hwp", "제안요청서(저장).hwp"]);
  assert.deepEqual(rows.get("R26BK2").files.map((file) => [file.name, file.source || "", file.kind || ""]), [["공고문.hwp", "", ""], ["제안요청서.hwpx", "제안요청정보", "제안요청서"], ["과업지시서.hwp", "제안요청정보", "기타문서"]]);
});

test("실시간 제안요청정보는 저장 CSV와 같은 규칙으로 묶는다", () => {
  const groups = globalThis.GongRows.eorderFiles([
    { bidNtceNo: "R26BK1", bidNtceOrd: "000", atchSno: "1", eorderDocDivNm: "제안요청서", eorderAtchFileNm: "구판.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/1" },
    { bidNtceNo: "R26BK1", bidNtceOrd: "001", atchSno: "4", eorderDocDivNm: "기타문서", eorderAtchFileNm: "별첨.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/4" },
    { bidNtceNo: "R26BK1", bidNtceOrd: "001", atchSno: "2", eorderDocDivNm: "제안요청서", eorderAtchFileNm: "수정본.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/2" },
    { bidNtceNo: "R26BK1", bidNtceOrd: "001", atchSno: "5", eorderDocDivNm: "기타문서", eorderAtchFileNm: "중복.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp/2" },
    { bidNtceNo: "R26BK2", bidNtceOrd: "000", atchSno: "1", eorderAtchFileUrl: "javascript:alert(1)" },
  ]);
  assert.deepEqual([...groups.keys()], ["R26BK1"]);
  assert.deepEqual(groups.get("R26BK1").map((file) => file.name), ["수정본.hwp", "별첨.hwp"]);
  assert.equal("sno" in groups.get("R26BK1")[0], false);
});
