import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResult } from './ecr.js';
import { compareCoverage } from './ecr-coverage.js';
import { consolidate } from './ecr-merge.js';

test('같은 요구사항의 다른 장비에 숫자만 있는 수량 인용을 붙이지 않는다',()=>{
  const source='요구사항 번호 ECR-015\nGPU서버 2대\n수량 2식\n연구분석용 스토리지 Usable 100TB, SAN스위치포함\n백업관리 2식';
  const items=[{id:'ECR-015',kind:'서버',name:'GPU서버',facts:[{field:'수량',value:'2대',evidence:'GPU서버 2대'}]},
    {id:'ECR-015',kind:'스위치',name:'SAN스위치',facts:[{field:'수량',value:'2식',evidence:'2식'}]}];
  const result=parseResult({response:{items}},source,'rfp.pdf',0);
  assert.equal(result[0].장비요약[0].규격[0].검증,'원문 확인');
  assert.equal(result[1].장비요약[0].규격[0].검증,'확인 필요');
  const separate='요구사항 번호 ECR-001\n서버\n2대\n요구사항 번호 ECR-002\n스위치\n3대';
  const separateItems=[{id:'ECR-001',kind:'서버',name:'서버',facts:[{field:'수량',value:'2대',evidence:'2대'}]},
    {id:'ECR-002',kind:'스위치',name:'스위치',facts:[{field:'수량',value:'3대',evidence:'3대'}]}];
  assert.ok(parseResult({response:{items:separateItems}},separate,'rfp.pdf',0).every(r=>r.장비요약[0].규격[0].검증==='원문 확인'));
});

test('여러 장비 목록의 총합을 개별 장비 수량의 확인된 근거로 쓰지 않는다',()=>{
  const source='요구사항 번호 ECR-001\n요구사항 명칭 UNIX 서버\n총 17식(운영 및 개발 14식, DR 3식)\n구분: 가급 서버A\n규격: 예상 Core: 50\n구분: 가급 서버B\n규격: 예상 Core: 20';
  const [result]=parseResult({response:{items:[{id:'ECR-001',kind:'서버',name:'서버A',facts:[{field:'수량',value:'17식',evidence:'총 17식(운영 및 개발 14식, DR 3식)'},{field:'CPU',value:'50',evidence:'예상 Core: 50'}]}]}},source,'rfp.pdf',0);
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='수량').검증,'확인 필요');
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='CPU').검증,'원문 확인');
});

test('한글 줄바꿈·띄어쓰기는 근거 대조에서 허용하지만 숫자 경계와 다른 요구사항 소속은 유지한다',()=>{
  const source='요구사항 번호 ECR-001\n요구사항 명칭 서버\n제조사가 제\n공하는 케어팩 포함\n메모리: 1\n28GB\n요구사항 번호 ECR-002\n요구사항 명칭 스토리지\n압축 기능을 제\n공해야 한다';
  const [result]=parseResult({response:{items:[{id:'ECR-001',kind:'서버',name:'서버',facts:[
    {field:'유지보수',value:'제조사가 제공하는 케어팩',evidence:'제조사가 제공하는 케어팩 포함'},
    {field:'메모리',value:'128GB',evidence:'메모리: 128GB'},
    {field:'기타 조건',value:'압축 기능',evidence:'압축 기능을 제공해야 한다'}
  ]}]}},source,'rfp.pdf',0);
  const facts=result.장비요약[0].규격;
  assert.equal(facts.find(f=>f.항목==='유지보수').검증,'원문 확인');
  assert.equal(facts.find(f=>f.항목==='메모리').검증,'확인 필요');
  assert.equal(facts.some(f=>f.항목==='기타 조건'),false);
});

test('수량 없는 물리 자원 행에서 가상서버 수를 수량으로 보충하지 않고 규격 조건을 보존한다',()=>{
  const source='요구사항 번호 AIR-002\n요구사항 명칭 서버 도입\n[ x86 서버 ]\n구분: 운영 IT운영 1호기\n규격: CPU: 8코어x2개 / 메모리: 384GB / 내장디스크: 480GBx3개 / 가상서버 RHEL: 4 / 가상서버 윈도우: 1';
  const parsed=parseResult({response:{items:[{id:'AIR-002',kind:'서버',name:'서버',facts:[{field:'수량',value:'4',evidence:'가상서버 RHEL: 4'}]}]}},source,'rfp.pdf',0);
  const [result]=consolidate(parsed,{verifiedOnly:true}),[device]=result.장비요약;
  assert.match(device.명칭,/운영 IT운영 1호기/);
  assert.ok(!device.규격.some(f=>f.항목==='수량'));
  assert.ok(device.규격.some(f=>f.항목==='로컬 디스크'&&f.값==='480GBx3개'));
  assert.ok(device.규격.some(f=>f.항목==='기타 조건'&&f.값==='가상서버 RHEL: 4'));
});

