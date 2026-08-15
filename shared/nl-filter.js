// 자연어 질의를 조회 화면의 검색 조건으로 바꾸는 순수 함수 모음.
// src/worker.js(ESM)와 devserver/server.js(CJS)가 함께 쓴다. wrangler(esbuild)가 CJS를 ESM
// 진입점에서 import할 수 있게 번들하므로 형식은 shared/의 관례대로 CommonJS로 둔다.
//
// 두 가지를 반드시 지킨다.
//   1. Node 내장 모듈을 쓰지 않는다. 이 파일은 Worker 번들에 들어가므로 fs·process·Buffer가
//      들어오면 배포가 깨진다. shared/pipeline-utils.js는 node:fs를 쓰므로 재사용 금지.
//   2. 로컬 시간 API(getFullYear 등)를 쓰지 않는다. Worker는 UTC로 돌고 개발자 PC는 KST라
//      같은 입력에 다른 답이 나온다. 날짜는 전부 Date.UTC와 문자열로 다룬다.
//
// 설계의 핵심: **모델에게 날짜 산술을 시키지 않는다.** 이름 있는 기간은 모델이 enum 하나만
// 고르고 실제 날짜는 resolvePeriod가 만든다. 모델이 "2026-02-30" 같은 값을 지어내도 형식은
// 맞아서 정규식 검증을 그대로 통과하는데, 그 오류를 애초에 만들 수 없게 하는 편이 낫다.

// 수집 시작일. 이보다 앞선 구간은 볼 수 없으므로 바닥으로 쓴다.
const DATA_FLOOR = "2020-01-01";
const MODES = ["pre", "bid", "plan"];
const MODE_NAMES = { pre: "사전공고", bid: "본공고", plan: "발주계획" };
// 화면의 업무구분 드롭다운(public/index.html)과 정확히 같아야 한다. rows.js의 typeMatches가
// 접미사 일치를 허용하므로 "기술용역"은 "용역"으로 잡힌다 — 모델에는 네 갈래만 고르게 한다.
const BUSINESS_TYPES = ["물품", "외자", "용역", "공사"];
const PERIODS = ["none", "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days", "this_year", "last_year", "month", "explicit"];
// 기관명에 허용할 문자. 모델이 무엇을 뱉든 조회 조건에는 이 모양만 들어간다 —
// src/worker.js의 RELAY_ALLOW와 같은 원칙이다: 임의 입력을 그대로 흘리지 않는다.
const INSTITUTION_OK = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9()·\-\s]+$/;
// 검색어로 쓰면 전부 0건이 되는 말들. 질의문에서 그대로 딸려 오기 쉽다.
const STOPWORDS = new Set(["사업", "공고", "입찰", "알려줘", "보여줘", "찾아줘", "알려", "보여", "목록", "리스트", "전체", "조회", "내역", "현황", "관련", "정보"]);

const pad = (value) => String(value).padStart(2, "0");
const ymd = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const split = (date) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
// 제어문자를 공백으로 바꾼다. 줄바꿈을 그대로 두면 질의가 가짜 대화 턴처럼 보이게 만들 수 있다.
// 정규식에 제어문자를 직접 쓰지 않는 이유는 소스에 그 바이트가 박히는 사고를 피하기 위해서다.
const stripControl = (text) => Array.from(text, (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("");

// Worker는 UTC로 돈다. 데이터의 날짜는 KST 벽시계이므로 "오늘"은 여기서 만든다.
// KST는 1988년 이후 서머타임이 없어 고정 오프셋이 안전하다.
function kstToday(nowMs) { return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10); }
// Date.UTC(y, m, 0)은 m월의 말일이다(월이 0-based라 m이 곧 다음 달). 윤년도 여기서 풀린다.
function lastDay(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function monthBounds(year, month) { return { begin: ymd(year, month, 1), end: ymd(year, month, lastDay(year, month)) }; }
function shift(date, days) { const { year, month, day } = split(date); return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10); }
// 월요일까지 며칠 뒤로 가야 하는지. getUTCDay()는 일요일이 0이라 월요일 기준으로 옮긴다.
function weekOffset(date) { const { year, month, day } = split(date); return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7; }
// 정규식만으로는 2026-02-30이 통과한다. 달력에 실재하는 날짜인지까지 본다.
function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false; const { year, month, day } = split(value); return month >= 1 && month <= 12 && day >= 1 && day <= lastDay(year, month); }
// "4월"에 연도를 붙이는 규칙: 아직 시작하지 않은 달을 말했을 리 없으므로, 1일이 오늘 이하인
// 가장 최근의 그 달을 고른다. 게시일은 미래가 될 수 없다는 성질이 근거다.
function recentMonth(today, month) { const { year } = split(today); return ymd(year, month, 1) <= today ? year : year - 1; }

