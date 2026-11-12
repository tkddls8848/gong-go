// 배포본의 질의 해석. 모델 없이 도는 부분이 전부 여기에 있다. 오늘을 고정해 두므로 실행
// 날짜와 무관하게 같은 답이 나와야 한다 — 이 파일이 로컬 시간 API를 쓰지 않는다는 규칙
// (ask.js 머리 주석)을 지키는지 확인하는 역할도 겸한다.
import test from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod, normalizeAsk, ruleParse, dataFloor, ASK_SCHEMA } from "./ask.js";

const TODAY = "2026-08-13"; // 목요일
const ask = (parsed, mode = "pre") => normalizeAsk(parsed, { today: TODAY, mode });

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
  // 2020년 이전은 수집 시작일로 올린다.
  const early = ask({ period: "explicit", from: "1999-01-01", to: "2026-06-01" });
  assert.equal(early.filter.begin, dataFloor(TODAY));
  assert.match(early.notes.join(" "), /가장 이른 날짜/);
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

// 모델에 주는 스키마와 프롬프트는 배포본에만 있다.
test("스키마는 평면이고 모든 키가 required다", () => {
  // Workers AI의 JSON 모드는 constrained decoding이라 중첩·oneOf에서 실패하고, llama는
  // optional 키를 빠뜨리거나 없는 키를 지어낸다. "없음"은 ""·0·[]로 표현한다.
  assert.deepEqual(ASK_SCHEMA.required.sort(), Object.keys(ASK_SCHEMA.properties).sort());
  for (const property of Object.values(ASK_SCHEMA.properties)) {
    assert.ok(["string", "integer", "array"].includes(property.type), property.type);
  }
});

