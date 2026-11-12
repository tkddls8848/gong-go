import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFact, normalizeItems, cleanValue } from "./ecr-normalize.js";

const pick = (field, quote) => normalizeFact(field, quote).map(({ 수치, 단위, 조건 }) => `${수치}${단위}${조건 ? ` ${조건}` : ""}`);

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
  assert.equal(cleanValue("기타 조건", "| 기타 | 랙 마운트 킷 포함 |"), "기타 | 랙 마운트 킷 포함", "모르는 항목은 표 기호만 정리한다");
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
