const test=require('node:test');
const assert=require('node:assert/strict');
const {segments}=require('../public/pdf-geometry.js');
const OPS={save:10,restore:11,transform:12,constructPath:91,stroke:20,closeStroke:21,fill:22};
test('장치가 빈 파생 규격 셀은 명시된 표준 규격 추가 문구가 있을 때만 복원한다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const item=(str,x,y)=>({str,x,y,width:8,height:4});
  const items=[item('구분',2,8),item('장치',24,8),item('세부규격',65,8),
    item('가급-2',2,22),item('가급(표준) 규격에 추가 - GPU A100',65,22),
    item('공통',2,42),item('전원',24,42),item('이중화',65,42)];
  const lines=[...[20,55].map(at=>({axis:'v',at,start:0,end:52})),
    ...[0,12,32,52].map(at=>({axis:'h',at,start:0,end:100}))];
  assert.deepEqual(tables(items,lines)[0].rows,[['가급-2','','가급(표준) 규격에 추가 - GPU A100'],['공통','전원','이중화']]);
  assert.equal(tables(items.map(i=>i.str.includes('GPU')?{...i,str:'GPU A100'}:i),lines).length,0);
});
test('기술 사양 표의 병합 등급을 CPU·메모리 셀에 연결하고 공통을 별도로 유지한다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const item=(str,x,y)=>({str,x,y,width:8,height:4});
  const items=[item('구분',2,8),item('장치',24,8),item('세부규격',65,8),
    item('가급',2,30),item('CPU',24,22),item('128Core',65,22),item('메모리',24,38),item('1024GB',65,38),
    item('공통',2,54),item('전원',24,54),item('이중화',65,54)];
  const lines=[...[20,55].map(at=>({axis:'v',at,start:0,end:60})),...[0,12,44,60].map(at=>({axis:'h',at,start:0,end:100})),{axis:'h',at:28,start:20,end:100}];
  const [table]=tables(items,lines);
  assert.deepEqual(table.rows,[['가급','CPU','128Core'],['가급','메모리','1024GB'],['공통','전원','이중화']]);
  assert.match(table.str,/규격 구분: 가급\n장치: 메모리\n세부규격: 1024GB/);
});
test('등급별 장비 목록의 예상 Core와 tpmC를 장비 행에 붙이고 수량을 만들지 않는다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const item=(str,x,y,width=8)=>({str,x,y,width,height:4});
  const items=[item('구분',2,8),item('장비',30,8),item('예상 tpmC',64,8,20),item('예상 Core',94,8,20),
    item('가급',2,30),item('나급',2,54),item('서버 A',25,22),item('서버 B',25,38),item('서버 C',25,54),
    ...[[22,'14500000','50'],[38,'5800000','20'],[54,'1000000','4']].flatMap(([y,t,c])=>[item(t,65,y),item(c,96,y)])];
  const lines=[...[20,60,90].map(at=>({axis:'v',at,start:0,end:60})),...[0,12,44,60].map(at=>({axis:'h',at,start:0,end:120})),{axis:'h',at:28,start:20,end:120}];
  const [table]=tables(items,lines);
  assert.deepEqual(table.rows.map(r=>r[0]),['가급 서버 A','가급 서버 B','나급 서버 C']);
  assert.equal(table.rows[1][1],'예상 tpmC: 5800000 / 예상 Core: 20');
  assert.ok(table.rows.every(r=>r[2]===''));
  assert.doesNotMatch(table.str,/수량:|대수:/);
});
test('짧은 stroke 점선을 연결하되 빈 구간·다른 축·고립 선분은 연결하지 않는다',()=>{
  const paths=[];
  const dash=(x,y,vertical=false)=>paths.push([20,[[0,x,y,1,x+(vertical?0:.36),y+(vertical?.36:0)]]]);
  for(let i=0;i<6;i++){dash(10+i*.84,20);dash(30,40+i*.84,true);}
  for(let i=0;i<6;i++)dash(20+i*.84,20);
  dash(50,20);dash(50.84,20);dash(51.68,20); // 3개는 경계로 삼지 않는다.
  dash(70,20);dash(70.84,21);dash(71.68,22);dash(72.52,23);
  const lines=segments({fnArray:paths.map(()=>91),argsArray:paths},OPS);
  assert.equal(lines.length,3);
  assert.deepEqual(lines.map(l=>[l.axis,l.at,l.start]),[['h',20,10],['h',20,20],['v',30,40]]);
  assert.ok(lines.every(l=>Math.abs(l.end-l.start-4.56)<1e-9));
});
test('번호·품명·규격·수량 표는 여러 줄 품명과 사양을 행별로 보존',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const item=(str,x,y)=>({str,x,y,width:8,height:4});
  const items=[item('번호',2,8),item('품명',22,8),item('규격 및 사양',52,8),item('수량',92,8),
    item('1',2,24),item('가상화',22,20),item('서버',22,28),item('CPU 12core',52,20),item('RAM 32G',52,28),item('2',92,24)];
  const lines=[...[20,50,90].map(at=>({axis:'v',at,start:0,end:40})),...[0,12,40].map(at=>({axis:'h',at,start:0,end:110}))];
  const [table]=tables(items,lines);
  assert.deepEqual(table.rows,[['1','가상화 서버','CPU 12core RAM 32G','2']]);
  assert.match(table.str,/품명: 가상화 서버\n규격: CPU 12core RAM 32G\n수량: 2/);
});
function tableFixture(){
  const item=(str,x,y)=>({str,x,y,width:10,height:5});
  return {items:[item('구분',5,8),item('규격',45,8),item('수량',85,8),
    item('운영',5,25),item('96TB',30,20),item('캐시',30,30),item('2',85,25),
    item('DR',5,45),item('200TB',30,45),item('1',85,45),item('공통',5,65)],
    lines:[{axis:'v',at:20,start:0,end:60},{axis:'v',at:80,start:0,end:60},
      ...[0,12,36,60].map(at=>({axis:'h',at,start:0,end:100}))]};
}

