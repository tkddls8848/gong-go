const test = require("node:test");
const assert = require("node:assert/strict");
const { retryPlan, mergeRetry } = require("../public/ecr-retry.js");

const usable = (id, value = "256GB") => ({ id, 명칭: id, 불확실: [], 장비요약: [{ 종류: "서버", 규격: [{ 항목: "메모리", 값: value, 근거: value, 검증: "원문 확인" }] }] });
const empty = (id, reason = "메모리: 모델이 가리킨 원문 줄(9~9)을 확인할 수 없어 제외함") => ({ id, 명칭: id, 불확실: [reason], 장비요약: [{ 종류: "서버", 규격: [] }] });
const previous = () => ({
  schemaVersion: 2, verified: false, analyzedAt: "2026-10-08T00:00:00Z", sourceFiles: ["rfp.pdf"],
  ecr: [usable("ECR-001"), empty("ECR-002")], 누락: ["ECR-002", "ECR-003"],
  coverage: { status: "partial", expectedIds: ["ECR-001", "ECR-002", "ECR-003"], matchedIds: ["ECR-001"], missingIds: ["ECR-002", "ECR-003"], unexpectedIds: ["ECR-X"] },
  verification: { errors: [], warnings: ["이전 경고"] },
});

test("번호 대조가 끝난 결과에서만 누락 번호와 이어받을 번호를 만든다", () => {
  assert.deepEqual(retryPlan(previous()), { focus: ["ECR-002", "ECR-003"], thin: [], matched: ["ECR-001"], unexpected: ["ECR-X"] });
  assert.equal(retryPlan({ ...previous(), coverage: undefined }), null, "대조 목록이 없으면 무엇이 빠졌는지 모른다");
  assert.equal(retryPlan({ ...previous(), 누락: [], coverage: { ...previous().coverage, missingIds: [] } }), null);
});

test("되찾은 번호는 새 항목으로 바꾸고, 여전히 비는 번호는 직전 사유를 남긴다", () => {
  const before = previous();
  const snapshot = JSON.stringify(before);
  const retry = {
    analyzedAt: "2026-10-08T01:00:00Z", ecr: [usable("ECR-002", "512GB"), empty("ECR-003")], 누락: ["ECR-003"],
    coverage: { status: "partial", expectedIds: ["ECR-001", "ECR-002", "ECR-003"], matchedIds: ["ECR-001", "ECR-002"], missingIds: ["ECR-003"], unexpectedIds: ["ECR-X"], warnings: [] },
    verification: { errors: [], warnings: ["서버 경고"] },
    retry: { focus: ["ECR-002", "ECR-003"], recovered: ["ECR-002"] },
  };
  const merged = mergeRetry(before, retry);
  assert.equal(JSON.stringify(before), snapshot, "직전 결과를 고치지 않는다");
  assert.deepEqual(merged.ecr.map((item) => [item.id, item.장비요약[0].규격[0]?.값 || ""]), [["ECR-001", "256GB"], ["ECR-002", "512GB"], ["ECR-003", ""]]);
  assert.deepEqual(merged.누락, ["ECR-003"]);
  assert.equal(merged.coverage, retry.coverage, "서버가 문서 전체 기준으로 다시 대조한 목록을 쓴다");
  assert.equal(merged.verified, false);
  assert.deepEqual(merged.verification.errors, ["ECR-003: 메모리: 모델이 가리킨 원문 줄(9~9)을 확인할 수 없어 제외함"]);
  assert.match(merged.verification.warnings.at(-1), /2개를 다시 분석해 1개의 규격을 찾아/);
  assert.deepEqual(merged.sourceFiles, ["rfp.pdf"]);
  assert.equal(retryPlan(merged), null, "이미 다시 물은 번호는 또 묻지 않는다");
});


