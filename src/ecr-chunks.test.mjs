import test from "node:test";
import assert from "node:assert/strict";
import { sliceSection, splitHalves, packPairs, packSparsePairs, equipmentRows } from "./ecr-chunks.js";
import { splitDocument, parseResult } from "./ecr.js";

test('서버 종류별 자원 행은 전체 공통 조건과 자기 소제목 조건만 유지한다',()=>{
  const head='요구사항 번호 AIR-002\n요구사항 명칭 서버 도입\n[ 공통사항 ]\n전원 이중화\n';
  const unix='[ 유닉스 서버 ]\nUnix 최소 사양\n구분: 운영\n규격: CPU 설치: 48\n대수: 2\n\n구분: DR\n규격: CPU 설치: 48\n대수: 1\nUnix 라이선스 포함\n';
  const x86='[ x86 서버 ]\nLinux 최소 사양\n구분: 운영\n규격: CPU: 8코어 / 가상서버 RHEL: 4\n\n구분: DR\n규격: CPU: 8코어 / 가상서버 RHEL: 2\nRack 3개\n';
  const extra='[ 어플라이언스 ]\n보안장비 조건\n';
  const rows=equipmentRows(head+unix+x86+extra);
  assert.equal(rows.length,5);
  for(const row of rows)assert.ok(row.startsWith(head));
  for(const row of rows.slice(0,2)){assert.match(row,/Unix 라이선스 포함/);assert.doesNotMatch(row,/가상서버 RHEL|Rack 3개|보안장비 조건/);}
  for(const row of rows.slice(2,4)){assert.match(row,/Rack 3개/);assert.doesNotMatch(row,/Unix|대수:/);}
  assert.match(rows[4],/보안장비 조건/);
  for(const row of rows.slice(0,4))assert.equal([...row.matchAll(/^구분:/gm)].length,1);
});

test('다른 장비 행을 주어로 명시한 조건을 공통 조건으로 복제하지 않는다',()=>{
  const head='요구사항 번호 ECR-02\n요구사항 명칭 스토리지\n';
  const row=name=>`구분: ${name}\n규격: Usable 96TB\n수량: 1\n`;
  const condition='- 기타 스토리지는 개발/테스트DB영역 제공';
  const tail=`공통 기능\n${condition}\n- 동기(DR DB) 원격 복제\n- 기타 조건은 협의\n`;
  const rows=equipmentRows(head+row('운영')+row('기타')+row('DR')+tail);
  assert.equal(rows.length,3);
  assert.equal(rows.filter(x=>x.includes(condition)).length,1);
  assert.ok(rows[1].includes(condition));
  for(const text of rows){assert.ok(text.includes('동기(DR DB)'));assert.ok(text.includes('기타 조건은 협의'));}
});

test('셀 복원 행은 장비별로 분리하고 번호·공통 조건을 보존한다',()=>{
  const head='요구사항 번호 ECR-02\n요구사항 명칭 스토리지 장비 규격\n';
  const first='구분: 운영\n규격: 용량 96TB, 캐시 1.5TB\n수량: 2\n';
  const second='구분: DR\n규격: 용량 200TB, 캐시 512GB\n수량: 1\n';
  const tail='공통 기능\n전원 및 FAN 이중화\nOEM 제외\n';
  const result=equipmentRows(head+first+'\n'+second+tail);
  assert.deepEqual(result,[head+first+tail,head+second+tail]);
  assert.equal(splitDocument(head+first+'\n'+second+tail).length,2);
  const unclear=head+first+'두 장비를 합쳐 3대\n'+second+tail;
  assert.deepEqual(equipmentRows(unclear),[unclear]);
  const noQuantity=head+first+second.replace('수량: 1','수량: 별도 참조')+tail;
  assert.deepEqual(equipmentRows(noQuantity),[noQuantity]);
});
import { requirementRanges } from "./ecr-source.js";

const TABLE = { size: 2400, overlap: 360, head: true };
const rows = (count) => Array.from({ length: count }, (_, index) => `| 항목${index + 1} | ○ 세부 규격 ${index + 1}: 10/25GbE SFP28 ${(index + 1) * 2}Port 이상, 메모리 ${(index + 1) * 16}GB 이상 제공 및 이중화 구성 |`);
const section = (count) => `요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n요구사항 분류 시스템 장비구성 요구사항\n세부내용\n${rows(count).join("\n")}\n`;
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];

