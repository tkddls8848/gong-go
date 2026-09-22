const stages = { request: "요청 확인", access: "분석 권한 확인", read: "저장 결과 조회", upload: "파일 업로드", convert: "PDF 텍스트 변환", prepare: "분석 문서 준비", saveDocument: "분석 문서 저장", loadDocument: "분석 문서 조회", loadPart: "완료 구간 조회", budget: "AI 예산 예약", inference: "AI 규격 추출", parse: "분석 응답 확인", savePart: "분석 구간 저장", merge: "분석 결과 병합", saveResult: "최종 결과 저장" };
const codes = {
  3036: [429, "Cloudflare의 오늘 무료 뉴런 할당량을 모두 사용했습니다. 한국시간 오전 9시 이후 다시 시도하세요."],
  3040: [503, "Cloudflare 모델 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도하세요."],
  3007: [504, "Cloudflare 모델 응답 시간이 초과되었습니다."],
  3008: [504, "Cloudflare 모델 요청이 중단되었습니다."],
  3006: [413, "모델에 전달할 입력이 너무 큽니다."],
  5007: [502, "설정된 Cloudflare 모델을 찾을 수 없습니다."],
  3042: [502, "Cloudflare 모델 이름이 올바르지 않습니다."],
  3023: [503, "Cloudflare 계정의 AI 사용이 제한되어 있습니다."],
  5035: [403, "모델이 유료 플랜을 요구하여 분석을 중단했습니다. 유료 모델로 전환하지 않습니다."],
};
export function ecrError(error, stage, reference) {
  const raw = String(error?.message || "");
  const candidate = Number(error?.code ?? error?.cause?.code);
  const code = codes[candidate] ? candidate : Number(raw.match(/\b(3036|3040|3007|3008|3006|5007|3042|3023|5035)\b/)?.[1]) || null;
  const label = stages[stage] || stages.request;
  let status = 502, message = `${label}에 실패했습니다. 오류 번호를 운영자에게 알려 주세요.`;
  if (stage === "inference" && codes[code]) [status, message] = codes[code];
  else if (stage === "inference" && /json mode|json.schema|response_format|grammar/i.test(raw)) message = "모델이 요청한 JSON 출력 형식을 처리하지 못했습니다.";
  else if (error?.ecrPublic) { status = error.status; message = error.message; }
  else if (stage === "budget" && [409, 429].includes(error?.status)) { status = error.status; message = error.message; }
  else if (stage === "convert" && /is not a function/.test(raw)) message = "현재 Worker에서 PDF 변환 기능을 사용할 수 없습니다. Markdown 또는 TXT로 올려 주세요.";
  return { status, body: { message: `${message} [${label} · ${reference}]`, stage, reference, ...(code ? { code } : {}) }, log: { event: "ecr_failure", stage, reference, code, status } };
}
