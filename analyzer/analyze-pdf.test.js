const test = require("node:test");
const assert = require("node:assert/strict");
const { planJobs, summarize } = require("./analyze-pdf");
const selection = { status: "ready", totalPages: 307, selectedPages: [188], selectedCount: 1, sections: [
  { id: "ECR-006", name: "도입 대상 HW", pages: [188], expectedDevices: ["클라우드 가상 서버", "중계서버", "SAN 스토리지"] }
] };
test("목차·개요 없이 선별한 페이지와 번호만 이미지 요청으로 계획한다", () => {
  const jobs = planJobs(selection);
  assert.equal(jobs.length, 1); assert.deepEqual(jobs[0].pages, [188]); assert.equal(jobs[0].id, "ECR-006");
});
test("선별 실패·과도한 요청은 전체 분석이나 조용한 잘라내기로 대체하지 않는다", () => {
  assert.throws(() => planJobs({ status: "needs-review" }), /전체 문서 분석/);
  assert.throws(() => planJobs({ ...selection, sections: [{ pages: [1, 2, 3, 4] }] }, 1), /분석하지 않았/);
  assert.throws(() => planJobs(selection, 1), /수량 재확인/);
});
test("여러 페이지의 장비 표는 인접 2쪽을 겹쳐 보내 경계 규격을 보존한다", () => {
  const jobs = planJobs({ ...selection, sections: [{ id: "ECR-001", pages: [3, 4, 5, 6] }] });
  assert.deepEqual(jobs.map(j => j.pages), [[3, 4], [4, 5], [5, 6]]);
});
test("ID가 나와도 원문의 장비명이 누락되면 완료로 판정하지 않는다", () => {
  const report = summarize(selection, planJobs(selection), [{ ecr: [
    { id: "ECR-006", 장비요약: [{ 명칭: "클라우드가상서버" }] },
    { id: "ECR-006", 장비요약: [{ 명칭: "중계 서버" }] }
  ] }]);
  assert.equal(report.status, "needs-review"); assert.equal(report.verified, false);
  assert.deepEqual(report.coverage[0].missingDevices, ["SAN 스토리지"]);
});