// 이름 있는 기간을 실제 구간으로 편다. 모델은 enum만 골랐으므로 여기서 틀릴 일이 없다.
function resolvePeriod(parsed, today) {
  const { year, month } = split(today);
  switch (parsed.period) {
    case "today": return { begin: today, end: today };
    case "yesterday": { const date = shift(today, -1); return { begin: date, end: date }; }
    case "this_week": return { begin: shift(today, -weekOffset(today)), end: today };
    case "last_week": { const monday = shift(today, -weekOffset(today) - 7); return { begin: monday, end: shift(monday, 6) }; }
    case "this_month": return { begin: ymd(year, month, 1), end: today };
    case "last_month": return monthBounds(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
    case "last_7_days": return { begin: shift(today, -6), end: today };
    case "last_30_days": return { begin: shift(today, -29), end: today };
    case "this_year": return { begin: ymd(year, 1, 1), end: today };
    case "last_year": return { begin: ymd(year - 1, 1, 1), end: ymd(year - 1, 12, 31) };
    // 연도를 말했으면 그 해로, 아니면 가장 최근 지나간 그 달로 본다.
    case "month": { const target = Number(parsed.month); if (!(target >= 1 && target <= 12)) return null; return monthBounds(Number(parsed.year) || recentMonth(today, target), target); }
    // 질의에 숫자가 적혀 있는 경우뿐이다. 모델이 하는 일은 옮겨 적기와 연도 붙이기로 좁혀진다.
    case "explicit": return validDate(parsed.from) && validDate(parsed.to) ? { begin: parsed.from, end: parsed.to } : null;
    default: return null;
  }
}

function yearBack(date) { return `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`; }
// 게시일은 미래가 될 수 없다. 그 성질로 모델의 연도 실수까지 되돌린다.
function clampSpan(span, today, notes) {
  if (!span) return null;
  let { begin, end } = span;
  if (!validDate(begin) || !validDate(end)) return null;
  if (begin > end) { const swap = begin; begin = end; end = swap; notes.push("시작일과 종료일이 뒤바뀌어 있어 바꿨습니다."); }
  // 구간이 통째로 미래면 연도를 잘못 붙인 것이다. 1년 되감으면 대개 뜻한 구간이 된다.
  if (begin > today) {
    const back = { begin: yearBack(begin), end: yearBack(end) };
    if (validDate(back.begin) && validDate(back.end) && back.begin <= today) { begin = back.begin; end = back.end; notes.push("구간이 통째로 미래라 연도를 1년 되감았습니다."); }
  }
  if (end > today) end = today;
  if (begin < DATA_FLOOR) begin = DATA_FLOOR;
  return begin > end ? null : { begin, end };
}

function cleanInstitutions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const value of list) {
    const name = stripControl(String(value == null ? "" : value)).replace(/\s+/g, " ").trim();
    // 두 글자 이하는 부분일치에서 사실상 전체 조회가 된다("한국"). 40자를 넘으면 기관명이 아니다.
    if (name.length < 3 || name.length > 40 || !INSTITUTION_OK.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length === 5) break;
  }
  return out;
}
function cleanKeyword(value) {
  const text = stripControl(String(value == null ? "" : value)).replace(/\s+/g, " ").trim().slice(0, 40);
  return text.split(" ").filter((word) => word && !STOPWORDS.has(word)).join(" ");
}

function explain(filter) {
  const pieces = [MODE_NAMES[filter.mode] || filter.mode];
  if (filter.begin && filter.end) pieces.push(`${filter.begin} ~ ${filter.end}`);
  if (filter.type) pieces.push(filter.type);
  if (filter.institutions.length) pieces.push(`${filter.institutions.join(", ")}(부분일치)`);
  if (filter.q) pieces.push(`검색어 「${filter.q}」`);
  return pieces.join(" · ");
}

