const test = require("node:test");
const assert = require("node:assert/strict");
const { createExports } = require("../public/exports.js");
const { createEcrView } = require("../public/ecr-view.js");
const { html, numberOf, format } = require("../public/format.js");
const EquipmentSummary = require("../public/equipment.js");
// 서버 저장 결과는 없다. 모달에 열린 공고와 이번 분석 결과만 내보낸다.
function runEcrExport(data, row = { announcementNumber: "test0", title: "테스트 공고" }) {
  const captured = { rows: null, name: null, errors: [] };
  createExports({
    model: { currentRow: row, currentAnalysis: data }, numberOf: (item) => item.announcementNumber,
    downloadRows: (rows, name) => { captured.rows = rows; captured.name = name; },
    window: { alert: (message) => captured.errors.push(message) }, EquipmentSummary: require("../public/equipment.js"),
  }).downloadEcr();
  return Promise.resolve(captured);
}

test("내려받은 CSV는 머리글과 칸 수가 같다", () => {
  // 열이 하나만 어긋나도 값이 옆 칸으로 밀려 들어가는데, 눈으로는 파일을 열기 전까지 모른다.
  // 바깥에서 끌어다 쓰는 것들을 인자로 가려 끼우고 실제로 돌려 본다.
  let captured = null;
  const build = (filtered, downloadRows, MODE_NAMES, normalizeFiles, numberOf) =>
    createExports({ model: { filtered }, downloadRows, MODE_NAMES, normalizeFiles, numberOf }).downloadCsv;
  build(
    [
      { mode: "bid", announcementNumber: "20260105123-00", businessType: "물품", institution: "기관", title: "서버", publishedAt: "2026-01-05", closeAt: "2026-01-20", files: [{ name: "규격서.hwp", url: "https://example.go.kr/1" }], detailUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R25BK1&bidPbancOrd=000" },
      { mode: "plan", announcementNumber: "P-2026-0001", businessType: "기술용역", institution: "기관", title: "포털", publishedAt: "2026-02-03", orderMonth: "2026-07", detailUrl: "https://example.go.kr/plan/1" },
      { mode: "pre", announcementNumber: "20260107001", businessType: "용역", institution: "기관", title: "유지관리", publishedAt: "2026-01-07", closeAt: "2026-01-14", files: [] },
    ],
    (rows) => { captured = rows; },
    { bid: "본공고", plan: "발주계획", pre: "사전공고" },
    (files) => (Array.isArray(files) ? files : []),
    (row) => row.announcementNumber,
  )();

  const [header, ...rows] = captured;
  assert.equal(header[header.length - 1], "나라장터 링크", "상세 링크를 담는 열이 없다");
  for (const row of rows) assert.equal(row.length, header.length, `${row[0]} 행의 칸 수가 머리글과 다르다`);
  const link = header.indexOf("나라장터 링크"), files = header.indexOf("첨부파일");
  assert.equal(rows[0][link], "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R25BK1&bidPbancOrd=000");
  assert.equal(rows[1][link], "https://example.go.kr/plan/1");
  // 발주계획에는 첨부 URL 자체가 없다. 예전에는 그 칸에 상세 링크를 넣어 열의 뜻이 모드마다 달랐다.
  assert.equal(rows[1][files], "");
  // 사전공고는 API가 상세 링크를 주지 않으므로 빈 칸이어야 한다(undefined가 아니라).
  assert.equal(rows[2][link], "");
});

test("ECR CSV는 여러 장비의 수량·규격·근거·개별 출처 소속을 유지한다", async () => {
  const data = { ecr: [{ id: "ECR-001", 장비요약: [
    { 종류: "서버", 명칭: "웹서버", 출처: "1쪽", 규격: [{ 항목: "수량", 값: "2대", 근거: "웹서버 2대", 검증: "원문 확인" }] },
    { 종류: "서버", 명칭: "DB서버", 출처: "2쪽", 규격: [{ 항목: "수량", 값: "1대", 근거: "DB서버 1대", 검증: "확인 필요" }] },
    { 종류: "미분류", 명칭: "추가 장비", 규격: [] },
  ] }] };
  const before = JSON.stringify(data);
  const { rows } = await runEcrExport(data);
  const value = (key) => rows[1][rows[0].indexOf(key)];
  assert.equal(rows.length, 2);
  assert.equal(rows[1].length, 19);
  assert.equal(value("수량"), "[장비 1 | 서버 | 웹서버] 2대\n[장비 2 | 서버 | DB서버] 1대");
  assert.match(value("장비 요구사항"), /\[장비 3 \| 미분류 \| 추가 장비\]\n추출 규격 없음/);
  assert.match(value("근거"), /\[장비 1 \| 서버 \| 웹서버\]\n출처: 1쪽\n수량: 웹서버 2대/);
  assert.match(value("근거"), /\[장비 2 \| 서버 \| DB서버\]\n출처: 2쪽\n수량: DB서버 1대/);
  assert.equal(JSON.stringify(data), before);
});

test("구형 ECR CSV도 기본규격 요구사항과 수량 0을 잃지 않는다", async () => {
  const { rows } = await runEcrExport({ ecr: [{ 기본규격: [{ 구분: "서버", 항목: "메모리", 요구사항: "256GB 이상", 수량: 0 }] }] });
  assert.equal(rows[1][rows[0].indexOf("수량")], "0");
  assert.equal(rows[1][rows[0].indexOf("장비 요구사항")], "서버 | 메모리: 256GB 이상");
});

test("ECR CSV는 미추출·제외 사유·검증 경고·분석 출처를 보존한다", async () => {
  const { rows } = await runEcrExport({ verified: false, analyzedAt: "2026-09-25T00:00:00Z", model: "test-model", 누락: ["ECR-002"], coverage: { status: "partial", missingIds: ["ECR-002"] }, verification: { errors: ["오류"], warnings: ["범위 확인"] }, ecr: [{ id: "ECR-001", 출처: "rfp.md 구간 1", 불확실: ["다른 요구사항 근거 제외함"], 장비요약: [{ 규격: [{ 항목: "메모리", 값: "256GB 이상", 근거: "메모리 256GB 이상", 검증: "원문 확인" }] }] }] });
  const value = (name) => rows[1][rows[0].indexOf(name)];
  assert.equal(rows[1].length, rows[0].length);
  assert.equal(value("미추출 번호"), "ECR-002");
  assert.match(value("제외/불확실"), /제외함/);
  assert.equal(value("검증 경고"), "범위 확인");
  assert.equal(value("분석 모델"), "test-model");
  assert.equal(value("출처"), "rfp.md 구간 1");
  assert.equal(value("검증"), "원문 확인 필요");
});

test("ECR 추출 0건도 경고를 포함한 행으로 내보낸다", async () => {
  const { rows } = await runEcrExport({ ecr: [], verified: true, 누락: ["ECR-001"] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].length, rows[0].length);
  assert.equal(rows[1][rows[0].indexOf("명칭")], "추출된 ECR 없음");
  assert.match(rows[1][rows[0].indexOf("검증")], /추출 결과 없음/);
  assert.equal(rows[1][rows[0].indexOf("미추출 번호")], "ECR-001");
});

test("ECR 배열이 없는 응답을 추출 0건으로 내보내지 않는다", async () => {
  for (const data of [{}, { ecr: {} }, { ecr: "" }]) {
    const output = await runEcrExport(data);
    assert.equal(output.rows, null);
    assert.match(output.errors[0], /형식/);
  }
});

test("분석 결과가 없으면 헤더만 있는 CSV를 만들지 않는다", async () => {
  const output = await runEcrExport(null);
  assert.equal(output.rows, null);
  assert.match(output.errors[0], /내보낼 ECR 분석 결과가 없/);
});

test("이번 분석 결과는 열린 공고의 번호와 제목으로 네트워크 조회 없이 내보낸다", async () => {
  const output = await runEcrExport({ ecr: [{ id: "ECR-001", 명칭: "서버" }] }, { announcementNumber: "R26-1", title: "원래 제목" });
  assert.equal(output.rows.length, 2);
  assert.equal(output.rows[1][0], "R26-1");
  assert.equal(output.rows[1][1], "원래 제목");
  assert.equal(output.name, "gong-go-ecr-R26-1");
});

test("누락·오류·불확실 정보는 저장된 통과 플래그보다 화면과 CSV에서 우선한다", async () => {
  let captured = "";
  const equipment = require("../public/equipment.js");
  const { renderEcr: render } = createEcrView({ $: () => ({ set innerHTML(value) { captured = value; } }), html, document: { querySelectorAll: () => [] }, EquipmentSummary: equipment });
  for (const extra of [
    { 누락: ["ECR-002"] }, { verification: { errors: ["근거 불일치"] } },
    { coverage: { status: "matched", missingIds: ["ECR-002"] } },
    { coverage: { status: "partial" } }, { coverage: { status: "unknown" } },
    { ecr: [{ id: "ECR-001", 불확실: ["수량 확인 필요"] }] },
  ]) {
    const data = { verified: true, ecr: [{ id: "ECR-001" }], ...extra };
    const before = JSON.stringify(data);
    render(data);
    assert.match(captured, /ecr-status unverified/);
    assert.doesNotMatch(captured, /자동 검증 통과/);
    if (extra.coverage?.missingIds) assert.match(captured, /누락: ECR-002/);
    const { rows } = await runEcrExport(data);
    assert.equal(rows[1][rows[0].indexOf("검증")], "원문 확인 필요");
    assert.equal(JSON.stringify(data), before);
  }
  const legacy = { verified: true, ecr: [{ id: "ECR-001" }] };
  assert.equal(equipment.isVerified(legacy), true, "명시적인 충돌 없는 구형 검증 표시는 유지한다");
});
