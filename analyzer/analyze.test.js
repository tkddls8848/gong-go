const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeNotice } = require("./analyze");
test("두 단계 모델 응답이 원문 검증을 거쳐 v2 장비 요약으로 연결된다", async (t) => {
  const source = "서버는 총 2대를 신규 도입하고 각 서버당 메모리 256GB 이상을 제공하여야 하며 설치와 이중화 구성 작업을 포함한다.";
  const list = [{ ID: "ECR-001", 구분: "서버", 명칭: "서버 도입" }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    assert.ok(request.messages[1].content.includes(source));
    const data = calls.length === 1 ? { 요구사항목록: list, 요구사항수: 1, ecr: [] } : {
      요구사항목록: list, ecr: [{ id: "ECR-001", 세부내용_원문: source, 장비요약: [{ 종류: "서버", 명칭: "서버 도입", 출처: "제안요청서", 규격: [{ 항목: "메모리", 값: "각 서버당 메모리 256GB 이상", 근거: source }] }] }],
    };
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(data) }, done_reason: "stop" }) };
  });
  const result = await analyzeNotice({ notice: "test", documents: [{ kind: "text", name: "제안요청서", text: `ECR-001\n${source}` }], markdown: `ECR-001\n${source}`, sourceFiles: ["test.hwpx"] });
  assert.equal(calls.length, 2);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.verified, true);
  assert.equal(result.ecr[0].장비요약[0].규격[0].검증, "원문 확인");
  assert.deepEqual(result.sourceFiles, ["test.hwpx"]);
});
