import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFact, normalizeItems } from "./ecr-normalize.js";

const pick = (field, quote) => normalizeFact(field, quote).map(({ 수치, 단위, 조건 }) => `${수치}${단위}${조건 ? ` ${조건}` : ""}`);

test("원문 수와 단위를 그대로 두고 조건어만 붙인다 — 환산하지 않는다", () => {
  assert.deepEqual(pick("메모리", "서버당 메모리 512GB 이상 (DDR5)"), ["512GB 이상"]);
  assert.deepEqual(pick("메모리", "최소 1TB"), ["1TB 이상"]);
  assert.deepEqual(pick("Usable 용량", "Usable 100 TB 이상(장비당), Raw 1.2PB"), ["100TB 이상", "1.2PB"]);
});

test("항목에 맞지 않는 단위는 읽지 않는다", () => {
  assert.deepEqual(pick("CPU", "Intel Xeon 2.4GHz 이상, 32코어 이상, 메모리 256GB"), ["2.4GHz 이상", "32코어 이상"]);
  assert.deepEqual(pick("수량", "운영 2대, 개발 1대 (메모리 256GB)"), ["2대", "1대"], "합산하지 않고 나란히 둔다");
});

test("모델·버전 번호의 숫자는 수치로 읽지 않는다", () => {
  assert.deepEqual(pick("CPU", "Xeon E5-2690 v4, Gen11, 16 cores"), ["16코어"]);
  assert.deepEqual(pick("메모리", "DDR5 RDIMM 64GB x 8EA"), ["64GB", "8EA"]);
});

test("빗금으로 이은 속도는 뒤의 단위를 함께 쓴다", () => {
  assert.deepEqual(pick("포트 속도", "10/25GbE SFP28 48포트"), ["10Gbps", "25Gbps"]);
  assert.deepEqual(pick("포트 수", "10/25GbE SFP28 48포트 이상"), ["48포트 이상"]);
  assert.deepEqual(pick("NIC/HBA", "10G 2포트 NIC 2EA, 32Gb FC HBA"), ["10Gbps", "2포트", "2EA", "32Gbps"]);
});

test("자릿수 쉼표와 성능 단위를 읽는다", () => {
  assert.deepEqual(pick("성능", "1,000,000 IOPS 이상, 처리량 20GB/s"), ["1000000IOPS 이상", "20GB/s"]);
  assert.deepEqual(pick("스위칭 용량", "스위칭 용량 6.4Tbps 이상, 2,000Mpps"), ["6.4Tbps 이상", "2000Mpps"]);
});

test("모르는 항목·빈 값은 비워 둔다", () => {
  assert.deepEqual(normalizeFact("이중화", "Active-Active 2중화"), []);
  assert.deepEqual(normalizeFact("메모리", ""), []);
  assert.deepEqual(normalizeFact("메모리", "충분한 용량"), []);
});

test("원문 확인된 값만 정규화하고 나머지 필드는 건드리지 않는다", () => {
  const items = [{ id: "ECR-001", 장비요약: [{ 종류: "서버", 규격: [
    { 항목: "메모리", 값: "512GB 이상", 근거: "512GB 이상", 검증: "원문 확인" },
    { 항목: "메모리", 값: "256GB", 근거: "", 검증: "확인 필요" },
    { 항목: "이중화", 값: "이중화 구성", 근거: "이중화 구성", 검증: "원문 확인" },
  ] }] }];
  const [item] = normalizeItems(items);
  const [checked, unchecked, plain] = item.장비요약[0].규격;
  assert.deepEqual(checked.정규화, [{ 수치: 512, 단위: "GB", 조건: "이상" }]);
  assert.equal(unchecked.정규화, undefined);
  assert.equal(plain.정규화, undefined);
  assert.equal(checked.값, "512GB 이상", "원문 값은 그대로 둔다");
  assert.equal(items[0].장비요약[0].규격[0].정규화, undefined, "입력을 고치지 않는다");
});
