import test from "node:test";
import assert from "node:assert/strict";
import { sliceSection, splitHalves } from "./ecr-chunks.js";
import { sourceLines, softPieces, requirementRanges } from "./ecr-source.js";

const TABLE = { size: 2400, overlap: 360, head: true };
const rows = (count) => Array.from({ length: count }, (_, index) => `| 항목${index + 1} | ○ 세부 규격 ${index + 1}: 10/25GbE SFP28 ${(index + 1) * 2}Port 이상, 메모리 ${(index + 1) * 16}GB 이상 제공 및 이중화 구성 |`);
const section = (count) => `요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n요구사항 분류 시스템 장비구성 요구사항\n세부내용\n${rows(count).join("\n")}\n`;
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];

test("구간은 줄을 통째로 싣고 숫자를 중간에서 자르지 않는다", () => {
  const source = section(60);
  const whole = new Set(linesOf(source));
  const chunks = sliceSection(source, TABLE);
  assert.ok(chunks.length > 1, "여러 구간으로 나뉘는 표여야 검증이 된다");
  for (const chunk of chunks) for (const line of linesOf(chunk)) assert.ok(whole.has(line), `원문에 없는 줄이 생겼다: ${JSON.stringify(line.slice(0, 40))}`);
});

test("이어지는 구간에도 번호 줄과 명칭 줄을 싣는다", () => {
  const chunks = sliceSection(section(60), TABLE);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith("요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n"), "모델이 어느 표의 어느 장비인지 알 수 있어야 한다");
    // 머리가 있어야 구간의 모든 줄이 그 번호의 것으로 대조된다.
    assert.deepEqual(requirementRanges(chunk).map((range) => range.id), ["ECR-001"]);
  }
  assert.ok(!chunks[1].slice(40).includes("요구사항 분류"), "머리는 명칭 줄까지만 반복한다");
});

test("앞 구간의 끝 몇 줄을 다시 싣고, 어느 줄도 빠뜨리지 않는다", () => {
  const source = section(60);
  const chunks = sliceSection(source, TABLE);
  const head = "요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n";
  const seen = new Set(linesOf(chunks[0]));
  for (let index = 1; index < chunks.length; index++) {
    const body = linesOf(chunks[index].slice(head.length));
    assert.ok(chunks[index - 1].endsWith(body[0]) || chunks[index - 1].includes(body[0]), "앞 구간에 있던 줄에서 시작한다");
    const repeated = body.filter((line) => seen.has(line)).join("");
    assert.ok(repeated.length > 0 && repeated.length <= 360, `겹침은 360자 이하의 온전한 줄이다(${repeated.length}자)`);
    for (const line of body) seen.add(line);
  }
  for (const line of linesOf(source)) assert.ok(seen.has(line), `빠진 줄: ${line.slice(0, 30)}`);
});

test("명칭 줄이 없는 표는 첫 줄만 반복하고, 머리를 반복하지 않는 분할은 본문만 싣는다", () => {
  const plain = `ECR-007 백업 스토리지\n${rows(60).join("\n")}\n`;
  const chunks = sliceSection(plain, TABLE);
  assert.ok(chunks[1].startsWith("ECR-007 백업 스토리지\n| 항목"));
  const body = sliceSection(`ECR-007 백업 스토리지\n${rows(150).join("\n")}\n`, { size: 5000, overlap: 360, head: false });
  assert.ok(body.length > 1 && !body[1].startsWith("ECR-007"), "문서 전체 분할에는 표 머리가 없다");
});

test("줄바꿈 없는 긴 글은 공백에서 끊어 수치를 온전히 둔다", () => {
  const flat = `요구사항 고유번호 ECR-003 ${"서버당 메모리 256GB 이상 제공 ".repeat(400)}`;
  const chunks = sliceSection(flat, TABLE);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    for (const line of sourceLines(chunk)) assert.doesNotMatch(line, /^(?:\d*GB|B\b)/, "앞자리가 잘린 수치로 시작하는 줄이 없다");
    assert.equal(chunk.replaceAll("256GB", "").match(/\d+GB|\b\d{1,2}\b(?!\w)/), null, "256GB가 쪼개진 흔적이 없다");
  }
  assert.ok(chunks[1].startsWith("요구사항 고유번호 ECR-003"), "첫 조각을 머리로 싣는다");
  assert.equal(chunks[1].split("\n")[0].length <= 240, true, "머리와 본문이 한 줄로 붙지 않는다");
});

