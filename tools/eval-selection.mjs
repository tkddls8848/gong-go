// 표 선별의 재현율을 실문서로 재는 평가 도구다. 제안요청서 원문은 저장소에 두지 않으므로
// 텍스트는 저장소 밖(기본값 ../gong-go-eval)에서 읽고, 없는 문서는 건너뛴다.
// 사용법: node tools/eval-selection.mjs [텍스트 디렉터리]
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requirementSections } from "../src/ecr-source.js";
import { splitDocument } from "../src/ecr.js";

// 구간 하나가 쓰는 뉴런. src/ai-budget.js의 qwen3 단가에 2400자 구간과 출력 2048토큰을 넣은 값이다.
export const NEURONS_PER_CHUNK = 142;
export const EVAL_DIR = path.join(import.meta.dirname, "..", "..", "gong-go-eval");

const ids = (prefix, from, to, width) =>
  Array.from({ length: to - from + 1 }, (_, index) => prefix + String(from + index).padStart(width, "0"));
const DAE_EQUIPMENT = ["ECR-004", "ECR-009", "ECR-010", "ECR-012"];

// 정답 라벨은 사용자가 직접 분류한 것이다. 선별기를 고치면 이 표가 아니라 선별기를 고친다.
export const DOCUMENTS = [
  {
    file: "yangsan.txt",
    name: "양산선 통합경영정보시스템",
    // 비장비는 ECR-001(공통), ECR-031·032(랙), ECR-033~050(PC·UPS·소프트웨어)이다.
    equipment: ids("ECR-", 2, 30, 3),
    other: ["ECR-001", ...ids("ECR-", 31, 50, 3)],
  },
  {
    file: "4dae.txt",
    name: "4대보험 고객센터 노후장비 교체",
    // 장비는 서버 셋과 스토리지 하나뿐이고 나머지 ECR-001~015는 전부 비장비다.
    equipment: DAE_EQUIPMENT,
    other: ids("ECR-", 1, 15, 3).filter((id) => !DAE_EQUIPMENT.includes(id)),
  },
  {
    file: "srmaas.txt",
    name: "SR-MaaS 통합정보시스템 운영환경",
    // 확정 라벨이 없다. 접두어로 세운 대리 라벨(HW·NW는 장비, SW·COM은 비장비)이라 수치는 참고용이다.
    estimated: true,
    equipment: [...ids("ECR-HW-", 1, 8, 2), ...ids("ECR-NW-", 1, 12, 2)],
    other: [...ids("ECR-SW-", 1, 11, 2), ...ids("ECR-COM-", 1, 11, 2)],
  },
];

export function readDocument(dir, file) {
  try {
    return readFileSync(path.join(dir, file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const ratio = (part, whole) => (whole ? part / whole : null);

export function evaluate(text, label) {
  const { sections, ids: candidates } = requirementSections(text);
  const selected = [...new Set(sections.map((section) => section.id))];
  const hit = selected.filter((id) => label.equipment.includes(id));
  const missed = label.equipment.filter((id) => !selected.includes(id));
  const wrong = selected.filter((id) => label.other.includes(id));
  // 라벨 어느 쪽에도 없는 ID. 라벨이 문서를 못 따라간 것이므로 오검출로 세지 않고 따로 알린다.
  const unknown = selected.filter((id) => !label.equipment.includes(id) && !label.other.includes(id));
  // 누락을 둘로 나눈다. 후보였다면 상세 표 판정이 버린 것이고, 아니라면 구간 경계가 못 찾은 것이다.
  const droppedByFilter = missed.filter((id) => candidates.includes(id));
  let chunks = null, error = null;
  // splitDocument는 길이·구간 수 상한에서 던진다. 그 문서만 비용을 비우고 이유를 남긴다.
  try { chunks = splitDocument(text).length; } catch (failure) { error = failure.message; }
  return {
    selected, candidates, hit, missed, wrong, unknown, droppedByFilter, chunks, error,
    sections: sections.length,
    recall: ratio(hit.length, label.equipment.length),
    falseRate: ratio(wrong.length, selected.length),
    neurons: chunks === null ? null : chunks * NEURONS_PER_CHUNK,
  };
}

// 한글은 터미널에서 두 칸을 쓴다. 칸 너비를 글자 수로 재면 표가 어긋난다.
const wide = (text) => [...text].reduce((sum, ch) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣！-｠]/.test(ch) ? 2 : 1), 0);
const pad = (text, size) => {
  const gap = " ".repeat(Math.max(0, size - wide(text)));
  return /^[\d.,%-]+$/.test(text) ? gap + text : text + gap;
};
function table(header, rows) {
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => wide(row[column]))));
  const line = (row) => row.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd();
  return [line(header), widths.map((size) => "-".repeat(size)).join("  "), ...rows.map(line)].join("\n");
}

