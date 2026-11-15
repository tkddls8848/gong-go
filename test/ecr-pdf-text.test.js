const test=require('node:test');
const assert=require('node:assert/strict');
const {createEcr}=require('../public/ecr-ui.js');
function setup(size=20){
  const nodes=new Map(), requests=[];let resolve,cancelled=0;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{files:[{name:'원본.pdf',size}]});return nodes.get(id);};
  const model={currentRow:{mode:'bid'}},state={aiUnlocked:true,ecrRun:0};
  const ui=createEcr({model,state,$,numberOf:()=> 'notice',pdfReader:{convert:()=>new Promise(r=>resolve=r),cancel:()=>cancelled++},GongHttp:{async requestJson(url,options){requests.push({url,...options});return {response:{ok:true},data:{total:0}};}}});
  return {ui,model,state,requests,start:()=>ui.startEcrAnalysis({preventDefault(){}}),finish:(format='text')=>resolve({format,blob:new Blob(['ECR-001\nMemory 256GB'])}),cancelled:()=>cancelled};
}
test('PDF 좌표 텍스트를 원래 PDF 이름과 함께 업로드한다',async()=>{
  const s=setup(),pending=s.start();s.finish();await pending;
  const request=s.requests[0],url=new URL(request.url,'https://test');
  assert.equal(url.searchParams.get('name'),'원본.pdf');
  assert.equal(url.searchParams.get('format'),'text');
  assert.equal(await request.body.text(),'ECR-001\nMemory 256GB');
});
test('8MB를 넘는 PDF도 브라우저 선별 후 원래 이름과 selection 형식을 전송한다',async()=>{
  const s=setup(12*1024*1024),pending=s.start();s.finish('selection');await pending;
  assert.equal(s.requests.length,1);
  const url=new URL(s.requests[0].url,'https://test');
  assert.equal(url.searchParams.get('format'),'selection');assert.equal(url.searchParams.get('name'),'원본.pdf');
});
for(const reason of ['stop','row','lock'])test(`PDF 읽기 중 ${reason} 이후에는 AI 요청을 보내지 않는다`,async()=>{
  const s=setup(),pending=s.start();
  if(reason==='stop'){s.ui.stopEcrAnalysis();assert.equal(s.cancelled(),1);}
  if(reason==='row')s.model.currentRow={mode:'bid'};
  if(reason==='lock')s.state.aiUnlocked=false;
  s.finish();await pending;assert.equal(s.requests.length,0);
});
