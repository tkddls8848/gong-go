const test = require("node:test");
const assert = require("node:assert/strict");
require("../public/rows.js");
require("../public/dates.js");
const { createSearch } = require("../public/search.js");

const TODAY = "2026-10-05";
async function settled(ui, pattern) {
  const deadline = Date.now() + 2000;
  while (!pattern.test(ui.status()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(ui.status(), pattern);
}

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

