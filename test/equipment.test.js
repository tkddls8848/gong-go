const test = require("node:test");
const assert = require("node:assert/strict");
const { render, devices } = require("../public/equipment");

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

test("요약은 조건, 검증 상태, 원문을 표시하고 문서의 HTML을 실행하지 않는다", () => {
  const html = render({ schemaVersion: 2, verified: false, ecr: [{ id: "ECR-001", 세부내용_원문: "<script>alert(1)</script>", 장비요약: [{ 종류: "스토리지", 명칭: "증설", 출처: "별첨 3쪽", 규격: [{ 항목: "Usable 용량", 값: "전체 100TB 이상", 근거: "전체 100TB 이상", 검증: "원문 확인" }, { 항목: "수량", 값: "2대", 근거: "" }] }] }] });
  assert.match(html, /전체 100TB 이상/);
  assert.match(html, /Raw 용량<\/th><td>미기재/);
  assert.match(html, /확인 필요/);
  assert.match(html, /ECR 원문 보기/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("정규화 수치는 원문 값 옆에 보조로 그리고 형식이 어긋나면 거절한다", () => {
  const { render, validate } = require("../public/equipment.js");
  const data = { schemaVersion: 2, ecr: [{ id: "ECR-001", 장비요약: [{ 종류: "서버", 명칭: "웹서버", 규격: [{ 항목: "메모리", 값: "512GB 이상", 근거: "512GB 이상", 검증: "원문 확인", 정규화: [{ 수치: 512, 단위: "GB", 조건: "이상" }, { 수치: 2, 단위: "EA", 조건: "" }] }] }] }] };
  assert.equal(validate(data), data);
  assert.match(render(data), /<span class="spec-norm"[^>]*>512 GB 이상 · 2 EA<\/span>/);
  for (const bad of [{ 수치: "512", 단위: "GB", 조건: "" }, { 수치: 512, 단위: "", 조건: "" }, { 수치: Infinity, 단위: "GB", 조건: "" }, "512GB"]) {
    const broken = structuredClone(data);
    broken.ecr[0].장비요약[0].규격[0].정규화 = [bad];
    assert.throws(() => validate(broken), /형식이 올바르지 않습니다/);
  }
});

const spec = (항목, 값, 검증 = "원문 확인") => ({ 항목, 값, 근거: 값, 검증 });
const overviewOf = (data) => { const output = render(data); const at = output.indexOf('<section class="equipment-overview">'); return at < 0 ? "" : output.slice(at, output.indexOf("</section>", at)); };

test("장비 총괄표는 장비 한 종을 한 줄로, 종류 순으로 싣는다", () => {
  const data = { schemaVersion: 2, verified: false, ecr: [
    { id: "ECR-005", 장비요약: [{ 종류: "스위치", 명칭: "L3 스위치", 규격: [spec("수량", "2대"), spec("포트 수", "48Port 이상")] }] },
    { id: "ECR-001", 장비요약: [
      { 종류: "서버", 명칭: "WEB 서버", 규격: [spec("수량", "운영 2대\n개발 1대"), spec("CPU", "2.4GHz 16Core 이상"), spec("메모리", "256GB 이상")] },
      { 종류: "스토리지", 명칭: "통합 스토리지", 규격: [spec("수량", "1식"), spec("Raw 용량", "200TB 이상")] },
    ] },
  ] };
  const before = JSON.stringify(data);
  const table = overviewOf(data);
  assert.match(table, /장비 총괄 <small>3종<\/small>/);
  const order = [...table.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((found) => found[1]);
  assert.deepEqual(order, ["WEB 서버", "통합 스토리지", "L3 스위치"]);
  assert.match(table, /<td>운영 2대 \/ 개발 1대<\/td>/, "여러 줄 수량은 한 줄로 잇되 합산하지 않는다");
  assert.match(table, /<b>CPU<\/b> 2\.4GHz 16Core 이상/);
  assert.match(table, /<b>Raw 용량<\/b> 200TB 이상/);
  assert.equal((table.match(/핵심 항목 추출/g) || []).length, 3, "용량은 Raw나 Usable 하나, 포트는 수나 속도 하나면 채운 것이다");
  assert.ok(!table.includes("warning-text"));
  assert.equal(JSON.stringify(data), before);
});

test("총괄표는 핵심 규격이 빠진 장비와 확인 필요 규격을 줄마다 밝힌다", () => {
  const data = { schemaVersion: 2, verified: false, ecr: [{ id: "ECR-002", 장비요약: [
    { 종류: "서버", 명칭: "DB 서버", 규격: [spec("메모리", "512GB 이상", "확인 필요"), spec("CPU", "  ")] },
    { 종류: "스토리지", 명칭: "백업 스토리지", 규격: [spec("수량", "1식")] },
  ] }] };
  const [server, storage] = devices(data);
  assert.deepEqual(server.missing, ["수량", "CPU"], "값이 빈 규격은 추출된 것으로 세지 않는다");
  assert.equal(server.checks, 1);
  assert.deepEqual(storage.missing, ["Usable 용량·Raw 용량"]);
  // 테이프 라이브러리는 드라이브·슬롯으로 적는다. 디스크 용량이 없다고 핵심 미기재로 세지 않는다.
  const [tape] = devices({ schemaVersion: 2, ecr: [{ id: "ECR-002", 명칭: "테이프 라이브러리 시스템(PTL) 규격 정의", 장비요약: [{ 종류: "스토리지", 명칭: "테이프 라이브러리 시스템(PTL)", 규격: [spec("기타 조건", "LTO-8 FC Drive 4개 이상")] }] }] });
  assert.deepEqual(tape.missing, ["수량"]);
  const table = overviewOf(data);
  assert.match(table, /핵심 규격\(수량·CPU·메모리·용량·포트\)을 찾지 못한 장비가 2종/);
  assert.match(table, /핵심 미기재: 수량, CPU<\/span><span class="spec-mark warn">확인 필요 1/);
  assert.match(table, /핵심 미기재: Usable 용량·Raw 용량/);
  assert.match(table, /<td>미기재<\/td>/);
});

test("총괄표는 긴 값을 줄이고 저장된 문자열을 그대로 믿지 않는다", () => {
  const long = "가".repeat(200);
  const table = overviewOf({ schemaVersion: 2, ecr: [{ id: "<b>ECR</b>", 장비요약: [
    { 종류: "서버", 명칭: "<img src=x onerror=alert(1)>", 규격: [spec("CPU", long), spec("수량", "<script>2대</script>")] },
    { 종류: "__proto__", 명칭: "기타", 규격: [spec("수량", "1대")] },
  ] }] });
  assert.ok(!table.includes("<img") && !table.includes("<script>") && !table.includes("<b>ECR"));
  assert.ok(table.includes(`${"가".repeat(89)}…`) && !table.includes("가".repeat(91)), "긴 값은 줄여 적는다");
  assert.match(table, /<td>__proto__<\/td>/, "모르는 종류도 줄을 숨기지 않는다");
  assert.equal(overviewOf({ schemaVersion: 2, ecr: [] }), "", "장비가 없으면 빈 표를 그리지 않는다");
  assert.deepEqual(devices(null), []);
});
