(function (scope) {
  "use strict";
  // 공고 데이터의 날짜 기준은 한국시간이다. 사용자 기기의 시간대나 DST를 사용하지 않는다.
  function kstDate(value = new Date()) {
    return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function shiftDay(day, amount) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(amount)) throw new Error("날짜 형식 오류");
    const date = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error("날짜 형식 오류");
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }
  scope.GongDates = { kstDate, shiftDay };
})(typeof self === "undefined" ? globalThis : self);
