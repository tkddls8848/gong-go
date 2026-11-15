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
