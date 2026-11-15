// 요구사항 번호가 없어도 도입 맥락과 명시적 품목/규격/수량 머리가 있는 목록을 찾는다.
export function inventoryRows(text) {
  return [...text.matchAll(/^번호:\s*(\d+)[^\S\n]*\n품명:([^\n]+)\n규격:([^\n]*)\n수량:([^\n]+)/gm)]
    .map(match=>({name:match[2].trim(),spec:match[3].trim(),quantity:match[4].trim(),quantityEvidence:`수량:${match[4]}`,text:match[0],index:match.index}));
}
export function inventoryKind(row) {
  if(/스토리지|\bstorage\b/i.test(row.name))return '스토리지';
  if(/스위치|\bswitch\b/i.test(row.name))return '스위치';
  if(/서버|\bserver\b/i.test(row.name))return '서버';
  if(/^Backup\s+system$/i.test(row.name)&&/Storage\s*usable\s*\d+(?:\.\d+)?\s*[GT]B/i.test(row.spec))return '스토리지';
  return null;
}
export function inventorySections(text, selected=[]) {
  const header=/^번호\s+품명\s+규격\s*(?:및\s*사양)?\s+수량[^\S\n]*$/gm;
  const found=[];
  for(const match of text.matchAll(header)) {
    if(found.some(section=>match.index<section.end)||selected.some(section=>match.index>=section.start&&match.index<section.end))continue;
    const context=text.slice(Math.max(0,match.index-600),match.index);
    if(!/(?:구축|도입|납품|지원)[^\n]{0,50}(?:기자재|장비|품목)[^\n]{0,30}(?:목록|내역)/.test(context))continue;
    if(/(?:기존|보유|운영중인)[^\n]{0,35}(?:장비|기자재)[^\n]{0,20}현황/.test(context))continue;
    const after=text.slice(match.index+match[0].length);
    const stop=/^(?:\d+(?:-\d+)+[.)]\s+|요구사항\s*(?:고유번호|번호|ID)\s*[:：]?\s*[A-Z]+-)/m.exec(after);
    const end=stop?match.index+match[0].length+stop.index:text.length;
    const body=text.slice(match.index,end);
    if(!/서버|스토리지|스위치|\bStorage\b|Backup\s+system/i.test(body)||!/CPU|RAM|메모리|\d+\s*(?:[GT]B|Gbps|ports?)/i.test(body))continue;
    found.push({id:'',start:match.index,end,text:body,unnumbered:true});
  }
  return found.flatMap(section=>{
    const rows=inventoryRows(section.text);
    if(!rows.length)return [section];
    // 셀로 복원된 물품표에서는 대상 종류가 명시된 품목만 분석한다. PC/소프트웨어 규격을 섞지 않는다.
    const devices=rows.filter(row=>/서버|스토리지|스위치|\bStorage\b|\bBackup\s+system\b/i.test(row.name)
      && !/라이선스|운영체제|소프트웨어/i.test(row.name));
    if(!devices.length)return [section];
    return devices.map(row=>({id:'',start:section.start+row.index,end:section.start+row.index+row.text.length,text:row.text,unnumbered:true}));
  });
}
