import test from "node:test";
import assert from "node:assert/strict";
import { requirementSections, sourceLines } from "./ecr-source.js";
import { splitDocument, parseResult } from "./ecr.js";

test('물리 규격이 없는 구성 계획은 새 장비로 세지 않고 실제 서버 수치가 있는 표는 유지',()=>{
  const plan='요구사항 번호 ECR-001\n요구사항 명칭 가상화시스템 구성\n정의 가상 시스템 구축을 위한 구성 계획 제시\n세부내용\n서비스 가용성, 백업 및 장애 대응 방안 제시\n';
  assert.equal(requirementSections(plan).sections.length,0);
  assert.equal(requirementSections(plan+'CPU 16core 메모리 64GB\n서버 2대 도입\n').sections.length,1);
  assert.equal(requirementSections(plan+'서버 2대 도입\n').sections.length,1);
  const migration=plan.replace('가상화시스템 구성','데이터 마이그레이션').replace('가상 시스템 구축을 위한 구성 계획 제시','기존 데이터 이관방안 계획 제시');
  assert.equal(requirementSections(migration).sections.length,0);
});
test('테이프·포트 규격과 자원 증설, 혼합 HW/SW 표의 실제 서버도 놓치지 않는다',()=>{
  const section=(id,name,body)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n${body}\n`;
  const source=section('ECR-01','PTL 드라이브 증설','LTO-8 Tape Drive Module\n15EA')
    +section('ECR-02','L2 스위치 – 필수 제안','48Port 1/10G\n6EA')
    +section('ECR-03','모바일 WEB 중계서버 자원(CPU, Memory 등) 증설','세부내용\n메모리 32GB')
    +section('ECR-04','시스템 H/W 및 S/W 도입·설치','최소 요구 규격(서버)\nCPU\nMemory\n64GB')
    +section('ECR-05','서버 S/W 라이선스 증설','세부내용\nCPU 16Core 라이선스');
  assert.deepEqual(requirementSections(source).sections.map(s=>s.id),['ECR-01','ECR-02','ECR-03','ECR-04']);
});
test('소프트웨어 목적의 서버 도입과 공통 표 안의 실제 신규 장비는 선별',()=>{
  const section=(id,name,body)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n세부 내용\n${body}\n`;
  const source=section('ECR-001','웹 기안기 업그레이드를 위한 서버 도입','CPU 16core\n메모리 64GB')
    +section('ECR-002','서버 공통 요구사항','구분 수량 규격\nGPU서버 2대 신규도입\nCPU : 3GHz\n메모리 : 64GB')
    +section('ECR-003','서버 공통 정책','모든 서버는 보안 정책을 준수한다')
    +section('ECR-004','웹 기안기 서버 내 S/W 증설','CPU 16core 라이선스');
  assert.deepEqual(requirementSections(source).sections.map(s=>s.id),['ECR-001','ECR-002']);
});
const document = `# 사업 소개\n일반 배경입니다.\n# 요구사항 총괄표\n| ECR-001 | 서버 |\n| 장비-002 | 스토리지 |\n# 상세 요구사항\n| 요구사항 고유번호 | ECR-001 |\n| 요구사항 명칭 | 업무 서버 |\n| 세부 내용 | 서버당 메모리 256GB 이상 |\n| 요구사항 고유번호 | SFR-001 |\n| 세부 내용 | 로그인 화면 |\n| 요구사항 고유번호 | 장비-002 |\n| 요구사항 명칭 | 스토리지 |\n| 세부 내용 | Usable 100TB 이상 |`;

test('공백과 사업 접두어가 붙은 기능 번호에서 장비 표를 끝낸다',()=>{
  for(const id of ['기능 -001','노후장비교체 - 기능 -001']){
    const source=`장비-063\n요구사항 명칭 SAN 스위치\n세부 내용\n48Port 이상\n${id}\n요구사항 분류 기능 요구사항\n요구사항 명칭 설치 계획\n${'업무 화면 구성\n'.repeat(15000)}`;
    const sections=requirementSections(source).sections;
    assert.equal(sections.length,1);
    assert.ok(!sections[0].text.includes('설치 계획'));
    assert.equal(splitDocument(source).length,1);
    const [item]=parseResult({response:{items:[{id:'장비-063',kind:'스위치',name:'SAN 스위치',facts:[{field:'기타 조건',value:'업무 화면 구성',evidence:'업무 화면 구성'}]}]}},source,'rfp.pdf',0);
    assert.equal(item.장비요약[0].규격.length,0);
  }
});

