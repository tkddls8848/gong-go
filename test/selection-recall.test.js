// 실문서 없이 도는 합성 픽스처로 지표 계산을 고정한다. 실문서 수치는 tools/eval-selection.mjs가
// 잰다 — 원문은 저장소 밖에 있으므로 여기서는 쓰지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, NEURONS_PER_CHUNK, selectionFailures } from "../tools/eval-selection.mjs";

test("엄격한 선별 관문은 없는 표본·누락·오검출·미라벨·분할 실패를 거부한다", () => {
  const document = { file: "fixture.txt", estimated: false };
  const clean = { missed: [], wrong: [], unknown: [], error: null };
  assert.equal(selectionFailures([]).length, 1);
  assert.equal(selectionFailures([{ document, metrics: null }]).length, 1);
  for (const field of ["missed", "wrong", "unknown"]) {
    assert.equal(selectionFailures([{ document, metrics: { ...clean, [field]: ["ECR-001"] } }]).length, 1);
  }
  assert.equal(selectionFailures([{ document, metrics: { ...clean, error: "too large" } }]).length, 1);
  assert.deepEqual(selectionFailures([{ document, metrics: clean }]), []);
});

// (b) 좌우 2단 표. 제안요청서는 표 둘을 한 쪽에 나란히 싣고, 평문으로 풀면 한 줄에 요구사항
// 번호가 둘 온다. 쪽 구분은 \f다. 왼쪽 칸을 실문서만큼(번호 칸 두 개가 40열 이상 떨어지게)
// 넓혀 둔다 — 좁게 잡으면 한 단 쪽과 구분되지 않아 픽스처가 2단을 시험하지 못한다.
const GUTTER = 44;
const left = ["요구사항 고유번호  ECR-101", "요구사항 명칭  코어 라우터", "세부 내용  10GbE 24포트",
  "요구사항 고유번호  ECR-103", "요구사항 명칭  백본 스위치", "세부 내용  스위칭 용량 1.2Tbps"];
const right = ["요구사항 고유번호  ECR-102", "요구사항 명칭  방화벽 솔루션", "세부 내용  세션 200만, 8Gbps",
  "요구사항 고유번호  ECR-104", "요구사항 명칭  업무 서버", "세부 내용  CPU 32코어, 메모리 256GB"];
const twoColumn = {
  text: "\f" + left.map((line, index) => (line.padEnd(GUTTER) + right[index]).trimEnd()).join("\n") + "\n\f",
  // 같은 내용을 한 단으로 편 모습. 2단 처리와 무관하게 선별기가 다룰 수 있는 형태다.
  unfolded: [...left, ...right].join("\n"),
  equipment: ["ECR-101", "ECR-103", "ECR-104"],
  other: ["ECR-102"],
};

// 어느 픽스처에서나 성립해야 하는 셈이다. 선별기가 무엇을 고르든 장부는 맞아야 한다.
function assertBookkeeping(metrics, label) {
  assert.deepEqual([...metrics.hit, ...metrics.missed].sort(), [...label.equipment].sort());
  assert.equal(metrics.hit.some((id) => metrics.missed.includes(id)), false);
  assert.deepEqual(metrics.selected.filter((id) => label.equipment.includes(id)), metrics.hit);
  assert.equal(metrics.recall, metrics.hit.length / label.equipment.length);
  assert.equal(metrics.falseRate, metrics.selected.length ? metrics.wrong.length / metrics.selected.length : null);
  assert.equal(metrics.neurons, metrics.chunks * NEURONS_PER_CHUNK);
  assert.deepEqual(metrics.unknown, []);
}

test("한 줄에 요구사항 번호가 둘인 2단 표에서도 장부가 맞는다", () => {
  // 2단 줄을 어떻게 가르는지는 선별기 쪽에서 바뀌는 중이라 적중 수를 박지 않는다. 대신 셈과,
  // 가르다가 없는 ID를 만들어내지 않는지를 고정한다 — 번호 가운데를 자르면 그것부터 깨진다.
  const metrics = evaluate(twoColumn.text, twoColumn);
  assertBookkeeping(metrics, twoColumn);
  assert.equal(metrics.hit.length + metrics.missed.length, 3);
  assert.deepEqual(metrics.wrong, []);
  // 한 단으로 편 같은 내용은 장비 셋을 모두 찾고 방화벽 솔루션만 뺀다.
  const flat = evaluate(twoColumn.unfolded, twoColumn);
  assert.deepEqual(flat.selected, ["ECR-101", "ECR-103", "ECR-104"]);
  assert.equal(flat.recall, 1);
  assert.equal(flat.falseRate, 0);
  assertBookkeeping(flat, twoColumn);
});

