import test from "node:test";
import assert from "node:assert/strict";
import { consolidate } from "./ecr-merge.js";

const ORDER = ["수량", "CPU", "메모리", "로컬 디스크"];
const fact = (항목, 근거, 검증 = "원문 확인") => ({ 항목, 값: 근거, 근거, 검증 });
// parseResult가 구간마다 돌려주는 모양: 항목 하나에 장비 하나.
const part = (id, kind, name, facts, { chunk = 1, source = "", notes = [] } = {}) => ({
  id, 분류: kind, 명칭: name, 세부내용_원문: source, 기본규격: [], 산출물: [], 출처: `rfp.pdf · 구간 ${chunk}`, 불확실: notes,
  장비요약: [{ 종류: kind, 명칭: name, 출처: `rfp.pdf · 구간 ${chunk}`, 규격: facts }],
});
test('같은 근거에서 추출한 CPU 속도와 장착 수량을 모두 보존',()=>{
  const evidence='CPU 2.95GHz 이상, 32core 이상, 서버당 2개 장착';
  const values=['2.95GHz 이상, 32core 이상','서버당 2개 장착'];
  const [result]=consolidate([part('ECR-001','서버','서버',values.map(value=>({...fact('CPU',evidence),값:value})))]);
  assert.deepEqual(result.장비요약[0].규격.map(f=>f.값),values);
});

test('CPU 규격이 있어도 관제 PC·모니터는 서버로 내보내지 않고 PC 관리 서버는 보존',()=>{
  const names=['관제 PC','(모니터일체형)','PC 관리 서버','모니터링 서버'];
  const result=consolidate(names.map((name,i)=>part(`ECR-00${i}`,'서버',name,[fact('CPU','1.8GHz 이상')])));
  assert.deepEqual(result.flatMap(x=>x.장비요약.map(d=>d.명칭)),['PC 관리 서버','모니터링 서버']);
  assert.ok(result[0].불확실.some(x=>x.includes('PC/모니터')));
});

test("같은 줄만 인용한 서버 NIC는 별도 스위치에서 제외한다", () => {
  const line = '(CPU) 16core (MEM) 64GB (NIC) 1G NIC 4port';
  const [result] = consolidate([
    part('ECR-002', '서버', 'x86 서버', [fact('CPU', line), fact('NIC/HBA', line)]),
    part('ECR-002', '스위치', '1G NIC 4port', [fact('NIC/HBA', line)]),
  ]);
  assert.equal(result.장비요약.length, 1);
  assert.equal(result.장비요약[0].종류, '서버');
  assert.ok(result.불확실.some(note => note.includes('별도 장비에서 제외')));
});
test('수량 머리글을 잘못 인용했어도 한 표의 유일한 수량 셀을 복원',()=>{
  const source='요구사항 번호 ECR-002\n요구사항 명칭 서버\n구분 규격 수량\nCPU 16core\n2식';
  const [result]=consolidate([part('ECR-002','서버','서버',[fact('수량','구분 규격 수량'),fact('CPU','CPU 16core')],{source})]);
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='수량').값,'2식');
});
test('엄격한 병합은 근거 미확인 규격과 장비를 제외하고 사유를 남긴다',()=>{
  const [result]=consolidate([
    part('ECR-001','서버','서버',[fact('메모리','64GB'),fact('CPU','전체','확인 필요')]),
    part('ECR-001','스위치','스위치',[fact('포트 수','전체','확인 필요')]),
  ],{verifiedOnly:true});
  assert.equal(result.장비요약.length,1);
  assert.deepEqual(result.장비요약[0].규격.map(f=>f.항목),['메모리']);
  assert.ok(result.불확실.some(n=>n.includes('검증하지 못해')));
});
test('순수 SSD 규격의 전원 오분류를 고치고 실제 전력 조건은 보존',()=>{
  const [result]=consolidate([part('ECR-001','서버','GPU서버',[fact('전원','960GB SSD * 2 이상'),fact('전원','SSD 포함 최대 전력 800W')])]);
  assert.deepEqual(result.장비요약[0].규격.map(f=>f.항목),['로컬 디스크','전원']);
});