test('소프트웨어 사업명 아래의 실제 납품·증설 하드웨어 표를 포함하고 실행 환경은 제외',()=>{
  const table=(id,name,body)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n세부 내용\n${body}\n`;
  const source=table('ECR-001','전자결재 시스템 구성','도입 제품\n서버 최소 요구 규격\n수량 2식\nCPU 3.1GHz\nMEM 128GB')
    +table('ECR-002','망연계시스템 (HW, SW)','CPU Xeon 2.6GHz\nMEM 32GB\nSSD 240GB\n수량 6식')
    +table('ECR-003','원격분석 OS 디스크 증설','가용량 3TB\nRAID-1')
    +table('ECR-004','백업 솔루션','도입 규격\n수량 2식\nCPU: 2.2GHz\n메모리: 64GB\n디스크: 7.2K NL-SAS')
    +table('ECR-005','포털 서버 재배치','도입 제품\n서버 증설 요구 규격\nCPU 16Core\nMemory 32GB\n수량 1식')
    +table('ECR-006','웹메일 백업장비(LTO) 교체','LTO8 드라이브 2개')
    +table('ECR-007','백신 프로그램 도입','실행 환경\nCPU 2GHz\n메모리 32GB\nSSD 240GB')
    +table('ECR-008','전자결재 소프트웨어','기존 서버 현황\nCPU 2GHz\nMemory 32GB\n수량 1식');
  assert.deepEqual(requirementSections(source).sections.map(x=>x.id),['ECR-001','ECR-002','ECR-003','ECR-004','ECR-005','ECR-006']);
});

test('SAN 포트 블레이드 모델명을 요구사항 경계로 오인하지 않는다',()=>{
  const source='고유번호 ECR-009\n요구사항 명칭 백업 SAN 스위치 증설\n모델 품목명 수량\nBR-DCX8510-B-2148\nPORT BLADE, FC16-48 48P\n2식\n요구사항 번호 SFR-001\n화면 기능';
  const {sections}=requirementSections(source);
  assert.equal(sections.length,1);
  assert.ok(sections[0].text.includes('PORT BLADE'));
  assert.ok(sections[0].text.includes('2식'));
  assert.ok(!sections[0].text.includes('화면 기능'));
});

test('NIR·AIR의 장비 표와 같은 번호의 계속 쪽을 선별하되 소프트웨어/테스트 표는 제외', () => {
  const table=(id,name,body)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n세부 내용\n${body}\n`;
  const source=table('NIR-003','L2스위치 도입','24Port 이상\n수량 37대')
    +table('AIR-002','서버 도입 및 구성','CPU 16core')
    +'요구사항 번호 AIR-002(계속)\nx86 서버\n메모리 64GB\n'
    +table('AIR-006','소프트웨어 도입 및 구성','CPU 라이선스')
    +table('AIR-007','테스트 요건','서버 메모리 64GB 성능 시험')
    +table('SFR-001','화면 서버 기능','메모리 16GB')
    +'요구사항 번호 AIR-002(계속)\n다른 표를 건너뛴 불명확한 본문\n';
  const {sections}=requirementSections(source);
  assert.deepEqual(sections.map(s=>s.id),['NIR-003','AIR-002']);
  assert.ok(sections[1].text.includes('메모리 64GB'));
  assert.ok(!sections[1].text.includes('불명확한 본문'));
});

test('상세 머리글이 다른 셀과 엇갈려도 하이픈 포트 수 규격이 있는 표는 선별한다', () => {
  const source='고유번호 ECR-007\n요구사항 명칭 협력센터 인프라 자원 보강\n세부 장비를 포함하여 제안\n내용 기존 장비와 호환\nL2 Swich - 24-port 이상 4\n';
  assert.deepEqual(requirementSections(source).sections.map(s=>s.id),['ECR-007']);
});

