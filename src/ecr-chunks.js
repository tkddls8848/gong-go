// 모델에 보낼 구간을 만든다. 줄을 통째로 싣는다 — 글자 수로 자르면 줄과 숫자가 중간에서 끊겨,
// 다음 구간이 "6GB 이상"처럼 앞자리가 잘린 값으로 시작한다. 긴 줄은 공백 단위 조각으로 다룬다.
import { sourceLines, hasRequirementId, NAME_MARK } from "./ecr-source.js";

// 표 머리는 번호 줄에서 명칭 줄까지다. 이어지는 구간에도 실어야 모델이 어느 표의 어느 장비를
// 읽는지 안다. 첫 줄만 실으면 둘째 구간부터 장비명이 없어 같은 장비가 다른 이름으로 돌아온다.
// 명칭 줄이 앞쪽에 없으면 첫 줄만 쓴다.
const HEAD_LINES = 6;
const HEAD_CHARS = 400;
function headCount(pieces) {
  let chars = 0;
  for (let index = 0; index < Math.min(pieces.length, HEAD_LINES); index++) {
    chars += pieces[index].length;
    if (chars > HEAD_CHARS) break;
    if (NAME_MARK.test(pieces[index])) return index + 1;
  }
  return 1;
}
// 긴 첫 줄을 조각낸 머리는 줄바꿈 없이 끝난다. 그대로 이으면 머리와 본문이 한 줄이 되어
// 번호 줄에 다른 번호가 섞이고 구간 경계를 잃는다.
const closed = (text) => (text && !text.endsWith("\n") ? `${text}\n` : text);

// size는 본문 분량이다. 머리는 그 위에 얹는다. overlap은 앞 구간 끝에서 다시 싣는 줄의 상한이다 —
// 여러 줄에 걸친 규격과 소제목("가. WEB 서버")이 구간 경계에서 끊기지 않게 한다.
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
