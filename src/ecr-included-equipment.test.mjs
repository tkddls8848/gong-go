import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResult} from './ecr.js';
import {consolidate} from './ecr-merge.js';
const note='※ 연구분석용 스토리지용량 Usable 100TB이상, SAN스위치포함';
const source=line=>'요구사항 번호 ECR-015\nGPU서버 2대\n'+line;
test('AI가 빠뜨린 명시적 포함 스토리지와 SAN 스위치를 수량 없이 보존한다',()=>{
  const result=consolidate(parseResult({response:{items:[]}},source(note),'rfp.pdf',0),{verifiedOnly:true});
  assert.equal(result.length,1);
  const devices=result[0].장비요약;assert.equal(devices.length,2);
  assert.equal(devices.find(d=>d.종류==='스토리지').규격.find(f=>f.항목==='Usable 용량').값,'100TB이상');
  assert.ok(devices.find(d=>d.종류==='스위치').규격.some(f=>f.항목==='종류'&&f.값==='SAN스위치'));
  assert.ok(devices.every(d=>!d.규격.some(f=>f.항목==='수량')));
  assert.ok(devices.every(d=>d.규격.every(f=>source(note).includes(f.근거))));
});
test('연결·부정·조건·기존 구성과 번호 없는 문장에서는 포함 장비를 추정하지 않는다',()=>{
  for(const line of [note.replace('포함','미포함'),note.replace('포함','연결 지원'),note+'하지 않음',
    note.replace('연구분석용','필요 시'),note.replace('연구분석용','기존'),note.replace('100TB','100TB/s'),
    note.replace('100TB이상,','100TB이상 또는'),note.replace('포함','제외'),note.replace(', SAN',',\nSAN')])
    assert.equal(parseResult({response:{items:[]}},source(line),'rfp.pdf',0).length,0,line);
  assert.equal(parseResult({response:{items:[]}},note,'rfp.pdf',0).length,0);
});
test('같은 이름의 AI 장비와 합치고 다른 요구사항에는 복사하지 않는다',()=>{
  const items=[{id:'ECR-015',kind:'스위치',name:'SAN 스위치',facts:[{field:'기타 조건',value:'SAN스위치포함',evidence:note}]}];
  const text=source(note)+'\n요구사항 번호 ECR-016\n다른 서버 1대';
  const result=consolidate(parseResult({response:{items}},text,'rfp.pdf',0),{verifiedOnly:true});
  assert.equal(result.length,1);assert.equal(result[0].id,'ECR-015');assert.equal(result[0].장비요약.length,2);
});