test('서버의 여러 용도 괄호와 스위치 연결 대상 PC를 소프트웨어 품목으로 오인하지 않는다', () => {
  const section=(id,name)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n세부 내용\nCPU 2.3GHz\n`;
  const source=section('ECR-001','대민영역 가상화 서버(WAS/APP) (내부망)')
    +section('ECR-002','L2 스위치-사용자PC/관리망용(내부망/외부망)')
    +section('ECR-003','백신(PC용/서버용)');
  assert.deepEqual(requirementSections(source).sections.map(s=>s.id),['ECR-001','ECR-002']);
});

test('신규 설치 서버와 세로로 나뉜 상세 머리글을 선별하고 SW 설치는 제외', () => {
  const section=(id,name,body)=>`요구사항 번호 ${id}\n요구사항 명칭 ${name}\n${body}\n`;
  const source=section('ECR-001','사용자 포털 (WEB/WAS)서버 신규 설치','CPU 3.1GHz\nMemory 64GB')
    +section('ECR-002','백업 SAN 스위치 증설','세\n부\n내\n용\nPORT BLADE FC16-48\n2식')
    +section('ECR-003','DBMS 통합시스템 도입','CPU 3.6GHz\n메모리 300GB\nFC HBA 16Gb\n전원 및 팬 이중화')
    +section('ECR-004','포털 서버 S/W 신규 설치','CPU 16core 라이선스')
    +section('ECR-005','DBMS 통합시스템 도입','CPU 16core 라이선스\n메모리 32GB 권장');
  assert.deepEqual(requirementSections(source).sections.map(s=>s.id),['ECR-001','ECR-002','ECR-003']);
});

test("한글 기능 번호에서 장비 구간을 닫아 뒤쪽 기능 본문과 규격이 섞이지 않는다", () => {
  const source = "장비-029-저장장치 교체\n요구사항 분류\n장비 요구사항\n요구사항 명칭\nNAS 스토리지\n요구사항 내용\nUsable 60TB 이상\n"
    + "기능-001-공통\n요구사항 분류\n기능 요구사항\n요구사항 명칭\n응용 기능\n메모리 8GB\n" + "로그인 화면 개발\n".repeat(15000);
  const [section] = requirementSections(source).sections;
  assert.ok(!section.text.includes("로그인 화면"));
  assert.ok(!section.text.includes("메모리 8GB"));
  assert.equal(splitDocument(source).length, 1);
  const [item] = parseResult({ response: { items: [{ id: "장비-029", name: "NAS 스토리지", kind: "스토리지", facts: [{ field: "메모리", from: 14, to: 14 }] }] } }, source, "rfp", 0);
  assert.equal(item.장비요약[0].규격.length, 0, "다른 한글 요구사항의 규격도 가져오지 못한다");
});

test("다른 요구사항의 원문 줄을 장비 규격으로 가져오면 제외한다", () => {
  const source = "요구사항 번호 ECR-001\n업무 서버\n메모리 256GB\n요구사항 번호 ECR-002\nDB 서버\n메모리 1024GB\n요구사항 번호 SFR-001\n화면 메모리 8GB";
  const [item] = parseResult({ response: { items: [{ id: "ECR-001", name: "업무 서버", kind: "서버", facts: [{ field: "메모리", from: 3, to: 3 }, { field: "메모리", from: 6, to: 6 }, { field: "메모리", from: 8, to: 8 }] }] } }, source, "rfp", 0);
  assert.deepEqual(item.장비요약[0].규격.map((fact) => fact.값), ["메모리 256GB"]);
  assert.equal(item.불확실.filter((message) => message.includes("제외함")).length, 2);
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
  // 운영체제도 소프트웨어다. 괄호 안에 OS를 적은 서버와 BIOS는 걸리지 않는다.
  const os = table("ECR-004", "운영체제(OS) 교체") + table("ECR-005", "x86 서버(OS 포함)") + table("ECR-006", "BIOS 설정 서버");
  assert.deepEqual(requirementSections(os).sections.map((section) => section.id), ["ECR-005", "ECR-006"]);
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

test("보안장비 묶음·회선 표는 빼되 방화벽 단품과 서버·스위치 이름은 남긴다", () => {
  const table = (id, name) => `요구사항 고유번호 ${id}\n요구사항 명칭\n${name}\n세부 내용 CPU 8Core 이상, Memory 16GB 이상\n`;
  const source = table("ECR-009", "보안장비 구성") + table("ECR-011", "기반시설·회선 및 시스템 연계")
    + table("ECR-020", "내부 방화벽") + table("ECR-021", "VPN관리서버") + table("ECR-022", "스위치 및 회선 구성")
    + table("ECR-003", "서버 구성") + table("ECR-024", "웹방화벽");
  const 선별 = requirementSections(source).sections.map((section) => section.id);
  assert.deepEqual(선별, ["ECR-020", "ECR-021", "ECR-022", "ECR-003", "ECR-024"]);
});

