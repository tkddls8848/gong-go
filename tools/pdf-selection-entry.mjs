// 빌드 시 순수 선별 코드를 브라우저용으로 묶는다. 생성 번들의 런타임에는 src/ import가 없다.
import {unfoldColumns,sectionsOf} from '../src/ecr-source.js';
import {separateCells} from '../src/ecr-cells.js';
export function prepareSelection(text) {
  if(typeof text!=='string'||text.length>2000000)throw new Error('문서가 너무 큽니다. 제안요청서를 나누어 올려 주세요.');
  const unfolded=separateCells(unfoldColumns(text)),selection=sectionsOf(unfolded);
  if(!selection.sections.length)throw new Error('큰 문서에서 장비 상세 표를 선별하지 못했습니다. 제안요청서를 나누어 올려 주세요.');
  if(selection.sections.reduce((n,s)=>n+s.text.length,0)>120000)throw new Error('상세 요구사항 표가 너무 많습니다. 제안요청서를 나누어 올려 주세요.');
  return {schemaVersion:1,sourceChars:text.length,ids:selection.ids,sections:selection.sections.map(s=>({id:s.id,text:s.text,unnumbered:!!s.unnumbered}))};
}
