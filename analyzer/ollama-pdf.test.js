const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyzePages, analyzeTargets, validateResponse, factField } = require("./ollama-pdf");

const item = { id: "ECR-001", kind: "서버", name: "업무 서버", scope: "", facts: [{ field: "메모리", quote: "DDR5 256GB 이상" }] };
const pages = [{ page: 1, text: "고유번호 ECR-001\n업무 서버\nDDR5 256GB 이상" }];

test("PDF 글자 간격으로 나뉜 요구사항 ID만 정규화하고 원래 표기를 남긴다", () => {
  const [result] = validateResponse({ items: [{ ...item, id: "ECR- 001" }] }, pages, "fixture.pdf");
  assert.equal(result.id, "ECR-001"); assert.equal(result.originalId, "ECR- 001");
  const [invalid] = validateResponse({ items: [{ ...item, id: "업무 서버" }] }, pages, "fixture.pdf");
  assert.equal(invalid.id, "업무 서버");
});

test("PDF 텍스트가 일치해도 장비 소속과 누락을 검증 완료로 표시하지 않는다", () => {
  const [result] = validateResponse({ items: [item] }, pages, "fixture.pdf");
  const fact = result.장비요약[0].규격[0];
  assert.equal(fact.원문텍스트일치, true);
  assert.equal(fact.검증, "확인 필요");
  assert.equal(result.적용구분, "");
});

test("환각 수치·ID·용도와 스캔 PDF의 대조 불가를 경고한다", () => {
  const [result] = validateResponse({ items: [{ ...item, id: "ECR-099", scope: "DR", facts: [{ field: "메모리", quote: "DDR5 512GB 이상" }] }] }, pages, "fixture.pdf");
  assert.equal(result.불확실.length, 3);
  assert.equal(result.장비요약[0].규격[0].원문텍스트일치, false);
  assert.ok(validateResponse({ items: [item] }, [{ page: 1, text: "" }], "scan.pdf")[0].불확실.length >= 2);
});

test("반복 규격은 제거하며 의미 있는 다른 조건과 원문을 보존한다", () => {
  const [result] = validateResponse({ items: [{ ...item, facts: [...item.facts, ...item.facts, { field: "메모리", quote: "최대 4TB 확장" }] }] }, pages, "fixture.pdf");
  assert.equal(result.장비요약[0].규격.length, 2);
  assert.ok(result.불확실.some(v => v.includes("중복")));
  assert.equal(result.장비요약[0].규격[1].값, "최대 4TB 확장");
});

test("명시된 규격 단위로만 항목을 교정하며 모델 항목을 기록한다", () => {
  assert.equal(factField("도입구분", "○ 도입수량: 2식", "서버"), "수량");
  assert.equal(factField("도입구분", "증설", "서버"), "도입구분");
  assert.equal(factField("포트 수", "FC 32Gbps 4port Adapter", "서버"), "NIC/HBA");
  assert.equal(factField("포트 수", "48포트", "스위치"), "포트 수");
  assert.equal(factField("로컬 디스크", "Useable 50TB 이상 증설 (증설 후 270TB)", "서버"), "Usable 용량");
  const [result] = validateResponse({ items: [{ ...item, facts: [{ field: "도입구분", quote: "2식" }] }] }, pages, "fixture.pdf");
  assert.equal(result.장비요약[0].규격[0].모델항목, "도입구분");
});

test("글머리표 차이만 허용하고 숫자·부등 조건 차이는 불일치로 남긴다", () => {
  const source = [{ page: 1, text: "❍ 도입수량: 1식\n- 메모리 256GB 이상" }];
  const [result] = validateResponse({ items: [{ ...item, facts: [{ field: "수량", quote: "○ 도입수량: 1식" }, { field: "메모리", quote: "메모리 256GB 이하" }] }] }, source, "fixture.pdf");
  assert.deepEqual(result.장비요약[0].규격.map(f => f.원문텍스트일치), [true, false]);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gong-go-vision-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "page.png"), "fixture image");
  const file = path.join(dir, "pages.json");
  fs.writeFileSync(file, JSON.stringify({ pdf: "fixture.pdf", sha256: "fixture", pages: [{ ...pages[0], image: "page.png" }] }));
  return { file, dir };
}