test('단일 대수 행의 활성 규격을 보충하고 가상서버 별도 장비를 제외한다',()=>{
  const source='요구사항 번호 AIR-002\n요구사항 명칭 서버 도입\n[ 유닉스 서버 ]\n구분: 재해 복구 내부\n규격: CPU (코어) (1대 기준) 설치: 48 / CPU (코어) (1대 기준) act.: 18 / 메모리 (GB) (1대 기준) 설치: 1,024 / 메모리 (GB) (1대 기준) act.: 858\n대수: 1\n가상서버 4대 구성';
  const continued=source+'\n요구사항 번호 AIR-002(계속)\n메모리 활성화 지원';
  const result=parseResult({response:{items:[
    {id:'AIR-002',kind:'서버',name:'서버',facts:[{field:'수량',value:'1',evidence:'대수: 1'}]},
    {id:'AIR-002',kind:'서버',name:'가상서버',facts:[{field:'수량',value:'4',evidence:'가상서버 4대 구성'}]}
  ]}},continued,'rfp.pdf',0);
  const merged=consolidate(result,{verifiedOnly:true});
  const devices=merged.flatMap(x=>x.장비요약);
  assert.equal(devices.length,1);
  assert.match(devices[0].명칭,/재해 복구 내부/);
  assert.ok(devices[0].규격.some(f=>f.항목==='CPU'&&f.값==='CPU (코어) (1대 기준) act.: 18'));
  assert.ok(devices[0].규격.some(f=>f.항목==='메모리'&&f.값==='메모리 (GB) (1대 기준) act.: 858'));
  assert.equal(devices[0].규격.find(f=>f.항목==='수량').값,'1');
});

test('가상서버 OS별 개수를 물리 장비 수량의 확인된 근거로 쓰지 않는다',()=>{
  const source='요구사항 번호 AIR-002\n요구사항 명칭 x86 서버\n구분: 운영 IT운영 1호기\n규격: CPU: 8코어x2개 / 가상서버 RHEL: 4 / 가상서버 윈도우: 1';
  const [result]=parseResult({response:{items:[{id:'AIR-002',kind:'서버',name:'x86 서버',facts:[
    {field:'수량',value:'4',evidence:'가상서버 RHEL: 4'},
    {field:'CPU',value:'8코어x2개',evidence:'CPU: 8코어x2개'}]}]}},source,'rfp.pdf',0);
  assert.equal(result.장비요약[0].규격.some(f=>f.항목==='수량'),false);
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='CPU').검증,'원문 확인');
});

test('단일 표의 규격 근거로 생략된 ID를 복원해도 바꿔 쓴 이름의 불확실성은 유지',()=>{
  const source='요구사항 번호 AIR-002\n요구사항 명칭 유닉스 통합서버\n테스트\n메모리: 64GB 이상 제공';
  const item={id:'',kind:'서버',name:'(테스트) 유닉스 통합서버',facts:[{field:'메모리',value:'64GB 이상',evidence:'메모리: 64GB 이상 제공'}]};
  const [result]=parseResult({response:{items:[item]}},source,'rfp.pdf',0);
  assert.equal(result.id,'AIR-002');
  assert.ok(result.불확실.includes('장비명 원문 확인 필요'));
  assert.equal(result.장비요약[0].규격[0].검증,'원문 확인');
  const [unverified]=parseResult({response:{items:[{...item,facts:[{field:'메모리',value:'128GB',evidence:'메모리: 128GB 이상 제공'}]}]}},source,'rfp.pdf',0);
  assert.notEqual(unverified.id,'AIR-002');
});