test("여러 구간에서 돌아온 같은 장비는 한 항목으로 합치고 규격을 모은다", () => {
  const [item, ...rest] = consolidate([
    part("ECR-001", "서버", "WEB 서버", [fact("CPU", "| CPU | 2.4GHz 16Core 이상 |"), fact("메모리", "| 메모리 | 256GB 이상 |")], { chunk: 1 }),
    part("ECR-001", "서버", "WEB서버", [fact("메모리", "| 메모리 | 256GB 이상 |"), fact("수량", "| 수량 | 2대 |")], { chunk: 2 }),
  ], { fieldOrder: ORDER });
  assert.deepEqual(rest, [], "구간 수만큼 카드를 만들지 않는다");
  assert.equal(item.장비요약.length, 1, "띄어쓰기만 다른 이름은 같은 장비다");
  assert.deepEqual(item.장비요약[0].규격.map((entry) => entry.항목), ["수량", "CPU", "메모리"], "겹친 규격은 한 번만, 정해진 순서로");
  assert.equal(item.장비요약[0].출처, "rfp.pdf · 구간 1, 2");
  assert.equal(item.출처, "rfp.pdf · 구간 1, 2");
});

test("이름이 다르면 같은 번호 안의 다른 장비로 두고 사유에 장비 이름을 밝힌다", () => {
  const [item] = consolidate([
    part("ECR-003", "서버", "WEB 서버", [fact("메모리", "WEB 메모리 128GB")], { notes: ["CPU: 다른 요구사항의 원문 줄을 가리켜 제외함"] }),
    part("ECR-003", "서버", "DB 서버", [fact("메모리", "DB 메모리 512GB")], { notes: ["장비명 원문 확인 필요"] }),
    part("ECR-003", "스토리지", "DB 서버", [fact("Usable 용량", "100TB")], { notes: ["요구사항 ID 원문 확인 필요"] }),
  ]);
  assert.deepEqual(item.장비요약.map((entry) => `${entry.종류}/${entry.명칭}`), ["서버/WEB 서버", "서버/DB 서버", "스토리지/DB 서버"], "종류가 다르면 이름이 같아도 합치지 않는다");
  assert.equal(item.분류, "서버·스토리지");
  assert.equal(item.명칭, "WEB 서버 외 2종");
  assert.deepEqual(item.불확실, ["[WEB 서버] CPU: 다른 요구사항의 원문 줄을 가리켜 제외함", "[DB 서버] 장비명 원문 확인 필요", "요구사항 ID 원문 확인 필요"]);
});

test("한 인용이 다른 인용을 품으면 긴 쪽을 남기되 확인된 규격을 미확인으로 덮지 않는다", () => {
  const long = "CPU 2.4GHz 16Core 이상\n2 Socket 이상";
  const [merged] = consolidate([
    part("ECR-001", "서버", "서버", [fact("CPU", "CPU 2.4GHz 16Core 이상")]),
    part("ECR-001", "서버", "서버", [fact("CPU", long)], { chunk: 2 }),
    part("ECR-001", "서버", "서버", [fact("CPU", "2 Socket 이상")], { chunk: 3 }),
  ]);
  assert.deepEqual(merged.장비요약[0].규격.map((entry) => entry.근거), [long]);
  const [kept] = consolidate([
    part("ECR-002", "서버", "서버", [fact("메모리", "256GB 이상")]),
    part("ECR-002", "서버", "서버", [fact("메모리", "서버당 256GB 이상 권장", "확인 필요")], { chunk: 2 }),
  ]);
  assert.deepEqual(kept.장비요약[0].규격.map((entry) => entry.검증), ["원문 확인", "확인 필요"], "확인된 짧은 규격을 잃지 않는다");
  const [promoted] = consolidate([
    part("ECR-004", "서버", "서버", [fact("메모리", "256GB 이상", "확인 필요")]),
    part("ECR-004", "서버", "서버", [fact("메모리", "256GB 이상")], { chunk: 2 }),
  ]);
  assert.deepEqual(promoted.장비요약[0].규격.map((entry) => entry.검증), ["원문 확인"], "같은 인용은 확인된 쪽으로 남긴다");
  const [separate] = consolidate([part("ECR-005", "서버", "서버", [fact("CPU", "2소켓 256GB"), fact("메모리", "2소켓 256GB")])]);
  assert.equal(separate.장비요약[0].규격.length, 2, "항목이 다르면 같은 줄이어도 따로 둔다");
});