test("실제 이미지 입력은 loopback만 사용하고 텍스트는 모델에 보내지 않는다", async t => {
  const { file, dir } = fixture(t);
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith("http://127.0.0.1:11434/"));
    assert.equal(options.redirect, "error");
    calls.push(url);
    if (url.endsWith("/show")) return Response.json({ capabilities: ["vision"] });
    const body = JSON.parse(options.body);
    assert.equal(body.messages[1].images.length, 1);
    assert.ok(!body.messages.some(m => m.content.includes("DDR5 256GB 이상")));
    return Response.json({ done: true, done_reason: "stop", message: { content: JSON.stringify({ items: [item] }) }, total_duration: 1e9 });
  };
  const result = await analyzePages(file, { output: dir, fetchImpl });
  assert.equal(result.verified, false);
  assert.equal(result.ecr.length, 1);
  await analyzePages(file, { output: dir, fetchImpl });
  assert.equal(calls.length, 2, "같은 모델·프롬프트·이미지는 캐시를 재검증한다");
});

test("cloud 별칭·원격 모델·잘린 출력을 거부한다", async t => {
  const { file, dir } = fixture(t);
  await assert.rejects(analyzePages(file, { model: "qwen-cloud" }), /Cloud/);
  await assert.rejects(analyzePages(file, { output: dir, fetchImpl: async () => Response.json({ remote_host: "cloud", capabilities: ["vision"] }) }), /local vision/);
  await assert.rejects(analyzePages(file, { output: dir, fetchImpl: async url => Response.json(url.endsWith("/show") ? { capabilities: ["vision"] } : { done: true, done_reason: "length", message: { content: '{"items":[]}' } }) }), /Incomplete/);
});

test("대상 ID마다 요청을 분리하고 다른 ID의 응답은 격리한다", async t => {
  const { file, dir } = fixture(t);
  let requests = 0;
  const fetchImpl = async url => {
    if (url.endsWith("/show")) return Response.json({ capabilities: ["vision"] });
    requests++;
    return Response.json({ done: true, done_reason: "stop", message: { content: JSON.stringify({ items: [item] }) }, total_duration: 1e9 });
  };
  const result = await analyzeTargets(file, { output: dir, fetchImpl, targetIds: ["ECR-001", "ECR-002"], recoverQuantity: false });
  assert.equal(requests, 2);
  assert.equal(result.ecr.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.missingIds, ["ECR-002"]);
});

test("수량은 한 번만 재확인하고 같은 장비·구분·원문에 맞는 경우에만 합친다", async t => {
  for (const scenario of ["match", "other-scope", "invented-value"]) {
    const { file, dir } = fixture(t);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.pages[0].text += "\n도입수량: 2식";
    fs.writeFileSync(file, JSON.stringify(manifest));
    let calls = 0;
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/show")) return Response.json({ capabilities: ["vision"] });
      calls++;
      const isRetry = JSON.parse(options.body).messages[1].content.includes("이번에는 장비 수량만");
      const value = isRetry ? { ...item, scope: scenario === "other-scope" ? "DR" : "", facts: [{ field: "수량", quote: scenario === "invented-value" ? "99식" : "2식" }] } : item;
      return Response.json({ done: true, done_reason: "stop", message: { content: JSON.stringify({ items: [value] }) }, total_duration: 1e9, prompt_eval_count: 10, eval_count: 10 });
    };
    const result = await analyzeTargets(file, { output: dir, fetchImpl, targetIds: ["ECR-001"] });
    assert.equal(calls, 2);
    assert.equal(result.ecr[0].장비요약[0].규격.some(f => f.항목 === "수량"), scenario === "match");
    assert.deepEqual(result.quantityRetry.recovered, scenario === "match" ? ["ECR-001"] : []);
  }
});
