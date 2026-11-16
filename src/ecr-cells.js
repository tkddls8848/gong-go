// PDF 변환기가 이어 붙인 명시적 괄호 항목만 분리한다. 값은 변경하지 않는다.
const CELL = /\((CPU|MEM|Memory|RAM|DISK|NIC|HBA|GPU|OS|기타)\)/gi;
export function separateCells(text) {
  // 번호 셀에서 생긴 공백은 번호 인식 전에 정리한다. 일반 본문은 건드리지 않는다.
  text = text.replace(/(\bECR|장비)[ \t]*[-–][ \t]*(?=[A-Z0-9])/g, '$1-');
  if(text.includes('장비-'))text = text.replace(/(?<=[가-힣]{2})[ \t]*[-–][ \t]*(?=장비-\d)/g, '-');
  text = text.replace(/[§※○]|Form Factor(?=\s)/g,(mark,offset,source)=>offset&&source[offset-1]!=='\n'?'\n'+mark:mark);
  // 표의 마지막 수량 셀이 앞 한글 값과 붙은 경우, 독립된 단위 끝에서만 분리한다.
  text = text.replace(/([가-힣)])(\d+\s*(?:대|식))(?=\s|$)/g, '$1\n$2');
  return text.split('\n').map(line => {
    if(!line.includes('('))return line;
    const labels = [...line.matchAll(CELL)];
    if (labels.length < 2) return line;
    return line.replace(CELL, '\n$&').trimStart();
  }).join('\n');
}

// 같은 한 줄에 여러 항목이 인용된 구형 응답에도 항목 경계를 적용한다.
const FIELDS = { CPU: 'CPU', MEM: '메모리', MEMORY: '메모리', RAM: '메모리', DISK: '로컬 디스크', NIC: 'NIC/HBA', HBA: 'NIC/HBA', GPU: 'GPU', OS: 'OS', 기타: '기타 조건' };
export function cellValue(field, text) {
  const matches = [...text.matchAll(CELL)];
  if (matches.length < 2) return text;
  const cells = matches.map((m, i) => ({ field: FIELDS[m[1].toUpperCase()], text: text.slice(m.index + m[0].length, matches[i + 1]?.index).trim() }));
  const selected = cells.filter(c => c.field === field || field === '디스크 구성' && c.field === '로컬 디스크');
  return selected.length ? selected.map(c => c.text).join('\n') : text;
}