function resourceFixture(){
  const item=(str,x,y,width=8)=>({str,x,y,width,height:4});
  const items=[item('구분',15,14),item('대수',42,14),item('CPU',57,7),item('(코어)',68,7),
    item('메모리',87,7),item('(GB)',99,7),item('설치',57,16),item('act.',72,16),
    item('설치',87,16),item('act.',102,16),item('운영',2,32),item('A',22,26),item('B',22,46),
    ...[[26,['2','48','14','1024','550']],[46,['1','48','19','1024','862']]].flatMap(([y,values])=>values.map((s,i)=>item(s,42+i*15,y))),
    item('합 계',22,66),item('3',42,66)];
  const lines=[...[0,20,60,75].map(at=>({axis:'h',at,start:0,end:115})),
    {axis:'h',at:40,start:20,end:115},{axis:'h',at:10,start:55,end:115},
    ...[40,55,85].map(at=>({axis:'v',at,start:0,end:75})),
    ...[70,100].map(at=>({axis:'v',at,start:10,end:75})),{axis:'v',at:20,start:20,end:60}];
  // 수치 열 중심은 각 실제 셀 안에 둔다.
  items.filter(i=>/^\d+$/.test(i.str)).forEach(i=>{if(i.x>42)i.x+=2; i.width=5;});
  return {items,lines};
}

test('대수와 다단 CPU·메모리 머리글을 병합 구분 셀의 각 행에 연결한다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const {items,lines}=resourceFixture();
  const [table]=tables(items,lines);
  assert.ok(table);
  assert.deepEqual(table.rows.map(r=>[r[0],r[2]]),[['운영 A','2'],['운영 B','1']]);
  assert.match(table.rows[0][1],/CPU \(코어\) 설치: 48/);
  assert.match(table.rows[1][1],/메모리 \(GB\) act\.: 862/);
  assert.match(table.str,/합 계 3/);
  assert.equal(tables(items.filter(i=>i.str!=='862'),lines).length,0);
  assert.equal(tables(items,lines.filter(l=>l.axis!=='v')).length,0);
});