test('큰 표와 짧은 표의 배치 순서 때문에 상한을 넘을 때 원문을 버리지 않고 두 표씩 배치한다',()=>{
  const lengths=[253,313,1027,126,211,427,117,241,936,783,1614,396,594,1382,1520,378,1207,1557,1626,1036,971,1151,1998,1223,1732,1537,1631,788,1767,1907,1348,1996,2162,2048,1598,1903,721,2213,1560,712,1377,1039,842,779,1227,798,1507,606,1800,864,495,747];
  const chunks=lengths.map((length,i)=>`요구사항 번호 ECR-${i+1}\n요구사항 명칭 서버${i+1}\n`.padEnd(length-1,'규')+'\n');
  assert.ok(packPairs(chunks,2400).length>33);
  const packed=packSparsePairs(chunks,2400);
  assert.ok(packed.length<=33);
  for(const chunk of packed){assert.ok(chunk.length<=2400);assert.ok(requirementRanges(chunk).length<=2);}
  for(const original of chunks)assert.equal(packed.filter(text=>text.includes(original)).length,1);
});

test('상한을 넘는 짧은 상세 표를 두 개씩 묶어도 번호·값·소속은 보존한다', () => {
  const tables=Array.from({length:40},(_,i)=>`요구사항 번호 ECR-${String(i+1).padStart(3,'0')}\n요구사항 명칭 업무 서버 ${i+1}\n세부 내용\n메모리 ${(i+1)*64}GB 이상\n`);
  const chunks=splitDocument(tables.join('\n'));
  assert.equal(chunks.length,20);
  for(let i=0;i<chunks.length;i++){
    assert.ok(chunks[i].includes(tables[i*2]));
    assert.ok(chunks[i].includes(tables[i*2+1]));
    assert.ok(chunks[i].length<=2400);
    assert.equal(requirementRanges(chunks[i]).length,2);
  }
  const [item]=parseResult({response:{items:[{id:'ECR-001',name:'업무 서버 1',kind:'서버',facts:[{field:'메모리',value:'128GB 이상',evidence:'메모리 128GB 이상'}]}]}},chunks[0],'rfp.pdf',0);
  assert.equal(item.장비요약[0].규격.length,0);
  assert.ok(item.불확실.some(message=>message.includes('다른 요구사항')));
  assert.equal(splitDocument(tables.slice(0,2).join('\n')).length,2);
});

test('큰 구간을 무리하게 묶거나 33구간 상한을 늘리지 않는다', () => {
  assert.deepEqual(packPairs(['x'.repeat(2400),'y'],2400),['x'.repeat(2400),'y']);
  const tables=Array.from({length:34},(_,i)=>`요구사항 번호 ECR-${i+1}\n요구사항 명칭 업무 서버\n세부 내용\n${'메모리 64GB 이상\n'.repeat(110)}`);
  assert.throws(()=>splitDocument(tables.join('\n')),/표가 많습니다/);
});

test("구간은 줄을 통째로 싣고 숫자를 중간에서 자르지 않는다", () => {
  const source = section(60);
  const whole = new Set(linesOf(source));
  const chunks = sliceSection(source, TABLE);
  assert.ok(chunks.length > 1, "여러 구간으로 나뉘는 표여야 검증이 된다");
  for (const chunk of chunks) for (const line of linesOf(chunk)) assert.ok(whole.has(line), `원문에 없는 줄이 생겼다: ${JSON.stringify(line.slice(0, 40))}`);
});

test("이어지는 구간에도 번호 줄과 명칭 줄을 싣는다", () => {
  const chunks = sliceSection(section(60), TABLE);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith("요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n"), "모델이 어느 표의 어느 장비인지 알 수 있어야 한다");
    // 머리가 있어야 구간의 모든 줄이 그 번호의 것으로 대조된다.
    assert.deepEqual(requirementRanges(chunk).map((range) => range.id), ["ECR-001"]);
  }
  assert.ok(!chunks[1].slice(40).includes("요구사항 분류"), "머리는 명칭 줄까지만 반복한다");
});

test("명칭 라벨과 값이 다른 줄인 PDF 표도 후속 구간에 실제 이름을 반복한다", () => {
  const head = '장비-012\n응락수준\n필수\n요구사항 분류\n시스템 장비구성 요구사항\n요구사항 명칭\n\n청구포털 통합서버\n';
  const source = head + rows(60).join('\n') + '\n';
  const chunks = sliceSection(source, TABLE);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.startsWith(head));
  const [, back] = splitHalves(chunks[0]);
  assert.ok(back.startsWith(head));
  const whole = new Set(linesOf(source)), covered = new Set(chunks.flatMap(linesOf));
  assert.deepEqual(covered, whole);
});

