// PDF→Markdown은 표를 평문으로 풀기도 한다. 표의 셀 경계 대신 요구사항 번호와 상세 표 머리글을 쓴다.
// 장비 번호의 공백은 한 칸까지만 본다. \s*로 열어 두면 표 레이아웃의 빈 칸을 건너뛰어
// "장비" 머리글과 옆 칸의 숫자가 한 ID로 붙는다("장비             1").
const ID = /(?:\b[A-Z]{2,5}[-–][A-Z0-9]+(?:[-–][A-Z0-9]+)*|장비 ?[-–]?[A-Z]?\d+(?:[-–]\d+)*)/g;
const target = (id) => /^ECR[-–]|^장비/i.test(id);
const detail = /세부\s*내용|상세\s*내용|요구사항\s*정의|CPU|메모리|프로세서|컨트롤러|Usable|RAID|\d+\s*(?:GB|TB|GHz)/i;
// 소프트웨어·PC·UPS 표도 "시스템 장비구성 요구사항"으로 분류되고 CPU·메모리를 적는다.
// 분류로는 갈리지 않지만 명칭으로는 갈린다 — 같은 이름이 장비와 소프트웨어 양쪽에 있어도
// 장비 쪽만 꼬리에 서버/스토리지/스위치를 달고 있다(NMS/SMS서버와 NMS/SMS, 백신관리서버와
// 백신(PC용/서버용)). 그래서 이름이 걸려도 꼬리가 장비면 남긴다.
const NOT_EQUIPMENT = /\bPC\b|복합기|\bUPS\b|\bDBMS\b|그룹웨어|포털|백신|메신저|전자결재|기안기|오피스|Office|미들웨어|솔루션|소프트웨어|\bSW\b|S\/W|\bWAS\b|\bNMS\b|\bSMS\b|\bDRM\b|UI\/UX|공통/i;
const DEVICE_TAIL = /(?:서버|스토리지|스위치|장치|장비)\s*$/;
function equipmentTable(text) {
  // 명칭 칸이 옆 칸과 엇갈려 분류 문구만 잡히는 표가 있다(양산선 ECR-034 UPS). 그때는
  // 이름을 못 읽은 것으로 보고 표 머리를 본다.
  const name = (text.match(/요구사항\s*명칭\s*([^\n]{0,40})/) || [])[1];
  const usable = name && !/^\s*(?:시스템\s*장비구성|요구사항|정의)/.test(name);
  // 마크다운 표로 변환되면 이름 뒤에 칸 구분자가 붙는다. 꼬리 판정 전에 떼어 낸다.
  const subject = (usable ? name : text.slice(0, 300)).replace(/\s+/g, " ").replace(/^[\s|]+|[\s|]+$/g, "");
  return !NOT_EQUIPMENT.test(subject) || DEVICE_TAIL.test(subject);
}
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
    .filter((section) => detail.test(section.text) && equipmentTable(section.text));
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
