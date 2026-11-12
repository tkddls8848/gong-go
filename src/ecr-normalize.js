// 원문 인용에서 수치·단위·조건만 뽑는다. 모델을 부르지 않는다.
// 값은 원문에 적힌 수 그대로다 — 단위를 환산하거나(1TB→1024GB) 합산하거나(운영 2대+개발 1대)
// 하나를 골라내지 않는다. 장비당/전체, Raw/Usable의 구분은 원문 쪽에 남아 있고, 여기서는
// 비교·정렬하기 쉬운 형태로 나란히 놓을 뿐이다. 읽지 못한 표기는 비워 둔다 — 지어내지 않는다.
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
// 단위 표기를 한 이름으로 모은다. 큰 단위를 먼저 둔다(GbE를 Gb로, TB/s를 TB로 먹지 않게).
const UNITS = [
  { unit: "Tbps", pattern: String.raw`Tbps|Tb\/s` },
  { unit: "Gbps", pattern: String.raw`Gbps|Gb\/s|GbE|GE\b|Gb\b|G(?![A-Za-z0-9])` },
  { unit: "Mbps", pattern: String.raw`Mbps|Mb\/s` },
  { unit: "Mpps", pattern: String.raw`Mpps` },
  { unit: "GB/s", pattern: String.raw`GB\/s|GBps` },
  { unit: "MB/s", pattern: String.raw`MB\/s|MBps` },
  { unit: "IOPS", pattern: String.raw`IOPS` },
  { unit: "PB", pattern: String.raw`PB\b|PiB` },
  { unit: "TB", pattern: String.raw`TB\b|TiB` },
  { unit: "GB", pattern: String.raw`GB\b|GiB` },
  { unit: "GHz", pattern: String.raw`GHz` },
  { unit: "코어", pattern: String.raw`cores?\b|Cores?\b|CORES?\b|코어` },
  { unit: "소켓", pattern: String.raw`sockets?\b|Sockets?\b|소켓` },
  { unit: "포트", pattern: String.raw`ports?\b|Ports?\b|PORTS?\b|포트` },
  { unit: "대", pattern: String.raw`대(?![가-힣])` },
  { unit: "식", pattern: String.raw`식(?![가-힣])` },
  { unit: "식", pattern: String.raw`set\b|SET\b|Set\b|세트` },
  { unit: "노드", pattern: String.raw`nodes?\b|Nodes?\b|노드` },
  { unit: "EA", pattern: String.raw`EA\b|ea\b|개(?![가-힣])` },
];
// 항목마다 읽을 단위만 연다. 메모리 칸의 "2.4GHz"나 수량 칸의 "256GB"는 그 항목의 값이 아니다.
const FIELD_UNITS = {
  수량: ["대", "식", "노드", "EA"],
  CPU: ["코어", "소켓", "GHz", "EA"],
  메모리: ["GB", "TB", "EA"],
  "로컬 디스크": ["GB", "TB", "EA"],
  "NIC/HBA": ["Gbps", "포트", "EA"],
  "Raw 용량": ["GB", "TB", "PB"],
  "Usable 용량": ["GB", "TB", "PB"],
  "디스크 구성": ["GB", "TB", "EA"],
  컨트롤러: ["GB", "TB", "Gbps", "포트", "EA"],
  성능: ["IOPS", "GB/s", "MB/s", "Gbps"],
  "포트 수": ["포트", "EA"],
  "포트 속도": ["Gbps", "Mbps"],
  "스위칭 용량": ["Tbps", "Gbps", "Mpps"],
  "트랜시버·케이블": ["Gbps", "EA"],
};
const COMPILED = UNITS.map(({ unit, pattern }) => ({ unit, regex: new RegExp(`^\\s*(?:${pattern})`) }));
// 수 바로 뒤나 앞의 조건어. "최소 512GB", "512GB 이상", "16코어 이상"을 같은 형태로 놓는다.
const AFTER = /^\s*(?:\([^)]{0,20}\)\s*)?(이상|이하|미만|초과)/;
const BEFORE = /(최소|최대)\s*:?\s*$/;
const MAX_MENTIONS = 8;

