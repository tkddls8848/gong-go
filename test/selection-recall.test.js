// 실문서 없이 도는 합성 픽스처로 지표 계산을 고정한다. 실문서 수치는 tools/eval-selection.mjs가
// 잰다 — 원문은 저장소 밖에 있으므로 여기서는 쓰지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { evaluate, readDocument, report, DOCUMENTS, NEURONS_PER_CHUNK, selectionFailures } from "../tools/eval-selection.mjs";

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

test("추정 라벨만 있는 평가를 확정 정확도 통과로 간주하지 않는다", () => {
  assert.equal(selectionFailures([{ document: { estimated: true }, metrics: { missed: [], wrong: [], unknown: [] } }]).length, 1);
});

const row = (number, name, detail) =>
  `| 요구사항 고유번호 | ${number} |\n| 요구사항 명칭 | ${name} |\n| 세부 내용 | ${detail} |\n`;

// (a) 한 단 표. ECR-004는 총괄표에 이름만 있고 상세 표가 없다 — 사람은 장비로 읽지만 선별기가
// 볼 규격이 없으므로 재현율이 1 아래로 떨어진다. 비율 계산을 실제로 밟게 하려고 넣었다.
const singleColumn = {
  text: "# 요구사항 총괄표\n| ECR-004 | 증설 서버 |\n# 상세 요구사항\n"
    + row("ECR-001", "업무 서버", "CPU 32코어, 메모리 256GB 이상")
    + row("ECR-002", "백업 스토리지", "Usable 100TB 이상")
    + row("ECR-003", "공통 사업관리", "CPU 사용률 보고"),
  equipment: ["ECR-001", "ECR-002", "ECR-004"],
  other: ["ECR-003"],
};

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

// (c) 소프트웨어 표가 섞인 경우. 이름이 소프트웨어면 분류가 같아도 빼야 한다.
const withSoftware = {
  text: row("ECR-201", "업무 서버", "CPU 32코어, 메모리 256GB 이상")
    + row("ECR-202", "SAN 스위치", "32Gbps 24포트")
    + row("ECR-203", "백신(PC용/서버용)", "CPU 4코어, 메모리 8GB")
    + row("ECR-204", "그룹웨어 솔루션", "메모리 16GB 이상")
    + row("ECR-205", "PC 및 복합기", "CPU 8코어, 메모리 16GB"),
  equipment: ["ECR-201", "ECR-202"],
  other: ["ECR-203", "ECR-204", "ECR-205"],
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

test("한 단 표는 상세 표가 있는 장비만 세고 총괄표에만 있는 장비는 누락으로 남긴다", () => {
  const metrics = evaluate(singleColumn.text, singleColumn);
  assert.deepEqual(metrics.selected, ["ECR-001", "ECR-002"]);
  assert.deepEqual(metrics.missed, ["ECR-004"]);
  assert.deepEqual(metrics.wrong, []);
  assert.equal(metrics.recall, 2 / 3);
  assert.equal(metrics.falseRate, 0);
  assertBookkeeping(metrics, singleColumn);
});

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

test("소프트웨어·PC 표가 섞여도 장비만 세고 오검출률은 0이다", () => {
  const metrics = evaluate(withSoftware.text, withSoftware);
  assert.deepEqual(metrics.selected, ["ECR-201", "ECR-202"]);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falseRate, 0);
  assertBookkeeping(metrics, withSoftware);
});

test("라벨에 없는 ID는 오검출이 아니라 라벨 누락으로 따로 센다", () => {
  const partial = { equipment: ["ECR-201"], other: ["ECR-203"] };
  const metrics = evaluate(withSoftware.text, partial);
  assert.deepEqual(metrics.unknown, ["ECR-202"]);
  assert.deepEqual(metrics.wrong, []);
  assert.equal(metrics.falseRate, 0);
});

test("누락을 후보였던 것과 경계가 못 찾은 것으로 나눈다", () => {
  const metrics = evaluate(singleColumn.text, singleColumn);
  // ECR-004는 번호는 잡혔고 상세 표 판정에서 빠졌다. 경계 문제가 아니라 규격 문제다.
  assert.deepEqual(metrics.droppedByFilter, ["ECR-004"]);
  assert.ok(metrics.candidates.includes("ECR-004"));
});

test("장비 정답이 없으면 재현율은 0으로 나누지 않고 비운다", () => {
  const metrics = evaluate(singleColumn.text, { equipment: [], other: [] });
  assert.equal(metrics.recall, null);
});

test("텍스트가 없으면 오류로 죽지 않고 null을 돌려준다", () => {
  assert.equal(readDocument(path.join(import.meta.dirname, "없는-디렉터리"), "yangsan.txt"), null);
  assert.match(readDocument(path.join(import.meta.dirname, "..", "tools"), "eval-selection.mjs"), /NEURONS_PER_CHUNK/);
});

test("텍스트 없는 문서는 건너뜀으로 적고 추정 라벨은 표에 표시한다", () => {
  const output = report([{ document: DOCUMENTS[2], metrics: null }]);
  assert.match(output, /텍스트 없음 — 건너뜀/);
  assert.match(output, /추정 라벨/);
});

test("정답 라벨은 장비와 비장비가 겹치지 않는다", () => {
  for (const document of DOCUMENTS) {
    const overlap = document.equipment.filter((id) => document.other.includes(id));
    assert.deepEqual(overlap, [], `${document.file} 라벨이 겹친다`);
  }
  assert.equal(DOCUMENTS[0].equipment.length, 29);
  assert.equal(DOCUMENTS[0].equipment.at(0), "ECR-002");
  assert.equal(DOCUMENTS[0].equipment.at(-1), "ECR-030");
  assert.deepEqual(DOCUMENTS[1].equipment, ["ECR-004", "ECR-009", "ECR-010", "ECR-012"]);
  assert.equal(DOCUMENTS[2].equipment.length, 20);
  assert.equal(DOCUMENTS[2].estimated, true);
});