const percent = (value) => (value === null ? "-" : (value * 100).toFixed(1) + "%");
const list = (values) => (values.length ? values.join(" ") : "없음");

export function report(results) {
  const out = [];
  for (const { document, metrics } of results) {
    const label = document.estimated ? " [추정 라벨]" : "";
    out.push(`## ${document.name} (${document.file})${label}`);
    if (!metrics) { out.push("  텍스트 없음 — 건너뜀", ""); continue; }
    out.push(`  선별 ${metrics.selected.length}건: ${list(metrics.selected)}`);
    out.push(`  누락 ${metrics.missed.length}건: ${list(metrics.missed)}`
      + (metrics.missed.length ? ` (후보였으나 버림 ${metrics.droppedByFilter.length}, 후보에도 없음 ${metrics.missed.length - metrics.droppedByFilter.length})` : ""));
    out.push(`  오검출 ${metrics.wrong.length}건: ${list(metrics.wrong)}`);
    if (metrics.unknown.length) out.push(`  라벨에 없는 ID ${metrics.unknown.length}건: ${list(metrics.unknown)}`);
    if (metrics.error) out.push(`  구간 분할 실패: ${metrics.error}`);
    out.push("");
  }
  const rows = results.map(({ document, metrics }) => [
    document.file.replace(/\.txt$/, ""),
    document.estimated ? "추정" : "확정",
    ...(metrics
      ? [
        String(document.equipment.length), String(metrics.selected.length), String(metrics.hit.length),
        String(metrics.missed.length), String(metrics.wrong.length), percent(metrics.recall), percent(metrics.falseRate),
        metrics.chunks === null ? "-" : String(metrics.chunks), metrics.neurons === null ? "-" : String(metrics.neurons),
      ]
      // 텍스트가 없으면 라벨 수만 남기고 비운다. 어느 문서를 못 재었는지는 위 항목이 말한다.
      : [String(document.equipment.length), "-", "-", "-", "-", "-", "-", "-", "-"]),
  ]);
  const measured = results.filter((entry) => entry.metrics && entry.metrics.chunks !== null);
  const sum = (pick) => measured.reduce((total, entry) => total + pick(entry.metrics), 0);
  if (measured.length) rows.push(["합계", "", "", "", "", "", "", "", "", String(sum((m) => m.chunks)), String(sum((m) => m.neurons))]);
  out.push(table(["문서", "라벨", "정답", "선별", "적중", "누락", "오검출", "재현율", "오검출률", "구간", "예상뉴런"], rows));
  out.push("", `구간당 ${NEURONS_PER_CHUNK}뉴런 기준. 일일 무료 예산은 8,000뉴런이다.`);
  return out.join("\n");
}

function main(dir = process.argv[2] || EVAL_DIR) {
  console.log(`텍스트 디렉터리: ${dir}\n`);
  const results = DOCUMENTS.map((document) => {
    const text = readDocument(dir, document.file);
    return { document, metrics: text === null ? null : evaluate(text, document) };
  });
  console.log(report(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
