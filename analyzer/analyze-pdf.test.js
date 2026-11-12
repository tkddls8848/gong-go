const test = require("node:test");
const assert = require("node:assert/strict");
const { planJobs } = require("./analyze-pdf");
const selection = { status: "ready", totalPages: 307, selectedPages: [188], selectedCount: 1, sections: [
  { id: "ECR-006", name: "도입 대상 HW", pages: [188], expectedDevices: ["클라우드 가상 서버", "중계서버", "SAN 스토리지"] }
] };
test("선별 실패·과도한 요청은 전체 분석이나 조용한 잘라내기로 대체하지 않는다", () => {
  assert.throws(() => planJobs({ status: "needs-review" }), /전체 문서 분석/);
  assert.throws(() => planJobs({ ...selection, sections: [{ pages: [1, 2, 3, 4] }] }, 1), /분석하지 않았/);
  assert.throws(() => planJobs(selection, 1), /수량 재확인/);
});