// 셀 경계가 확인된 단일 장비 행의 명시적 항목을 보존한다. 수치나 단위를 새로 만들지 않는다.
export function rowFacts(specification, kind) {
  const facts=[];
  const add=(field,value,quote)=>{
    if(!facts.some(f=>f.항목===field&&f.값.includes(value)&&f.근거.includes(quote)))
      facts.push({항목:field,값:value,근거:quote,검증:'원문 확인',추출:'표 규격 셀'});
  };
  // 다단 자원 표의 머리글에 있는 단위·1대 기준·설치/활성 조건도 값에 보존한다.
  for(const m of specification.matchAll(/((CPU|메모리)\s+\([^\n:/]+\)\s+(?:설치|act\.)):\s*(\d[\d,]*)/g)) {
    add(m[2],m[0],m[0]);
  }
  for(const raw of specification.split(/\s+\/\s+(?=(?:CPU|메모리|내장디스크|가상서버\s+[^:]+)\s*:)|\s+(?=-\s+|운영체제\s*SW\s*[-:：]|(?:CPU|RAM|MEM|Memory|HDD|SSD|Disk|NIC|HBA|캐시|메모리|인터페이스|용량)\s*[:：])/i)) {
    const quote=raw.trim();
    if(!quote)continue;
    const label=/^(?:-\s*)?([^:：]{1,20})\s*[:：]\s*(.+)$/s.exec(quote);
    if(!label)continue;
    const name=label[1].trim(),value=label[2].trim();
    let field;
    if(/^(?:CPU|프로세서)$/i.test(name))field='CPU';
    else if(/^(?:메모리|MEM|Memory|RAM)$/i.test(name))field='메모리';
    else if(/^(?:캐시|Cache)$/i.test(name))field='캐시';
    else if(/^(?:용량|저장용량|가용용량)$/i.test(name)&&/\bUsable\b|가용|사용공간/i.test(value+' '+name))field='Usable 용량';
    else if(/^(?:용량|저장용량|물리용량)$/i.test(name)&&/\bRaw\b|물리/i.test(value+' '+name))field='Raw 용량';
    else if(/^(?:인터페이스|NIC|HBA)$/i.test(name))field=kind==='스위치'?'포트 수':'NIC/HBA';
    else if(/^(?:내장디스크|디스크|Disk|HDD|SSD)$/i.test(name))field=kind==='서버'?'로컬 디스크':'디스크 구성';
    else if(/^가상서버\s+/.test(name)&&/^\d+$/.test(value))field='기타 조건';
    if(field)add(field,field==='기타 조건'?quote:value,quote);
  }
  if(kind==='스토리지') {
    const capacity=/(?:^|[^A-Za-z])(?:Storage\s*)?(Usable|Raw|가용\s*용량|사용\s*공간)\s*[:：]?\s*(\d[\d,.]*\s*(?:[PTGM]B|[PTGM]iB)(?![A-Za-z/])(?:\s*(?:이상|이하|초과|미만))?)/gi;
    for(const match of specification.matchAll(capacity))add(/^raw$/i.test(match[1])?'Raw 용량':'Usable 용량',match[2],match[0].trim());
    for(const match of specification.matchAll(/백업\s*관리\s*대상\s*\d+\s*(?:nodes?|노드)/gi))add('기타 조건',match[0],match[0]);
  }
  if(kind==='스위치') {
    for(const match of specification.matchAll(/\d+\s*SFP(?:\s*GBIC)?(?:\s*슬롯)?(?:\s*제공)?/gi))add('포트 수',match[0],match[0]);
    for(const match of specification.matchAll(/(?:최대\s*|최소\s*)?\d[\d,]*\s*개(?:의)?\s*MAC\s*주소(?:\s*구성\s*기능)?/gi))add('기타 조건',match[0],match[0]);
  }
  return facts;
}

