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

test("app.js가 id로 찾는 요소는 index.html에 모두 있다", () => {
  const missing = SCRIPTS.flatMap(({ name, source }) => [...lookupsIn(source)]
    .filter((id) => !idsIn(HTML).has(id)).map((id) => name + ": " + id));
  assert.deepEqual(missing, [], `index.html에 없는 id: ${missing.join(", ")}`);
});

test("조회 줄에는 매번 바꾸는 것만 남기고 나머지는 ☰ 메뉴에 넣는다", () => {
  // 조회 줄이 버튼으로 붐비면 게시일 칸이 먼저 눌려 "오늘"이 두 줄로 접힌다. 자주 쓰지 않는
  // 동작은 메뉴로 내리고, 줄에는 검색어·업무·게시일과 검색 버튼만 남긴다.
  const panel = HTML.slice(at('id="menu-panel"'), at('class="filter-q"'));
  for (const id of ["rail-open", "advanced-toggle", "reset", "download-btn", "menu-refresh"]) {
    assert.ok(panel.includes(`id="${id}"`), `${id}는 메뉴 안에 있어야 한다`);
  }
  // ECR 결과는 서버에 저장하지 않으므로 목록 전체 내보내기가 없다. 분석한 모달에서만 내려받는다.
  assert.ok(!panel.includes('id="download-ecr-btn"'), "ECR 내보내기는 메뉴에 두지 않는다");
  const upload = HTML.slice(at('id="ecr-upload-form"'), at('id="ecr-content"'));
  assert.ok(upload.includes('id="download-ecr-btn"'), "ECR 내보내기는 분석 모달에 있어야 한다");
  assert.ok(upload.includes('id="download-ecr-devices-btn"') && !panel.includes('id="download-ecr-devices-btn"'), "장비별 규격표도 분석 모달에서만 내려받는다");
  // 검색은 메뉴로 내리지 않는다. 조회 줄의 유일한 주 동작이다.
  assert.ok(!panel.includes('id="search"'), "검색 버튼은 조회 줄에 남아야 한다");
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

test("초기 화면에서 AI 업로드·실행은 잠겨 있고 비밀번호는 별도 입력한다", () => {
  assert.match(HTML, /id="ecr-file"[^>]*disabled/);
  assert.match(HTML, /id="ecr-analyze-btn"[^>]*disabled/);
  assert.match(HTML, /id="ai-password"[^>]*type="password"/);
});

test("과거 백필 스키마 버전은 메인·검색 워커의 CSV 캐시 키에 함께 붙는다", () => {
  assert.match(read("data-index.js"), /dataSchemaVersion = String\(index\.schemaVersion \|\| ""\)/);
  assert.match(read("search-scan.js"), /worker\.postMessage\(\{[^}]*dataSchemaVersion/);
  assert.match(read("search-scan.js"), /\?v=\$\{encodeURIComponent\(model\.dataSchemaVersion\)\}/);
  assert.match(SEARCH_WORKER, /\?v=\$\{encodeURIComponent\(dataSchemaVersion\)\}/);
});

test("결과 요약이 쓰는 클래스는 style.css에 모두 규칙이 있다", () => {
  // equipment.js는 HTML을 문자열로 짜므로 클래스 이름을 고쳐도 아무 데서도 터지지 않는다.
  // 스타일만 조용히 빠져 테두리 없는 맨 글자가 나온다. 여기서 이름 두 벌을 맞춰 둔다.
  const EQUIPMENT = read("equipment.js");
  const used = new Set([...EQUIPMENT.matchAll(/class="([^"$]+)"/g)].flatMap((match) => match[1].split(" ")).filter(Boolean));
  const missing = [...used].filter((name) => !CSS.includes(`.${name}`));
  assert.deepEqual(missing, [], `style.css에 규칙이 없는 클래스: ${missing.join(", ")}`);
});

