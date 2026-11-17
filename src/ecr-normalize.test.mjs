import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFact, normalizeItems, cleanValue, relabelFact } from "./ecr-normalize.js";

const pick = (field, quote) => normalizeFact(field, quote).map(({ 수치, 단위, 조건 }) => `${수치}${단위}${조건 ? ` ${조건}` : ""}`);

test('OS 단독 조건을 하드웨어 규격으로 복제한 응답은 OS로 분류한다',()=>{
  const quote='§ 서버 OS는 제조사 직접 지원이 가능한 제품이어야 함';
  for(const field of ['CPU','메모리','디스크 구성','로컬 디스크','폼팩터','RAID','전원']) {
    const fact={항목:field,값:'제조사 직접 지원이 가능한 제품',근거:quote};
    const corrected=relabelFact('서버',fact);
    assert.equal(corrected.항목,'OS');assert.equal(corrected.모델항목,field);
    assert.equal(corrected.근거,quote);assert.equal(corrected.값,fact.값);
  }
  for(const quote of ['OS는 64GB 메모리를 지원해야 함','운영체제: Linux / CPU 16코어',
    '서버 OS는 제조사 지원 제품\n디스크 SSD 1TB 이상','CPU는 운영체제를 지원해야 함'])
    assert.equal(relabelFact('서버',{항목:'CPU',값:quote,근거:quote}).항목,'CPU');
  assert.equal(relabelFact('서버',{항목:'라이선스',값:'포함',근거:'OS는 라이선스를 포함'}).항목,'라이선스');
});

test('신규와 발주기관 제공을 수량으로 표시하지 않고 제공 주체를 보존한다',()=>{
  const action=relabelFact('서버',{항목:'수량',값:'신규',근거:'신규 서버'});
  assert.equal(action.항목,'도입구분');assert.equal(action.값,'신규');
  const quote='DB 서버, 스토리지, SAN 스위치는 본회에서 제공하며 기타 구성에 필요한 장비는 제안';
  for(const field of ['수량','전원']) {
    const fact=relabelFact('스토리지',{항목:field,값:'제공',근거:quote});
    assert.equal(fact.항목,'기타 조건');assert.equal(fact.값,quote);assert.equal(fact.근거,quote);
  }
  assert.equal(relabelFact('서버',{항목:'수량',값:'2',근거:'서버 2대 신규 제공'}).항목,'수량');
  assert.equal(relabelFact('서버',{항목:'전원',값:'제공',근거:'발주기관에서 제공하는 전원 장치'}).항목,'전원');
});

