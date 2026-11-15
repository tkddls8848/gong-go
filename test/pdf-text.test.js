const test=require('node:test');
const assert=require('node:assert/strict');
const {createReader,pageText}=require('../public/pdf-text.js');
const fixture=require('./pdf-fixture.cjs');

test('큰 PDF는 선별 원문으로 전송하고 브라우저에서 제한을 넘는 PDF는 거부한다',async()=>{
  const source='일반 안내 '.repeat(125000)+'\n요구사항 번호 ECR-001\n요구사항 명칭 서버\n세부내용 CPU 16core 메모리 128GB';
  let cleaned=0;
  const reader=createReader({loadSelection:()=>import('../tools/pdf-selection-entry.mjs'),load:async()=>({GlobalWorkerOptions:{},Util:{transform:(_,t)=>t},
    getDocument:()=>({destroy:async()=>{},promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:595,height:841,transform:[]}),getTextContent:async()=>({items:[{str:source,transform:[1,0,0,1,0,20],width:100,height:8}]}),cleanup(){cleaned++;}})})})})});
  const result=await reader.convert({size:12*1024*1024,arrayBuffer:async()=>new TextEncoder().encode('%PDF-test').buffer});
  assert.equal(result.format,'selection');
  const payload=JSON.parse(await result.blob.text());
  assert.equal(payload.sections.length,1);assert.ok(payload.sections[0].text.includes('128GB'));assert.equal(cleaned,1);
  await assert.rejects(reader.convert({size:33*1024*1024}),/32MB/);
});

test('모아찍기 PDF는 왼쪽 표 전체 뒤에 오른쪽 이어지는 규격을 둔다',()=>{
  const items=Array.from({length:21},(_,i)=>[
    {str:`left${i}`,x:20,y:i*10,width:80,height:8},
    {str:`right${i}`,x:450,y:i*10,width:80,height:8}
  ]).flat();
  const text=pageText(items,{width:840,height:595});
  assert.ok(text.indexOf('left20')<text.indexOf('right0'));
  for(const item of items)assert.ok(text.includes(item.str));
  const crossing={str:'across',x:20,y:250,width:700,height:8};
  assert.ok(!pageText([...items,crossing],{width:840,height:595}).includes('\f'));
});
test('단일쪽의 원래 순서는 보존하면서 좌표로 번호 셀의 줄바꿈을 복원한다',()=>{
  const items=[{str:'요구사항 번호',x:0,y:10,width:70,height:10},{str:'ECR-001',x:80,y:10,width:70,height:10},{str:'요구사항 명칭',x:0,y:30,width:70,height:10},{str:'DB 서버',x:80,y:30,width:70,height:10}];
  assert.equal(pageText(items,{width:595,height:840}),'요구사항 번호 ECR-001\n요구사항 명칭 DB 서버');
});
test('내부 저장 순서가 뒤섞인 단일쪽 요구사항 표를 좌표순으로 복원한다',()=>{
  const items=[{str:'장비-012',x:20,y:700,width:80,height:10},{str:'장비-010',x:20,y:220,width:80,height:10},{str:'장비-011',x:20,y:420,width:80,height:10}];
  assert.equal(pageText(items,{width:595,height:841,sortSinglePage:true}),'장비-010\n장비-011\n장비-012');
});
test('9쪽 모아찍기는 행 우선 칸 순서로 읽고 서로 다른 쪽의 표를 섞지 않는다',()=>{
  const items=[];
  for(let cell=8;cell>=0;cell--)for(let line=0;line<12;line++)items.push({str:`page${cell+1}-line${line}`,x:(cell%3)*200+20,y:Math.floor(cell/3)*280+30+line*8,width:120,height:6});
  const text=pageText(items,{width:600,height:840,sortSinglePage:true});
  const pages=text.split('\f');
  assert.equal(pages.length,9);
  for(let i=0;i<9;i++) {
    assert.ok(pages[i].includes(`page${i+1}-line11`));
    assert.equal(new Set([...pages[i].matchAll(/page(\d+)-/g)].map(m=>m[1])).size,1);
  }
});
test('가로 3쪽 모아찍기의 빈 아래 여백 때문에 세 쪽을 서로 섞지 않는다',()=>{
  const items=[];
  for(let line=0;line<30;line++)for(let cell=0;cell<3;cell++)items.push({str:`part${cell+1}-${line}`,x:cell*280+30,y:35+line*11,width:210,height:6});
  const pages=pageText(items,{width:840,height:595,sortSinglePage:true}).split('\f');
  assert.equal(pages.length,3);
  for(let i=0;i<3;i++)assert.ok(pages[i].includes(`part${i+1}-29`));
});

test('PDF 읽기 중 취소하면 문서 작업을 닫고 결과를 반환하지 않는다',async()=>{
  let resolveDocument,loaded;
  const started=new Promise(r=>loaded=r); let destroyed=0;
  const reader=createReader({load:async()=>({GlobalWorkerOptions:{},getDocument(){loaded();return {promise:new Promise(r=>resolveDocument=r),destroy:async()=>{destroyed++;}};}})});
  const pending=reader.convert(new Blob([fixture()]));
  await started; reader.cancel(); resolveDocument({numPages:0});
  await assert.rejects(pending,/중지/); assert.ok(destroyed>0);
});
test('PDF 파서 내부 오류를 화면에 노출하지 않는다',async()=>{
  const reader=createReader({load:async()=>{throw new Error('secret stack path');}});
  await assert.rejects(reader.convert(new Blob([fixture()])),error=>!error.message.includes('secret')&&error.message.includes('PDF'));
});
