// 조회 화면의 HTML과 스크립트 사이 계약. app.js는 요소를 id로 직접 찾으므로 index.html을
// 손보다 하나를 놓치면 그 순간 스크립트가 통째로 죽는다(맨 위 $("#...")에서 TypeError).
//
// rows.test.js와 같은 이유로 여기 둔다 — public/은 wrangler의 자산 디렉터리라
// 그 안의 파일은 전부 사이트로 배포된다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
const APP = read("app.js");
const HTML = read("index.html");
const CSS = read("style.css");

const idsIn = (source) => new Set([...source.matchAll(/id="([\w-]+)"/g)].map((match) => match[1]));
const lookupsIn = (source) => new Set([...source.matchAll(/\$\("#([\w-]+)"\)/g)].map((match) => match[1]));
// 위치를 견주는 검사가 많다. 찾지 못한 표식은 -1이 되어 비교를 조용히 통과시키므로 여기서 끊는다.
const at = (needle) => { const index = HTML.indexOf(needle); assert.notEqual(index, -1, `index.html에 ${needle}가 없다`); return index; };

test("app.js가 id로 찾는 요소는 index.html에 모두 있다", () => {
  const missing = [...lookupsIn(APP)].filter((id) => !idsIn(HTML).has(id));
  assert.deepEqual(missing, [], `index.html에 없는 id: ${missing.join(", ")}`);
});

test("접히는 패널은 hidden 속성으로 감추므로 전역 [hidden] 규칙이 있어야 한다", () => {
  // hidden은 UA 기본 display:none으로 걸리는데, 클래스가 display를 지정하면 그쪽이 이긴다.
  // .advanced-panel이 display:flex라 고급검색 패널은 접힌 적이 없었다. 이 규칙이 그것을 막는다.
  assert.match(CSS, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  // 감추기로 한 것들이 실제로 hidden 속성을 달고 있는지도 함께 본다.
  for (const id of ["advanced-panel", "inst-editor", "refresh-status", "nl-status", "today-summary"]) {
    assert.match(HTML, new RegExp(`id="${id}"[^>]*\\shidden`), `${id}에 hidden이 없다`);
  }
});

test("토글 버튼의 aria-controls는 실재하는 요소를 가리킨다", () => {
  const controls = [...HTML.matchAll(/aria-controls="([\w-]+)"/g)].map((match) => match[1]);
  assert.ok(controls.length >= 2, "접히는 패널이 둘(고급검색·관심 기관 편집)은 있어야 한다");
  for (const id of controls) assert.ok(idsIn(HTML).has(id), `aria-controls가 가리키는 ${id}가 없다`);
});

test("관심 기관은 조건과 편집 도구를 갈라 둔다", () => {
  // 지금 무엇으로 걸러지는지(칩·개수·부분일치)는 접으면 안 된다. 접힌 채로 조회하면
  // 결과가 왜 이만큼인지 알 수 없다. 접는 것은 기관을 더하고 프리셋을 관리하는 도구뿐이다.
  const editor = at('id="inst-editor"');
  for (const id of ["inst-name", "inst-code", "add-row-btn", "inst-preset", "preset-new", "preset-delete", "inst-search-btn", "clear-inst-btn"]) {
    assert.ok(at(`id="${id}"`) > editor, `${id}는 편집 영역 안에 있어야 한다`);
  }
  for (const id of ["inst-chips", "inst-count", "inst-loose"]) {
    assert.ok(at(`id="${id}"`) < editor, `${id}는 접히면 안 된다`);
  }
});

test("레일에는 늘 쓰는 것을, 본문에는 검색과 결과를 둔다", () => {
  // 한 번 정해 두고 계속 쓰는 것(유형·관심 기관·보유 데이터)은 왼쪽 레일에, 매번 바꾸는
  // 것(검색어·기간)과 결과는 본문에 둔다. 예전에는 조건 패널이 본문 위를 다 먹어 결과가
  // 첫 화면 밖으로 밀려 있었다.
  const rail = HTML.slice(at('id="rail"'), at('<main class="main">'));
  for (const id of ["mode-toggle", "today-summary", "inst-chips", "inst-editor", "data-range", "refresh-btn"]) {
    assert.ok(rail.includes(`id="${id}"`), `${id}는 레일에 있어야 한다`);
  }
  const main = HTML.slice(at('<main class="main">'));
  for (const id of ["q", "business-type", "begin", "end", "search", "advanced-toggle", "status", "results", "page-size"]) {
    assert.ok(main.includes(`id="${id}"`), `${id}는 본문에 있어야 한다`);
  }
  assert.ok(at('class="filter-row"') < at('class="results-header"'), "조회 줄이 결과보다 위에 있어야 한다");
});

test("표의 열 수와 빈 행의 colspan, renderRows가 그리는 칸 수가 모두 같다", () => {
  // 한 번에 한 모드만 조회하므로(applyFilters가 그 모드의 파일만 받는다) 유형 열은 모든
  // 행에서 같은 값이 된다. 그래서 뺐다 — 지금 보는 유형은 레일에서 이미 켜져 있다.
  const head = HTML.slice(at("<thead>"), at("</thead>"));
  const columns = [...head.matchAll(/<th\b/g)].length;
  assert.equal(columns, 6);
  assert.match(HTML, new RegExp(`id="empty-row"[\\s\\S]*?colspan="${columns}"`), "빈 행이 표 전체를 덮지 않는다");
  // 셋 중 하나만 어긋나도 값이 옆 칸으로 밀려 들어간다.
  const start = APP.indexOf("visible.map((row, i)");
  const row = APP.slice(start, APP.indexOf("</tr>`", start));
  assert.equal([...row.matchAll(/<td/g)].length, columns, "renderRows가 그리는 칸 수가 머리글과 다르다");
});

test("결과가 없을 때도 그 자리에서 보유데이터를 갱신할 수 있다", () => {
  // 0건의 가장 잦은 이유가 "아직 수집하지 않은 기간"이라, 레일까지 눈을 옮기지 않고
  // 안내 문구 아래에서 바로 다시 받을 수 있어야 한다.
  assert.match(HTML, /id="empty-row"[\s\S]*?class="[^"]*\bempty-refresh\b/);
  assert.match(APP, /querySelectorAll\("\.empty-refresh"\)/, "템플릿은 매번 다시 그려지므로 그릴 때마다 버튼을 걸어야 한다");
});
