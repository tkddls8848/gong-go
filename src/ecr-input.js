// 브라우저가 선별한 원문도 신뢰 경계 밖의 입력이다. 크기·구조를 검사하고
// 구간 수·모델 사용 예산은 기존 서버 경로에서 다시 제한한다.
import {requirementRanges} from './ecr-source.js';
export function readSelectionPayload(raw) {
  const invalid=()=>Object.assign(new Error('선별된 문서 형식이 올바르지 않습니다. 파일을 다시 올려 주세요.'),{status:400,ecrPublic:true});
  let data;try{data=JSON.parse(raw);}catch{throw invalid();}
  if(!data||data.schemaVersion!==1||!Number.isInteger(data.sourceChars)||data.sourceChars<1||data.sourceChars>2000000
    ||!Array.isArray(data.sections)||!data.sections.length||data.sections.length>200||!Array.isArray(data.ids)||data.ids.length>1000)throw invalid();
  const validId=id=>typeof id==='string'&&id.length<=80&&!/[\r\n\x00-\x1f]/.test(id);
  if(data.ids.some(id=>!validId(id)||!id.trim()))throw invalid();
  let total=0;
  const sections=data.sections.map(section=>{
    if(!section||!validId(section.id)||typeof section.text!=='string'||!section.text.trim()||typeof section.unnumbered!=='boolean'
      ||(!section.id&&!section.unnumbered))throw invalid();
    total+=section.text.length;
    if(total>120000)throw Object.assign(new Error('상세 요구사항 표가 너무 많습니다. 제안요청서를 나누어 올려 주세요.'),{status:413,ecrPublic:true});
    if(section.id&&(!data.ids.includes(section.id)||!requirementRanges(section.text).some(range=>range.id===section.id)))throw invalid();
    return {id:section.id,text:section.text,unnumbered:section.unnumbered};
  });
  const unfolded=sections.map(s=>s.text).join('\n\n');
  let offset=0;
  for(const section of sections){section.start=offset;section.end=offset+section.text.length;offset=section.end+2;}
  return {unfolded,sections,ids:[...new Set(data.ids)]};
}