test('케어팩 지원 조건은 유지보수로 분류하되 명시적인 라이선스는 유지',()=>{
  const value='제조사의 파트너사가 제공하는 케어팩(24시간×7일)';
  assert.equal(relabelFact('서버',{항목:'라이선스',값:value,근거:value}).항목,'유지보수');
  assert.equal(relabelFact('서버',{항목:'라이선스',값:'라이선스 및 케어팩 포함',근거:'라이선스 및 케어팩 포함'}).항목,'라이선스');
});
test('스위칭 용량의 MAC·SFP 오분류를 수정하고 실제 대역폭은 유지',()=>{
  for(const [value,field] of [['8,000개의 MAC주소','기타 조건'],['구성기능','기타 조건'],['2 SFP','포트 수'],['SFP GBIC 슬롯 제공','포트 수'],['56Gbps','스위칭 용량']]) {
    const result=relabelFact('스위치',{항목:'스위칭 용량',값:value,근거:value});
    assert.equal(result.항목,field);assert.equal(result.값,value);
  }
});
test('스위치의 기타 조건에 넘어온 성능 지표와 포트 개수를 제 항목으로 옮긴다',()=>{
  for(const [field,value,expected] of [
    ['기타 조건','L7 처리량 : 125Gbps 이상 지원','성능'],['기타 조건','동시세션수 : 145,000,000 이상 지원','성능'],
    ['기타 조건','L4 Connetions(CPS) : 1,900,000 이상 지원','성능'],['기타 조건','L7 HTTP transaction(RPS) : 4,500,000 이상 지원','성능'],
    ['기타 조건','10G SFP+ 16포트 이상 제공 (10G GBIC 포함)','포트 수'],
    // 숫자 없는 기능 설명, 유지보수 품목, 성능 이름 없는 대역폭, 포트 구성을 담은 제품 종류는 그대로 둔다.
    ['종류','Catalyst 9500 24x1/10/25G and 4-port 40/100G','종류'],
    ['기타 조건','관리 포트 및 콘솔포트를 제공하여야 함','기타 조건'],['기타 조건','SNTC-8X5XNBD Catalyst 9500 24-port 25/100G o','기타 조건'],
    ['기타 조건','주메모리 : 256Gbps 이상 지원','기타 조건'],['기타 조건','19인치 표준랙 마운트 가능 타입 지원','기타 조건'],
    ['종류','L3 스위치','종류'],
  ]) {
    const result=relabelFact('스위치',{항목:field,값:value,근거:value});
    assert.equal(result.항목,expected,value);assert.equal(result.값,value);
  }
  // 전원 공급 장치 줄은 전원이다. 포트가 함께 적힌 줄은 두고 본다.
  assert.equal(relabelFact('스위치',{항목:'포트 수',값:'650W AC config 4 Power Supply front to backco',근거:'- 650W AC config 4 Power Supply front to backco'}).항목,'전원');
  assert.equal(relabelFact('스위치',{항목:'기타 조건',값:'이중화 전원 공급 장치 제공',근거:'이중화 전원 공급 장치 제공'}).항목,'전원');
  assert.equal(relabelFact('스위치',{항목:'포트 수',값:'48포트, Power Supply 2개',근거:'48포트, Power Supply 2개'}).항목,'포트 수');
  // 서버의 기타 조건은 옮기지 않는다.
  assert.equal(relabelFact('서버',{항목:'기타 조건',값:'10G 4포트',근거:'10G 4포트'}).항목,'기타 조건');
});
test('응용 소프트웨어와 CPU 소켓 오분류를 고치되 실제 OS와 프로토콜은 유지',()=>{
  for(const [field,value,expected] of [
    ['OS','Oracle 19C','기타 조건'],['OS','Oracle RAC','기타 조건'],
    ['OS','GUI 기반 상용 MLops 내장','기타 조건'],['OS','Oracle Linux 9','OS'],
    ['OS','Linux 및 MLOps 설치','OS'],['OS','Oracle 19C 라이선스','라이선스'],
    ['프로토콜','2-소켓','CPU'],['프로토콜','2개 장착 (서버당 64core)','CPU'],
    ['프로토콜','TCP/IP','프로토콜'],
  ]){
    const actual=relabelFact('서버',{항목:field,값:value,근거:value});
    assert.equal(actual.항목,expected,value);assert.equal(actual.값,value);
    assert.equal(actual.근거,value);
  }
});
test('스토리지 용량을 장비 수량으로 표시하지 않고 명시된 사용공간만 가용 용량으로 분류',()=>{
  const fact={항목:'수량',값:'19TB 이상',근거:'19TB 이상'};
  assert.equal(relabelFact('스토리지',fact,'3. 저장장치 사용공간은 RAID10 구성으로 19TB 이상, 확장을\n위한 Enclosure를 납품').항목,'Usable 용량');
  assert.equal(relabelFact('스토리지',fact,'물리 용량 19TB 이상').항목,'Raw 용량');
  assert.equal(relabelFact('스토리지',fact,'RAID10 구성으로 19TB 이상').항목,'기타 조건');
  assert.equal(relabelFact('스토리지',fact,'사용공간 19TB 이상\n물리 용량 19TB 이상').항목,'기타 조건');
  assert.equal(relabelFact('서버',fact,'메모리 19TB 이상').항목,'기타 조건');
  const quantity={항목:'수량',값:'2대',근거:'2대'};
  assert.equal(relabelFact('스토리지',quantity,'2대').항목,'수량');
});

