// PDF 원문을 외부에 전송하지 않는 선별 진단. Python pypdf가 별도로 필요하다.
// Cloudflare toMarkdown이나 실제 모델 품질을 대신 검증하지 않는다.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DOCUMENTS, evaluate, selectionFailures } from "./eval-selection.mjs";

const dir = path.resolve(process.argv[2] || ".");
const files = [
  ["4dae.txt", "[제안요청서] 4대보험 고객센터 노후장비 교체 및 인프라 고도화.pdf"],
  ["srmaas.txt", "[제안요청서] SR-MaaS통합정보시스템 운영환경(인프라) 구축사업 (본공고).pdf"],
  ["yangsan.txt", "[제안요청서] 우진메트로양산_양산선 차세대 통합경영정보시스템 구축 (본공고).pdf"],
];
const python = `
import sys,json
from pypdf import PdfReader, __version__
results=[]
for filename in sys.argv[1:]:
    reader=PdfReader(filename)
    results.append({"pages":len(reader.pages),"text":"\\n\\n".join(page.extract_text() for page in reader.pages)})
print(json.dumps({"extractor":"pypdf "+__version__,"documents":results}))
`;
try {
  const result = spawnSync("python", ["-c", python, ...files.map(([, name]) => path.join(dir, name))], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error("로컬 PDF 추출 실패: 파일 경로와 Python pypdf 설치를 확인하세요. 원문·하위 프로세스 출력은 로그에 기록하지 않습니다.");
  let extracted;
  try { extracted = JSON.parse(result.stdout.trim()); }
  catch { throw new Error("로컬 PDF 추출 응답 형식 오류 (원문 비공개)"); }
  console.log(`추출기: ${extracted.extractor}; 원격 요청·AI 호출 없음`);
  const results = files.map(([file, name], index) => {
    const document = DOCUMENTS.find((entry) => entry.file === file);
    const source = extracted.documents[index];
    const metrics = evaluate(source.text, document);
    console.log(JSON.stringify({ file, pdfPages: source.pages,
      sha256: createHash("sha256").update(readFileSync(path.join(dir, name))).digest("hex"),
      label: document.estimated ? "추정" : "기존 확정 번호 라벨", selected: metrics.selected,
      missed: metrics.missed, wrong: metrics.wrong, unknown: metrics.unknown,
      chunks: metrics.chunks, error: metrics.error }, null, 2));
    return { document, metrics };
  });
  const failures = selectionFailures(results);
  console.log(failures.length ? `FAIL\n${failures.join("\n")}` : "PASS: 이 로컬 추출 방식의 번호 선별만 통과");
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
