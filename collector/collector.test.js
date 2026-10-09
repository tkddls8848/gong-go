const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeCsv } = require("./csv-record");
const {
  applyItems,
  checkpointState,
  clearJobRange,
  clearLegacySources,
  recordsForWrite,
  sourceEndpoint,
  parseArgs,
} = require("./collector");
const { serverTimingDuration, isRetryable } = require("./api");

test("백필은 CLI에서 사전공고와 본공고만 선택할 수 있다", () => {
  assert.deepEqual(parseArgs(["--begin=2020-01-01", "--end=2020-03-31", "--no-resume", "--modes=pre,bid,bid"]), {
    begin: "2020-01-01", end: "2020-03-31", resume: false, modes: ["pre", "bid"],
  });
  assert.throws(() => parseArgs(["--modes=pre,unknown"]), /지원하지 않는 수집 모드/);
  assert.throws(() => parseArgs(["--bogus"]), /알 수 없는 인자/);
});

test("체크포인트는 flush 시작 뒤 완료된 작업을 포함하지 않는다", () => {
  const state = { completedJobs: ["job-1", "job-1", "job-2"] };
  const checkpoint = checkpointState(state);

  // 파일 저장을 기다리는 동안 후속 작업이 끝나는 상황이다. 이전 체크포인트가 이 변경을
  // 따라가면, 후속 작업의 파일을 쓰기 전에 중단됐을 때 재개가 job-3을 잘못 건너뛴다.
  state.completedJobs.push("job-3");

  assert.deepEqual(checkpoint, { completedJobs: ["job-1", "job-2"] });
  assert.deepEqual(state.completedJobs, ["job-1", "job-1", "job-2", "job-3"]);
});

function storeOf(rows) {
  const store = { buckets: new Map(), location: new Map(), counts: new Map() };
  const changed = new Set();
  applyItems(store, rows, changed);
  return store;
}

test("CSV 행 순서는 Map 삽입 순서와 무관하게 공고 키로 고정된다", () => {
  const first = { bidNtceNo: "202608110003", bidNtceDt: "2026-08-11 03:00:00", bidNtceNm: "셋" };
  const second = { bidNtceNo: "202608110001", bidNtceDt: "2026-08-11 01:00:00", bidNtceNm: "하나" };
  const third = { bidNtceNo: "202608110002", bidNtceDt: "2026-08-11 02:00:00", bidNtceNm: "둘" };
  const a = storeOf([first, second, third]).buckets.get("bid|2026-08-11");
  const b = storeOf([third, first, second]).buckets.get("bid|2026-08-11");
  assert.equal(serializeCsv(recordsForWrite(a)), serializeCsv(recordsForWrite(b)));
  assert.deepEqual(recordsForWrite(a).map((row) => row.bidNtceNo), ["202608110001", "202608110002", "202608110003"]);
});

