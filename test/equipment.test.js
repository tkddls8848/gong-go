const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../public/equipment");

test("구형 항목 하나 때문에 함께 저장된 신형 장비 요약을 숨기지 않는다", () => {
  const data = { schemaVersion: 2, verified: true, ecr: [
    { id: "ECR-OLD", 명칭: "<기존 장비>", 기본규격: [{ 수량: "2대" }], 불확실: ["수량을 확인하지 못해 제외함"] },
    { id: "ECR-NEW", 장비요약: [{ 종류: "서버", 명칭: "신형 서버", 규격: [{ 항목: "메모리", 값: "256GB", 근거: "메모리 256GB", 검증: "원문 확인" }] }] },
  ] };
  const snapshot = JSON.stringify(data);
  const output = render(data);
  assert.match(output, /장비 요약 형식이 없는 요구사항 1건/);
  assert.match(output, /ECR-OLD · &lt;기존 장비&gt;/);
  assert.match(output, /서버 <strong>1<\/strong>/);
  assert.match(output, /메모리 256GB/);
  assert.match(output, /확인 불가로 제외된 규격 1건/);
  assert.match(output, /추출된 스토리지 항목이 없습니다\. 분석이 미검증/);
  assert.equal(JSON.stringify(data), snapshot);
});

test("모두 구형이면 대상 목록과 원문 안내를 보이며 장비 0건으로 집계하지 않는다", () => {
  const output = render({ schemaVersion: 2, ecr: [{ id: "ECR-OLD" }, { 명칭: "기존 장비" }] });
  assert.match(output, /장비 요약 형식이 없는 요구사항 2건/);
  assert.match(output, /ID 없음 · 기존 장비/);
  assert.match(output, /기존 ECR 원문은 아래/);
  assert.ok(!output.includes("equipment-count"));
});

test("알 수 없는 저장 장비 종류도 규격·근거를 보존하고 별도 분류 경고를 표시한다", () => {
  const data = { schemaVersion: 2, ecr: [{ id: "ECR-001", 장비요약: [
    { 종류: "서버", 명칭: "웹서버", 규격: [] },
    { 종류: "<img src=x onerror=alert(1)>", 명칭: "기존 장비", 규격: [{ 항목: "포트", 값: "24개", 근거: "포트 24개", 검증: "확인 필요" }] },
  ] }] };
  const before = JSON.stringify(data);
  const output = render(data);
  assert.match(output, /분류 확인 필요 <strong>1<\/strong>/);
  assert.match(output, /서버 <strong>1<\/strong>/);
  assert.match(output, /자동 재분류하지 않았습니다/);
  assert.match(output, /저장된 종류: &lt;img/);
  assert.ok(!output.includes("<img"));
  assert.match(output, /포트 24개/);
  assert.equal((output.match(/<article class="equipment-card">/g) || []).length, 2);
  assert.equal(JSON.stringify(data), before);
});

test("종류 누락·공백·프로토타입 속성명도 정상 장비로 오인하거나 숨기지 않는다", () => {
  for (const 종류 of [undefined, "", " ", "toString", "__proto__"]) {
    const output = render({ schemaVersion: 2, ecr: [{ 장비요약: [{ 종류, 규격: [] }] }] });
    assert.match(output, /분류 확인 필요 <strong>1<\/strong>/);
    assert.equal((output.match(/<article class="equipment-card">/g) || []).length, 1);
  }
  assert.ok(!render({ schemaVersion: 2, ecr: [] }).includes("분류 확인 필요"));
});

test("빈 분석은 검증 플래그와 무관하게 원문 확인을 안내한다", () => {
  const output = render({ schemaVersion: 2, verified: true, ecr: [] });
  assert.match(output, /미검증 상태이므로 원문 확인/);
  assert.match(output, /추출 0건은 장비 요구사항이 없다는 뜻이 아닙니다/);
});

test("요약은 번호 대조 범위와 미추출 건수를 완전성 검증과 구분한다", () => {
  const html = render({ schemaVersion: 2, ecr: [], coverage: { expectedIds: ["ECR-001", "ECR-002"], matchedIds: ["ECR-001"], missingIds: ["ECR-002"] } });
  assert.match(html, /분석 대상 번호 2개 중 유효 규격 추출 1개 · 미추출 1개/);
  assert.match(html, /규격 전체의 완전성을 보증하지 않습니다/);
  assert.match(render({ schemaVersion: 2, ecr: [] }), /추출 0건은 장비 요구사항이 없다는 뜻이 아닙니다/);
});
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
test("스위치 요구사항도 별도 섹션으로 표시한다", () => {
  const html = render({ schemaVersion: 2, verified: false, ecr: [{ id: "ECR-026", 세부내용_원문: "SAN 스위치", 장비요약: [{ 종류: "스위치", 명칭: "SAN 스위치", 출처: "3쪽", 규격: [{ 항목: "포트 속도", 값: "32Gbps 24포트", 근거: "32Gbps 24포트", 검증: "원문 확인" }] }] }] });
  assert.match(html, /스위치 요구사항/);
  assert.match(html, /32Gbps 24포트/);
  assert.match(html, /스위칭 용량<\/th><td>미기재/);
});
// 한 줄이 어느 규격인지로 갈라 본다. thead의 <tr>은 속성이 없어 여기 걸리지 않는다.
const rowsOf = (html) => html.split("<tr ").slice(1);
const rowFor = (html, field) => rowsOf(html).find((row) => row.includes(`row">${field}</th>`));