// 번호는 대조됐지만 장비가 핵심 규격 없이 온 번호. 큰 문서에서 실행마다 갈리는 쪽이다(노후 인프라 L7 스위치, 전문도서관 DB 서버).
const fact = (항목, 값) => ({ 항목, 값, 근거: 값, 검증: "원문 확인" });
const device = (종류, 명칭, ...facts) => ({ 종류, 명칭, 규격: facts });
const thinPrevious = () => ({
  schemaVersion: 2, verified: false, sourceFiles: ["rfp.pdf"],
  ecr: [
    usable("ECR-001"),
    { id: "ECR-002", 명칭: "L7", 불확실: [], 장비요약: [device("스위치", "L7 스위치", fact("수량", "2식"), fact("기타 조건", "Hot-swap 지원"))] },
    { id: "ECR-003", 명칭: "도서관", 불확실: ['장비 "DB 서버": 유효한 원문 규격이 없어 장비 요약에서 제외함', "CPU: 근거 확인 필요"], 장비요약: [device("서버", "HCI 노드", fact("메모리", "192GB 증설"))] },
    { id: "ECR-004", 명칭: "증설", 불확실: [], 장비요약: [device("서버", "서버", fact("기타 조건", "Core 확장"))] },
  ],
  누락: [],
  coverage: { status: "matched", expectedIds: ["ECR-001", "ECR-002", "ECR-003", "ECR-004"], matchedIds: ["ECR-001", "ECR-002", "ECR-003", "ECR-004"], missingIds: [], unexpectedIds: [] },
  verification: { errors: [], warnings: [] },
  retried: ["ECR-004"],
});

test("핵심 규격 없이 대조된 번호와 장비가 빠진 번호도 다시 묻고, 이어받는 번호에는 그대로 둔다", () => {
  const plan = retryPlan(thinPrevious());
  assert.deepEqual(plan.focus, ["ECR-002", "ECR-003"], "이미 다시 물은 ECR-004와 규격이 있는 ECR-001은 묻지 않는다");
  assert.deepEqual(plan.thin, ["ECR-002", "ECR-003"]);
  assert.deepEqual(plan.matched, ["ECR-001", "ECR-002", "ECR-003", "ECR-004"], "다시 물어 못 찾아도 대조된 번호로 남는다");
  // 빠진 번호가 먼저이고 규격이 빈 번호가 뒤따른다.
  const both = { ...thinPrevious(), 누락: ["ECR-005"], coverage: { ...thinPrevious().coverage, expectedIds: [...thinPrevious().coverage.expectedIds, "ECR-005"], missingIds: ["ECR-005"] } };
  assert.deepEqual(retryPlan(both).focus, ["ECR-005", "ECR-002", "ECR-003"]);
  assert.deepEqual(retryPlan(both).thin, ["ECR-002", "ECR-003"]);
});

test("규격이 빈 번호는 핵심 규격을 가진 장비가 새로 나올 때만 보강하고 그렇지 않으면 직전 항목을 둔다", () => {
  const before = thinPrevious();
  const snapshot = JSON.stringify(before);
  const retry = {
    ecr: [
      { id: "ECR-002", 명칭: "L7", 불확실: [], 장비요약: [device("스위치", "L7 스위치", fact("기타 조건", "Hot-swap 지원"))] },
      { id: "ECR-003", 명칭: "도서관", 불확실: [], 장비요약: [device("서버", "DB 서버", fact("메모리", "32GB 이상"))] },
    ],
    누락: [], coverage: before.coverage, verification: { errors: [], warnings: [] },
    // 서버는 이어받은 번호라 둘 다 되찾았다고 센다. 화면은 장비로 판단한다.
    retry: { focus: ["ECR-002", "ECR-003"], recovered: ["ECR-002", "ECR-003"] },
  };
  const merged = mergeRetry(before, retry, ["ECR-002", "ECR-003"], ["ECR-002", "ECR-003"]);
  assert.equal(JSON.stringify(before), snapshot, "직전 결과를 고치지 않는다");
  assert.deepEqual(merged.ecr.map((item) => item.id), ["ECR-001", "ECR-002", "ECR-003", "ECR-004"]);
  assert.equal(merged.ecr[1], before.ecr[1], "핵심 규격이 새로 나오지 않은 번호는 직전 항목 그대로다");
  assert.deepEqual(merged.ecr[2].장비요약.map((entry) => entry.명칭), ["HCI 노드", "DB 서버"], "규격이 있던 장비는 두고 빠졌던 장비를 더한다");
  assert.deepEqual(merged.ecr[2].불확실, ["CPU: 근거 확인 필요"], "되찾은 장비의 제외 사유는 뺀다");
  assert.deepEqual(merged.retry, { focus: ["ECR-002", "ECR-003"], recovered: ["ECR-003"] });
  assert.match(merged.verification.warnings.at(-1), /2개를 다시 분석해 1개의 규격을 찾아/);
  assert.equal(retryPlan(merged), null, "다시 물은 번호는 또 묻지 않는다");
});

