// 좌표로 복원된 장비 목록과 기술 사양 표만 등급별로 연결한다.
// 이름의 유사성으로 추측하거나 누락된 수량·규격을 생성하지 않는다.
export function gradeGroups(source) {
  const devices=[...source.matchAll(/^구분:([^\n]+)\n규격:([^\n]*(?:예상\s*(?:Core|tpmC))[^\n]*)(?:\n|$)/gim)];
  const specs=[...source.matchAll(/^규격 구분:([^\n]+)\n장치:([^\n]*)\n세부규격:([^\n]+)(?:\n|$)/gm)];
  if(devices.length<2||specs.length<2||devices.at(-1).index>=specs[0].index)return null;
  const contiguous=rows=>rows.every((row,i)=>!i||!source.slice(rows[i-1].index+rows[i-1][0].length,row.index).trim());
  if(!contiguous(devices)||!contiguous(specs))return null;
  const key=name=>name.replace(/\s/g,'').replace(/\(표준\)$/,'');
  const groups=[...new Set(specs.map(row=>key(row[1])).filter(name=>name!=='공통'))];
  if(groups.length<2)return null;
  const assigned=devices.map(row=>{
    const words=row[1].trim().split(/\s+/);
    return groups.filter(group=>words.some((_,i)=>i<words.length-1&&key(words.slice(0,i+1).join(''))===group));
  });
  if(assigned.some(matches=>matches.length!==1)||groups.some(group=>!assigned.some(matches=>matches[0]===group)))return null;
  const inherited=new Map();
  for(const group of groups) {
    const parents=[...new Set(specs.filter(row=>key(row[1])===group).flatMap(row=>[...row[3].matchAll(/([가-힣A-Za-z0-9_-]+\s*\(표준\))\s*규격에\s*추가/g)].map(m=>key(m[1]))))];
    if(parents.some(parent=>parent===group||!groups.includes(parent)))return null;
    inherited.set(group,parents);
  }
  const include=(group,seen=new Set())=>{
    if(seen.has(group))return null;
    const next=new Set(seen).add(group),all=new Set([group,'공통']);
    for(const parent of inherited.get(group)) {
      const parents=include(parent,next);if(!parents)return null;
      for(const name of parents)all.add(name);
    }
    return all;
  };
  const included=groups.map(group=>include(group));
  if(included.some(value=>!value))return null;
  const head=source.slice(0,devices[0].index);
  const last=devices.at(-1),between=source.slice(last.index+last[0].length,specs[0].index);
  const end=specs.at(-1),tail=source.slice(end.index+end[0].length);
  return groups.map((group,index)=>head+devices.filter((_,i)=>assigned[i][0]===group).map(row=>row[0]).join('\n')
    +'\n'+between+specs.filter(row=>included[index].has(key(row[1]))).map(row=>row[0]).join('\n')+'\n'+tail);
}