test('GPU 하위 메모리 대역폭만 GPU로 분류하고 일반 메모리는 유지',()=>{
  const source='Memory - 1TB 이상\n그래픽카드\n- 메모리대역폭 4TB/s이상\nI/O 인터페이스 10G';
  const bandwidth={항목:'메모리',값:'4TB/s이상',근거:'- 메모리대역폭 4TB/s이상'};
  assert.equal(relabelFact('서버',bandwidth,source).항목,'GPU');
  assert.equal(relabelFact('서버',{항목:'메모리',값:'1TB 이상',근거:'Memory - 1TB 이상'},source).항목,'메모리');
  assert.equal(relabelFact('서버',bandwidth,source+'\n'+bandwidth.근거).항목,'메모리');
});
test('GPU 메모리 대역폭을 메모리 용량으로 정규화하지 않는다',()=>{
  assert.deepEqual(pick('메모리','4TB/s 이상, 80GB 용량'),['80GB']);
  assert.deepEqual(pick('메모리','4 TiB / s'),[]);
  assert.deepEqual(pick('성능','4GB/s 이상'),['4GB/s 이상']);
});

test("원문 수와 단위를 그대로 두고 조건어만 붙인다 — 환산하지 않는다", () => {
  assert.deepEqual(pick("메모리", "서버당 메모리 512GB 이상 (DDR5)"), ["512GB 이상"]);
  assert.deepEqual(pick("메모리", "최소 1TB"), ["1TB 이상"]);
  assert.deepEqual(pick("Usable 용량", "Usable 100 TB 이상(장비당), Raw 1.2PB"), ["100TB 이상", "1.2PB"]);
});

test("모델·버전 번호의 숫자는 수치로 읽지 않는다", () => {
  assert.deepEqual(pick("CPU", "Xeon E5-2690 v4, Gen11, 16 cores"), ["16코어"]);
  assert.deepEqual(pick("메모리", "DDR5 RDIMM 64GB x 8EA"), ["64GB", "8EA"]);
});

test("값에서 표 칸 구분자·글머리표·항목명 칸을 걷어 낸다", () => {
  assert.equal(cleanValue("CPU", "| CPU | Intel Xeon 2.4GHz 16Core 이상 × 2EA |"), "Intel Xeon 2.4GHz 16Core 이상 × 2EA");
  assert.equal(cleanValue("CPU", "| 서버 | CPU | 2.4GHz | 2EA |"), "2.4GHz | 2EA", "항목명만 든 칸의 뒤쪽이 값이다");
  assert.equal(cleanValue("CPU", "프로세서(Core) : 16Core 이상"), "16Core 이상");
  assert.equal(cleanValue("메모리", "○ 메모리 : 256GB 이상"), "256GB 이상");
  assert.equal(cleanValue("메모리", "  -  메모리   256GB 이상  "), "256GB 이상");
  assert.equal(cleanValue("수량", "| 수량(대) | 2 |"), "2");
  assert.equal(cleanValue("Usable 용량", "Usable 용량 100TB 이상을 제공한다."), "100TB 이상을 제공한다.");
  assert.equal(cleanValue("포트 수", "1) 포트 수: 48Port 이상"), "48Port 이상");
  // 교육포털 제안요청서의 서버 표가 쓰는 표기.
  assert.equal(cleanValue("메모리", "◦ MEM: 512GB 이상 제공"), "512GB 이상 제공");
  assert.equal(cleanValue("로컬 디스크", "◦ Disk: (OS 영역) SSD 960GB * 2ea 이상 제공"), "(OS 영역) SSD 960GB * 2ea 이상 제공");
  assert.equal(cleanValue("기타 조건", "◦ 기타: 전원 및 팬 이중화, Hot Swap 지원"), "전원 및 팬 이중화, Hot Swap 지원");
  assert.equal(cleanValue("수량", "◦ 도입 수량: 3대"), "3대");
});