test('물품 순번을 요구사항 ID로 쓰지 않고 명시된 저장장치 분류와 수량을 보존',()=>{
  const source='번호: 17\n품명: Backup system\n규격: Storageusable10TB 이상 관리서버 포함\n수량: 2';
  const parsed=parseResult({response:{items:[{id:'17',kind:'서버',name:'Backup system',facts:[{field:'스위칭 용량',value:'10TB 이상',evidence:'Storageusable10TB 이상'}]}]}},source,'rfp.pdf',0);
  const [result]=consolidate(parsed,{verifiedOnly:true});
  assert.notEqual(result.id,'17');
  assert.equal(result.장비요약[0].종류,'스토리지');
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='Usable 용량').값,'10TB 이상');
  assert.equal(result.장비요약[0].규격.find(f=>f.항목==='수량').값,'2');
});

test('명시된 물품 외에 보안 기능만으로 생성한 추가 장비는 내보내지 않는다',()=>{
  const source='번호: 5\n품명: L2 스위치\n규격: 24 port IEEE 802.1x 사용자인증\n수량: 4';
  const items=[{id:'5',kind:'스위치',name:'L2 스위치',facts:[{field:'포트 수',value:'24 port',evidence:'24 port'}]},
    {id:'5',kind:'스위치',name:'(보안)',facts:[{field:'프로토콜',value:'IEEE 802.1x',evidence:'IEEE 802.1x 사용자인증'}]}];
  const [result]=consolidate(parseResult({response:{items}},source,'rfp.pdf',0),{verifiedOnly:true});
  assert.deepEqual(result.장비요약.map(d=>d.명칭),['L2 스위치']);
});

test('같은 모델 장비명도 원문의 운영·DR 행별로 병합하고 동일 행의 중복만 합친다',()=>{
  const row=(role,ports)=>{
    const source=`요구사항 번호 ECR-03\n요구사항 명칭 SAN 스위치 장비 규격\n구분: ${role}\n규격: ${ports}포트\n수량: 2\n`;
    return parseResult({response:{items:[{id:'ECR-03',kind:'스위치',name:'SAN 스위치',facts:[{field:'포트 수',value:`${ports}포트`,evidence:`${ports}포트`}]}]}},source,'rfp.pdf',0);
  };
  const [result]=consolidate([...row('운영',144),...row('DR',42),...row('운영',144)],{verifiedOnly:true});
  assert.deepEqual(result.장비요약.map(x=>[x.명칭,x.규격.map(f=>f.값)]),[
    ['SAN 스위치 장비 규격 (운영)',['144포트','2']],['SAN 스위치 장비 규격 (DR)',['42포트','2']]]);
  assert.ok(result.장비요약.every(x=>x.규격.find(f=>f.항목==='수량').추출==='표 수량 셀'));
});

test('단일 요구사항의 괄호 구분명은 실제 원문 이름이 있을 때 번호를 복원',()=>{
  const source='요구사항 번호 ECR-02\n요구사항 명칭 스토리지\n구분: DR\n용량: 96TB';
  const run=(name,text=source)=>parseResult({response:{items:[{id:'',kind:'스토리지',name,facts:[{field:'Usable 용량',value:'96TB',evidence:'용량: 96TB'}]}]}},text,'rfp.pdf',0)[0];
  assert.equal(run('(DR)').id,'ECR-02');
  assert.equal(run('(DR)').장비요약[0].규격[0].검증,'원문 확인');
  assert.notEqual(run('(운영)').id,'ECR-02');
  assert.notEqual(run('(DR)',source+'\n요구사항 번호 ECR-03\n요구사항 명칭 SAN 스위치\n포트 32개').id,'ECR-02');
});

test('반복으로 채워진 모델 응답은 누락 위험을 표시하고 다른 값은 중복으로 세지 않는다',()=>{
  const source='요구사항 번호 ECR-002\n요구사항 명칭 스토리지\n구분: 운영\n용량: 96TB';
  const fact={field:'용도',value:'운영',evidence:'구분: 운영'};
  const run=facts=>parseResult({response:{items:[{id:'ECR-002',kind:'스토리지',name:'스토리지',facts}]}},source,'rfp.pdf',0)[0];
  assert.ok(run(Array.from({length:100},()=>({...fact}))).불확실.some(x=>x.includes('과도하게 반복')));
  assert.ok(!run(Array.from({length:12},(_,i)=>({...fact,value:String(i)}))).불확실.some(x=>x.includes('과도하게 반복')));
});

