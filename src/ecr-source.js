// PDF→Markdown은 표를 평문으로 풀기도 한다. 표의 셀 경계 대신 요구사항 번호와 상세 표 머리글을 쓴다.
// 장비 번호의 공백은 한 칸까지만 본다. \s*로 열어 두면 표 레이아웃의 빈 칸을 건너뛰어
// "장비" 머리글과 옆 칸의 숫자가 한 ID로 붙는다("장비             1").
const ID = /(?:\b[A-Z]{2,5}[-–][A-Z0-9]+(?:[-–][A-Z0-9]+)*|장비 ?[-–]?[A-Z]?\d+(?:[-–]\d+)*)/g;
// 요구사항 번호의 가운데 마디는 갈래를 가리킨다(ECR-HW-01 하드웨어, ECR-NW-06 네트워크,
// ECR-SW-04 소프트웨어, ECR-COM-08 공통). 소프트웨어와 공통은 장비 표가 아니다.
const target = (id) => (/^ECR[-–]|^장비/i.test(id)) && !/^ECR[-–](?:SW|COM)[-–]/i.test(id);
const detail = /세부\s*내용|상세\s*내용|요구사항\s*정의|CPU|메모리|프로세서|컨트롤러|Usable|RAID|\d+\s*(?:GB|TB|GHz)/i;
// 소프트웨어·PC·UPS 표도 "시스템 장비구성 요구사항"으로 분류되고 CPU·메모리를 적는다.
// 분류로는 갈리지 않지만 명칭으로는 갈린다 — 같은 이름이 장비와 소프트웨어 양쪽에 있어도
// 장비 쪽만 꼬리에 서버/스토리지/스위치를 달고 있다(NMS/SMS서버와 NMS/SMS, 백신관리서버와
// 백신(PC용/서버용)). 그래서 이름이 걸려도 꼬리가 장비면 남긴다.
const NOT_EQUIPMENT = /\bPC\b|복합기|\bUPS\b|\bDBMS\b|그룹웨어|포털|백신|메신저|전자결재|기안기|오피스|Office|미들웨어|솔루션|소프트웨어|\bSW\b|S\/W|\bWAS\b|\bNMS\b|\bSMS\b|\bDRM\b|UI\/UX|공통|교환기|IP-?PBX|IP\s?Phone/i;
const DEVICE_TAIL = /(?:서버|스토리지|스위치|장치|장비)\s*$/;
const LICENSE_ONLY = /^(?:(?:장비|서버|시스템|SW|S\/W)\s*)?(?:라이선스|라이센스|licen[cs]es?)(?:\s*(?:요건|요구사항|도입|구매|제공))?$/i;
function equipmentTable(text) {
  // 명칭 칸이 옆 칸과 엇갈려 분류 문구만 잡히는 표가 있다(양산선 ECR-034 UPS). 그때는
  // 이름을 못 읽은 것으로 보고 표 머리를 본다.
  const name = (text.match(/요구사항\s*명칭\s*([^\n]{0,40})/) || [])[1];
  const usable = name && !/^\s*(?:시스템\s*장비구성|요구사항|정의)/.test(name);
  // 마크다운 표로 변환되면 이름 뒤에 칸 구분자가 붙는다. 꼬리 판정 전에 떼어 낸다.
  const subject = (usable ? name : text.slice(0, 300)).replace(/\s+/g, " ").replace(/^[\s|]+|[\s|]+$/g, "");
  // 별도 라이선스 조건 표와 '라이선스 포함 서버'는 다르다. 명칭 전체가 라이선스일 때만 제외한다.
  if (usable && LICENSE_ONLY.test(subject)) return false;
  return !NOT_EQUIPMENT.test(subject) || DEVICE_TAIL.test(subject);
}
// 제안요청서는 요구사항 표 둘을 한 쪽에 좌우로 붙여 싣기도 한다(SR-MaaS 본공고). 평문으로
// 풀면 한 줄에 왼쪽 표와 오른쪽 표가 같이 오므로, 줄 단위로 읽는 선별기는 그런 줄을 통째로
// 건너뛰고 표 절반을 잃는다. 쪽마다 어느 칸이 늘 비어 있는지 보고 그 자리를 세로로 자른다.
const NUMBER_MARK = /(?:요구사항|요구|고유|식별)\s*(?:고유\s*)?(?:번호|ID|코드)/;
const GUTTER_MIN = 3;
const ONE_ID = new RegExp(ID.source);
export function unfoldColumns(text) {
  if (!text.includes("\f")) return text;
  return text.split("\f").map(unfoldPage).join("\f");
}
// 오른쪽 표에 가장 가까운 여백을 고른다. 왼쪽에 있는 여백은 라벨 칸과 값 칸 사이일 뿐이다.
function widestGap(blank, enough, from, to) {
  let gap = null;
  for (let x = from; x < to;) {
    if (blank[x] < enough) { x++; continue; }
    const start = x;
    while (x < to && blank[x] >= enough) x++;
    if (x - start >= GUTTER_MIN) gap = { start, end: x };
  }
  return gap;
}
function unfoldPage(page) {
  const lines = page.split("\n");
  const filled = lines.filter((line) => line.trim());
  if (filled.length < 5) return page;
  // 번호 칸이 찍힌 열을 본다. 왼쪽 표와 오른쪽 표는 같은 라벨을 서로 다른 열에 쓴다.
  const columns = [];
  for (const line of lines) { const finder = new RegExp(NUMBER_MARK, "g"); let found; while ((found = finder.exec(line))) columns.push(found.index); }
  if (columns.length < 2) return page;
  const near = Math.min(...columns), far = Math.max(...columns);
  // 같은 열에만 찍혔다면 한 단 쪽이다. 열 차이가 뚜렷할 때만 두 표로 본다.
  if (far - near < 40) return page;
  const width = Math.max(...filled.map((line) => line.length));
  const blank = new Array(width).fill(0);
  for (const line of filled) for (let x = 0; x < width; x++) if ((line[x] ?? " ") === " ") blank[x]++;
  // 두 표 사이의 여백을 찾는다. 쪽마다 사정이 다르다 — 넉넉히 떨어진 쪽은 전칸이 비고,
  // 빽빽한 쪽은 긴 줄 한둘이 여백을 넘어온다. 기준을 차례로 늦추며 자른 결과가 두 표로
  // 보이는 첫 자리를 쓴다. 자리를 고르기만 하고 검증을 밖에서 하면, 엉뚱한 자리 하나에
  // 걸려 남은 기준을 못 써 본 채 한 단으로 되돌아간다.
  for (const ratio of [1, 0.95, 0.92]) {
    const cut = widestGap(blank, filled.length * ratio, near + GUTTER_MIN, far);
    if (!cut) continue;
    const left = [], right = [];
    for (const line of lines) {
      // 여백을 가로지르는 줄은 자르지 않는다. 쪽 머리글이거나 왼쪽 표의 긴 줄이다.
      if (line.slice(cut.start, cut.end).trim()) { left.push(line); right.push(""); continue; }
      left.push(line.slice(0, cut.start).trimEnd());
      right.push(line.slice(cut.end).trimEnd());
    }
    const [leftText, rightText] = [left.join("\n"), right.join("\n")];
    // 양쪽에 번호 칸과 그 번호가 가리키는 ID가 함께 남아야 두 표다. 라벨 칸만 떼어낸 자리도
    // "요구사항 번호"는 품으므로 ID까지 본다. 한쪽만 표이면 다음 기준으로 넘어간다.
    if ([leftText, rightText].every((side) => NUMBER_MARK.test(side) && ONE_ID.test(side))) return `${leftText}\n${rightText}`;
  }
  return page;
}
// 입력의 문자 위치를 보존한다. 모델 근거 줄의 소속 검증에서도 사용한다.
export function requirementRanges(text) {
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
  return boundaries.map((boundary, index) => ({ ...boundary, end: boundaries[index + 1]?.start ?? text.length }))
    .map((section) => ({ ...section, text: text.slice(section.start, section.end) }));
}
export function requirementSections(source) {
  // 좌우로 붙은 표를 먼저 위아래로 편다. 이미 편 글은 번호 칸이 한 열에 모여 그대로 돌아온다.
  const ranges = requirementRanges(unfoldColumns(source));
  const sections = ranges.filter((section) => target(section.id))
    .filter((section) => detail.test(section.text) && equipmentTable(section.text));
  return { sections, ids: [...new Set(ranges.filter((entry) => target(entry.id)).map((entry) => entry.id))] };
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
