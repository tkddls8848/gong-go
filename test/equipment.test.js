const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../public/equipment");
test("구형 결과는 장비 없음으로 오인하지 않고 재분석 안내를 표시한다", () => {
  assert.match(render({ schemaVersion: 1, ecr: [{}] }), /재분석/);
});
test("요약은 조건, 검증 상태, 원문을 표시하고 문서의 HTML을 실행하지 않는다", () => {
  const html = render({ schemaVersion: 2, verified: false, ecr: [{ id: "ECR-001", 세부내용_원문: "<script>alert(1)</script>", 장비요약: [{ 종류: "스토리지", 명칭: "증설", 출처: "별첨 3쪽", 규격: [{ 항목: "Usable 용량", 값: "전체 100TB 이상", 근거: "전체 100TB 이상", 검증: "원문 확인" }, { 항목: "수량", 값: "2대", 근거: "" }] }] }] });
  assert.match(html, /전체 100TB 이상/);
  assert.match(html, /Raw 용량<\/th><td>미기재/);
  assert.match(html, /확인 필요/);
  assert.match(html, /ECR 원문 보기/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});