test("규격이 빈 장비는 이름이 같은 새 장비가 핵심 규격을 가져올 때만 바뀌고, 이름이 다른 장비는 종류가 같아도 남는다", () => {
  const before = { ...thinPrevious(), ecr: [{ id: "ECR-002", 명칭: "망", 불확실: [], 장비요약: [
    device("스위치", "L7 스위치", fact("수량", "2식")), device("스위치", "C9500-24Y4C-A", fact("기타 조건", "dvantage")), device("서버", "관리 서버", fact("수량", "1식")),
  ] }] };
  // 다시 물은 응답이 본체 대신 딸린 품번을 장비로 냈다. 본체는 남아야 한다.
  const retry = { ecr: [{ id: "ECR-002", 명칭: "망", 불확실: [], 장비요약: [
    device("스위치", "L7 스위치", fact("수량", "2식"), fact("성능", "L7 처리량 125Gbps 이상")), device("스위치", "C9K-PWR-650WAC-R/2", fact("포트 수", "4 Ports")),
  ] }], 누락: [], coverage: before.coverage, verification: { errors: [], warnings: [] } };
  const merged = mergeRetry(before, retry, ["ECR-002"], ["ECR-002"]);
  assert.deepEqual(merged.ecr[0].장비요약.map((entry) => entry.명칭), ["C9500-24Y4C-A", "관리 서버", "L7 스위치", "C9K-PWR-650WAC-R/2"]);
  assert.deepEqual(merged.ecr[0].장비요약[2].규격.map((entry) => entry.항목), ["수량", "성능"]);
});

test("장비가 모두 빠진 채 대조된 번호도 다시 묻고, 되찾은 장비의 제외 사유를 지운다", () => {
  const note = '장비 "C9500-24Y4C-A": 서버·스토리지·스위치가 아닌 규격 없는 품목 목록(소프트웨어·솔루션 추정) 항목이므로 장비 요약에서 제외함';
  const before = { ...thinPrevious(), ecr: [{ id: "ECR-002", 명칭: "L3", 불확실: [note, "종류: 근거 확인 필요"], 장비요약: [] }], retried: [] };
  before.coverage = { ...before.coverage, matchedIds: ["ECR-002"], expectedIds: ["ECR-002"] };
  assert.deepEqual(retryPlan(before).thin, ["ECR-002"]);
  const retry = { ecr: [{ id: "ECR-002", 명칭: "L3", 불확실: [], 장비요약: [device("스위치", "C9500-24Y4C-A", fact("포트 수", "24x1/10/25G and 4-port 40/100G"))] }], 누락: [], coverage: before.coverage, verification: { errors: [], warnings: [] } };
  const merged = mergeRetry(before, retry, ["ECR-002"], ["ECR-002"]);
  assert.deepEqual(merged.ecr[0].장비요약.map((entry) => entry.명칭), ["C9500-24Y4C-A"]);
  assert.deepEqual(merged.ecr[0].불확실, ["종류: 근거 확인 필요"]);
  assert.deepEqual(merged.retry.recovered, ["ECR-002"]);
});