test('소수점 수치를 인용 줄 번호로 잘라 검증하지 않는다',()=>{
  const source='서버\nCPU\n6GHz';
  const [item]=parseResult({response:{items:[{id:'',kind:'서버',name:'서버',facts:[{field:'CPU',value:'6GHz',evidence:'3.6GHz'}]}]}},source,'rfp.pdf',0);
  assert.equal(item.장비요약[0].규격[0].검증,'확인 필요');
});

test('문단 순번만 있는 근거는 수량으로 인정하지 않고 실제 수량은 유지',()=>{
  for(const [quote,value,expected] of [
    ['1) 기업인터넷뱅킹 업무 검증을 위한 단위테스트','1','확인 필요'],
    ['2) 기업스마트뱅킹 : 하이브리드 방식','2','확인 필요'],
    ['1) 서버 1대 공급','1','원문 확인'],
    ['2) 수량: 2','2','원문 확인'],
  ]){
    const [item]=parseResult({response:{items:[{id:'',kind:'서버',name:'서버',facts:[{field:'수량',value,evidence:quote}]}]}},'서버\n'+quote,'rfp.pdf',0);
    assert.equal(item.장비요약[0].규격[0].검증,expected,quote);
  }
});

test('원문 NIR·AIR 번호의 유효 규격을 번호 대조에서 미추출로 오인하지 않는다',()=>{
  for(const id of ['NIR-003','AIR-002','HWR-001','노후장비교체-장비-011']){
    const source=`요구사항 번호 ${id}\n요구사항 명칭 업무 서버\n메모리 64GB 이상`;
    const result=parseResult({response:{items:[{id,kind:'서버',name:'업무 서버',facts:[{field:'메모리',value:'64GB 이상',evidence:'메모리 64GB 이상'}]}]}},source,'rfp.pdf',0);
    assert.deepEqual(compareCoverage({expectedIds:[id]},result).missingIds,[]);
    assert.ok(!result[0].불확실.some(x=>x.includes('ID 원문')));
  }
});
test('유일한 표에서 번호를 생략해도 원문 장비명과 근거로 번호를 복원',()=>{
  const source='요구사항 번호 ECR-002\n요구사항 명칭 x86 서버\nCPU 3.6GHz\n메모리 64GB 이상';
  const [item]=parseResult({response:{items:[{id:'',kind:'서버',name:'x86 서버',facts:[{field:'메모리',value:'64GB 이상',evidence:'메모리 64GB 이상'}]}]}},source,'rfp.pdf',0);
  assert.equal(item.id,'ECR-002');
  assert.equal(item.장비요약[0].규격[0].검증,'원문 확인');
});
test('원문에 없는 수치는 확인됨으로 표시하지 않는다',()=>{
  const [item]=parseResult({response:{items:[{id:'',kind:'서버',name:'서버',facts:[{field:'메모리',value:'128GB',evidence:'메모리 64GB'}]}]}},'서버\n메모리 64GB','rfp.pdf',0);
  assert.equal(item.장비요약[0].규격[0].검증,'확인 필요');
});
test('원문 줄 표식을 숫자 목록으로 바꾼 인용은 실제 지정 줄과 일치할 때만 복원',()=>{
  const source='요구사항 번호 ECR-002\n요구사항 명칭 DB 서버\n- CPU 3.6GHz\n- 메모리 1600GB 이상';
  const facts=[{field:'CPU',value:'3.6GHz',evidence:'3. - CPU 3.6GHz'},
    {field:'메모리',value:'1600GB 이상',evidence:'[L4] - 메모리 1600GB 이상'},
    {field:'메모리',value:'1600GB 이상',evidence:'3. - 메모리 1600GB 이상'},
    {field:'메모리',value:'800GB 이상',evidence:'4. - 메모리 800GB 이상'}];
  const [item]=parseResult({response:{items:[{id:'ECR-002',kind:'서버',name:'DB 서버',facts}]}},source,'rfp.pdf',0);
  assert.deepEqual(item.장비요약[0].규격.map(x=>x.검증),['원문 확인','원문 확인','확인 필요','확인 필요']);
  assert.equal(item.장비요약[0].규격[0].근거,'- CPU 3.6GHz');
});