// 모델(또는 규칙 파서)이 뱉은 것을 화면 필터로 바꾸는 유일한 관문. Worker도 devserver도
// 여기만 통과시킨다. 나올 수 있는 최악은 "이상하지만 구조적으로 유효한 조회 조건"이다.
function normalizeAsk(parsed, { today, mode } = {}) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  const notes = [];
  const filter = {
    // "keep"이나 enum 밖이면 화면이 지금 보고 있는 모드를 그대로 둔다.
    mode: MODES.includes(raw.mode) ? raw.mode : MODES.includes(mode) ? mode : "bid",
    begin: "",
    end: "",
    type: BUSINESS_TYPES.includes(raw.business_type) ? raw.business_type : "",
    q: cleanKeyword(raw.keyword),
    institutions: cleanInstitutions(raw.institutions),
  };
  // 모델이 만든 기관명은 언제나 접미사 위험이 있다("국민연금공단" ⊂ "국민연금공단 서울지역본부").
  filter.looseInstitution = filter.institutions.length > 0;
  const period = PERIODS.includes(raw.period) ? raw.period : "none";
  const span = clampSpan(resolvePeriod({ ...raw, period }, today), today, notes);
  if (span) { filter.begin = span.begin; filter.end = span.end; }
  else if (period !== "none") notes.push("기간을 알아듣지 못해 게시일 조건은 그대로 두었습니다.");
  if (period === "month" && span && !Number(raw.year)) notes.push(`연도를 말하지 않아 가장 최근 지나간 ${Number(raw.month)}월(${span.begin.slice(0, 4)}년)로 봤습니다.`);
  return { filter, explain: explain(filter), notes };
}

// 스키마는 일부러 평면이다. Workers AI의 JSON 모드는 constrained decoding이라 중첩·oneOf에서
// 실패한다. 모든 키를 required로 두는 것도 같은 이유다 — llama는 optional 키를 빠뜨리거나
// 없는 키를 지어낸다. "없음"은 ""·0·[]로 표현한다.
const ASK_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: [...MODES, "keep"] },
    period: { type: "string", enum: PERIODS },
    year: { type: "integer" },
    month: { type: "integer" },
    from: { type: "string" },
    to: { type: "string" },
    business_type: { type: "string", enum: ["", ...BUSINESS_TYPES] },
    institutions: { type: "array", items: { type: "string" } },
    keyword: { type: "string" },
  },
  required: ["mode", "period", "year", "month", "from", "to", "business_type", "institutions", "keyword"],
};

// few-shot은 별도 assistant 턴이 아니라 시스템 프롬프트 안 텍스트로 넣는다. JSON 모드에서
// assistant 턴에 JSON을 흘리면 constrained decoder가 흔들린다.
function buildPrompt(today) {
  const { year, month } = split(today);
  return `너는 나라장터 공고 조회 화면의 검색 조건을 채우는 파서다. JSON만 출력한다.

오늘: ${today} (KST). 올해: ${year}. 이번 달: ${pad(month)}. 보유 데이터: ${DATA_FLOOR} ~ 오늘.

규칙
- 날짜를 직접 계산하지 마라. 이름 있는 기간은 period 값만 고르고 from/to는 ""로 둔다.
- "N월"처럼 달만 나오면 period="month", month=N. 연도를 말했으면 year에 넣고 아니면 year=0.
- 날짜가 구체적으로 나오면 period="explicit"에 from/to를 YYYY-MM-DD로 쓴다.
  연도를 말하지 않았으면 오늘보다 미래가 되지 않는 가장 가까운 연도를 쓴다.
- 기간을 말하지 않았으면 period="none".
- 사전공고·사전규격 → pre, 본공고·입찰공고 → bid, 발주계획·발주예정 → plan, 안 나오면 keep.
- business_type은 물품·외자·용역·공사 중 하나이거나 "". 그 밖의 말은 ""로 둔다.
- institutions에는 질의에 나온 기관명만 원문 그대로 넣는다. 없으면 [].
- keyword에는 기관·기간·업무구분을 뺀 나머지 검색어만 넣는다.
  "사업" "공고" "입찰" "알려줘" 같은 말은 넣지 않는다. 없으면 "".

예시
"8월 3일~8월 9일에 공고된 사업 알려줘"
{"mode":"keep","period":"explicit","year":0,"month":0,"from":"${year}-08-03","to":"${year}-08-09","business_type":"","institutions":[],"keyword":""}
"국민연금공단의 4월 본공고 알려줘"
{"mode":"bid","period":"month","year":0,"month":4,"from":"","to":"","business_type":"","institutions":["국민연금공단"],"keyword":""}
"지난달 조달청 용역 공고"
{"mode":"keep","period":"last_month","year":0,"month":0,"from":"","to":"","business_type":"용역","institutions":["조달청"],"keyword":""}
"최근 일주일 서버 관련 발주계획"
{"mode":"plan","period":"last_7_days","year":0,"month":0,"from":"","to":"","business_type":"","institutions":[],"keyword":"서버"}`;
}

