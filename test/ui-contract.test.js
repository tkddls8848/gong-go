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
const HTML = read("index.html");
const APP = read("app.js");
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((match) => ({ name: match[1], source: read(match[1]) }));
const CSS = read("style.css");
const SEARCH_WORKER = read("search-worker.js");

const idsIn = (source) => new Set([...source.matchAll(/id="([\w-]+)"/g)].map((match) => match[1]));
const lookupsIn = (source) => new Set([...source.matchAll(/\$\("#([\w-]+)"\)/g)].map((match) => match[1]));
// 위치를 견주는 검사가 많다. 찾지 못한 표식은 -1이 되어 비교를 조용히 통과시키므로 여기서 끊는다.
const at = (needle) => { const index = HTML.indexOf(needle); assert.notEqual(index, -1, `index.html에 ${needle}가 없다`); return index; };

test("비동기 검색·수집 상태는 화면 낭독기에 전체 문장으로 전달한다", () => {
  for (const id of ["status", "nl-status", "refresh-status"]) {
    const tag = HTML.match(new RegExp(`<p\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.match(tag, /role="status"/);
    assert.match(tag, /aria-live="polite"/);
    assert.match(tag, /aria-atomic="true"/);
  }
});

test("플레이스홀더만 있던 입력에도 지속적인 접근성 이름을 제공한다", () => {
  for (const id of ["inst-name", "inst-code", "inst-preset", "nl-query"]) {
    const tag = HTML.match(new RegExp(`<(?:input|select)\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.match(tag, /aria-label="[^"]+"/);
  }
});

test("app.js가 id로 찾는 요소는 index.html에 모두 있다", () => {
  const missing = SCRIPTS.flatMap(({ name, source }) => [...lookupsIn(source)]
    .filter((id) => !idsIn(HTML).has(id)).map((id) => name + ": " + id));
  assert.deepEqual(missing, [], `index.html에 없는 id: ${missing.join(", ")}`);
});

test("접히는 패널은 hidden 속성으로 감추므로 전역 [hidden] 규칙이 있어야 한다", () => {
  // hidden은 UA 기본 display:none으로 걸리는데, 클래스가 display를 지정하면 그쪽이 이긴다.
  // .advanced-panel이 display:flex라 고급검색 패널은 접힌 적이 없었다. 이 규칙이 그것을 막는다.
  assert.match(CSS, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  // 감추기로 한 것들이 실제로 hidden 속성을 달고 있는지도 함께 본다.
  for (const id of ["advanced-panel", "inst-editor", "menu-panel", "refresh-status", "nl-status", "today-summary"]) {
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

test("조회 줄에는 매번 바꾸는 것만 남기고 나머지는 ☰ 메뉴에 넣는다", () => {
  // 조회 줄이 버튼으로 붐비면 게시일 칸이 먼저 눌려 "오늘"이 두 줄로 접힌다. 자주 쓰지 않는
  // 동작은 메뉴로 내리고, 줄에는 검색어·업무·게시일과 검색 버튼만 남긴다.
  const panel = HTML.slice(at('id="menu-panel"'), at('class="filter-q"'));
  for (const id of ["rail-open", "advanced-toggle", "reset", "download-btn", "download-ecr-btn", "menu-refresh"]) {
    assert.ok(panel.includes(`id="${id}"`), `${id}는 메뉴 안에 있어야 한다`);
  }
  // 검색은 메뉴로 내리지 않는다. 조회 줄의 유일한 주 동작이다.
  assert.ok(!panel.includes('id="search"'), "검색 버튼은 조회 줄에 남아야 한다");
});

test("메뉴의 레일 열기 항목은 레일이 접혀 있을 때만 나온다", () => {
  // 이 항목의 전신인 .rail-open은 `display: none`을 뒤에 오는 `.icon-btn`의
  // `display: inline-flex`에 빼앗겼다(특정도가 같으면 뒤에 쓴 쪽이 이긴다). 그래서 레일이
  // 펼쳐진 넓은 화면에서도 버튼이 보였고, 눌러도 이미 열린 레일을 또 여는 빈 동작이었다.
  const hide = CSS.indexOf(".menu-rail-open { display: none; }");
  assert.notEqual(hide, -1, "레일 열기 항목을 감추는 규칙이 없다");
  assert.match(CSS, /body\.rail-collapsed \.menu-rail-open \{ display: flex; \}/);
  // 이 항목에 함께 걸리면서 display를 지정하는 규칙(.menu-item)은 특정도가 같으므로
  // 반드시 앞에 와야 한다. 뒤에 오면 그 순간 예전 .rail-open과 똑같이 되살아난다.
  const item = CSS.indexOf(".menu-item {");
  assert.notEqual(item, -1, ".menu-item 규칙이 없다");
  assert.ok(item < hide, ".menu-item이 뒤에 와서 .menu-rail-open의 display:none을 덮는다");
});

test("메뉴의 갱신 항목은 레일의 갱신 버튼과 진행 상태를 함께 쓴다", () => {
  // 버튼만 하나 더 두면 한쪽이 "갱신 중…"인 동안 다른 쪽은 눌리는 채로 남는다.
  assert.match(APP, /\$\("#menu-refresh"\)\.onclick = startRefresh/);
  assert.match(read("refresh.js"), /querySelectorAll\("\.empty-refresh, #menu-refresh"\)/, "메뉴 항목도 갱신 중 상태를 따라가야 한다");
});

test("폴링은 초반을 촘촘히 보고 60초를 넘긴 실행만 느슨하게 본다", (t) => {
  const { pollDelay } = require("../public/refresh.js").createRefresh();
  t.mock.method(Date, "now", () => 120000);
  assert.equal(pollDelay({}), 2000);
  assert.equal(pollDelay({ startedAt: new Date(61000).toISOString() }), 2000);
  assert.equal(pollDelay({ startedAt: new Date(60000).toISOString() }), 5000);
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

test("초기 화면에서 AI 업로드·실행은 잠겨 있고 비밀번호는 별도 입력한다", () => {
  assert.match(HTML, /id="ecr-file"[^>]*disabled/);
  assert.match(HTML, /id="ecr-analyze-btn"[^>]*disabled/);
  assert.match(HTML, /id="ai-password"[^>]*type="password"/);
});

test("첨부가 있는 공고에서도 상세 링크가 사라지지 않는다", () => {
  // 예전 모달은 files.length가 0일 때만 대체 목록을 그렸다. 본공고는 첨부가 있는 쪽이
  // 보통이라, 링크를 그 분기 안에 두면 정작 필요한 공고에서 링크가 안 보인다.
  const source = read("notice-modal.js");
  const start = source.indexOf('$("#modal-file-list").innerHTML =');
  assert.ok(start >= 0);
  const assignment = source.slice(start, source.indexOf(";", start));
  assert.match(assignment, /^\$\("#modal-file-list"\)\.innerHTML = detailLink\(row\) \+/, "상세 링크가 첨부 유무 분기 밖에 있지 않다");
  // planLinks도 같은 링크를 그리면 발주계획 모달에 링크가 두 번 나온다.
  const { planLinks } = require("../public/notice-view.js").createNoticeView({ html: String });
  assert.doesNotMatch(planLinks({ detailUrl: "https://example.test/plan" }), /href=/);
});

test("과거 백필 스키마 버전은 메인·검색 워커의 CSV 캐시 키에 함께 붙는다", () => {
  assert.match(read("data-index.js"), /dataSchemaVersion = String\(index\.schemaVersion \|\| ""\)/);
  assert.match(read("search-scan.js"), /worker\.postMessage\(\{[^}]*dataSchemaVersion/);
  assert.match(read("search-scan.js"), /\?v=\$\{encodeURIComponent\(model\.dataSchemaVersion\)\}/);
  assert.match(SEARCH_WORKER, /\?v=\$\{encodeURIComponent\(dataSchemaVersion\)\}/);
});

test("입찰 일정 탭은 본공고에서만 보인다", () => {
  const openModal = read("notice-modal.js");
  assert.match(openModal, /\$\("#schedule-tab"\)\.disabled = row\.mode !== "bid"/);
  const selectTab = read("notice-modal.js");
  assert.match(selectTab, /\$\("#schedule-content"\)\.hidden = tab !== "schedule"/);
});

test("결과 요약이 쓰는 클래스는 style.css에 모두 규칙이 있다", () => {
  // equipment.js는 HTML을 문자열로 짜므로 클래스 이름을 고쳐도 아무 데서도 터지지 않는다.
  // 스타일만 조용히 빠져 테두리 없는 맨 글자가 나온다. 여기서 이름 두 벌을 맞춰 둔다.
  const EQUIPMENT = read("equipment.js");
  const used = new Set([...EQUIPMENT.matchAll(/class="([^"$]+)"/g)].flatMap((match) => match[1].split(" ")).filter(Boolean));
  const missing = [...used].filter((name) => !CSS.includes(`.${name}`));
  assert.deepEqual(missing, [], `style.css에 규칙이 없는 클래스: ${missing.join(", ")}`);
});

test("좁은 화면의 카드 목록 규칙은 결과 표 안에만 건다", () => {
  // `table, tbody, tr, td { display: block }`을 전역으로 걸면 모달의 규격 표까지 블록이 되어
  // 항목과 값이 서로 다른 줄로 흩어지고, td:nth-child 자리 바꾸기가 엉뚱한 칸에 걸린다.
  // 결과 표는 .table-scroll 안에만 있으므로 거기까지만 미친다.
  const start = CSS.indexOf("@media (max-width: 700px)");
  assert.notEqual(start, -1, "좁은 화면 블록이 없다");
  const narrow = CSS.slice(start);
  assert.match(narrow, /\.table-scroll table, \.table-scroll tbody, \.table-scroll tr, \.table-scroll td \{ display: block/);
  assert.match(narrow, /\.table-scroll thead \{ display: none/);
  assert.match(narrow, /\.table-scroll td \{ width: auto !important/);
  for (const stray of [/^\s*table, tbody, tr, td \{/m, /^\s*thead \{ display: none/m, /^\s*td \{ width: auto/m, /^\s*td:nth-child\(/m]) {
    assert.ok(!stray.test(narrow), `좁은 화면 규칙이 결과 표 밖까지 걸린다: ${stray}`);
  }
});

test("360px에서 장비 규격 표는 가로로 넘치지 않고 줄로 눕는다", () => {
  // .nested-spec은 세 열이다. 360px 화면에서 모달 안쪽은 300px 남짓이라 그대로 두면 값이
  // 한두 글자씩 끊긴다. min-width를 풀고 항목 위·값 아래로 눕힌다.
  const tiny = CSS.indexOf("@media (max-width: 560px)");
  assert.notEqual(tiny, -1, "아주 좁은 화면 블록이 없다");
  // 두 블록이 함께 걸리는 폭이라 뒤에 와야 이긴다. 앞에 두면 700px 블록에 그대로 덮인다.
  assert.ok(tiny > CSS.indexOf("@media (max-width: 700px)"), "560px 블록이 700px 블록보다 앞에 있다");
  const rules = CSS.slice(tiny);
  assert.match(rules, /\.equipment-card table \{ min-width: 0/);
  assert.match(rules, /\.equipment-card \.nested-spec[^{]*\{ display: block/);
  assert.match(rules, /\.equipment-card \.nested-spec thead \{ display: none/);
  // 기본규격 표는 첫 칸이 머리글이 아니라 값이라, 눕히면 어느 칸이 무엇이었는지 사라진다.
  // 그쪽은 .ecr-scroll 안에서 옆으로 미는 쪽으로 둔다 — 눕히는 것은 장비 카드 안뿐이다.
  assert.ok(!/^\s*\.nested-spec[^{]*\{ display: block/m.test(rules), "기본규격 표까지 눕히면 칸의 뜻이 사라진다");
});

test("원문 상자는 띄어쓰기 없이 이어진 긴 문장도 상자 안에서 끊는다", () => {
  // 제안요청서 원문에는 공백 없이 이어지는 규격 문자열이 흔하다. white-space: pre-wrap만
  // 두면 그런 줄이 상자를 밀고 나가 360px에서 모달 전체가 가로로 흐른다.
  assert.match(CSS, /\.detail-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere/);
  assert.match(CSS, /\.equipment-card h4 \{[^}]*overflow-wrap: anywhere/);
});
