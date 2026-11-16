// 모델에 보낼 구간을 만든다. 줄을 통째로 싣는다 — 글자 수로 자르면 줄과 숫자가 중간에서 끊겨,
// 다음 구간이 "6GB 이상"처럼 앞자리가 잘린 값으로 시작한다. 긴 줄은 공백 단위 조각으로 다룬다.
import { sourceLines, hasRequirementId, requirementRanges, NAME_MARK } from "./ecr-source.js";
import {gradeGroups} from './ecr-grade-groups.js';

// 표 머리는 번호 줄에서 명칭 줄까지다. 이어지는 구간에도 실어야 모델이 어느 표의 어느 장비를
// 읽는지 안다. 첫 줄만 실으면 둘째 구간부터 장비명이 없어 같은 장비가 다른 이름으로 돌아온다.
// 명칭 줄이 앞쪽에 없으면 첫 줄만 쓴다.
const HEAD_LINES = 12;
const HEAD_CHARS = 400;
function headCount(pieces) {
  let chars = 0;
  for (let index = 0; index < Math.min(pieces.length, HEAD_LINES); index++) {
    chars += pieces[index].length;
    if (chars > HEAD_CHARS) break;
    const mark = NAME_MARK.exec(pieces[index]);
    if (!mark) continue;
    // PDF 평문은 '요구사항 명칭'과 실제 이름을 서로 다른 줄에 둔다.
    // 라벨만 반복하면 둘째 구간부터 장비 이름이 사라진다.
    if (pieces[index].slice(mark.index + mark[0].length).replace(/[\s|:：]/g, "")) return index + 1;
    for (let next = index + 1; next < Math.min(pieces.length, HEAD_LINES); next++) {
      chars += pieces[next].length;
      if (chars > HEAD_CHARS) break;
      const value = pieces[next].replace(/^[\s|]+|[\s|]+$/g, "");
      if (!value) continue;
      if (/^(?:요구\s*사항|세\s*부\s*내\s*용|상세\s*내용|정의|산출정보)/.test(value)) break;
      return next + 1;
    }
    return index + 1;
  }
  return 1;
}
// 긴 첫 줄을 조각낸 머리는 줄바꿈 없이 끝난다. 그대로 이으면 머리와 본문이 한 줄이 되어
// 번호 줄에 다른 번호가 섞이고 구간 경계를 잃는다.
const closed = (text) => (text && !text.endsWith("\n") ? `${text}\n` : text);

// 셀 경계로 복원된 행만 분리하고 표 머리와 공통 조건을 각 행에 보존한다.
export function equipmentRows(section) {
  const graded=gradeGroups(section);
  if(graded)return graded;
  // 서로 다른 서버 종류가 한 요구사항에 이어지는 자원 표다. 뒤의 다른 표를
  // 앞 행의 공통 조건으로 붙이지 않고, 대괄호 소제목 안에서만 행을 분리한다.
  const headings=[...section.matchAll(/^\[[ \t]*([^\]\n]+?)[ \t]*\][ \t]*$/gm)];
  const resources=headings.map((h,i)=>({heading:h,text:section.slice(h.index,headings[i+1]?.index)}))
    .filter(block=>/서버/.test(block.heading[1])&&/^구분:[^\n]+\n규격:[^\n]+/m.test(block.text));
  if(resources.length) {
    const first=resources[0].heading.index;
    // 중간에 있는 비자원 소제목은 누락시키지 않고 별도 구간으로 남긴다.
    const head=section.slice(0,first),output=[];
    for(let i=headings.findIndex(h=>h.index===first);i<headings.length;i++) {
      const block=section.slice(headings[i].index,headings[i+1]?.index);
      const rows=/서버/.test(headings[i][1])?[...block.matchAll(/^구분:[^\n]+\n규격:[^\n]+(?:\n대수:[^\S\n]*\d+[^\S\n]*)?(?:\n|$)/gm)]:[];
      if(rows.length<2||rows.some((row,n)=>n&&block.slice(rows[n-1].index+rows[n-1][0].length,row.index).trim())) {
        output.push(head+block);continue;
      }
      const prefix=block.slice(0,rows[0].index),last=rows.at(-1),tail=block.slice(last.index+last[0].length);
      for(const row of rows)output.push(head+prefix+closed(row[0])+tail);
    }
    return output;
  }
  const matches=[...section.matchAll(/^구분:[^\n]*\n규격:[^\n]+\n수량:[^\S\n]*\d+[^\S\n]*(?:대|식|개|EA|sets?)?[^\S\n]*(?:\n|$)/gim)];
  if(matches.length<2)return [section];
  for(let i=1;i<matches.length;i++)if(section.slice(matches[i-1].index+matches[i-1][0].length,matches[i].index).trim())return [section];
  const head=section.slice(0,matches[0].index),last=matches.at(-1);
  const tail=section.slice(last.index+last[0].length);
  const roles=matches.map(row=>/^구분:([^\n]*)/.exec(row[0])[1].trim()).filter(Boolean);
  return matches.map(row=>{
    const role=/^구분:([^\n]*)/.exec(row[0])[1].trim();
    const scopedTail=tail.split('\n').filter(line=>{
      // '기타 스토리지는 …'처럼 다른 행을 주어로 명시한 조건만 그 행에 남긴다.
      const subject=/^\s*(?:[-•○◦]\s*)?(.+?)\s*(?:스토리지|서버|스위치)(?:는|은|의)\s/.exec(line);
      return !subject||!roles.includes(subject[1].trim())||subject[1].trim()===role;
    }).join('\n');
    return head+closed(row[0])+scopedTail;
  });
}

