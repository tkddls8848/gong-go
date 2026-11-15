// 모델이 인용을 원문과 조금 다르게 적어도, 인용의 조각이 모두 원문에 그대로 있으면 원문 쪽 글을 근거로 삼는다.
// 모델을 부르지 않고 글자를 지어내지 않는다 — 돌려주는 근거는 언제나 원문의 이어진 한 토막이다.
//
// 실문서에서 원문 표에 그대로 있는 값이 "근거 검증 실패"로 버려진 까닭은 거의 다 인용의 겉모양이었다.
//   · 목록 번호·글머리표를 떼거나 바꾼다: 원문 "3. 저장장치 …19TB 이상"을 "[L9] 저장장치 …"로,
//     원문 "※ 최소 수량 2개 이상"을 "- 최소 수량 2개 이상"으로 적는다.
//   · 표의 항목명 칸과 값 칸을 한 줄로 잇는다: 원문 "CPU" / "3.6GHZ 16core*2CPU"를 "- CPU - 3.6GHZ 16core*2CPU"로.
//   · 값이 인용한 줄의 다음 줄까지 이어진다: 인용은 "…컨트롤러를 구성하고,"에서 끝나는데 값은 다음 줄의
//     "수평(스케일 아웃) 확장구조로 …"까지 담는다. 그 사이에 표 왼쪽 칸의 "요구", "사항" 같은 짧은 줄이 끼어 있다.
// 값이 근거 밖의 글을 담으면 여전히 통과하지 못한다. 조각이 서로 멀리 떨어져 있어도 통과하지 못한다.

const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();
const evidenceText = (text) => norm(text).replace(/([가-힣]) (?=[가-힣])/g, "$1");
export const includesEvidence = (source, quote) => norm(source).includes(norm(quote)) || evidenceText(source).includes(evidenceText(quote));

// 인용 앞에 붙은 원문 위치 표식([L12], "12.")과 글머리표. 여러 겹이면 모두 뗀다.
const LEAD = /^\s*(?:\[L\d+\]\s*|\d{1,3}[.)]\s+|[-–—•·○●◦▪■□◆◇※*§ㅇ]\s*)+/;
const strip = (text) => String(text || "").replace(LEAD, "").trim();
// 인용에만 쓰는 정리: 괄호 없는 줄 표식("L14 * 인터페이스 …")과 앞뒤에 덧붙인 대시("-RAID 6 구성 … 제공-")를 뗀다.
// 값에는 쓰지 않는다 — "L3 스위치"의 L3은 값의 일부다.
const QUOTE_LEAD = /^\s*(?:(?:\[L\d+\]|L\d{1,3}(?=\s))\s*|\d{1,3}[.)]\s+|[-–—•·○●◦▪■□◆◇※*§ㅇ]\s*)+/;
const trimDash = (text) => String(text || "").replace(/^\s*[-–—]+\s*|\s*[-–—]+\s*$/g, "").trim();
const stripQuote = (text) => trimDash(String(text || "").replace(QUOTE_LEAD, ""));
// 맨 앞 괄호 묶음을 나눈다: "(B형(DB)) : 2.66GHz…" → { inner: "B형(DB)", rest: " : 2.66GHz…" }. 없거나 맞지 않으면 null.
function leadGroup(text) {
  text = String(text || "").trim();
  if (!text.startsWith("(")) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return { inner: text.slice(1, i), rest: text.slice(i + 1) };
  }
  return null;
}
// 괄호만 벗긴다: "(B형(DB)) : 2.66GHz…" → "B형(DB) : 2.66GHz…", "(OEM 제품 제외)" → "OEM 제품 제외".
const unwrap = (text) => { const group = leadGroup(text); return group ? (group.inner + group.rest).trim() : String(text || "").trim(); };
// 괄호 묶음과 뒤따르는 ":"를 통째로 뗀다: "(B형(DB)) : 2.66GHz…" → "2.66GHz…".
const dropLeadGroup = (text) => { const group = leadGroup(text); return group ? group.rest.replace(/^\s*[:：]?\s*/, "") : String(text || "").trim(); };
// 표의 항목명 칸과 값 칸을 이은 자리(" - ", " : ")와 줄바꿈에서 인용을 조각낸다.
const pieces = (quote) => String(quote || "").split(/\n|\s[-–—]\s|\s[:：]\s/).map((piece) => unwrap(stripQuote(piece))).filter((piece) => piece.length >= 2);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 공백의 모양만 다른 것은 같은 글이다. 한글 단어 중간의 줄바꿈도 허용한다(evidenceText와 같은 기준).
const pattern = (piece) => new RegExp(escape(norm(piece)).replace(/ /g, "\\s*").replace(/([가-힣])(?=[가-힣])/g, "$1\\s*"), "g");
// 표 왼쪽 칸이 풀려 값 사이에 끼어든 짧은 줄("요구", "사항", "세부", "내용").
const dropLabelLines = (text) => String(text).split("\n").filter((line) => line.replace(/\s/g, "").length > 4).join("\n");