test("겹쳐 자른 구간의 원문은 표 머리와 겹친 줄을 걷어 내고 한 번만 잇는다", () => {
  const head = "요구사항 고유번호 ECR-001\n요구사항 명칭 통합 DB 서버\n";
  const first = `${head}세부내용\nCPU 2.4GHz 16Core 이상 제공\n메모리 512GB 이상 제공\n`;
  const second = `${head}메모리 512GB 이상 제공\n디스크 960GB SSD 2개 이상\n수량 2대\n`;
  const [item] = consolidate([
    part("ECR-001", "서버", "DB 서버", [fact("CPU", "CPU 2.4GHz 16Core 이상 제공")], { source: first }),
    part("ECR-001", "서버", "DB 서버", [fact("수량", "수량 2대")], { chunk: 2, source: second }),
    part("ECR-001", "서버", "DB 서버", [], { chunk: 2, source: second }),
  ]);
  assert.equal(item.세부내용_원문, `${head}세부내용\nCPU 2.4GHz 16Core 이상 제공\n메모리 512GB 이상 제공\n디스크 960GB SSD 2개 이상\n수량 2대\n`);
  assert.equal(item.명칭, "통합 DB 서버", "요구사항 이름은 원문 표의 명칭 칸에서 읽는다");
  assert.equal(item.장비요약[0].명칭, "DB 서버", "장비 이름은 모델이 읽은 그대로 둔다");
});

