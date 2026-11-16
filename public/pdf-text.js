// PDF 좌표를 유지하며 두 쪽 모아찍기의 읽기 순서를 복원한다.
(function(scope) {
  'use strict';
  const geometry=typeof module!=='undefined'&&module.exports?require('./pdf-geometry.js'):scope.GongPdfGeometry;
  function originalLines(items) {
    let text='', previous;
    for(const item of items) {
      if(previous && (previous.hasEOL || Math.abs(previous.y-item.y)>Math.max(1,item.height*.2) || item.x<previous.x)) text+='\n';
      else if(text) text+=' ';
      text+=item.str; previous=item;
    }
    return text;
  }
  function ordered(items,lines=[]) {
    const tables=geometry?.tables(items,lines)||[];
    const used=new Set(tables.flatMap(t=>t.members));
    items=[...items.filter(i=>!used.has(i)),...tables];
    const rows=[];
    for(const item of [...items].sort((a,b)=>a.y-b.y||a.x-b.x)) {
      const last=rows.at(-1);
      if(last && Math.abs(last.y-item.y)<=Math.max(1,item.height*.2)) last.items.push(item);
      else rows.push({y:item.y,items:[item]});
    }
    return rows.map(row=>row.items.sort((a,b)=>a.x-b.x).map(i=>i.str).join(' ')).join('\n');
  }
  function pageText(items, {width,height,sortSinglePage=true,lines=[]}) {
    if(sortSinglePage) {
      // 인쇄 모아찍기(2쪽·4쪽·9쪽 등)는 칸 사이 빈 여백과 각 칸의 종횡비를 함께 확인한다.
      // 단순히 가운데서 자르면 한 표의 열이나 문단이 별개 쪽으로 갈린다.
      const candidates=[];
      const top=items.reduce((n,i)=>Math.min(n,i.y-i.height),height);
      const bottom=items.reduce((n,i)=>Math.max(n,i.y),0);
      // 홀수 쪽 모아찍기는 아래쪽 인쇄 영역이 통째로 비어 있을 수 있다(가로 3쪽).
      const occupiedHeight=Math.min(height,bottom+Math.max(0,top));
      for(let columns=1;columns<=4;columns++) for(let rows=1;rows<=4;rows++) {
        if(columns*rows===1)continue;
        const ratio=(width/columns)/(height/rows);
        const trimmedRatio=(width/columns)/((occupiedHeight>height*.45?occupiedHeight:height)/rows);
        if((ratio<.60||ratio>.82)&&(trimmedRatio<.60||trimmedRatio>.82))continue;
        let clear=true;
        for(let c=1;c<columns&&clear;c++) {
          const cut=width*c/columns,gap=Math.max(4,width*.008);
          if(items.some(i=>i.x<cut+gap&&i.x+i.width>cut-gap))clear=false;
        }
        for(let r=1;r<rows&&clear;r++) {
          const cut=height*r/rows,gap=Math.max(4,height*.008);
          if(items.some(i=>i.y-i.height<cut+gap&&i.y>cut-gap))clear=false;
        }
        if(!clear)continue;
        const cells=Array.from({length:columns*rows},()=>[]);
        for(const item of items) {
          const c=Math.min(columns-1,Math.max(0,Math.floor(item.x/(width/columns))));
          const r=Math.min(rows-1,Math.max(0,Math.floor(item.y/(height/rows))));
          cells[r*columns+c].push(item);
        }
        if(cells.every(cell=>cell.length>=12))candidates.push({cells,count:columns*rows});
      }
      candidates.sort((a,b)=>b.count-a.count);
      if(candidates.length)return candidates[0].cells.map(cell=>ordered(cell,lines)).join('\n\f\n');
      return ordered(items,lines);
    }
    const middle=width/2,gutter=12;
    const split=width>height*1.2 && items.length>40
      && !items.some(i=>i.x<middle+gutter&&i.x+i.width>middle-gutter)
      && items.filter(i=>i.x+i.width<middle).length>=20 && items.filter(i=>i.x>middle).length>=20;
    return split ? ordered(items.filter(i=>i.x<middle))+'\n\f\n'+ordered(items.filter(i=>i.x>=middle)) : sortSinglePage ? ordered(items) : originalLines(items);
  }
  function createReader({load=()=>import('/pdf-runtime/pdf.mjs'),loadSelection=()=>import('/pdf-runtime/selection.mjs'),makeBlob=text=>new Blob([text],{type:'text/plain;charset=utf-8'})}={}) {
    let generation=0, active=null;
    const cancelled=()=>new Error('PDF 읽기를 중지했습니다.');
    function cancel() { generation++; const task=active; active=null; if(task) void task.destroy().catch(()=>{}); }
    async function convert(file,{onProgress=()=>{}}={}) {
      cancel(); const run=generation;
      let task;
      const check=()=>{if(run!==generation) throw cancelled();};
      try {
        if(file.size>32*1024*1024) throw new Error('size');
        const bytes=await file.arrayBuffer(); check();
        if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-') throw new Error('header');
        const pdf=await load(); check();
        pdf.GlobalWorkerOptions.workerSrc='/pdf-runtime/pdf.worker.mjs';
        task=pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,verbosity:0,cMapUrl:'/pdf-runtime/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdf-runtime/standard_fonts/'});
        active=task;
        const document=await task.promise; check();
        const parts=[]; let length=0;
        for(let n=1;n<=document.numPages;n++) {
          check(); onProgress(`PDF 원문을 읽고 있습니다. ${n} / ${document.numPages}쪽`);
          const page=await document.getPage(n); check();
          try {
            const viewport=page.getViewport({scale:1}), content=await page.getTextContent(); check();
            const items=content.items.filter(i=>typeof i.str==='string'&&i.str.trim()).map(i=>{
              const t=pdf.Util.transform(viewport.transform,i.transform);
              return {...i,x:t[4],y:t[5]};
            });
            let lines=[];
            if(geometry?.needsLines(items)) {
              lines=geometry.segments(await page.getOperatorList(),pdf.OPS,viewport.transform);check();
            }
            const text=pageText(items,{...viewport,lines});
            length+=text.length+3;
            if(length>2000000) throw new Error('text-size');
            parts.push(text);
          } finally {page.cleanup();}
        }
        const text=parts.join('\n\f\n');
        if(!text.trim()) throw new Error('empty');
        if(text.length>600000) {
          onProgress('큰 PDF에서 장비 상세 표를 선별하고 있습니다.');
          let selection;
          try {const module=await loadSelection();check();selection=module.prepareSelection(text);}
          catch {check();throw new Error('selection');}
          check();
          return {blob:makeBlob(JSON.stringify(selection)),format:'selection',pages:document.numPages};
        }
        return {blob:makeBlob(text),format:'text',pages:document.numPages};
      } catch(error) {
        if(run!==generation) throw cancelled();
        if(error.message==='text-size') throw new Error('문서가 너무 큽니다. 제안요청서를 나누어 올려 주세요.');
        if(error.message==='size') throw new Error('PDF는 32MB까지 지원합니다.');
        if(error.message==='selection') throw new Error('큰 PDF의 장비 상세 표를 선별하지 못했거나 분석 분량을 초과했습니다. 제안요청서를 나누어 올려 주세요.');
        if(error.message==='empty') throw new Error('PDF에서 텍스트를 읽지 못했습니다. 스캔 문서는 텍스트 변환 후 올려 주세요.');
        throw new Error('PDF 원문을 읽지 못했습니다. 파일이 올바른 PDF인지, 암호로 잠겨 있지 않은지 확인해 주세요.');
      } finally {if(active===task)active=null; if(task)await task.destroy().catch(()=>{});}
    }
    return {convert,cancel};
  }
  const api={createReader,pageText};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  scope.GongPdfText=api;
})(typeof self==='undefined'?globalThis:self);
