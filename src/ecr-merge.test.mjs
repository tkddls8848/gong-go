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

test("장비가 하나면 사유를 그대로 두고 같은 사유는 한 번만 싣는다", () => {
  const [item] = consolidate([
    part("ECR-001", "서버", "서버", [], { notes: ["장비명 원문 확인 필요"] }),
    part("ECR-001", "서버", "서버", [], { chunk: 2, notes: ["장비명 원문 확인 필요"] }),
  ]);
  assert.deepEqual(item.불확실, ["장비명 원문 확인 필요"]);
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
  const [separate] = consolidate([part("ECR-005", "서버", "서버", [fact("CPU", "256GB"), fact("메모리", "256GB")])]);
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