// size는 본문 분량이다. 머리는 그 위에 얹고 overlap은 앞 구간의 끝줄을 반복한다.
export function sliceSection(section, { size, overlap, head: repeatHead }) {
  const pieces = sourceLines(section);
  const heads = repeatHead && pieces.length ? headCount(pieces) : 0;
  const chunks = [];
  for (let start = 0; start < pieces.length;) {
    let end = start, length = 0;
    // 조각 하나는 size보다 짧다. 적어도 하나는 싣는다.
    while (end < pieces.length && (end === start || length + pieces[end].length <= size)) length += pieces[end++].length;
    // 머리 줄 안에서 시작하는 구간에는 아직 싣지 않은 머리만 얹는다.
    const head = start > 0 ? closed(pieces.slice(0, Math.min(heads, start)).join("")) : "";
    chunks.push(head + pieces.slice(start, end).join(""));
    if (end === pieces.length) break;
    let back = end, carried = 0;
    while (back > start + 1 && carried + pieces[back - 1].length <= overlap) carried += pieces[--back].length;
    start = back;
  }
  return chunks;
}

// 출력 한도를 끝까지 올려도 잘리는 구간을 둘로 가른다. 가운데 줄에서 가르고 한 줄씩 겹친다.
// 번호 줄로 시작하는 구간이면 뒤쪽 절반에도 표 머리를 싣는다. 더 가를 수 없으면 null이다.
export function splitHalves(source) {
  const pieces = sourceLines(source);
  if (pieces.length < 2) return null;
  // 두 표를 묶은 구간은 표 사이에서 가른다. 가운데 줄에서 가르면 뒤쪽 절반이 앞 표의 머리와 뒤 표의 본문을
  // 함께 갖게 되어, 모델이 뒤 표의 규격을 앞 표의 번호로 돌려준다.
  const tables = requirementRanges(source).filter((range, index, all) => range.start > 0 && range.id !== all[0].id);
  if (tables.length) {
    const cut = tables.reduce((best, range) => (Math.abs(range.start - source.length / 2) < Math.abs(best.start - source.length / 2) ? range : best)).start;
    return [source.slice(0, cut), source.slice(cut)];
  }
  const half = source.length / 2;
  let middle = 0;
  for (let length = 0; middle < pieces.length - 1 && length < half;) length += pieces[middle++].length;
  // 조각이 넉넉할 때만 겹친다. 어느 쪽 절반도 원래 구간 전체가 되어서는 안 된다 — 같은 입력을
  // 같은 한도로 다시 보내면 같은 자리에서 또 잘린다.
  const lap = pieces.length >= 6 ? 1 : 0;
  const until = Math.min(middle + lap, pieces.length - 1);
  const from = Math.max(1, middle - lap);
  const heads = hasRequirementId(pieces[0]) ? Math.min(headCount(pieces), from) : 0;
  return [pieces.slice(0, until).join(""), closed(pieces.slice(0, heads).join("")) + pieces.slice(from).join("")];
}

// 표마다 한 호출을 쓰면 짧은 표가 많은 문서도 33구간을 넘는다.
// 번호/본문을 그대로 둔 인접한 두 구간만 묶으며 기존 표 본문 상한을 늘리지 않는다.
export function packPairs(chunks, size) {
  const packed = [];
  for (let index = 0; index < chunks.length; index++) {
    const current = chunks[index], next = chunks[index + 1];
    if (next !== undefined && current.length + next.length + 1 <= size) {
      packed.push(`${current}\n${next}`);
      index++;
    } else packed.push(current);
  }
  return packed;
}

// 인접 표만 묶어도 상한을 넘으면 여유가 맞는 짧은 표끼리 배치한다.
// 한 구간에는 여전히 최대 두 표만 넣으며 각 표의 머리와 본문은 통째로 보존한다.
export function packSparsePairs(chunks, size) {
  const bins=[];
  const entries=chunks.map((text,index)=>({text,index})).sort((a,b)=>b.text.length-a.text.length||a.index-b.index);
  for(const entry of entries) {
    const bin=bins.find(bin=>bin.entries.length===1&&bin.length+entry.text.length+1<=size);
    if(bin){bin.entries.push(entry);bin.length+=entry.text.length+1;}
    else bins.push({entries:[entry],length:entry.text.length});
  }
  for(const bin of bins)bin.entries.sort((a,b)=>a.index-b.index);
  bins.sort((a,b)=>a.entries[0].index-b.entries[0].index);
  return bins.map(bin=>bin.entries.map(entry=>entry.text).join('\n'));
}
