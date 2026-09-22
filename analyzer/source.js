// 원문을 조용히 잘라 규격이 사라지는 것을 방지한다. 예산을 넘으면 명시적으로 실패한다.
function completeSource(documents, prompt, context) {
  const source = documents.map((document) => `문서: ${document.name}\n\n${document.text}`).join("\n\n---\n\n");
  // 한국어/표 입력에 대한 보수적인 추정치. 출력과 시스템 지시문 공간을 따로 확보한다.
  const estimated = Math.ceil((source.length + prompt.length) * 1.5) + 10000;
  if (estimated > context) throw new Error(`문서 전체 입력이 Ollama context 예산을 초과합니다(추정 ${estimated}, 설정 ${context}). 원문을 자르지 않았습니다. --ollama-context를 늘리거나 문서를 나누거나 Anthropic을 사용하세요.`);
  return source;
}
module.exports = { completeSource };
