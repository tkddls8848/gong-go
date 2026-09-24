import test from "node:test";
import assert from "node:assert/strict";
import { requirementSections, priorityOrder, sourceLines } from "./ecr-source.js";
import { splitDocument, parseResult } from "./ecr.js";
const document = `# 사업 소개\n일반 배경입니다.\n# 요구사항 총괄표\n| ECR-001 | 서버 |\n| 장비-002 | 스토리지 |\n# 상세 요구사항\n| 요구사항 고유번호 | ECR-001 |\n| 요구사항 명칭 | 업무 서버 |\n| 세부 내용 | 서버당 메모리 256GB 이상 |\n| 요구사항 고유번호 | SFR-001 |\n| 세부 내용 | 로그인 화면 |\n| 요구사항 고유번호 | 장비-002 |\n| 요구사항 명칭 | 스토리지 |\n| 세부 내용 | Usable 100TB 이상 |`;
test("총괄표·기능 요구사항을 제외하고 ECR 및 장비 번호 상세 표를 선별한다", () => {
  assert.deepEqual(requirementSections(document).sections.map((section) => section.id), ["ECR-001", "장비-002"]);
  const chunks = splitDocument(document);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].includes("256GB 이상"));
  assert.ok(chunks[1].includes("Usable 100TB 이상"));
  assert.ok(!chunks.join("").includes("로그인 화면"));
  assert.ok(!chunks.join("").includes("일반 배경"));
});
test("평문으로 변환된 번호 표와 상세 번호의 하위 마디를 지원한다", () => {
  const plain = "요구사항 번호\nECR-HW-001-01\n세부 내용\nCPU 32코어\n요구사항 번호\n장비001\n세부 내용\n메모리 256GB";
  assert.deepEqual(requirementSections(plain).sections.map((section) => section.id), ["ECR-HW-001-01", "장비001"]);
});
test("이전 작업도 상세 표 먼저 처리하되 원래 구간 번호는 보존한다", () => {
  assert.deepEqual(priorityOrder(["일반 배경", "ECR-001 서버", "요구사항 번호 ECR-002\n세부 내용 CPU 32코어"]), [2, 1, 0]);
});
test("모델의 줄 번호로 값과 근거를 복원하고 틀린 범위는 거절한다", () => {
  const text = "장비-001\n서버당 메모리 256GB 이상\n2대 신규 도입";
  const result = { response: { items: [{ id: "장비-001", kind: "서버", name: "서버", facts: [{ field: "메모리", from: 2, to: 2 }] }] } };
  const [item] = parseResult(result, text, "rfp", 0);
  assert.equal(item.장비요약[0].규격[0].값, "서버당 메모리 256GB 이상");
  assert.equal(item.장비요약[0].규격[0].근거, "서버당 메모리 256GB 이상");
  assert.ok(!item.불확실.some((message) => message.includes("ID")));
  result.response.items[0].facts[0].to = 99;
  assert.throws(() => parseResult(result, text, "rfp", 0), /줄 번호/);
  assert.equal(sourceLines("가".repeat(1000)).join(""), "가".repeat(1000));
});
test("이름이 같아도 장비 표만 남기고 소프트웨어·PC·UPS 표는 제외한다", () => {
  const table = (id, name) => `| 요구사항 고유번호 | ${id} |\n| 요구사항 명칭 | ${name} |\n| 세부 내용 | CPU 32코어, 메모리 256GB |\n`;
  const text = table("ECR-010", "NMS/SMS서버") + table("ECR-038", "NMS/SMS") + table("ECR-012", "백신관리서버")
    + table("ECR-046", "백신(PC용/서버용)") + table("ECR-033", "PC 및 복합기") + table("ECR-026", "SAN 스위치");
  assert.deepEqual(requirementSections(text).sections.map((section) => section.id), ["ECR-010", "ECR-012", "ECR-026"]);
});