test("새 레코드는 ServiceKey가 없는 원천 endpoint 표식을 보존한다", () => {
  const job = { mode: "bid", type: "물품", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const store = storeOf([]), changed = new Set();
  applyItems(store, [{ bidNtceNo: "1", bidNtceDt: "2026-08-11" }], changed, job);
  const [record] = store.buckets.get("bid|2026-08-11").values();
  assert.equal(record.__sourceEndpoint, sourceEndpoint(job));
  assert.doesNotMatch(record.__sourceEndpoint, /ServiceKey|\?/);
  clearJobRange(store, job, changed);
  assert.equal(store.buckets.get("bid|2026-08-11").size, 0);
});

test("기존 사전공고의 세부 용역 구분은 용역 endpoint 재수집 때 제거된다", () => {
  const job = { mode: "pre", type: "용역", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const store = storeOf([{ bfSpecRgstNo: "1", rgstDt: "2026-08-11", bsnsDivNm: "기술용역" }]);
  clearJobRange(store, job, new Set());
  assert.equal(store.buckets.get("pre|2026-08-11").size, 0);
});

test("네 endpoint가 모두 성공한 범위에서만 무표식 본공고를 이관 정리한다", () => {
  const types = ["물품", "외자", "용역", "공사"];
  const range = { begin: "2026-08-11", end: "2026-08-11" };
  const entries = types.map((type) => ({ job: { mode: "bid", type, range }, id: type }));
  const incomplete = storeOf([{ bidNtceNo: "old", bidNtceDt: "2026-08-11" }]);
  assert.equal(clearLegacySources(incomplete, entries, new Set(types.slice(0, 3)), types, new Set()), 0);
  assert.equal(incomplete.location.size, 1);
  const complete = storeOf([{ bidNtceNo: "old", bidNtceDt: "2026-08-11" }]);
  assert.equal(clearLegacySources(complete, entries, new Set(types), types, new Set()), 1);
  assert.equal(complete.location.size, 0);
});

// requestJson이 상태로 실패를 던질 때 붙이는 표식. 이것이 없는 오류는 응답 단계까지 가지
// 못했거나 본문에서 끊긴 것이므로 상태를 보고 판단하면 안 된다.
function httpError(status) { const error = new Error(`HTTP ${status}`); error.httpStatus = status; return error; }

test("Server-Timing과 재시도 가능 상태를 분류한다", () => {
  assert.equal(serverTimingDuration("cache;desc=miss, upstream;dur=412.7", "upstream"), 412.7);
  assert.equal(serverTimingDuration("", "upstream"), null);
  assert.equal(isRetryable(httpError(503)), true);
  assert.equal(isRetryable(httpError(429)), true);
  assert.equal(isRetryable(httpError(401)), false);
  assert.equal(isRetryable(new TypeError("fetch failed")), true);
  assert.equal(isRetryable(new SyntaxError("truncated JSON")), true);
});

// 200 헤더를 받은 뒤 본문에서 끊긴 요청. 상태로 가리던 때는 이 오류가 재시도 없이
// 작업을 실패시켜 워크플로 전체를 멈췄다.
test("본문을 받다 걸린 timeout은 헤더가 200이어도 재시도한다", () => {
  assert.equal(isRetryable(new DOMException("The operation was aborted due to timeout", "TimeoutError")), true);
});

test("제안요청정보는 공고보다 먼저 와도, 나중에 와도 같은 공고 행에 붙는다", () => {
  const { applyEorder } = require("./collector");
  const { EORDER_TYPE } = require("./api");
  const job = { mode: "bid", type: "용역", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const notice = { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceDt: "2026-08-11 10:00:00" };
  const eorder = [{ bidNtceNo: "R26BK1", bidNtceOrd: "000", atchSno: "6", eorderDocDivNm: "제안요청서", eorderAtchFileNm: "제안요청서.hwp", eorderAtchFileUrl: "https://www.g2b.go.kr/rfp?no=6" }];
  const read = (store) => store.buckets.get("bid|2026-08-11").get("bid:R26BK1");
  for (const order of ["eorder-first", "notice-first"]) {
    const store = { buckets: new Map(), location: new Map(), counts: new Map(), eorder: new Map() }, changed = new Set();
    if (order === "eorder-first") { assert.equal(applyEorder(store, eorder, changed), 0); applyItems(store, [notice], changed, job); }
    else { applyItems(store, [notice], changed, job); assert.equal(applyEorder(store, eorder, changed), 1); }
    assert.equal(read(store).eorderAtchFileNm1, "제안요청서.hwp", order);
    assert.equal(read(store).eorderDocDivNm1, "제안요청서", order);
    assert.ok(changed.has("bid|2026-08-11"));
    // 공고 목록을 다시 받아도(정정·재개) 이미 붙은 첨부를 지우지 않는다.
    applyItems(store, [{ ...notice, bidNtceNm: "갱신" }], changed, job);
    assert.equal(read(store).eorderAtchFileNm1, "제안요청서.hwp", order);
  }
  assert.equal(EORDER_TYPE, "제안요청정보");
});

test("재개 실행은 이번에 제안요청정보를 받지 않은 공고의 이전 첨부를 이어 붙인다", () => {
  const job = { mode: "bid", type: "용역", range: { begin: "2026-08-11", end: "2026-08-11" } };
  const store = { buckets: new Map(), location: new Map(), counts: new Map(), eorder: new Map() }, changed = new Set();
  applyItems(store, [{ bidNtceNo: "R26BK1", bidNtceDt: "2026-08-11", eorderAtchFileUrl1: "https://www.g2b.go.kr/rfp?no=1", eorderAtchFileNm1: "제안요청서.hwp", eorderDocDivNm1: "제안요청서" }], changed);
  applyItems(store, [{ bidNtceNo: "R26BK1", bidNtceDt: "2026-08-11", bidNtceNm: "갱신" }], changed, job);
  const record = store.buckets.get("bid|2026-08-11").get("bid:R26BK1");
  assert.equal(record.bidNtceNm, "갱신");
  assert.equal(record.eorderAtchFileNm1, "제안요청서.hwp");
});

test("제안요청정보 작업은 업무구분 묶음에 끼지 않아 무표식 레코드 이관을 막지 않는다", () => {
  const { EORDER_TYPE } = require("./api");
  const range = { begin: "2026-08-11", end: "2026-08-11" };
  const store = storeOf([{ bidNtceNo: "legacy", bidNtceDt: "2026-08-11" }]), changed = new Set();
  const entries = [...["물품", "외자", "용역", "공사"], EORDER_TYPE].map((type, index) => ({ job: { range, mode: "bid", type }, index, id: String(index) }));
  const removed = clearLegacySources(store, entries, new Set(entries.map((entry) => entry.id)), ["물품", "외자", "용역", "공사"], changed);
  assert.equal(removed, 1);
});

test("제안요청정보 작업의 endpoint는 e발주 첨부파일정보 오퍼레이션이다", () => {
  const { EORDER_TYPE } = require("./api");
  assert.equal(sourceEndpoint({ mode: "bid", type: EORDER_TYPE }), "/1230000/ad/BidPublicInfoService/getBidPblancListInfoEorderAtchFileInfo");
});

test("같은 사전규격에서 나온 본공고 둘은 서로 덮지 않고, 같은 공고의 정정 차수는 한 행이다", () => {
  const store = storeOf([
    { bidNtceNo: "R26BK1", bidNtceOrd: "000", bfSpecRgstNo: "R26BD9", bidNtceDt: "2026-08-11 09:00:00", bidNtceNm: "원공고" },
    { bidNtceNo: "R26BK2", bidNtceOrd: "000", bfSpecRgstNo: "R26BD9", bidNtceDt: "2026-08-11 10:00:00", bidNtceNm: "재공고" },
    { bidNtceNo: "R26BK2", bidNtceOrd: "001", bfSpecRgstNo: "R26BD9", bidNtceDt: "2026-08-11 11:00:00", bidNtceNm: "재공고 정정" },
    { bfSpecRgstNo: "R26BD9", rgstDt: "2026-08-11 08:00:00", prdctClsfcNoNm: "사전규격" },
  ]);
  assert.deepEqual([...store.buckets.get("bid|2026-08-11").keys()].sort(), ["bid:R26BK1", "bid:R26BK2"]);
  assert.equal(store.buckets.get("bid|2026-08-11").get("bid:R26BK2").bidNtceNm, "재공고 정정");
  assert.deepEqual([...store.buckets.get("pre|2026-08-11").keys()], ["pre:R26BD9"]);
});
