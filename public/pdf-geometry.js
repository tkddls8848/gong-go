// PDF.js 6의 그리기 경로에서 표 경계 후보를 읽는다. 텍스트나 장비를 생성하지 않는다.
(function(scope) {
  'use strict';
  const identity = [1,0,0,1,0,0];
  function multiply(a,b) {
    return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],
      a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
      a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function segments(list, OPS, viewportTransform=identity) {
    const result=[],short=[],stack=[];
    let matrix=[...viewportTransform];
    const point=(x,y)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
    function line(a,b) {
      if(!a||!b||!a.concat(b).every(Number.isFinite))return;
      const dx=Math.abs(a[0]-b[0]),dy=Math.abs(a[1]-b[1]);
      if(dy<=(dx>=3?.3:.03)&&dx>=.1)(dx>=3?result:short).push({axis:'h',at:(a[1]+b[1])/2,start:Math.min(a[0],b[0]),end:Math.max(a[0],b[0])});
      else if(dx<=(dy>=3?.3:.03)&&dy>=.1)(dy>=3?result:short).push({axis:'v',at:(a[0]+b[0])/2,start:Math.min(a[1],b[1]),end:Math.max(a[1],b[1])});
    }
    for(let i=0;i<list.fnArray.length;i++) {
      const op=list.fnArray[i],args=list.argsArray[i];
      if(op===OPS.save){stack.push([...matrix]);continue;}
      if(op===OPS.restore){matrix=stack.pop()||[...viewportTransform];continue;}
      if(op===OPS.transform){matrix=multiply(matrix,args);continue;}
      if(op!==OPS.constructPath||!args)continue;
      const [paint,data]=args;
      if(![OPS.stroke,OPS.closeStroke,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke].filter(Number.isInteger).includes(paint))continue;
      const path=data?.[0];
      if(!path||typeof path.length!=='number')continue;
      let current=null,first=null;
      for(let j=0;j<path.length;) {
        const command=path[j++];
        if(command===0){current=point(path[j++],path[j++]);first=current;}
        else if(command===1){const next=point(path[j++],path[j++]);line(current,next);current=next;}
        else if(command===2){j+=4;current=point(path[j++],path[j++]);}
        else if(command===3){j+=2;current=point(path[j++],path[j++]);}
        else if(command===4){line(current,first);current=first;}
        else break;
      }
      if([OPS.closeStroke,OPS.closeFillStroke,OPS.closeEOFillStroke].filter(Number.isInteger).includes(paint))line(current,first);
    }
    // 일부 PDF는 점선 하나를 수백 개의 짧은 stroke로 그린다.
    // 고립된 짧은 선이나 빈 구간을 연장하지 않고, 같은 축의 조밀한 연속만 복원한다.
    short.sort((a,b)=>a.axis.localeCompare(b.axis)||a.at-b.at||a.start-b.start);
    const groups=[];
    for(const part of short) {
      let group=groups.at(-1);
      if(!group||group.axis!==part.axis||Math.abs(group.at-part.at)>.03) {
        group={axis:part.axis,at:part.at,parts:[]};groups.push(group);
      }
      group.parts.push(part);
    }
    for(const group of groups) {
      let run=null,count=0;
      const flush=()=>{if(count>=4&&run.end-run.start>=3)result.push(run);};
      for(const part of group.parts.sort((a,b)=>a.start-b.start)) {
        if(!run||part.start-run.end>.6) {
          if(run)flush();
          run={axis:group.axis,at:group.at,start:part.start,end:part.end};count=1;
        } else if(part.end>run.end) {run.end=part.end;count++;}
      }
      if(run)flush();
    }
    return result;
  }
  // 세 열의 명시적 머리와 규격 열을 가로지르는 선이 모두 있을 때만 행을 복원한다.
  // 공통 기능처럼 수량 열 경계 밖으로 이어지는 영역은 그대로 둔다.
  function resourceTable(first,items,lines) {
    const join=cell=>[...cell].sort((a,b)=>Math.abs(a.y-b.y)>1?a.y-b.y:a.x-b.x).map(i=>i.str).join(' ');
    const unique=a=>a.sort((x,y)=>x-y).filter((v,i)=>!i||v-a[i-1]>.5);
    const quantity=items.find(i=>i.str.trim()==='대수'&&i.x>first.x&&Math.abs(i.y-first.y)<2);
    const equipment=items.find(i=>i.str.trim()==='장비'&&i.x>first.x&&Math.abs(i.y-first.y)<2);
    const anchor=quantity||items.find(i=>i.str.trim()==='CPU'&&i.x>first.x&&Math.abs(i.y-first.y)<2)||equipment;
    if(!anchor)return null;
    const top=lines.filter(l=>l.axis==='h'&&l.at<first.y-first.height*.3&&l.at>first.y-first.height*4&&l.start<first.x&&l.end>anchor.x+anchor.width).sort((a,b)=>b.at-a.at)[0];
    if(!top)return null;
    const full=lines.filter(l=>l.axis==='h'&&l.start<=top.start+.5&&l.end>=top.end-.5).sort((a,b)=>a.at-b.at);
    const headerEnd=full.find(l=>l.at>first.y);
    if(!headerEnd)return null;
    const vertical=lines.filter(l=>l.axis==='v'&&l.at>top.start&&l.at<top.end&&l.start<=headerEnd.at+.3&&l.end>headerEnd.at+first.height*2);
    const bounds=unique([top.start,...vertical.map(l=>l.at),top.end]);
    if(bounds.length<(anchor===equipment?4:6))return null;
    const q=bounds.findIndex((x,c)=>anchor.x+anchor.width/2>x&&anchor.x+anchor.width/2<bounds[c+1])+(anchor===equipment?1:0);
    if(q<1)return null;
    const specStart=quantity?q+1:q;
    const end=Math.min(...vertical.filter(l=>quantity?Math.abs(l.at-bounds[q])<.5||Math.abs(l.at-bounds[q+1])<.5:l.at>=bounds[q]-.5).map(l=>l.end));
    const bottom=full.find(l=>Math.abs(l.at-end)<.5)?.at;
    if(!Number.isFinite(bottom))return null;
    const members=items.filter(i=>i.x+i.width/2>top.start&&i.x+i.width/2<top.end&&i.y-i.height*.3>top.at&&i.y-i.height*.3<bottom);
    let heads=members.filter(i=>i.y<headerEnd.at);
    if(anchor===equipment) {
      if(!heads.some(i=>/예상\s*(?:Core|tpmC)/i.test(i.str)))return null;
    } else {
      if(!heads.some(i=>/CPU/.test(i.str))||!heads.some(i=>/메모리/.test(i.str)))return null;
      if(!quantity&&!heads.some(i=>/가상서버/.test(i.str)))return null;
    }
    // PDF.js가 인접한 머리글들을 한 text item으로 묶은 경우, 실제 열 경계와
    // 공백으로 나뉜 단어 수가 일치할 때만 왼쪽부터 각 셀에 대응시킨다.
    const headerBounds=i=>unique([top.start,...lines.filter(l=>l.axis==='v'&&l.start<i.y-i.height*.3&&l.end>i.y-i.height*.3&&l.at>top.start&&l.at<top.end).map(l=>l.at),top.end]);
    let unsafeHeader=false;
    heads=heads.flatMap(i=>{
      const active=headerBounds(i),cells=active.slice(0,-1).map((x,c)=>[x,active[c+1]]).filter(([lo,hi])=>i.x<hi-.5&&i.x+i.width>lo+.5);
      if(cells.length<2)return [i];
      const words=i.str.trim().split(/\s+/);
      if(words.length!==cells.length){unsafeHeader=true;return [i];}
      return words.map((str,c)=>({...i,str,x:(cells[c][0]+cells[c][1])/2,width:0}));
    });
    if(unsafeHeader)return null;
    if(members.some(i=>i.y>headerEnd.at&&!/합\s*계/.test(i.str)&&bounds.slice(1,-1).some(x=>i.x<x-.5&&i.x+i.width>x+.5)))return null;
    // 상위 머리글은 그 높이에서 이어진 실제 셀의 하위 열에만 적용한다.
    const labels=bounds.slice(0,-1).map((x,c)=>join(heads.filter(i=>{
      const cx=i.x+i.width/2,cy=i.y-i.height*.3;
      const active=unique([top.start,...lines.filter(l=>l.axis==='v'&&l.start<cy&&l.end>cy&&l.at>top.start&&l.at<top.end).map(l=>l.at),top.end]);
      const k=active.findIndex((v,n)=>cx>v&&cx<active[n+1]);
      return k>=0&&x>=active[k]-.5&&bounds[c+1]<=active[k+1]+.5;
    })));
    if(labels.slice(specStart).some(s=>!s))return null;
    const ys=unique([headerEnd.at,...lines.filter(l=>l.axis==='h'&&l.at>headerEnd.at&&l.at<=bottom+.3&&l.start<=bounds[q]+.5&&l.end>=top.end-.5).map(l=>l.at)]);
    if(Math.abs(ys.at(-1)-bottom)>.5)return null;
    const rows=[],totals=[];
    for(let r=0;r<ys.length-1;r++) {
      const cy=(ys[r]+ys[r+1])/2;
      const values=bounds.slice(0,-1).map((x,c)=>{
        const edges=lines.filter(l=>l.axis==='h'&&l.start<=x+.5&&l.end>=bounds[c+1]-.5);
        const lo=Math.max(headerEnd.at,...edges.filter(l=>l.at<cy).map(l=>l.at));
        const hi=Math.min(bottom,...edges.filter(l=>l.at>cy).map(l=>l.at));
        return join(members.filter(i=>i.x>=x-.5&&i.x+i.width<=bounds[c+1]+.5&&i.y-i.height*.3>lo&&i.y-i.height*.3<hi));
      });
      if(/합\s*계/.test(values.slice(0,q).join(' '))){totals.push(join(members.filter(i=>i.y>ys[r]&&i.y<ys[r+1])));continue;}
      if(quantity&&!/^\d+$/.test(values[q])||values.slice(specStart).some((v,i)=>!v&&!/가상서버/.test(labels[specStart+i]))||!values.slice(0,q).some(Boolean))return null;
      rows.push([values.slice(0,q).join(' ').trim(),values.slice(specStart).map((v,i)=>`${labels[specStart+i]}: ${v||'(빈 셀)'}`).join(' / '),quantity?values[q]:'']);
    }
    if(rows.length<2)return null;
    return {x:top.start,y:top.at,width:top.end-top.start,height:1,members,rows,
      // 대수 머리글을 유지한다. 기존 3열 표용 분할기가 뒤의 별도 표를 공통 조건으로 복사하지 않게 한다.
      str:rows.map(row=>`구분: ${row[0]}\n규격: ${row[1]}`+(quantity?`\n대수: ${row[2]}`:'')).join('\n\n')+(totals.length?'\n'+totals.join('\n'):'')};
  }
  function tables(items,lines) {
    const output=[];
    const plain=i=>i.str.replace(/\s/g,'');
    const join=cell=>[...cell].sort((a,b)=>Math.abs(a.y-b.y)>1?a.y-b.y:a.x-b.x).map(i=>i.str).join(' ');
    const unique=values=>values.sort((a,b)=>a-b).filter((v,i,a)=>!i||v-a[i-1]>.5);
    for(const first of items.filter(i=>['구분','번호'].includes(plain(i)))) {
      const resources=plain(first)==='구분'&&resourceTable(first,items,lines);
      if(resources){output.push(resources);continue;}
      const inventory=plain(first)==='번호';
      const same=items.filter(i=>Math.abs(i.y-first.y)<=Math.max(2,first.height*.4)&&i.x>first.x);
      const technical=!inventory&&same.some(i=>plain(i)==='장치')&&same.some(i=>plain(i)==='세부규격');
      const spec=same.find(i=>plain(i)===(inventory?'규격및사양':technical?'장치':'규격')),quantity=same.find(i=>plain(i)===(technical?'세부규격':'수량'));
      if(!spec||!quantity||spec.x>=quantity.x)continue;
      const headers=inventory?[first,same.find(i=>plain(i)==='품명'),spec,quantity]:[first,spec,quantity];
      if(headers.some(i=>!i)||headers.some((h,i)=>i&&h.x<=headers[i-1].x))continue;
      const vertical=lines.filter(l=>l.axis==='v'&&l.start<first.y&&l.end>first.y);
      const dividers=headers.slice(0,-1).map((h,i)=>vertical.filter(l=>l.at>h.x+h.width&&l.at<headers[i+1].x).sort((a,b)=>a.at-b.at)[0]);
      if(dividers.some(d=>!d))continue;
      const top=lines.filter(l=>l.axis==='h'&&l.at<first.y-first.height*.3&&l.at>=first.y-first.height*3&&l.start<=first.x&&l.end>=quantity.x+quantity.width).sort((a,b)=>b.at-a.at)[0];
      if(!top)continue;
      const bottom=Math.min(...dividers.map(d=>d.end));
      const bounds=[top.start,...dividers.map(d=>d.at),top.end];
      const ys=unique(lines.filter(l=>l.axis==='h'&&l.at>=top.at-.3&&l.at<=bottom+.3&&l.start<=dividers[0].at+.5&&l.end>=dividers.at(-1).at-.5).map(l=>l.at));
      if(ys.length<(inventory?3:4)||Math.abs(ys.at(-1)-bottom)>.5)continue;
      const members=items.filter(i=>i.x+i.width/2>bounds[0]&&i.x+i.width/2<bounds.at(-1)&&i.y-i.height*.3>ys[0]&&i.y-i.height*.3<bottom);
      // 텍스트가 열 경계를 실제로 가로지르면 잘못 판별한 표일 수 있다.
      if(members.some(i=>bounds.slice(1,-1).some(x=>i.x<x-.5&&i.x+i.width>x+.5)))continue;
      const rows=[];
      for(let r=1;r<ys.length-1;r++) {
        const row=members.filter(i=>i.y-i.height*.3>ys[r]&&i.y-i.height*.3<ys[r+1]);
        rows.push(bounds.slice(0,-1).map((x,c)=>{
          if(technical&&c===0) {
            const edges=lines.filter(l=>l.axis==='h'&&l.start<=x+.5&&l.end>=bounds[c+1]-.5);
            const cy=(ys[r]+ys[r+1])/2;
            const lo=Math.max(ys[1],...edges.filter(l=>l.at<cy).map(l=>l.at));
            const hi=Math.min(bottom,...edges.filter(l=>l.at>cy).map(l=>l.at));
            return join(members.filter(i=>i.x+i.width/2>x&&i.x+i.width/2<bounds[c+1]&&i.y-i.height*.3>lo&&i.y-i.height*.3<hi));
          }
          return join(row.filter(i=>i.x+i.width/2>x&&i.x+i.width/2<bounds[c+1]));
        }));
      }
      if(rows.length<(inventory?1:2)||rows.some(row=>(!row[1]&&!(technical&&/규격에\s*추가/.test(row[2])))||(technical?!row[0]||!row[2]:!/^\d+\s*(?:대|식|개|EA|sets?)?$/i.test(row.at(-1)))||inventory&&!/^\d+$/.test(row[0])))continue;
      output.push({x:bounds[0],y:top.at,width:bounds.at(-1)-bounds[0],height:1,members,rows,
        str:technical?rows.map(row=>`규격 구분: ${row[0]}\n장치: ${row[1]}\n세부규격: ${row[2]}`).join('\n\n')
          :inventory?'번호 품명 규격 및 사양 수량\n'+rows.map(row=>`번호: ${row[0]}\n품명: ${row[1]}\n규격: ${row[2]}\n수량: ${row[3]}`).join('\n\n')
          :rows.map(row=>`구분: ${row[0]}\n규격: ${row[1]}\n수량: ${row[2]}`).join('\n\n')});
    }
    return output.concat(gridTables(items,lines,new Set(output.flatMap(table=>table.members))));
  }
  // 선으로 그린 자원 표를 행마다 "머리글: 값" 한 줄로 복원한다. 값은 옮기기만 하고 만들지 않는다.
  // 칸 안 글이 두 줄이면("1,200,000"/"이상") 평문에서는 옆 칸의 가운데 줄과 섞여 값이 한 열씩 밀린다.
  // 대상은 두 가지뿐이다: 열 머리에 CPU·메모리·디스크가 둘 이상 있는 표와, 구분·규격·수량 머리를 가진 표.
  // 머리글이 값처럼 보이거나, 기존 장비 현황 표이거나, 글이 열 경계를 넘거나, 이름 칸이 비면 손대지 않는다.
  const RESOURCE=/^(?:(?:기존|증설|변경)\s*)?(?:CPU|MEM|Memory|메모리|RAM|Disk|디스크|HDD|SSD|tpmC)(?![가-힣A-Za-z])/i;
  const STATUS=/도입\s*년도|도입\s*연도|사용량|여유|현황/;
  // 칸마다 따로 그린 선분을 한 줄로 잇는다. 머리글 아래 선을 칸별로 그리는 문서가 있다.
  function joined(lines) {
    const output=[];
    for(const axis of ['h','v']) {
      const list=lines.filter(l=>l.axis===axis).sort((a,b)=>a.at-b.at||a.start-b.start);
      let group=[];
      const flush=()=>{
        let run=null;
        for(const part of group.sort((a,b)=>a.start-b.start)) {
          if(run&&part.start-run.end<=1.5)run.end=Math.max(run.end,part.end);
          else {if(run)output.push(run);run={axis,at:group[0].at,start:part.start,end:part.end};}
        }
        if(run)output.push(run);
      };
      for(const line of list) {
        if(group.length&&Math.abs(group[0].at-line.at)>.3){flush();group=[];}
        group.push(line);
      }
      if(group.length)flush();
    }
    return output;
  }
  function gridTables(items,rawLines,used=new Set()) {
    if(!items.some(i=>RESOURCE.test(i.str.trim()))&&!items.some(i=>/^(?:규격|사양|세부규격)$/.test(i.str.replace(/\s/g,''))))return [];
    const lines=joined(rawLines),H=lines.filter(l=>l.axis==='h'),V=lines.filter(l=>l.axis==='v');
    const unique=(values,gap=.5)=>values.sort((a,b)=>a-b).filter((v,i,a)=>!i||v-a[i-1]>gap);
    const join=cell=>[...cell].sort((a,b)=>Math.abs(a.y-b.y)>1?a.y-b.y:a.x-b.x).map(i=>i.str.trim()).join(' ').replace(/\s+/g,' ').trim();
    const cx=i=>i.x+i.width/2,cy=i=>i.y-i.height*.3;
    const spans=[],output=[],taken=[];
    for(const line of H) {
      let span=spans.find(s=>Math.abs(s.start-line.start)<=1&&Math.abs(s.end-line.end)<=1);
      if(!span)spans.push(span={start:line.start,end:line.end,ats:[]});
      span.ats.push(line.at);
    }
    for(const span of spans.sort((a,b)=>(b.end-b.start)-(a.end-a.start))) {
      // 머리글 아래 겹선(0.7 간격)은 한 줄이다.
      const ys=unique(span.ats,2);
      if(ys.length<3)continue;
      const left=span.start,right=span.end,top=ys[0],bottom=ys.at(-1);
      if(taken.some(t=>left<t.right&&right>t.left&&top<t.bottom&&bottom>t.top))continue;
      const columnsAt=y=>unique([left,...V.filter(l=>l.at>left+1&&l.at<right-1&&l.start<y&&l.end>y).map(l=>l.at),right]);
      const bounds=columnsAt((ys[1]+ys[2])/2);
      if(bounds.length<4)continue;
      const members=items.filter(i=>cx(i)>left&&cx(i)<right&&cy(i)>top&&cy(i)<bottom);
      if(members.some(i=>used.has(i)))continue;
      const heads=members.filter(i=>cy(i)<ys[1]);
      if(!heads.length)continue;
      // 여러 열에 걸친 윗머리("기존", "증설")는 그 아래 열마다 붙인다.
      const labels=bounds.slice(0,-1).map((x,c)=>join(heads.filter(i=>{
        const active=columnsAt(cy(i)),k=active.findIndex((v,n)=>cx(i)>v&&cx(i)<active[n+1]);
        return k>=0&&x>=active[k]-.5&&bounds[c+1]<=active[k+1]+.5;
      })));
      const plain=labels.map(label=>label.replace(/\s/g,''));
      if(heads.some(i=>!labels.some(label=>label.includes(i.str.trim()))))continue;
      const resource=labels.filter(label=>RESOURCE.test(label)).length>=2;
      // 구분·규격·수량 순서의 표는 위의 복원기가 맡는다(거절한 표도 건드리지 않는다). 여기서는 수량이 규격 앞에 오는 표만 다룬다.
      const specAt=plain.findIndex(label=>/^(?:규격|사양|세부규격|규격및사양)$/.test(label)),countAt=plain.findIndex(label=>/^(?:수량|대수)$/.test(label));
      const specList=countAt>0&&specAt>countAt&&/^(?:구분|품명|장비명|품목|항목|장비)$/.test(plain[0]);
      if(!resource&&!specList)continue;
      if(labels.some(label=>!label||label.length>28||/[:：]|이상|이하/.test(label)||STATUS.test(label))||new Set(plain).size!==plain.length)continue;
      const rowYs=unique([ys[1],...H.filter(l=>l.at>ys[1]+.5&&l.at<bottom-.5&&l.start<right-1&&l.end>=right-1).map(l=>l.at),bottom],2);
      const rows=[],placed=new Set();
      let end=bottom,unsafe=false;
      for(let r=0;r<rowYs.length-1&&!unsafe;r++) {
        const middle=(rowYs[r]+rowYs[r+1])/2,active=columnsAt(middle);
        // 열 구성이 달라지는 행(전체를 가로지르는 주석 등)부터는 표 밖으로 둔다.
        if(active.length!==bounds.length||active.some((v,n)=>Math.abs(v-bounds[n])>.5)){end=rowYs[r];break;}
        const values=bounds.slice(0,-1).map((x,c)=>{
          // 세로로 합쳐진 칸의 글은 걸친 행마다 싣는다.
          const edges=H.filter(l=>l.start<=x+1&&l.end>=bounds[c+1]-1);
          const lo=Math.max(ys[1],...edges.filter(l=>l.at<middle).map(l=>l.at));
          const hi=Math.min(bottom,...edges.filter(l=>l.at>middle).map(l=>l.at));
          const cell=members.filter(i=>cy(i)>lo&&cy(i)<hi&&cx(i)>x&&cx(i)<bounds[c+1]);
          if(cell.some(i=>i.x<x-1||i.x+i.width>bounds[c+1]+1))unsafe=true;
          for(const i of cell)placed.add(i);
          return join(cell);
        });
        if(!values[0]||specList&&!resource&&!/^\d+\s*(?:대|식|개|EA|sets?)?$/i.test(values[countAt]))unsafe=true;
        rows.push(values);
      }
      // 어느 칸에도 들지 못한 글(열 경계 위에 걸친 글)이 있으면 그 글이 사라지므로 손대지 않는다.
      if(unsafe||!rows.length||members.some(i=>cy(i)>ys[1]&&cy(i)<end&&!placed.has(i)))continue;
      taken.push({left,right,top,bottom:end});
      output.push({x:left,y:top,width:right-left,height:1,members:members.filter(i=>cy(i)<end),rows,labels,
        str:rows.map(values=>values.map((value,c)=>`${labels[c]}: ${value||'-'}`).join(' | ')).join('\n')});
    }
    return output;
  }
  // 표 선을 읽을 쪽인지. 그리기 목록을 읽는 것은 느리므로 표 머리 낱말이 있는 쪽에서만 읽는다.
  function needsLines(items) {
    const plain=items.map(i=>i.str.replace(/\s/g,''));
    return plain.some(s=>s==='구분'||s==='번호')&&(plain.some(s=>['수량','대수','가상서버','세부규격'].includes(s))||items.some(i=>/예상\s*(?:Core|tpmC)/i.test(i.str)))
      ||items.filter(i=>RESOURCE.test(i.str.trim())).length>=2;
  }
  const api={segments,tables,needsLines};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  scope.GongPdfGeometry=api;
})(typeof self==='undefined'?globalThis:self);