test("긴 줄은 공백 뒤에서 끊고 수와 단위 사이는 피한다", () => {
  const line = `${"가나다라 ".repeat(46)}용량 1,024 GB 이상을 제공한다 ${"마바사 ".repeat(20)}`;
  const pieces = softPieces(line);
  assert.equal(pieces.join(""), line, "조각을 이으면 원래 줄이다");
  for (const piece of pieces) {
    assert.ok(piece.length <= 240);
    assert.doesNotMatch(piece, /^GB/, "단위만 다음 조각으로 넘기지 않는다");
  }
  assert.ok(pieces.some((piece) => piece.includes("1,024 GB")), "수와 단위가 한 조각에 있다");
  assert.deepEqual(softPieces("짧은 줄\n"), ["짧은 줄\n"]);
  assert.equal(softPieces("가".repeat(1000)).join(""), "가".repeat(1000), "공백이 없으면 그대로 끊는다");
});

test("잘리는 구간은 줄 단위로 둘로 가르고 뒤쪽에도 표 머리를 싣는다", () => {
  const [chunk] = sliceSection(section(20), TABLE);
  const [front, back] = splitHalves(chunk);
  assert.ok(front.length < chunk.length && back.length < chunk.length, "양쪽 모두 원래보다 작다");
  assert.ok(back.startsWith("요구사항 고유번호 ECR-001\n요구사항 명칭 WEB 서버\n"));
  const whole = new Set(linesOf(chunk)), covered = new Set([...linesOf(front), ...linesOf(back)]);
  for (const line of covered) assert.ok(whole.has(line), "원문에 없는 줄을 만들지 않는다");
  for (const line of whole) assert.ok(covered.has(line), "가르면서 줄을 빠뜨리지 않는다");
});

test("가를 수 없는 구간과 조각이 고르지 않은 구간도 원래 크기로 돌아가지 않는다", () => {
  assert.equal(splitHalves("한 줄뿐인 구간"), null);
  const lopsided = `${"짧다\n".repeat(5)}${"긴줄".repeat(100)}`;
  const [front, back] = splitHalves(lopsided);
  assert.ok(front.length < lopsided.length && back.length < lopsided.length);
  assert.ok(front.length > 0 && back.length > 0);
  // 번호 줄로 시작하지 않는 구간의 뒤쪽 절반에는 머리를 붙이지 않는다.
  assert.ok(!back.startsWith("짧다\n짧다\n짧다\n짧다\n짧다\n"));
});

test("글자 수로 자르던 때보다 구간이 늘지 않는다", () => {
  // 구간 상한 33은 그대로다. 줄 단위로 바꾸면서 같은 문서가 구간을 더 쓰면 전에 되던 문서가 거절된다.
  const before = (length, size) => (length <= size ? 1 : 1 + Math.ceil((length - size) / (size - 600)));
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const widest = [20, 60, 120, 239, 700][round % 5];
    let text = "요구사항 고유번호 ECR-001\n요구사항 명칭 시험 서버\n";
    const target = 2000 + Math.floor(random() * 18000);
    while (text.length < target) text += `${"규격 ".repeat(1 + Math.floor(random() * widest / 3)).slice(0, 1 + Math.floor(random() * widest))}\n`;
    for (const [size, head] of [[2400, true], [5000, false]]) {
      const count = sliceSection(text, { size, overlap: 360, head }).length;
      assert.ok(count <= before(text.length, size), `${text.length}자·줄 최대 ${widest}자: ${count}구간 > 예전 ${before(text.length, size)}구간`);
    }
  }
});
