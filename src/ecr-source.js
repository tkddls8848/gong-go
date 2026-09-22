// PDF→Markdown은 표를 평문으로 풀기도 한다. 표의 셀 경계 대신 요구사항 번호와 상세 표 머리글을 쓴다.
const ID = /(?:\b[A-Z]{2,5}[-–][A-Z0-9]+(?:[-–][A-Z0-9]+)*|장비\s*[-–]?[A-Z]?\d+(?:[-–]\d+)*)/g;
const target = (id) => /^ECR[-–]|^장비/i.test(id);
const detail = /세부\s*내용|상세\s*내용|요구사항\s*정의|CPU|메모리|프로세서|컨트롤러|Usable|RAID|\d+\s*(?:GB|TB|GHz)/i;
export function requirementSections(text) {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((line) => line[0]);
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0], ids = [...line.matchAll(ID)].map((match) => match[0]);
    if (ids.length !== 1 || /참조|참고|연계|관련\s*요구/.test(line)) continue;
    const field = /(?:요구사항|요구|고유|식별)\s*(?:고유\s*)?(?:번호|ID|코드)/i.test(line + (i ? lines[i - 1][0] : ""));
    const leading = /^[\s|#*]*(?:ECR[-–]|[A-Z]{2,5}[-–]|장비\s*[-–]?\s*[A-Z]?\d)/.test(line);
    if (!field && !leading) continue;
    boundaries.push({ id: ids[0], start: lines[i].index });
  }
  const sections = boundaries.map((boundary, index) => ({ ...boundary, end: boundaries[index + 1]?.start ?? text.length }))
    .filter((section) => target(section.id))
    .map((section) => ({ ...section, text: text.slice(section.start, section.end) }))
    .filter((section) => detail.test(section.text));
  return { sections, ids: [...new Set(boundaries.filter((entry) => target(entry.id)).map((entry) => entry.id))] };
}
export function priorityOrder(chunks) {
  const rank = (text) => requirementSections(text).sections.length ? 0 : /ECR[-–]|장비\s*[-–]?\s*\d/i.test(text) ? 1 : 2;
  return chunks.map((text, index) => ({ index, rank: rank(text) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.index);
}
// 모델은 원문을 다시 쓰지 않고 줄 번호만 반환한다. 값·근거는 서버가 이 원문에서 복원한다.
export function sourceLines(text) {
  const lines = [];
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    for (let start = 0; start < match[0].length; start += 240) lines.push(match[0].slice(start, start + 240));
  }
  return lines;
}
export function numberedSource(text) { return sourceLines(text).map((line, index) => `[L${index + 1}] ${line}`).join("\n"); }
