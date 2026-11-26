import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { handleBusinessStatus } from "../src/business-status.js";
const require = createRequire(import.meta.url);
const { createTracked } = require("../public/tracked.js");
const { html } = require("../public/format.js");

test("사전공고 저장 → Worker 공고 연결·점수 → 브라우저 결과 보존 계약", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const specNo = "R26BD00278954", bidNo = "R26BK01847773";
  let unavailable = false;
  globalThis.fetch = async (input) => {
    if (unavailable) return new Response("private upstream details", { status: 503 });
    const url = new URL(input), op = url.pathname.split("/").at(-1);
    const items = op.startsWith("getCntrct")
      ? [{ bidNtceNo: bidNo, bidNtceOrd: "000", bfSpecRgstNo: specNo, bidNtceNm: "정보시스템 구축", bidNtceDt: "2026-11-20 09:00:00", cntrctCnclsMthdNm: "일반경쟁" }]
      : op.endsWith("OpengCompt")
        ? [{ bidNtceNo: bidNo, bidNtceOrd: "000", rbidNo: "000", bidClsfcNo: "0", opengRank: "1", prcbdrNm: "검증업체", prcbdrBizno: "1234567890", techEvlVal: "80", bidPrceEvlVal: "10", totalEvlAmtVal: "90" }]
        : [{ bidNtceNo: bidNo, bidNtceOrd: "000", rbidNo: "000", bidClsfcNo: "0", progrsDivCdNm: "개찰완료", prtcptCnum: "1", opengDt: "2026-11-26 10:00:00" }];
    return Response.json({ response: { header: { resultCode: "00" }, body: { items, totalCount: items.length } } });
  };
  const data = new Map();
  const tracked = createTracked({
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
    now: () => Date.parse("2026-11-26T11:00:00+09:00"), html,
    fetchJson: async (path) => {
      const url = new URL(path, "https://test.local");
      const response = await handleBusinessStatus(new Request(url), { DATA_GO_KR_SERVICE_KEY: "test-only" }, url);
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.message), { code: body.code });
      return body;
    },
  });
  tracked.toggle({ mode: "pre", announcementNumber: specNo, businessType: "용역", title: "정보시스템 구축", institution: "검증기관" });
  await tracked.refresh();
  const [saved] = tracked.items();
  assert.equal(saved.error, null);
  assert.equal(saved.result.current.bidNtceNo, bidNo);
  assert.equal(saved.result.current.bidders[0].totalScore, 90);
  assert.equal(tracked.isSaved({ mode: "bid", announcementNumber: bidNo }), true);
  assert.equal(tracked.dueItems().length, 0);
  unavailable = true;
  await tracked.refresh({ all: true });
  const [failed] = tracked.items();
  assert.equal(failed.error.code, "upstream");
  assert.deepEqual(failed.result, saved.result);
  assert.doesNotMatch(JSON.stringify(failed), /private upstream details/);
});