test("조건의 일부이거나 값의 뜻을 가르는 말은 항목명으로 떼지 않는다", () => {
  for (const [field, quote] of [
    ["CPU", "CPU 사용률 70% 이하 유지"],
    ["메모리", "서버당 메모리 256GB 이상을 제공한다."],
    ["메모리", "메모리슬롯 24개 이상"],
    ["로컬 디스크", "SSD 960GB × 2"],
    ["이중화", "전원 및 FAN 이중화 구성"],
  ]) assert.equal(cleanValue(field, quote), quote);
  assert.equal(cleanValue("NIC/HBA", "| HBA | 32Gb 2Port |"), "HBA | 32Gb 2Port", "NIC와 HBA는 한 항목이라 이름이 값이다");
  assert.equal(cleanValue("CPU", "| CPU |"), "CPU", "뒤에 남는 것이 없으면 떼지 않는다");
  assert.equal(cleanValue("트랜시버·케이블", "| 케이블 | LC-LC 5m |"), "케이블 | LC-LC 5m", "항목명을 모르는 항목은 표 기호만 정리한다");
});

test("줄 범위로 복원한 규격만 값을 다듬고 근거와 구형 응답의 값은 그대로 둔다", () => {
  const raw = "| 메모리 | 512GB 이상 |";
  const [item] = normalizeItems([{ id: "ECR-001", 장비요약: [{ 종류: "서버", 규격: [
    { 항목: "메모리", 값: raw, 근거: raw, 검증: "원문 확인" },
    { 항목: "메모리", 값: raw, 근거: raw, 검증: "확인 필요" },
    { 항목: "메모리", 값: "| 메모리 | 256GB", 근거: "| 메모리 | 256GB 이상 제공 |", 검증: "원문 확인" },
  ] }] }]);
  const [ranged, unchecked, legacy] = item.장비요약[0].규격;
  assert.equal(ranged.값, "512GB 이상");
  assert.equal(ranged.근거, raw, "근거는 원문 줄 그대로다");
  assert.deepEqual(ranged.정규화, [{ 수치: 512, 단위: "GB", 조건: "이상" }]);
  assert.equal(unchecked.값, "512GB 이상", "확인 필요 값도 읽기 쉽게 다듬는다");
  assert.equal(unchecked.정규화, undefined, "확인하지 못한 값은 정규화하지 않는다");
  assert.equal(legacy.값, "| 메모리 | 256GB", "모델이 값을 따로 적은 응답은 건드리지 않는다");
});

test('항목의 단위가 없고 다른 항목의 단위만 있는 값을 열 밀림으로 본다',async()=>{
  const { unitMismatch } = await import('./ecr-normalize.js');
  for(const [field,value] of [['CPU','64GB'],['메모리','2.4GHz 8core'],['메모리','4'],['포트 수','1,200,000'],['메모리','700,000이상'],['로컬 디스크','10Gbps 2Port'],['수량','16core']])
    assert.equal(unitMismatch(field,value),true,`${field} ${value}`);
  for(const [field,value] of [['CPU','2.4GHz 16core 이상'],['CPU','2소켓 이상'],['메모리','512GB 이상'],['메모리','DDR5 32GB x 16'],['포트 수','48 port'],['포트 수','10G SFP+ 24'],
    ['로컬 디스크','SSD 960GB x 2'],['수량','2대'],['CPU','이중화 구성'],['포트 수','24']])
    assert.equal(unitMismatch(field,value),false,`${field} ${value}`);
});

test('스토리지의 Gbps 인터페이스를 스위칭 용량으로 고르면 포트 속도로 바로잡는다',()=>{
  const fact={항목:'스위칭 용량',값:'10/25/100 Gbps 이상 지원',근거:'- 인터페이스 : 10/25/100 Gbps 이상 지원',검증:'원문 확인'};
  assert.equal(relabelFact('스토리지',fact).항목,'포트 속도');
  assert.equal(relabelFact('스위치',{...fact,값:'3.2Tbps 이상'}).항목,'스위칭 용량');
});

