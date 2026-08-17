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
  const editor = HTML.slice(HTML.indexOf('id="inst-editor"'), HTML.indexOf('class="advanced-row"'));
  for (const id of ["inst-name", "inst-code", "add-row-btn", "inst-preset", "preset-new", "preset-delete", "inst-search-btn", "clear-inst-btn"]) {
    assert.ok(editor.includes(`id="${id}"`), `${id}는 편집 영역 안에 있어야 한다`);
  }
  for (const id of ["inst-chips", "inst-count", "inst-loose"]) {
    assert.ok(!editor.includes(`id="${id}"`), `${id}는 접히면 안 된다`);
  }
});

test("주 조회 줄이 관심 기관 블록보다 위에 있다", () => {
  // 사람이 가장 자주 만지는 것이 먼저 와야 한다. 예전에는 관심 기관 관리 블록이 위에 있어
  // 검색어와 게시일이 그 아래로 밀려 있었다.
  assert.ok(HTML.indexOf('class="filter-row"') < HTML.indexOf('class="inst-section"'));
});

test("조회 조건은 세로를 먹는 줄을 따로 쌓지 않는다", () => {
  // 조회 결과가 첫 화면에 함께 보여야 한다. 상태·오늘 요약·갱신 버튼이 각자 줄을 쓰면
  // 그것만으로 100px이 넘고, 칩이 제 줄을 쓰면 40px이 더 붙는다.
  const statusBar = HTML.slice(HTML.indexOf('class="data-status"'), HTML.indexOf('id="refresh-status"'));
  assert.ok(statusBar.includes('id="today-summary"'), "오늘 요약은 보유 데이터 줄 안에 있어야 한다");
  assert.ok(statusBar.includes('id="refresh-btn"'), "갱신 버튼은 보유 데이터 줄 안에 있어야 한다");
  const head = HTML.slice(HTML.indexOf('class="inst-head"'), HTML.indexOf('id="inst-editor"'));
  assert.ok(head.includes('id="inst-chips"'), "칩은 관심 기관 라벨과 같은 줄에 있어야 한다");
  // 고급검색 토글은 검색·초기화와 같은 버튼 묶음에 있다(예전에는 제 줄을 하나 썼다).
  const actions = HTML.slice(HTML.indexOf('class="filter-actions"'), HTML.indexOf('id="advanced-panel"'));
  assert.ok(actions.includes('id="advanced-toggle"'));
});