// 값이 근거 안에 있는가. 근거에 끼어든 표 칸 머리 줄은 무시한다.
export function valueInQuote(quote, value) {
  if (!norm(value)) return false;
  return includesEvidence(quote, value) || includesEvidence(dropLabelLines(quote), value) || includesEvidence(quote, strip(value));
}

// 조각들이 원문에 순서대로, 서로 가깝게 있으면 처음부터 끝까지의 원문 토막을 돌려준다.
function locate(source, parts) {
  if (!parts.length || !parts.some((part) => part.replace(/\s/g, "").length >= 6)) return null;
  const budget = parts.reduce((sum, part) => sum + part.length, 0) + 40 * (parts.length - 1) + 80;
  const first = pattern(parts[0]);
  let tries = 0;
  for (let found = first.exec(source); found && tries < 50; found = first.exec(source), tries++) {
    let at = found.index + found[0].length, ok = true;
    for (const part of parts.slice(1)) {
      const next = pattern(part);
      next.lastIndex = at;
      const hit = next.exec(source);
      if (!hit || hit.index + hit[0].length - found.index > budget) {
        // 네 글자 이하의 조각("사양", "세부")은 모델이 표 왼쪽 칸 이름을 잘못 옮긴 것이다. 없어도 건너뛴다.
        if (part.replace(/\s/g, "").length <= 4) continue;
        ok = false; break;
      }
      at = hit.index + hit[0].length;
    }
    if (ok) {
      // 줄 앞의 글머리표·목록 번호까지 근거에 넣는다. 원문 줄을 온전히 보여 준다.
      const lineStart = source.lastIndexOf("\n", found.index - 1) + 1;
      const start = /^[\s\-–—•·○●◦▪■□◆◇※*§ㅇ\d.)]*$/.test(source.slice(lineStart, found.index)) ? lineStart : found.index;
      return { start, end: at };
    }
    if (found[0].length === 0) first.lastIndex++;
  }
  return null;
}

// 인용이 끝난 자리에서 원문 줄을 하나씩 더 붙여 값이 들어오는지 본다. 세 줄까지만이다.
function extend(source, span, fits) {
  let end = span.end;
  for (let step = 0; step < 3; step++) {
    const next = source.indexOf("\n", end + 1);
    end = next < 0 ? source.length : next;
    const text = source.slice(span.start, end);
    if (fits(text)) return text.trim();
    if (next < 0) break;
  }
  return null;
}

// 모델이 값에 덧붙인 겉모양은 원문 값이 아니다.
//   · 앞의 괄호 문구: "(공사 기준에 따름) 설치에 필요한 …", "(RAC포함) Oracle …"
//   · 값 전체나 앞 구분자를 감싼 괄호: "(OEM 제품 제외)", "(B형(DB)) : 2.66GHz*16Core 이상"
//   · 앞뒤 대시: "-RAID 6 구성 … 제공-"
// 값이 근거에 그대로 있으면 그대로, 겉모양을 뗀 값만 근거에 있으면 처음으로 맞는 것을 돌려준다. 그 밖에는 손대지 않는다.
const QUALIFIER = /^\s*\([^()]{1,30}\)\s*/;
function valueCandidates(value) {
  value = String(value || "");
  const list = [value, value.replace(QUALIFIER, ""), unwrap(value), trimDash(value), trimDash(unwrap(value)), dropLeadGroup(value)];
  // 겉모양을 떼고 숫자만 남으면 쓰지 않는다: "- 20 -"은 쪽 번호이고, 떼면 쪽 번호 거르기를 빠져나간다.
  return [...new Set(list.map((item) => item.trim()).filter((item, i) => item && (i === 0 || /[A-Za-z가-힣]/.test(item))))];
}
export function groundValue(quote, value) {
  if (valueInQuote(quote, value)) return value;
  return valueCandidates(value).find((candidate) => valueInQuote(quote, candidate)) || value;
}

// 원문에서 확인할 수 있는 근거를 돌려준다. 확인하지 못하면 모델의 인용을 그대로 돌려준다 — 검증은 호출하는 쪽이 한다.
export function groundQuote(source, quote, value) {
  quote = String(quote || "");
  const values = valueCandidates(value);
  const fits = (text) => values.some((candidate) => valueInQuote(text, candidate));
  if (includesEvidence(source, quote) && fits(quote)) return quote;
  let span = null;
  if (includesEvidence(source, quote)) span = locate(source, [norm(quote)]);
  else {
    for (const variant of new Set([strip(quote), stripQuote(quote), unwrap(stripQuote(quote))])) {
      if (variant && includesEvidence(source, variant)) span = locate(source, [norm(variant)]);
      if (span) break;
    }
    if (!span) span = locate(source, pieces(quote));
  }
  if (!span) return quote;
  const text = source.slice(span.start, span.end).trim();
  if (fits(text)) return text;
  return extend(source, span, fits) || text;
}
