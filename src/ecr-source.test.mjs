import test from "node:test";
import assert from "node:assert/strict";
import { requirementSections, priorityOrder, sourceLines } from "./ecr-source.js";
import { splitDocument, parseResult } from "./ecr.js";
const document = `# 사업 소개\n일반 배경입니다.\n# 요구사항 총괄표\n| ECR-001 | 서버 |\n| 장비-002 | 스토리지 |\n# 상세 요구사항\n| 요구사항 고유번호 | ECR-001 |\n| 요구사항 명칭 | 업무 서버 |\n| 세부 내용 | 서버당 메모리 256GB 이상 |\n| 요구사항 고유번호 | SFR-001 |\n| 세부 내용 | 로그인 화면 |\n| 요구사항 고유번호 | 장비-002 |\n| 요구사항 명칭 | 스토리지 |\n| 세부 내용 | Usable 100TB 이상 |`;

test("다른 요구사항의 원문 줄을 장비 규격으로 가져오면 제외한다", () => {
  const source = "요구사항 번호 ECR-001\n업무 서버\n메모리 256GB\n요구사항 번호 ECR-002\nDB 서버\n메모리 1024GB\n요구사항 번호 SFR-001\n화면 메모리 8GB";
  const [item] = parseResult({ response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", from: 3, to: 3 }, { field: "메모리", from: 6, to: 6 }, { field: "메모리", from: 8, to: 8 }] }] } }, source, "rfp", 0);
  assert.deepEqual(item.장비요약[0].규격.map((fact) => fact.값), ["메모리 256GB"]);
  assert.equal(item.불확실.filter((message) => message.includes("제외함")).length, 2);
});

test("두 요구사항에 걸친 근거 범위는 하나의 장비 규격으로 합치지 않는다", () => {
  const source = "ECR-001 업무 서버\n메모리 256GB\nECR-002 DB 서버\n메모리 1024GB";
  const [item] = parseResult({ response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", from: 2, to: 4 }] }] } }, source, "rfp", 0);
  assert.equal(item.장비요약[0].규격.length, 0);
  assert.match(item.불확실.join(" "), /다른 요구사항/);
});

test("구형 문자열 근거도 다른 장비에서만 찾을 수 있으면 제외한다", () => {
  const source = "ECR-001 업무 서버\n메모리 256GB\nECR-002 DB 서버\n메모리 1024GB";
  const [item] = parseResult({ response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", value: "1024GB", evidence: "메모리 1024GB" }, { field: "메모리", value: "256GB", evidence: "메모리 256GB" }] }] } }, source, "rfp", 0);
  assert.deepEqual(item.장비요약[0].규격.map((fact) => fact.값), ["256GB"]);
});

test("번호 앞의 공통 본문은 장비별 적용을 확인한 것으로 표시하지 않는다", () => {
  const source = "메모리 256GB\nECR-001 업무 서버\n메모리 1024GB";
  const [item] = parseResult({ response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", from: 1, to: 1 }] }] } }, source, "rfp", 0);
  assert.equal(item.장비요약[0].규격[0].검증, "확인 필요");
  assert.match(item.불확실.join(" "), /소속 확인/);
});

test("라이선스 전용 표는 제외하되 서버 본문의 라이선스 조건은 보존한다", () => {
  const table = (id, name) => `| 요구사항 번호 | ${id} |\n| 요구사항 명칭 | ${name} |\n| 세부 내용 | CPU 32코어, 메모리 256GB, 라이선스 포함 |\n`;
  const source = table("ECR-001", "장비 라이선스") + table("ECR-002", "서버(라이선스 포함)") + table("ECR-003", "라이선스 관리 서버") + table("ECR-004", "라이선스 구매");
  assert.deepEqual(requirementSections(source).sections.map((entry) => entry.id), ["ECR-002", "ECR-003"]);
  assert.ok(splitDocument(source).every((chunk) => chunk.includes("라이선스 포함")));
});
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
test("모델의 줄 번호로 값과 근거를 복원하고 틀린 범위는 그 규격만 빼고 남긴다", () => {
  const text = "장비-001\n서버당 메모리 256GB 이상\n2대 신규 도입";
  const facts = [{ field: "메모리", from: 2, to: 2 }];
  const result = { response: { items: [{ id: "장비-001", kind: "서버", name: "서버", facts }] } };
  const [item] = parseResult(result, text, "rfp", 0);
  assert.equal(item.장비요약[0].규격[0].값, "서버당 메모리 256GB 이상");
  assert.equal(item.장비요약[0].규격[0].근거, "서버당 메모리 256GB 이상");
  assert.ok(!item.불확실.some((message) => message.includes("ID")));
  // 범위가 문서 밖이어도 구간 전체를 버리지 않는다. 그 규격만 빼고 무엇을 뺐는지 남긴다.
  facts.push({ field: "수량", from: 3, to: 99 });
  const [tolerated] = parseResult(result, text, "rfp", 0);
  assert.equal(tolerated.장비요약[0].규격.length, 1);
  assert.ok(tolerated.불확실.some((message) => message.includes("수량") && message.includes("제외")));
  assert.equal(sourceLines("가".repeat(1000)).join(""), "가".repeat(1000));
});
test("이름이 같아도 장비 표만 남기고 소프트웨어·PC·UPS 표는 제외한다", () => {
  const table = (id, name) => `| 요구사항 고유번호 | ${id} |\n| 요구사항 명칭 | ${name} |\n| 세부 내용 | CPU 32코어, 메모리 256GB |\n`;
  const text = table("ECR-010", "NMS/SMS서버") + table("ECR-038", "NMS/SMS") + table("ECR-012", "백신관리서버")
    + table("ECR-046", "백신(PC용/서버용)") + table("ECR-033", "PC 및 복합기") + table("ECR-026", "SAN 스위치");
  assert.deepEqual(requirementSections(text).sections.map((section) => section.id), ["ECR-010", "ECR-012", "ECR-026"]);
});

test("쪽이 갈려 번호만 남은 표는 명칭으로 본문을 잇는다", () => {
  const source = [
    "요구사항 고유번호 ECR-018",
    "요구사항 분류 시스템 장비구성 요구사항",
    "요구사항 명칭 유해사이트차단",
    "요구사항 고유번호 ECR-016",
    "요구사항 명칭 문서보안서버",
    "세부 내용 CPU 8core, 메모리 16GB",
    "- 21 -",
    "정의 유해사이트차단 규격",
    "세부 내용 CPU 16core, 메모리 32GB",
  ].join("\n");
  const 선별 = requirementSections(source).sections;
  assert.deepEqual(선별.map((section) => section.id).sort(), ["ECR-016", "ECR-018"]);
  assert.ok(선별.find((section) => section.id === "ECR-018").text.includes("CPU 16core"), "다음 쪽의 규격을 이어 붙인다");
});

test("꼬리 없는 이름이 같은 문서의 장비 이름 앞부분이면 소프트웨어로 본다", () => {
  const table = (id, name) => `요구사항 고유번호 ${id}\n요구사항 명칭 ${name}\n세부 내용 CPU 8core, 메모리 16GB\n`;
  const source = table("ECR-041", "서버보안") + table("ECR-015", "서버보안서버")
    + table("ECR-023", "백본 스위치(내부망)") + table("ECR-024", "백본 스위치(인터넷망)");
  const 선별 = requirementSections(source).sections.map((section) => section.id);
  assert.ok(!선별.includes("ECR-041"), "서버보안은 서버보안서버의 앞부분이라 뺀다");
  assert.deepEqual(선별.sort(), ["ECR-015", "ECR-023", "ECR-024"], "둘 다 장비인 이름끼리는 서로를 떨어뜨리지 않는다");
});

test("이름이 랙 하나인 표는 빼되 트랜시버를 함께 적은 표는 남긴다", () => {
  const table = (id, name) => `요구사항 고유번호 ${id}\n요구사항 명칭 ${name}\n세부 내용 42U, 포트 48개, 메모리 16GB\n`;
  const 선별 = requirementSections(table("ECR-031", "서버 RACK") + table("ECR-NW-12", "SFP & Rack")).sections.map((section) => section.id);
  assert.deepEqual(선별, ["ECR-NW-12"]);
});

test("보안장비·회선 표는 빼되 명칭에 서버·스토리지·스위치가 있으면 남긴다", () => {
  const table = (id, name) => `요구사항 고유번호 ${id}\n요구사항 명칭\n${name}\n세부 내용 CPU 8Core 이상, Memory 16GB 이상\n`;
  const source = table("ECR-009", "보안장비 구성") + table("ECR-011", "기반시설·회선 및 시스템 연계")
    + table("ECR-020", "내부 방화벽") + table("ECR-021", "VPN관리서버") + table("ECR-022", "스위치 및 회선 구성")
    + table("ECR-003", "서버 구성");
  const 선별 = requirementSections(source).sections.map((section) => section.id);
  assert.deepEqual(선별, ["ECR-021", "ECR-022", "ECR-003"]);
});

test("명칭을 읽지 못한 표는 본문에 방화벽·회선이 있어도 남긴다", () => {
  const source = "요구사항 고유번호 ECR-004\n세부 내용 CPU 32core, 메모리 256GB\n방화벽 구간 뒤에 두고 전용 회선으로 연결\n";
  assert.deepEqual(requirementSections(source).sections.map((section) => section.id), ["ECR-004"]);
});