// 기관명은 접미사로 찾는다. 고정 목록을 두면 목록 밖 기관을 영영 못 잡는다. 애매한 한 글자
// 접미사(부·원·시)는 "일부"·"지원"처럼 기관이 아닌 말을 끌어오므로 넣지 않는다.
const INSTITUTION_PATTERN = /[가-힣A-Za-z0-9]{2,18}(?:공단|공사|공제회|진흥원|정보원|평가원|연구원|연구소|재단|병원|대학교|은행|위원회)|조달청|국세청|관세청|경찰청|소방청|산림청|기상청|통계청|특허청|병무청/g;
// "최근 7일"은 아래 숫자 패턴이 먼저 잡는다. 여기 있는 것은 숫자를 쓰지 않는 표현들이다.
const RELATIVE = [[/오늘/, "today"], [/어제/, "yesterday"], [/(?:최근|지난)\s*(?:일주일|한\s*주)/, "last_7_days"], [/(?:최근|지난)\s*(?:한\s*달|1개월)/, "last_30_days"], [/이번\s*주|금주/, "this_week"], [/지난\s*주|저번\s*주|전주/, "last_week"], [/이번\s*달|이달|금월/, "this_month"], [/지난\s*달|저번\s*달|전월/, "last_month"], [/올해|금년/, "this_year"], [/작년|지난해|전년/, "last_year"]];

// 모델 없이도 도는 규칙 파서. devserver의 /api/ask 구현이자 Worker의 마지막 폴백이고,
// 덕분에 AI가 죽어도 대표 질의는 회귀 테스트로 고정된다. 못 알아들으면 null을 돌려준다.
function ruleParse(query, today) {
  const text = stripControl(String(query || ""));
  const parsed = { mode: "keep", period: "none", year: 0, month: 0, from: "", to: "", business_type: "", institutions: [], keyword: "" };
  let hit = false;

  const mode = /사전\s*(?:공고|규격)/.test(text) ? "pre" : /본\s*공고|입찰\s*공고/.test(text) ? "bid" : /발주\s*(?:계획|예정)/.test(text) ? "plan" : "";
  if (mode) { parsed.mode = mode; hit = true; }

  const type = BUSINESS_TYPES.find((name) => text.includes(name));
  if (type) { parsed.business_type = type; hit = true; }

  // "8월 3일~8월 9일"과 "8월 3일 ~ 9일"을 모두 받는다. 뒤쪽 월이 없으면 앞쪽 월을 쓴다.
  const span = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일[^\d]{0,6}(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일/);
  const recent = text.match(/최근\s*(\d{1,3})\s*일/);
  const relative = RELATIVE.find(([pattern]) => pattern.test(text));
  const single = text.match(/(\d{1,2})\s*월(?!\s*\d{1,2}\s*일)/);
  if (span) {
    const beginMonth = Number(span[1]), endMonth = Number(span[3] || span[1]);
    const year = recentMonth(today, beginMonth);
    parsed.period = "explicit";
    parsed.from = ymd(year, beginMonth, Number(span[2]));
    // 12월~1월처럼 해를 넘기면 끝쪽이 다음 해다.
    parsed.to = ymd(endMonth < beginMonth ? year + 1 : year, endMonth, Number(span[4]));
    hit = true;
  } else if (recent) {
    const days = Math.min(Math.max(Number(recent[1]), 1), 3650);
    parsed.period = "explicit"; parsed.from = shift(today, -(days - 1)); parsed.to = today; hit = true;
  } else if (relative) {
    parsed.period = relative[1]; hit = true;
  } else if (single) {
    parsed.period = "month"; parsed.month = Number(single[1]); hit = true;
    const year = text.match(/(20\d{2})\s*년/);
    if (year) parsed.year = Number(year[1]);
  }

  const institutions = text.match(INSTITUTION_PATTERN);
  if (institutions) { parsed.institutions = institutions; hit = true; }

  return hit ? parsed : null;
}

module.exports = { DATA_FLOOR, ASK_SCHEMA, MODES, BUSINESS_TYPES, kstToday, monthBounds, lastDay, recentMonth, resolvePeriod, normalizeAsk, ruleParse, buildPrompt, validDate };
