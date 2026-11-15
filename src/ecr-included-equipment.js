// 명시된 용량과 포함 장비가 한 주석에 함께 있을 때만 복원한다.
// 연결 기능, 선택 구성, 발주기관 제공, 수량은 이 문법으로 추정하지 않는다.
export function includedEquipment(ranges, location) {
  const results=[];
  const pattern=/^[ \t]*[※○•-]\s*([가-힣A-Za-z0-9 ()_-]{0,40}스토리지)\s*(?:용량\s*)?(Usable|Raw|가용\s*용량|물리\s*용량)\s*[:：]?\s*(\d[\d,.]*\s*(?:[PTGM]B|[PTGM]iB)\s*(?:이상|이하)?)\s*[,，]\s*(SAN\s*스위치)\s*포함\s*[.]?\s*$/gim;
  for(const range of ranges)for(const match of range.text.matchAll(pattern)) {
    const name=match[1].trim(),quote=match[0].trim();
    if(quote.includes('\n')||/기존|재사용|재활용|선택|필요|경우|가정|예시|제공|별도|제외|미포함|없|검토|대안/.test(name))continue;
    const fact=(field,value,evidence=quote)=>({항목:field,값:value,근거:evidence,검증:'원문 확인',추출:'원문 포함 구성'});
    const capacity=/^(?:Raw|물리)/i.test(match[2])?'Raw 용량':'Usable 용량';
    for(const [kind,title,facts] of [
      ['스토리지',name,[fact(capacity,match[3].trim()),fact('기타 조건',quote)]],
      ['스위치',match[4],[fact('종류',match[4]),fact('기타 조건',quote)]],
    ])results.push({id:range.id,분류:kind,명칭:title,세부내용_원문:range.text,기본규격:[],산출물:[],출처:location,
      불확실:['포함 구성 주석에서 확인한 장비이며 수량·추가 규격은 별도 원문 확인 필요'],
      장비요약:[{종류:kind,명칭:title,출처:location,규격:facts}]});
  }
  return results;
}
