// Worker의 KST 날짜 계산. 자연어 질의(ask.js)와 수집 갱신(refresh.js)이 함께 쓴다.
//
// 로컬 시간 API(getFullYear 등)를 쓰지 않는다. Worker는 UTC로 돌고 개발자 PC는 KST라
// 같은 입력에 다른 답이 나온다. 날짜는 전부 Date.UTC와 "YYYY-MM-DD" 문자열로 다룬다.

const pad = (value) => String(value).padStart(2, "0");
const ymd = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const split = (date) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });

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

export { pad, ymd, split, kstToday, lastDay, monthBounds, shift, weekOffset, validDate, recentMonth };
