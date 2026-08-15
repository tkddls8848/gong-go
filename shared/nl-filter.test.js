// 자연어 → 검색조건 변환의 순수 함수 테스트. 모델 없이 도는 부분이 전부 여기에 있다.
// 오늘을 고정해 두므로 실행 날짜와 무관하게 같은 답이 나와야 한다 — 이 파일이 로컬 시간
// API를 쓰지 않는다는 규칙(nl-filter.js 머리 주석)을 지키는지 확인하는 역할도 겸한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { kstToday, monthBounds, lastDay, recentMonth, resolvePeriod, normalizeAsk, ruleParse, validDate, DATA_FLOOR } = require("./nl-filter");

const TODAY = "2026-08-13"; // 목요일
const ask = (parsed, mode = "pre") => normalizeAsk(parsed, { today: TODAY, mode });

test("kstToday는 UTC 15:00에 다음 날로 넘어간다", () => {
  assert.equal(kstToday(Date.parse("2026-08-12T14:59:59Z")), "2026-08-12");
  assert.equal(kstToday(Date.parse("2026-08-12T15:00:00Z")), "2026-08-13");
  assert.equal(kstToday(Date.parse("2026-08-13T14:59:59Z")), "2026-08-13");
});

test("연도 없는 달은 아직 시작하지 않았으면 작년으로 본다", () => {
  assert.equal(recentMonth(TODAY, 4), 2026);
  assert.equal(recentMonth(TODAY, 8), 2026); // 이번 달은 이미 시작했다
  assert.equal(recentMonth(TODAY, 10), 2025);
  assert.equal(recentMonth(TODAY, 12), 2025);
});