test("번호가 다르면 합치지 않고 번호의 대시 표기만 다른 것은 같은 번호로 본다", () => {
  const items = consolidate([
    part("ECR-001", "서버", "서버", [fact("메모리", "256GB")]),
    part("ECR–001", "서버", "서버", [fact("수량", "2대")], { chunk: 2 }),
    part("ECR-002", "서버", "서버", [fact("메모리", "128GB")], { chunk: 3 }),
    part("확인 필요 (4)", "스위치", "L2 스위치", [fact("포트 수", "48포트")], { chunk: 4 }),
    part("확인 필요 (5)", "스위치", "L2 스위치", [fact("포트 수", "24포트")], { chunk: 5 }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ["ECR-001", "ECR-002", "확인 필요 (4)", "확인 필요 (5)"], "번호를 모르는 항목은 구간별로 따로 둔다");
  assert.equal(items[0].장비요약[0].규격.length, 2);
  assert.deepEqual(consolidate([]), []);
});

// 교육포털 제안요청서(2026-11)에서 실제 모델이 돌려준 모양. 원문에 스위치 도입은 없고 서버는 3대다.
const NIC = "◦ NIC: 1G UTP 8Port 이상 제공, 10G SFP+ 6Port 이상 제공";
const SAN = "◦ SAN 스위치 연결 기능 제공";
const serverTable = `요구사항 번호 ECR-003\n요구사항 명칭 가상화 서버 통합 운영 노드 규격 정의\n◦ 도입 수량: 3대\n◦ 아래 규격을 충족하여야 함\n◦ CPU: 24Core x 2ea 이상 (2CPU) 이상 제공\n◦ Disk: (OS 영역) SSD 960GB * 2ea 이상 제공\n${NIC}\n`;
test("다른 장비의 규격 줄로 지어낸 장비는 싣지 않고, 놓친 수량은 원문의 수량 줄로 채운다", () => {
  const [tape, server] = consolidate([
    part("ECR-002", "스토리지", "테이프 라이브러리 시스템(PTL)", [fact("도입구분", "◦ 도입 수량: 1대"), fact("기타 조건", "테이프 ◦ 120개 이상"), fact("기타 조건", SAN)]),
    part("ECR-002", "스위치", "SAN 스위치", [fact("기타 조건", SAN)]),
    part("ECR-003", "서버", "가상화 서버", [fact("CPU", "◦ CPU: 24Core x 2ea 이상 (2CPU) 이상 제공"), fact("디스크 구성", "◦ Disk: (OS 영역) SSD 960GB * 2ea 이상 제공"), fact("NIC/HBA", NIC)], { chunk: 2, source: serverTable }),
    part("ECR-003", "스위치", "1G UTP 스위치", [fact("NIC/HBA", NIC)], { chunk: 2, source: serverTable, notes: ["장비명 원문 확인 필요"] }),
    part("ECR-003", "스위치", "10G SFP+ 스위치", [fact("포트 수", NIC)], { chunk: 2, source: serverTable, notes: ["장비명 원문 확인 필요"] }),
  ], { fieldOrder: ORDER });
  assert.deepEqual(tape.장비요약.map((entry) => entry.명칭), ["테이프 라이브러리 시스템(PTL)"]);
  assert.deepEqual(tape.불확실, ['장비 "SAN 스위치": "테이프 라이브러리 시스템(PTL)"의 규격 줄만 가리켜 별도 장비에서 제외함']);
  const quantity = tape.장비요약[0].규격.find((entry) => entry.항목 === "수량");
  assert.deepEqual([quantity.근거, quantity.모델항목], ["◦ 도입 수량: 1대", "도입구분"], "수량을 밝혀 적은 줄은 수량으로 바로잡고 모델의 분류를 남긴다");

  assert.deepEqual(server.장비요약.map((entry) => entry.명칭), ["가상화 서버"], "이름이 원문에 없으면 제 종류의 항목을 달고 있어도 뺀다");
  assert.equal(server.분류, "서버");
  assert.equal(server.불확실.length, 2, "뺀 장비의 이름 사유는 내려놓고 뺐다는 것만 남긴다");
  assert.ok(server.불확실.every((message) => message.includes("제외함") && !message.startsWith("[")));
  const specs = server.장비요약[0].규격;
  assert.deepEqual(specs.map((entry) => entry.항목), ["수량", "CPU", "로컬 디스크", "NIC/HBA"], "서버의 디스크는 로컬 디스크다");
  assert.deepEqual(specs[0], { 항목: "수량", 값: "◦ 도입 수량: 3대", 근거: "◦ 도입 수량: 3대", 검증: "원문 확인", 추출: "규칙" });
});

test("제 규격을 가진 다른 종류의 장비와 같은 종류의 장비는 줄이 겹쳐도 남기고, 수량 줄이 둘이면 채우지 않는다", () => {
  const shared = "◦ 10TB 이상 제공";
  const [mixed] = consolidate([
    part("ECR-010", "서버", "DB 서버", [fact("CPU", "CPU 32Core"), fact("로컬 디스크", shared)]),
    part("ECR-010", "스토리지", "DB 스토리지", [fact("Usable 용량", shared)]),
    part("ECR-010", "서버", "개발 서버", [fact("CPU", "CPU 32Core")]),
  ]);
  assert.deepEqual(mixed.장비요약.map((entry) => entry.명칭), ["DB 서버", "DB 스토리지", "개발 서버"]);
  assert.deepEqual(mixed.불확실, []);
  const twoLines = "ECR-011 서버\n◦ 도입 수량: 2대\n◦ 수량: 케이블 10개\nCPU 16Core\n";
  const [ambiguous] = consolidate([part("ECR-011", "서버", "서버", [fact("CPU", "CPU 16Core")], { source: twoLines })]);
  assert.deepEqual(ambiguous.장비요약[0].규격.map((entry) => entry.항목), ["CPU"], "어느 줄이 이 장비의 수량인지 모르면 지어내지 않는다");
  // 번호 표를 찾지 못해 구간 전체가 원문으로 온 경우. 그 수량 줄이 이 장비의 것인지 알 수 없다.
  const [loose] = consolidate([part("확인 필요 (1)", "서버", "서버", [fact("CPU", "CPU 8Core")], { source: "서버 일반 설명\n◦ 도입 수량: 5대\nCPU 8Core\n" })]);
  assert.deepEqual(loose.장비요약[0].규격.map((entry) => entry.항목), ["CPU"]);
});

test('보안·전화 장비, 라이선스 행, 서버 카드 열 머리글, 규격 조각은 장비로 내보내지 않고 사유를 남긴다',()=>{
  const names=[['서버','IPS'],['서버','DDoS 방어장비'],['스위치','방화벽 부하분산용 L7 스위치'],['스위치','IP전화기(일반)'],
    ['서버','데이터모델링도구 라이센스'],['스위치','스위치 N/W card'],['스위치','(1Gbps Ethernet) 포트'],['서버','core'],['서버','노후연계서버'],['서버','노후 DB서버 교체']];
  const result=consolidate(names.map(([kind,name],i)=>part(`ECR-0${10+i}`,kind,name,[fact(kind==='서버'?'CPU':'포트 수',kind==='서버'?'2.4GHz 16core':'48 port')])));
  assert.deepEqual(result.flatMap(x=>x.장비요약.map(d=>d.명칭)),['방화벽 부하분산용 L7 스위치','노후 DB서버 교체']);
  const notes=result.flatMap(x=>x.불확실);
  for(const reason of ['보안 장비','전화 장비','소프트웨어·라이선스','서버 부품 열 머리글','규격 조각','기존 장비'])assert.ok(notes.some(n=>n.includes(reason)),reason);
});

test('설치 장소만 덧붙인 같은 장비는 하나로 합치고, 망마다 규격이 다르면 그대로 둔다',()=>{
  const [same]=consolidate([
    part('ECR-004','서버','x86 서버',[fact('CPU','2.4GHz 16core 이상')]),
    part('ECR-004','서버','x86 서버 (국방망)',[fact('메모리','256GB 이상')]),
  ]);
  assert.deepEqual(same.장비요약.map(d=>d.명칭),['x86 서버']);
  assert.deepEqual(same.장비요약[0].규격.map(f=>f.항목).sort(),['CPU','메모리']);
  assert.ok(same.불확실.some(n=>n.includes('설치 장소만 다른')));
  const [split]=consolidate([
    part('ECR-005','서버','WEB 서버',[fact('CPU','2.4GHz 16core 이상')]),
    part('ECR-005','서버','WEB 서버 (인터넷망)',[fact('CPU','2.4GHz 8core 이상')]),
  ]);
  assert.equal(split.장비요약.length,2);
});

test('장비명 바로 뒤에만 적힌 수량을 그 장비의 수량으로 쓰고, 여러 값이면 쓰지 않는다',()=>{
  const source='요구사항 고유번호 ECR-020\n요구사항 명칭 네트워크 장비\nL4스위치(6식)\n- 10G 포트 8 port 이상\nOOB 스위치 (2식)\n- 1G 24 port';
  const [result]=consolidate([
    part('ECR-020','스위치','L4스위치',[fact('포트 수','10G 포트 8 port 이상')],{source}),
    part('ECR-020','스위치','OOB 스위치',[fact('포트 수','1G 24 port')],{source}),
  ]);
  const quantity=name=>result.장비요약.find(d=>d.명칭===name).규격.find(f=>f.항목==='수량');
  assert.equal(quantity('L4스위치').값,'6식');
  assert.equal(quantity('L4스위치').추출,'장비명 수량');
  assert.equal(quantity('OOB 스위치').값,'2식');
  const nas='요구사항 고유번호 ECR-001\n○ 품목 및 수량\n- NAS 스토리지 메인 구축/1식\n- 디스크 용량 : Usable 1.5 PB 이상';
  const [storage]=consolidate([part('ECR-001','스토리지','NAS 스토리지',[fact('Usable 용량','Usable 1.5 PB 이상')],{source:nas})]);
  assert.equal(storage.장비요약[0].규격.find(f=>f.항목==='수량').값,'1식');
  const twice='요구사항 고유번호 ECR-021\nL4스위치(6식)\nL4스위치(2식)';
  const [ambiguous]=consolidate([part('ECR-021','스위치','L4스위치',[fact('포트 수','8 port')],{source:twice})]);
  assert.equal(ambiguous.장비요약[0].규격.some(f=>f.항목==='수량'),false);
});

test('표 열이 밀려 다른 항목의 단위만 든 값은 제외하고 사유를 남긴다',()=>{
  const [result]=consolidate([part('ECR-015','서버','챗봇 서버',[
    fact('CPU','64GB'),fact('메모리','2.4GHz 8core'),fact('로컬 디스크','4'),fact('메모리','128GB 이상'),fact('CPU','2.4GHz 8core'),
  ])]);
  assert.deepEqual(result.장비요약[0].규격.map(f=>`${f.항목}:${f.값}`).sort(),['CPU:2.4GHz 8core','메모리:128GB 이상']);
  assert.ok(result.불확실.some(n=>n.includes('열 밀림')));
});

test('핵심 규격도 장비 이름도 없는 항목이 한 번호에 셋 이상이면 품목 목록으로 보고 제외한다',()=>{
  const rows=['서버보안','DB 접근제어','OS 백업','통합관제'].map(name=>part('ECR-B-005-01','서버',name,[fact('수량','2식')]));
  const [list]=consolidate([...rows,part('ECR-B-005-01','서버','관리 서버',[fact('CPU','2.4GHz 16core')])]);
  assert.deepEqual(list.장비요약.map(d=>d.명칭),['관리 서버']);
  assert.ok(list.불확실.some(n=>n.includes('품목 목록')));
  // 하나둘뿐이면 규격을 따로 배포하는 실제 장비일 수 있다.
  const [few]=consolidate([part('ECR-007','스토리지','PDS',[fact('수량','1식')]),part('ECR-007','서버','통합관제',[fact('수량','1식')])]);
  assert.equal(few.장비요약.length,2);
});

test('표 머리나 쪽 번호를 가리킨 값은 원문에 있어도 규격으로 싣지 않는다',()=>{
  const [result]=consolidate([part('ECR-B-004-01','서버','CMS 어플라이언스',[
    fact('CPU','고유번호 ECR-B-004-01'),fact('용도','62 -'),fact('메모리','- 63 -'),fact('포트 수','24'),fact('CPU','2.4GHz 16core'),
  ])]);
  assert.deepEqual(result.장비요약[0].규격.map(f=>`${f.항목}:${f.값}`).sort(),['CPU:2.4GHz 16core','포트 수:24']);
  assert.ok(result.불확실.some(n=>n.includes('표 머리나 쪽 번호')));
});