test("명칭 값이 없을 때 본문 라벨을 장비 이름으로 반복하지 않는다", () => {
  const source = 'ECR-001\n요구사항 명칭\n세부 내용\n' + rows(60).join('\n');
  const chunks = sliceSection(source, TABLE);
  assert.ok(chunks[1].startsWith('ECR-001\n요구사항 명칭\n'));
  assert.ok(!chunks[1].includes('세부 내용'));
});

test("앞 구간의 끝 몇 줄을 다시 싣고, 어느 줄도 빠뜨리지 않는다", () => {
  const source = section(60);
  const chunks = sliceSection(source, TABLE);
  const head = "요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n";
  const seen = new Set(linesOf(chunks[0]));
  for (let index = 1; index < chunks.length; index++) {
    const body = linesOf(chunks[index].slice(head.length));
    assert.ok(chunks[index - 1].endsWith(body[0]) || chunks[index - 1].includes(body[0]), "앞 구간에 있던 줄에서 시작한다");
    const repeated = body.filter((line) => seen.has(line)).join("");
    assert.ok(repeated.length > 0 && repeated.length <= 360, `겹침은 360자 이하의 온전한 줄이다(${repeated.length}자)`);
    for (const line of body) seen.add(line);
  }
  for (const line of linesOf(source)) assert.ok(seen.has(line), `빠진 줄: ${line.slice(0, 30)}`);
});

test("잘리는 구간은 줄 단위로 둘로 가르고 뒤쪽에도 표 머리를 싣는다", () => {
  const [chunk] = sliceSection(section(20), TABLE);
  const [front, back] = splitHalves(chunk);
  assert.ok(front.length < chunk.length && back.length < chunk.length, "양쪽 모두 원래보다 작다");
  assert.ok(back.startsWith("요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n"));
  const whole = new Set(linesOf(chunk)), covered = new Set([...linesOf(front), ...linesOf(back)]);
  for (const line of covered) assert.ok(whole.has(line), "원문에 없는 줄을 만들지 않는다");
  for (const line of whole) assert.ok(covered.has(line), "가르면서 줄을 빠뜨리지 않는다");
});

test("두 표를 묶은 구간이 잘리면 표 사이에서 가르고 앞 표의 머리를 뒤쪽에 싣지 않는다", () => {
  // 실문서: 가운데 줄에서 가른 뒤쪽 절반이 "고유번호 ECR-B-001-03" 머리 아래 ECR-B-001-04 표를 통째로 가져,
  // 모델이 뒤 표의 규격을 앞 표 번호로 돌려주었고 장비가 통째로 빠졌다.
  const table = (id, name, count) => `고유번호 ${id}\n요구사항 명칭 통신 및 부대장비 교체\n정의 ${name} 교체 요구사항\n` + rows(count).join("\n") + "\n";
  const chunk = table("ECR-B-001-03", "포털망 외부 L7 스위치", 14) + table("ECR-B-001-04", "포털망 DMZ L7 스위치", 10);
  const [front, back] = splitHalves(chunk);
  assert.equal(front + back, chunk);
  assert.ok(back.startsWith("고유번호 ECR-B-001-04\n"));
  assert.ok(!back.includes("ECR-B-001-03") && !front.includes("ECR-B-001-04"));
});

test("글자 수로 자르던 때보다 구간이 늘지 않는다", () => {
  // 구간 상한 33은 그대로다. 줄 단위로 바꾸면서 같은 문서가 구간을 더 쓰면 전에 되던 문서가 거절된다.
  const before = (length, size) => (length <= size ? 1 : 1 + Math.ceil((length - size) / (size - 600)));
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const widest = [20, 60, 120, 239, 700][round % 5];
    let text = "요구사항 고유번호 ECR-001\n요구사항 명칭 시험 서버\n";
    const target = 2000 + Math.floor(random() * 18000);
    while (text.length < target) text += `${"규격 ".repeat(1 + Math.floor(random() * widest / 3)).slice(0, 1 + Math.floor(random() * widest))}\n`;
    for (const [size, head] of [[2400, true], [5000, false]]) {
      const count = sliceSection(text, { size, overlap: 360, head }).length;
      assert.ok(count <= before(text.length, size), `${text.length}자·줄 최대 ${widest}자: ${count}구간 > 예전 ${before(text.length, size)}구간`);
    }
  }
});