export function normalizeFact(field, quote) {
  const units = FIELD_UNITS[field];
  if (!units || typeof quote !== "string" || !quote.trim()) return [];
  const text = quote.replace(/\s+/g, " ");
  const mentions = [], seen = new Set();
  const finder = new RegExp(NUMBER, "g");
  let found, pending = [];
  while ((found = finder.exec(text))) {
    const before = text.slice(0, found.index);
    // 버전·모델 번호(Gen11, E5-2690, PCIe 4.0)의 숫자는 수치가 아니다. 영문자·하이픈에 바로 붙은 수는 건너뛴다.
    if (/[A-Za-z_-]$/.test(before) && !/[xX×]$/.test(before)) { pending = []; continue; }
    const rest = text.slice(found.index + found[0].length);
    // "10/25GbE"처럼 빗금으로 이은 수는 뒤의 단위를 함께 쓴다.
    if (/^\s*\/\s*\d/.test(rest)) { pending.push(found[0]); continue; }
    const matched = COMPILED.find(({ unit, regex }) => units.includes(unit) && regex.test(rest));
    const group = [...pending, found[0]];
    pending = [];
    if (!matched) continue;
    const after = rest.replace(matched.regex, "");
    const condition = (AFTER.exec(after) || [])[1] || { 최소: "이상", 최대: "이하" }[(BEFORE.exec(before) || [])[1]] || "";
    for (const raw of group) {
      const value = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      const key = `${value}|${matched.unit}|${condition}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({ 수치: value, 단위: matched.unit, 조건: condition });
      if (mentions.length >= MAX_MENTIONS) return mentions;
    }
  }
  return mentions;
}
// 줄 범위로 복원한 규격은 원문 줄이 통째로 값이 된다("| CPU | 2.4GHz 16Core 이상 |").
// 값에서는 표 칸 구분자·글머리표·항목명 칸을 걷어 낸다. 줄의 앞뒤만 덜어 내므로 남은 값은
// 여전히 원문 줄의 이어진 일부다 — 글자를 바꾸거나 줄 가운데를 잘라 잇지 않는다. 근거는 손대지 않는다.
// 항목명은 뒤에 칸 구분자·쌍점이 오거나 곧바로 수가 올 때만 뗀다. "CPU 사용률 70% 이하"의 CPU는
// 항목명 칸이 아니라 조건의 일부다. 값의 뜻을 가르는 말은 항목명으로 보지 않는다 — SSD·HDD는
// 디스크 종류이고, NIC·HBA와 트랜시버·케이블은 한 항목에 둘이 함께 들어 있어 떼면 어느 쪽인지 잃는다.
const LABELS = {
  용도: String.raw`용\s*도`,
  수량: String.raw`(?:도입\s*)?수\s*량`,
  도입구분: String.raw`도입\s*구분|구\s*분`,
  CPU: String.raw`CPU|프로세서|Processor`,
  메모리: String.raw`메모리|Memory|RAM|주기억\s*장치`,
  "로컬 디스크": String.raw`(?:내장|로컬|Local|OS)\s*(?:디스크|Disk)|디스크|Disk`,
  이중화: String.raw`이중화`,
  유지보수: String.raw`(?:무상\s*)?(?:유지\s*보수|하자\s*보수)`,
  종류: String.raw`종\s*류|유\s*형`,
  "Raw 용량": String.raw`Raw\s*용량|물리\s*용량`,
  "Usable 용량": String.raw`Usable\s*용량|가용\s*용량|유효\s*용량|실\s*사용\s*용량`,
  "디스크 구성": String.raw`디스크\s*구성`,
  프로토콜: String.raw`(?:지원\s*)?프로토콜|Protocol`,
  컨트롤러: String.raw`컨트롤러|Controller`,
  성능: String.raw`성\s*능`,
  복제: String.raw`복\s*제`,
  "포트 수": String.raw`포트\s*수|Port\s*수`,
  "포트 속도": String.raw`포트\s*속도`,
  "스위칭 용량": String.raw`스위칭\s*용량|Switching\s*Capacity`,
  라이선스: String.raw`라이선스|라이센스|Licen[cs]e`,
};
const NOTE = String.raw`(?:\([^)|]{0,20}\)\s*)?`;
const LABEL_FINDERS = Object.fromEntries(Object.entries(LABELS).map(([field, label]) => [field, {
  cell: new RegExp(String.raw`(?:^|\|)\s*(?:${label})\s*${NOTE}\|\s*`, "i"),
  lead: new RegExp(String.raw`^(?:${label})\s*${NOTE}(?:[:：]\s*|\s+(?=\d))`, "i"),
}]));
const EDGE_PIPES = /^(?:\|\s*)+|(?:\s*\|)+$/g;
const BULLET = /^(?:[-–—•·○●◦▪■□◆◇※*ㅇo]\s+|[①-⑳]\s*|\(?\d{1,2}[.)]\s+|[가-하][.)]\s+)/;
const RULE_ONLY = /^[\s|:=–—-]*$/;
function cleanLine(field, line) {
  let text = line.replace(/\s+/g, " ").trim();
  if (RULE_ONLY.test(text)) return "";
  text = text.replace(EDGE_PIPES, "").trim().replace(BULLET, "");
  const finder = LABEL_FINDERS[field];
  if (finder) {
    // 표 칸에서는 항목명만 든 칸의 뒤쪽이 값이다("서버 | CPU | 2.4GHz" → "2.4GHz").
    const found = (text.includes("|") && finder.cell.exec(text)) || finder.lead.exec(text);
    const from = found ? found.index + found[0].length : 0;
    if (from && from < text.length) text = text.slice(from);
  }
  return text.replace(EDGE_PIPES, "").trim();
}
export function cleanValue(field, quote) {
  if (typeof quote !== "string") return quote;
  const lines = quote.split("\n").map((line) => cleanLine(field, line)).filter(Boolean);
  // 걷어 내고 남는 것이 없으면 원문을 그대로 둔다. 값을 비우지 않는다.
  return lines.length ? lines.join("\n") : quote;
}
// 확인된 원문 인용(값)에서만 뽑는다. 근거를 확인하지 못한 값은 정규화해도 믿을 수 없다.
export function normalizeItems(items) {
  return items.map((item) => ({
    ...item,
    장비요약: (item.장비요약 || []).map((entry) => ({
      ...entry,
      규격: (entry.규격 || []).map((fact) => {
        // 값과 근거가 같은 것은 줄 범위로 복원한 규격이다. 모델이 값을 따로 적은 구형 응답은 다듬지 않는다.
        const value = fact.값 && fact.값 === fact.근거 ? cleanValue(fact.항목, fact.값) : fact.값;
        const cleaned = value === fact.값 ? fact : { ...fact, 값: value };
        const mentions = fact.검증 === "원문 확인" ? normalizeFact(fact.항목, value) : [];
        return mentions.length ? { ...cleaned, 정규화: mentions } : cleaned;
      }),
    })),
  }));
}
