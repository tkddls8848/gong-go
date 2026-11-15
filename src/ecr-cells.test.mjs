import test from 'node:test';
import assert from 'node:assert/strict';
import { separateCells, cellValue, rowFacts } from './ecr-cells.js';
import { normalizeItems } from './ecr-normalize.js';
import { selectDocument } from './ecr.js';

test('자원 행의 내장디스크와 OS별 가상서버 조건을 분리하며 빈 셀을 수량으로 만들지 않는다',()=>{
  const spec='CPU: 8코어x2개 / 메모리: 384GB / 내장디스크: 480GBx3개 / 가상서버 RHEL: 4 / 가상서버 윈도우: (빈 셀)';
  assert.deepEqual(rowFacts(spec,'서버').map(f=>[f.항목,f.값]),[
    ['CPU','8코어x2개'],['메모리','384GB'],['로컬 디스크','480GBx3개'],['기타 조건','가상서버 RHEL: 4']]);
});

test('물품표 한 셀의 CPU·RAM·HDD 라벨 경계를 유지한다',()=>{
  const source='CPU : 12core * 14 RAM : 32G*9 / 16G*5 HDD :2TB2.5HDD*12';
  assert.deepEqual(rowFacts(source,'서버').map(f=>[f.항목,f.값]),[
    ['CPU','12core * 14'],['메모리','32G*9 / 16G*5'],['로컬 디스크','2TB2.5HDD*12']]);
});

test('디스크 뒤 운영체제SW 머리글을 디스크 값에 포함하지 않는다',()=>{
  const source='HDD :2TB2.5HDD*12/1.92TB2.5SDD*3 운영체제SW - Hyperviseor Agnostic Installer - Controller VM - Starter Manager';
  const [disk]=rowFacts(source,'서버');
  assert.equal(disk.값,'2TB2.5HDD*12/1.92TB2.5SDD*3');
  assert.equal(disk.근거,'HDD :2TB2.5HDD*12/1.92TB2.5SDD*3');
  assert.ok(source.includes(disk.근거));
  assert.equal(rowFacts('HDD : 운영체제SW 포함 디스크','서버')[0].값,'운영체제SW 포함 디스크');
});

test('붙여쓴 Usable 용량과 관리 노드, SFP 수와 MAC 최대 조건을 원문대로 보존',()=>{
  const storage='백업관리대상 5node Storageusable10TB 이상 관리서버 및 서버용 OS포함';
  assert.deepEqual(rowFacts(storage,'스토리지').map(f=>[f.항목,f.값]),[['Usable 용량','10TB 이상'],['기타 조건','백업관리대상 5node']]);
  assert.deepEqual(rowFacts('Storage 10TB, unusable20TB, usable3TB/s','스토리지'),[]);
  const network='24 port with 4 SFP GBIC 슬롯 제공 최대 8,000개의 MAC주소 구성기능';
  const facts=rowFacts(network,'스위치');
  assert.deepEqual(facts.map(f=>[f.항목,f.값]),[['포트 수','4 SFP GBIC 슬롯 제공'],['기타 조건','최대 8,000개의 MAC주소 구성기능']]);
  assert.ok(facts.every(f=>network.includes(f.근거)&&f.근거.includes(f.값)));
});

test('명시적 규격 셀에서 용량 종류·RAID·미디어·확장 조건을 생략하지 않는다',()=>{
  const source='- 용량 : Usable 96TB 이상 (RAID6) 제공 (Flash) - 캐시 : 1.5TB 이상 제공 - 인터페이스 : FC 32Gbps 64port 이상 제공(128포트 이상 확장지원)';
  const facts=rowFacts(source,'스토리지');
  assert.deepEqual(facts.map(f=>[f.항목,f.값]),[
    ['Usable 용량','Usable 96TB 이상 (RAID6) 제공 (Flash)'],['캐시','1.5TB 이상 제공'],
    ['NIC/HBA','FC 32Gbps 64port 이상 제공(128포트 이상 확장지원)']]);
  assert.ok(facts.every(f=>source.includes(f.근거)&&f.근거.includes(f.값)));
  assert.deepEqual(rowFacts('- 용량 : 96TB','스토리지'),[],'가용/물리 구분을 추측하지 않는다');
  assert.deepEqual(rowFacts('이 장비는 메모리를 제공해야 한다','서버'),[]);
});

test('PDF 번호 셀의 대시 앞뒤 공백을 정리하고 다른 규격 수치는 보존',()=>{
  const source='요구사항 번호 장비 - 013\n요구사항 명칭 DB 서버\nCPU 3.6GHz\n요구사항 번호 ECR- 014\n요구사항 명칭 스토리지\nUsable 19TB 이상';
  const selection=selectDocument(source);
  assert.deepEqual(selection.sections.map(s=>s.id),['장비-013','ECR-014']);
  assert.ok(selection.unfolded.includes('CPU 3.6GHz'));
  assert.ok(selection.unfolded.includes('Usable 19TB 이상'));
  assert.equal(separateCells('CPU - 2개\nLTO - 8'), 'CPU - 2개\nLTO - 8');
});
test('사업 구분이 붙은 장비 번호를 줄 경계와 선별 결과에서 보존한다',()=>{
  const source='노후장비교체 - 장비 -011\n요구사항 명칭 HP 서버 메모리 증설\nCPU 3GHz\n메모리 32GB\n노후장비교체 - 장비 -012\n요구사항 명칭 IBM 서버 메모리 증설\n메모리 64GB';
  assert.deepEqual(selectDocument(source).sections.map(s=>s.id),['노후장비교체-장비-011','노후장비교체-장비-012']);
});
test('PDF에서 붙은 항목 경계를 분리하되 수치와 조건은 보존', () => {
  const text='장비(CPU) 3.6Ghz, 16core * 2 이상(MEM) 64GB 이상(DISK) 960GB SSD * 2 이상(NIC) 1G NIC 4port 이상(OS) RHEL';
  assert.equal(separateCells(text).split('\n').length,6);
  assert.equal(cellValue('메모리',text),'64GB 이상');
  const result=normalizeItems([{장비요약:[{규격:[{항목:'메모리',값:text,근거:text,검증:'원문 확인'}]}]}]);
  assert.deepEqual(result[0].장비요약[0].규격[0].정규화,[{수치:64,단위:'GB',조건:'이상'}]);
});
test('설명 속 단독 괄호와 수치는 바꾸지 않음',()=>{
  const text='프로세서(CPU) 2개 이상, 64GB 메모리';
  assert.equal(separateCells(text),text);
  assert.equal(cellValue('CPU',text),text);
});
test('PDF의 번호 공백과 글머리표, 붙은 수량 셀을 분리',()=>{
  const result=separateCells('ECR - 002\n(기타) JVM 설치2식\n공통§ 전원 이중화§ OS 지원');
  assert.ok(result.startsWith('ECR-002'));
  assert.ok(result.includes('설치\n2식'));
  assert.ok(result.includes('공통\n§ 전원 이중화\n§ OS 지원'));
});
test('한 줄 끝에 붙은 추가 장비 주석을 별도 줄로 보존',()=>{
  const source='I/O 인터페이스 10G 4port※ 연구용 스토리지 Usable 100TB, SAN스위치 포함○ 도입 S/W';
  assert.equal(separateCells(source),'I/O 인터페이스 10G 4port\n※ 연구용 스토리지 Usable 100TB, SAN스위치 포함\n○ 도입 S/W');
});