test('수량 없는 자원 표는 합쳐진 가상서버 머리글과 빈 셀을 보존하며 대수를 만들지 않는다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const item=(str,x,y,width=8)=>({str,x,y,width,height:4});
  const items=[item('구분',4,14),item('CPU',42,14),item('메모리',62,14),item('가상서버',84,7),item('RHEL 윈도우',82,16,34),
    item('운영',2,32),item('A',22,26),item('B',22,46),item('8코어',42,26),item('16GB',62,26),item('4',82,26),item('1',102,26),
    item('8코어',42,46),item('32GB',62,46),item('2',82,46),item('합 계',22,66),item('6',82,66),item('1',102,66)];
  const lines=[...[0,20,60,75].map(at=>({axis:'h',at,start:0,end:120})),{axis:'h',at:40,start:20,end:120},
    {axis:'h',at:10,start:80,end:120},...[40,60,80].map(at=>({axis:'v',at,start:0,end:75})),
    {axis:'v',at:100,start:10,end:75},{axis:'v',at:20,start:20,end:60}];
  const [table]=tables(items,lines);
  assert.deepEqual(table.rows.map(r=>[r[0],r[2]]),[['운영 A',''],['운영 B','']]);
  assert.match(table.rows[0][1],/가상서버 RHEL: 4 \/ 가상서버 윈도우: 1/);
  assert.match(table.rows[1][1],/가상서버 윈도우: \(빈 셀\)/);
  assert.doesNotMatch(table.str,/수량:|대수:/);
  assert.equal(tables(items.map(i=>i.str==='RHEL 윈도우'?{...i,str:'RHEL윈도우'}:i),lines).length,0);
});
test('가운데 정렬된 구분·수량을 셀 경계로 묶고 공통 영역을 남긴다',()=>{
  const {tables}=require('../public/pdf-geometry.js'),{pageText}=require('../public/pdf-text.js');
  const {items,lines}=tableFixture();
  const [table]=tables(items,lines);
  assert.deepEqual(table.rows,[['운영','96TB 캐시','2'],['DR','200TB','1']]);
  assert.equal(table.members.some(i=>i.str==='공통'),false);
  const text=pageText(items,{width:595,height:841,lines});
  assert.match(text,/구분: 운영\n규격: 96TB 캐시\n수량: 2/);
  assert.match(text,/구분: DR\n규격: 200TB\n수량: 1/);
  assert.match(text,/공통/);
});
test('경계 불명확·열을 가로지르는 글·수량 없는 표를 임의로 재구성하지 않는다',()=>{
  const {tables}=require('../public/pdf-geometry.js');
  const {items,lines}=tableFixture();
  assert.deepEqual(tables(items,lines.filter(l=>l.axis!=='v')),[]);
  assert.deepEqual(tables([...items,{str:'across',x:10,y:22,width:80,height:5}],lines),[]);
  assert.deepEqual(tables(items.filter(i=>i.str!=='2'),lines),[]);
});
test('표 경계를 viewport와 중첩 transform에 맞춰 읽고 restore한다',()=>{
  const list={fnArray:[10,12,91,11,91],argsArray:[[],[2,0,0,2,10,20],
    [20,[[0,0,0,1,10,0,1,10,10]],[0,0,10,10]],[],[20,[[0,0,0,1,10,0]],[0,0,10,0]]]};
  assert.deepEqual(segments(list,OPS,[1,0,0,-1,0,100]),[
    {axis:'h',at:80,start:10,end:30},{axis:'v',at:30,start:60,end:80},{axis:'h',at:100,start:0,end:10}]);
});
test('곡선·대각선·채움은 표 경계로 추측하지 않는다',()=>{
  const list={fnArray:[91,91],argsArray:[
    [20,[[0,0,0,2,1,1,5,5,10,0,1,20,10,1,30,10]],[0,0,30,10]],
    [22,[[0,0,0,1,20,0]],[0,0,20,0]]]};
  assert.deepEqual(segments(list,OPS),[{axis:'h',at:10,start:20,end:30}]);
});