test("결과 머리에 장비 종류별 건수를 0건인 종류까지 적는다", () => {
  const html = render({ schemaVersion: 2, verified: true, ecr: [
    { id: "ECR-001", 장비요약: [
      { 종류: "서버", 명칭: "웹서버", 출처: "1쪽", 규격: [{ 항목: "수량", 값: "2대", 근거: "2대", 검증: "원문 확인" }] },
      { 종류: "서버", 명칭: "DB서버", 출처: "2쪽", 규격: [{ 항목: "수량", 값: "1대", 근거: "1대", 검증: "확인 필요" }] },
    ] },
    { id: "ECR-002", 장비요약: [{ 종류: "스위치", 명칭: "L2 스위치", 출처: "3쪽", 규격: [] }] },
  ] });
  assert.match(html, /서버 <strong>2<\/strong>/);
  assert.match(html, /스토리지 <strong>0<\/strong>/);
  assert.match(html, /스위치 <strong>1<\/strong>/);
  assert.match(html, /확인 필요 <strong>1<\/strong>/);
  // 0건인 종류를 감추면 빠뜨린 것인지 없는 것인지 구분할 수 없다. 옅게만 둔다.
  assert.match(html, /<span class="equipment-count zero">스토리지/);
  // 머리의 건수와 아래 카드가 어긋나면 둘 다 믿을 수 없다. 같은 기준으로 세는지 함께 본다.
  assert.equal([...html.matchAll(/<article class="equipment-card">/g)].length, 3);
});

test("확인 불가로 제외된 규격은 건수를 세어 따로 모은다", () => {
  const html = render({ schemaVersion: 2, verified: false, ecr: [
    { id: "ECR-003", 불확실: ["CPU 코어 수를 원문에서 확인하지 못해 제외함", "근거 문장이 두 쪽에 걸쳐 있음"], 장비요약: [] },
    { id: "ECR-004", 불확실: ["메모리 용량을 확인하지 못해 제외함"], 장비요약: [] },
  ] });
  assert.match(html, /확인 불가로 제외된 규격 2건/);
  assert.match(html, /<strong>ECR-003<\/strong> CPU 코어 수를 원문에서 확인하지 못해 제외함/);
  assert.match(html, /<strong>ECR-004<\/strong> 메모리 용량을 확인하지 못해 제외함/);
  // 제외가 아닌 불확실 메시지까지 끌어오면 "표에서 무엇을 뺐는가"가 다시 흐려진다.
  assert.ok(!html.includes("근거 문장이 두 쪽에"));
  // 뺀 것이 없으면 상자 자체를 내지 않는다.
  assert.ok(!render({ schemaVersion: 2, verified: true, ecr: [{ id: "ECR-005", 불확실: [], 장비요약: [] }] }).includes("제외된 규격"));
  // 구형 결과라 요약을 못 그려도 제외 사유는 남아야 한다 — app.js가 경고 묶음에서 빼기 때문이다.
  assert.match(render({ schemaVersion: 1, ecr: [{ id: "ECR-009", 불확실: ["수량을 확인하지 못해 제외함"] }] }), /제외된 규격 1건/);
});

test("검증된 규격과 확인이 필요한 규격은 줄 단위로 갈라 보인다", () => {
  const html = render({ schemaVersion: 2, verified: false, ecr: [{ id: "ECR-006", 세부내용_원문: "웹서버", 장비요약: [{ 종류: "서버", 명칭: "웹서버", 출처: "12쪽", 규격: [
    { 항목: "CPU", 값: "16코어 이상", 근거: "16코어 이상", 검증: "원문 확인" },
    { 항목: "메모리", 값: "128GB", 근거: "128GB 이상", 검증: "확인 필요" },
  ] }] }] });
  assert.match(rowFor(html, "CPU"), /^class="spec-row verified"/);
  assert.match(rowFor(html, "CPU"), /<span class="spec-mark ok">원문 확인<\/span>/);
  assert.match(rowFor(html, "메모리"), /^class="spec-row unverified"/);
  assert.match(rowFor(html, "메모리"), /<span class="spec-mark warn">확인 필요<\/span>/);
  assert.match(rowFor(html, "이중화"), /^class="spec-row missing"/);
  // 표식이 .warning-text로 그려지면 칸 안에서 블록 상자가 되어 표가 벌어진다.
  assert.ok(!html.includes('class="warning-text">확인 필요'));
  // 카드마다 몇 건을 대조했고 몇 건이 남았는지 함께 적는다.
  assert.match(html, /<p class="equipment-tally"><span class="spec-mark ok">원문 확인 1<\/span><span class="spec-mark warn">확인 필요 1<\/span><\/p>/);
});

test("규격 표는 모두 가로 스크롤 상자 안에 들어간다", () => {
  // 360px에서 표가 모달 밖으로 흘러넘치면 모달 전체가 가로로 밀린다.
  const html = render({ schemaVersion: 2, verified: true, ecr: [{ id: "ECR-007", 장비요약: [{ 종류: "스토리지", 명칭: "SAN", 출처: "5쪽", 규격: [{ 항목: "수량", 값: "1식", 근거: "1식", 검증: "원문 확인" }] }] }] });
  const wrapper = '<div class="ecr-scroll">';
  const tables = [...html.matchAll(/<table/g)].map((match) => match.index);
  assert.ok(tables.length, "표가 하나도 없다");
  for (const index of tables) assert.equal(html.slice(index - wrapper.length, index), wrapper);
});