test('복원한 표 칸의 머리글로 값의 항목을 정하고, 같은 값이 다른 항목 칸에도 있으면 정하지 않는다', async () => {
  const { cellField } = await import('./ecr-cells.js');
  const source = '업무명: 개발서버 | CPU (tpmC): 1,200,000 이상 | MEM (GB): 64이상 | Disk: 1TB | N/W card TX 1G (4port): 2 | 서버 수량: 1\n'
    + '구분: 증설 | 서버명: 중계서버 | 기존 CPU: 4 core | 기존 MEM: 8GB | 증설 CPU: 4 Core | 증설 MEM: 16GB';
  const fact = (값, 근거 = 값) => ({ 항목: 'CPU', 값, 근거 });
  // 인용이 칸 하나면 그 칸의 머리글.
  assert.equal(cellField(source, fact('64이상', 'MEM (GB): 64이상'), '서버').field, '메모리');
  // 인용이 행 전체면 값이 같은 칸.
  assert.equal(cellField(source, fact('1TB', source.split('\n')[0]), '서버').field, '로컬 디스크');
  assert.equal(cellField(source, fact('1TB', source.split('\n')[0]), '스토리지').field, '디스크 구성');
  assert.equal(cellField(source, fact('1', '서버 수량: 1'), '서버').field, '수량');
  // 기존 사양 칸은 기존이라고 알려 준다.
  assert.deepEqual(cellField(source, fact('8GB', '기존 MEM: 8GB'), '서버'), { field: '메모리', existing: true, label: '기존 MEM', quote: '기존 MEM: 8GB', value: '8GB' });
  assert.equal(cellField(source, fact('16GB', '증설 MEM: 16GB'), '서버').existing, false);
  // 이름·비고 칸처럼 항목을 뜻하지 않는 머리글, 표가 아닌 원문, 표에 없는 값은 정하지 않는다.
  assert.equal(cellField(source, fact('개발서버', '업무명: 개발서버'), '서버'), null);
  assert.equal(cellField('CPU 2.4GHz 16core', fact('2.4GHz'), '서버'), null);
  assert.equal(cellField(source, fact('128이상'), '서버'), null);
  // 띄어쓰기만 다른 같은 값이 여러 행에 있어도 같은 칸이다("64이상"과 "64 이상").
  const twice = source + '\n업무명: 모바일WAS서버 | CPU (tpmC): 1,200,000 이상 | MEM (GB): 64 이상 | Disk: 600GB | 서버 수량: 1';
  assert.equal(cellField(twice, fact('64이상', 'MEM (GB): 64이상'), '서버').value, '64이상 (GB)');
});

test('도입구분에 넣은 규격 줄은 값의 내용으로 항목을 다시 정하고, 도입구분 말은 그대로 둔다', () => {
  const f = (값, 근거 = 값) => ({ 항목: '도입구분', 값, 근거, 검증: '원문 확인' });
  assert.equal(relabelFact('스위치', f('9.6Tbps 이상 지원', '- 스위칭 용량 : 최대 9.6Tbps 이상 지원')).항목, '스위칭 용량');
  assert.equal(relabelFact('스위치', f('3Bpps 이상(IPv4/IPv6 동일성능) 지원')).항목, '성능');
  assert.equal(relabelFact('스위치', f('L7 처리량 : 125Gbps 이상 지원')).항목, '성능');
  assert.equal(relabelFact('스위치', f('10G SFP+ 16포트 이상 제공 (10G GBIC 포함)')).항목, '포트 수');
  assert.equal(relabelFact('서버', f('10G SFP+ 2포트 이상')).항목, 'NIC/HBA');
  assert.equal(relabelFact('스위치', f('IEEE 802.1d, 802.1w, 802.1Q, 802.3ad 지원')).항목, '기타 조건');
  for (const word of ['교체', '신규도입', '증설', '신규도입 (조건부)']) assert.equal(relabelFact('스위치', f(word)).항목, '도입구분');
  // 수량 줄은 수량 교정이 맡는다.
  assert.equal(relabelFact('스위치', f('공공망 6식, 금융망 6식', '○ 도입 수량 : 공공망 6식, 금융망 6식')).항목, '수량');
});
