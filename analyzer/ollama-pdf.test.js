const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyzePages, validateResponse } = require("./ollama-pdf");

const item = { id: "ECR-001", kind: "서버", name: "업무 서버", scope: "", facts: [{ field: "메모리", quote: "DDR5 256GB 이상" }] };
const pages = [{ page: 1, text: "고유번호 ECR-001\n업무 서버\nDDR5 256GB 이상" }];

test("환각 수치·ID·용도와 스캔 PDF의 대조 불가를 경고한다", () => {
  const [result] = validateResponse({ items: [{ ...item, id: "ECR-099", scope: "DR", facts: [{ field: "메모리", quote: "DDR5 512GB 이상" }] }] }, pages, "fixture.pdf");
  assert.equal(result.불확실.length, 3);
  assert.equal(result.장비요약[0].규격[0].원문텍스트일치, false);
  assert.ok(validateResponse({ items: [item] }, [{ page: 1, text: "" }], "scan.pdf")[0].불확실.length >= 2);
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