test("말일은 윤년까지 맞춘다", () => {
  assert.deepEqual(monthBounds(2026, 2), { begin: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(monthBounds(2024, 2), { begin: "2024-02-01", end: "2024-02-29" });
  assert.equal(lastDay(2026, 12), 31);
});

test("달력에 없는 날짜는 형식이 맞아도 거른다", () => {
  assert.equal(validDate("2026-02-28"), true);
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2026-13-01"), false);
  assert.equal(validDate("20260201"), false);
});

test("이름 있는 기간은 코드가 날짜를 만든다", () => {
  const cases = {
    today: ["2026-08-13", "2026-08-13"],
    yesterday: ["2026-08-12", "2026-08-12"],
    this_week: ["2026-08-10", "2026-08-13"],
    last_week: ["2026-08-03", "2026-08-09"],
    this_month: ["2026-08-01", "2026-08-13"],
    last_month: ["2026-07-01", "2026-07-31"],
    last_7_days: ["2026-08-07", "2026-08-13"],
    last_30_days: ["2026-07-15", "2026-08-13"],
    this_year: ["2026-01-01", "2026-08-13"],
    last_year: ["2025-01-01", "2025-12-31"],
  };
  for (const [period, [begin, end]] of Object.entries(cases)) {
    assert.deepEqual(resolvePeriod({ period }, TODAY), { begin, end }, period);
  }
  assert.equal(resolvePeriod({ period: "none" }, TODAY), null);
});

test("월만 말하면 그 달 전체, 연도를 말하면 그 해로 본다", () => {
  assert.deepEqual(ask({ period: "month", month: 4 }).filter.begin, "2026-04-01");
  assert.deepEqual(ask({ period: "month", month: 4 }).filter.end, "2026-04-30");
  assert.equal(ask({ period: "month", month: 4, year: 2025 }).filter.begin, "2025-04-01");
  // 이번 달을 말하면 끝은 말일이 아니라 오늘로 잘린다 — 게시일은 미래가 될 수 없다.
  assert.equal(ask({ period: "month", month: 8 }).filter.end, TODAY);
  assert.equal(ask({ period: "month", month: 13 }).filter.begin, "");
});

test("게시일은 미래가 될 수 없다 — 클램프·스왑·연도 되감기", () => {
  // 끝이 미래면 오늘로 자른다.
  assert.equal(ask({ period: "explicit", from: "2026-08-01", to: "2026-12-31" }).filter.end, TODAY);
  // 뒤바뀐 구간은 바꾼다.
  const swapped = ask({ period: "explicit", from: "2026-08-09", to: "2026-08-03" });
  assert.deepEqual([swapped.filter.begin, swapped.filter.end], ["2026-08-03", "2026-08-09"]);
  assert.match(swapped.notes.join(" "), /뒤바뀌어/);
  // 구간이 통째로 미래면 연도를 잘못 붙인 것이다.
  const future = ask({ period: "explicit", from: "2027-03-01", to: "2027-03-31" });
  assert.deepEqual([future.filter.begin, future.filter.end], ["2026-03-01", "2026-03-31"]);
  assert.match(future.notes.join(" "), /1년 되감/);
  // 수집 시작일보다 앞서면 바닥으로 올린다.
  assert.equal(ask({ period: "explicit", from: "1999-01-01", to: "2020-06-01" }).filter.begin, DATA_FLOOR);
  // 달력에 없는 날짜는 기간 조건을 아예 버린다.
  const broken = ask({ period: "explicit", from: "2026-02-30", to: "2026-03-01" });
  assert.equal(broken.filter.begin, "");
  assert.match(broken.notes.join(" "), /알아듣지 못해/);
});

test("모델 출력이 enum 밖이면 조용히 버린다", () => {
  assert.equal(ask({ business_type: "기술용역" }).filter.type, "");
  assert.equal(ask({ business_type: "용역" }).filter.type, "용역");
  assert.equal(ask({ mode: "keep" }).filter.mode, "pre"); // 화면의 현재 모드를 유지
  assert.equal(ask({ mode: "bogus" }, "plan").filter.mode, "plan");
  assert.equal(ask({ mode: "bid" }).filter.mode, "bid");
  assert.equal(ask({ period: "언젠가" }).filter.begin, "");
});

test("기관명은 세 글자 이상에 허용 문자만 남긴다", () => {
  const filter = ask({ institutions: ["한국", "조달청", "<script>", "국민연금공단", "국민연금공단"] }).filter;
  assert.deepEqual(filter.institutions, ["조달청", "국민연금공단"]);
  assert.equal(filter.looseInstitution, true);
  // 기관이 없으면 부분일치를 켜지 않는다.
  assert.equal(ask({ institutions: [] }).filter.looseInstitution, false);
  assert.deepEqual(ask({ institutions: "국민연금공단" }).filter.institutions, []);
});

test("검색어에서 값 없는 말을 걷어낸다", () => {
  assert.equal(ask({ keyword: "사업" }).filter.q, "");
  assert.equal(ask({ keyword: "클라우드 사업 알려줘" }).filter.q, "클라우드");
  assert.equal(ask({ keyword: "  서버   증설  " }).filter.q, "서버 증설");
});

test("깨진 입력에도 안전한 기본값을 낸다", () => {
  assert.equal(ask(null).filter.mode, "pre");
  assert.equal(ask(undefined).filter.begin, "");
  assert.equal(ask("문자열").filter.q, "");
  assert.deepEqual(ask({}).filter.institutions, []);
});

test("규칙 파서가 대표 질의 두 개를 모델 없이 처리한다", () => {
  const span = ask(ruleParse("8월 3일~8월 9일에 공고된 사업 알려줘", TODAY)).filter;
  assert.deepEqual([span.begin, span.end], ["2026-08-03", "2026-08-09"]);

  const month = ask(ruleParse("국민연금공단의 4월 본공고 알려줘", TODAY)).filter;
  assert.equal(month.mode, "bid");
  assert.deepEqual([month.begin, month.end], ["2026-04-01", "2026-04-30"]);
  assert.deepEqual(month.institutions, ["국민연금공단"]);
  assert.equal(month.looseInstitution, true);
});

test("규칙 파서가 나머지 표현도 받는다", () => {
  const plan = ask(ruleParse("최근 일주일 서버 관련 발주계획", TODAY)).filter;
  assert.equal(plan.mode, "plan");
  assert.deepEqual([plan.begin, plan.end], ["2026-08-07", TODAY]);

  const last = ask(ruleParse("지난달 조달청 용역 공고", TODAY)).filter;
  assert.deepEqual([last.begin, last.end], ["2026-07-01", "2026-07-31"]);
  assert.equal(last.type, "용역");
  assert.deepEqual(last.institutions, ["조달청"]);

  // "8월 3일 ~ 9일"처럼 뒤쪽 월이 빠져도 앞쪽 월을 쓴다.
  assert.equal(ask(ruleParse("8월 3일 ~ 9일 공고", TODAY)).filter.end, "2026-08-09");
  assert.equal(ask(ruleParse("최근 30일 물품", TODAY)).filter.begin, "2026-07-15");
});

test("규칙 파서는 못 알아들으면 null을 낸다", () => {
  assert.equal(ruleParse("안녕", TODAY), null);
  assert.equal(ruleParse("", TODAY), null);
  assert.equal(ruleParse("아무 말이나 적어 본다", TODAY), null);
});

test("설명 문장에 해석 결과가 그대로 담긴다", () => {
  const { explain } = ask(ruleParse("국민연금공단의 4월 본공고 알려줘", TODAY));
  assert.match(explain, /본공고/);
  assert.match(explain, /2026-04-01 ~ 2026-04-30/);
  assert.match(explain, /국민연금공단\(부분일치\)/);
});