// 브라우저가 선으로 그린 표를 복원한 행("업무명: 개발서버 | CPU (tpmC): 1,200,000 이상 | MEM (GB): 64이상")의 칸을 읽는다.
// 머리글이 항목을 정한다. 값은 칸의 글이고, 머리글 괄호의 단위("(GB)")만 값 뒤에 붙인다.
const CELL_FIELDS = [
  [/^(?:CPU|tpmC|Core|코어)(?![가-힣A-Za-z])/i, "CPU"],
  [/^(?:MEM|Memory|메모리|RAM)(?![가-힣A-Za-z])/i, "메모리"],
  [/^(?:Disk|디스크|HDD|SSD)(?![A-Za-z])/i, "디스크"],
  [/^(?:FC|NIC|N\/W|Network|네트워크)(?![가-힣A-Za-z])/i, "NIC/HBA"],
  [/(?:^|\s)(?:수\s*량|대\s*수)$/, "수량"],
];
const tight = (text) => String(text || "").replace(/\s+/g, "");
function gridRows(source) {
  const rows = [];
  for (const line of String(source || "").split("\n")) {
    if (!line.includes(" | ")) continue;
    const cells = line.split(" | ").map((part) => { const at = part.indexOf(": "); return at > 0 ? { label: part.slice(0, at).trim(), value: part.slice(at + 2).trim(), text: part.trim() } : null; });
    if (cells.length >= 3 && cells.every(Boolean)) rows.push({ line: tight(line), cells });
  }
  return rows;
}
function readCell(cell, kind) {
  const existing = /^기존\s*/.test(cell.label);
  const label = cell.label.replace(/^(?:기존|증설|변경)\s*/, "");
  let field = CELL_FIELDS.find(([pattern]) => pattern.test(label))?.[1] || "";
  if (field === "디스크") field = kind === "서버" ? "로컬 디스크" : /usable|가용|사용\s*공간/i.test(cell.value) ? "Usable 용량" : /\braw\b|물리/i.test(cell.value) ? "Raw 용량" : "디스크 구성";
  const unit = /^(?:CPU|MEM|Memory|메모리|RAM|Disk|디스크|HDD|SSD)\s*\(([^()]+)\)$/i.exec(label)?.[1];
  const plain = /^(?:CPU|MEM|Memory|메모리|RAM|Disk|디스크|HDD|SSD|수\s*량|대\s*수|서버\s*수량)$/i.test(label);
  return { field, existing, label: cell.label, quote: cell.text, value: unit ? `${cell.value} (${unit})` : plain ? cell.value : `${label}: ${cell.value}` };
}
// 규격의 인용이 가리키는 칸. 인용이 칸 하나면 그 칸, 아니면 인용이 든 행에서 값이 같은 칸이다.
// 같은 값이 서로 다른 항목의 칸에 있으면 정하지 않는다.
export function cellField(source, fact, kind) {
  const value = tight(fact?.값), quote = tight(fact?.근거);
  if (!value) return null;
  const cells = gridRows(source).flatMap((row) => row.cells.map((cell) => ({ ...cell, row: row.line })));
  let found = cells.filter((cell) => tight(cell.text) === quote);
  if (!found.length) found = cells.filter((cell) => tight(cell.value) === value && (cell.row.includes(quote) || quote.includes(tight(cell.text))));
  if (!found.length) return null;
  // 띄어쓰기만 다른 같은 값("64이상", "64 이상")은 같은 칸으로 보고 먼저 찾은 쪽을 쓴다.
  const kinds = [...new Map(found.map((cell) => readCell(cell, kind)).reverse().map((entry) => [`${entry.field}|${entry.existing}|${tight(entry.value)}`, entry])).values()];
  return kinds.length === 1 && kinds[0].field ? kinds[0] : null;
}
// 모델은 복원한 행에서 용도 하나만 돌려주기도 한다. 장비의 행이 정해지면 그 행의 자원 칸을 규격으로 싣는다.
// 행은 장비 이름이 이름 칸과 같거나, 확인된 규격의 인용이 그 행에만 있을 때 그 장비의 것이다.
export function gridRowFacts(source, name, facts, kind) {
  const rows = gridRows(source);
  if (!rows.length) return [];
  const title = tight(String(name || "").replace(/^\(([^]*)\)$/, "$1"));
  const quotes = facts.filter((fact) => fact.검증 === "원문 확인").map((fact) => tight(fact.근거)).filter((quote) => quote.length >= 4);
  const owned = rows.filter((row) => title && row.cells.slice(0, 2).some((cell) => tight(cell.value) === title)
    || quotes.some((quote) => row.line.includes(quote) && rows.filter((other) => other.line.includes(quote)).length === 1));
  const output = [];
  for (const row of owned) for (const cell of row.cells) {
    const read = readCell(cell, kind);
    if (!read.field || read.existing || !/[0-9A-Za-z가-힣]/.test(cell.value)) continue;
    if (!output.some((fact) => fact.항목 === read.field && fact.근거 === read.quote)) output.push({ 항목: read.field, 값: read.value, 근거: read.quote, 검증: "원문 확인", 추출: "표 칸" });
  }
  return output;
}

// 복원한 행의 비고 칸이 기존 장비라고 적은 장비("비고: 가상화서버 (자체보유) ※ 상수도사업본부 기존 장비 사용")인지.
export function existingRow(source, name) {
  const title = tight(String(name || "").replace(/^\(([^]*)\)$/, "$1"));
  if (!title) return false;
  const rows = gridRows(source).filter((row) => row.cells.slice(0, 2).some((cell) => tight(cell.value) === title));
  return rows.length > 0 && rows.every((row) => row.cells.some((cell) => /기존\s*장비\s*사용|자체\s*보유/.test(cell.value)));
}
