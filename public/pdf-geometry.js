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
    return output;
  }
  const api={segments,tables};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  scope.GongPdfGeometry=api;
})(typeof self==='undefined'?globalThis:self);
