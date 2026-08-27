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
const SEARCH_WORKER = read("search-worker.js");

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
  assert.match(APP, /querySelectorAll\("\.empty-refresh, #menu-refresh"\)/, "메뉴 항목도 갱신 중 상태를 따라가야 한다");
});

test("폴링은 초반을 촘촘히 보고 60초를 넘긴 실행만 느슨하게 본다", () => {
  // 버튼 실행(어제~오늘)은 30초대에 끝난다. 두 상수가 뒤바뀌면 그 구간을 5초 간격으로만 보게
  // 되어 이미 끝난 실행을 최대 5초 늦게 알아챈다 — 눈에 띄지 않고 조용히 느려지는 자리라 박아 둔다.
  const source = APP.match(/function pollDelay\([^)]*\)\s*\{[^}]*\}/)?.[0];
  assert.ok(source, "pollDelay를 찾지 못했다");
  assert.match(source, />=\s*60000\s*\?\s*POLL_SLOW_MS\s*:\s*POLL_FAST_MS/);
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

// app.js는 모듈이 아니라 브라우저 스크립트라 통째로는 불러올 수 없다(맨 위에서 DOM을 만진다).
// 순수 함수만 원문에서 떼어 내 실제로 돌린다 — 문자열 매칭보다 훨씬 많은 것을 잡는다.
function sourceOf(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js에 ${name}가 없다`);
  let depth = 0;
  for (let i = APP.indexOf("{", start); i < APP.length; i += 1) {
    if (APP[i] === "{") depth += 1;
    else if (APP[i] === "}" && (depth -= 1) === 0) return APP.slice(start, i + 1);
  }
  throw new Error(`${name}의 끝을 찾지 못했다`);
}
function evaluate(...names) {
  return new Function(`${names.map(sourceOf).join("\n")}\nreturn { ${names.join(", ")} };`)();
}

test("상세 링크가 있는 공고는 모드와 무관하게 나라장터로 열 수 있다", () => {
  const { detailLink } = evaluate("detailLink", "html");
  const bid = detailLink({ mode: "bid", detailUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R25BK1&bidPbancOrd=000" });
  assert.match(bid, /href="https:\/\/www\.g2b\.go\.kr\/link\/PNPE027_01\/single\/\?bidPbancNo=R25BK1&amp;bidPbancOrd=000"/, "쿼리의 &가 이스케이프되지 않았다");
  assert.match(bid, /rel="noopener noreferrer"/);
  assert.match(bid, /나라장터 공고 상세 열기/);
  assert.match(detailLink({ mode: "plan", detailUrl: "https://example.go.kr/p" }), /나라장터 발주계획 상세 열기/);
  // 사전공고와, 컬럼을 추가하기 전에 모은 본공고에는 링크가 없다.
  assert.equal(detailLink({ mode: "pre" }), "");
  assert.equal(detailLink({ mode: "bid", detailUrl: "" }), "");
});

test("첨부가 있는 공고에서도 상세 링크가 사라지지 않는다", () => {
  // 예전 모달은 files.length가 0일 때만 대체 목록을 그렸다. 본공고는 첨부가 있는 쪽이
  // 보통이라, 링크를 그 분기 안에 두면 정작 필요한 공고에서 링크가 안 보인다.
  const start = APP.indexOf('$("#modal-file-list").innerHTML =');
  const assignment = APP.slice(start, APP.indexOf(";", start));
  assert.match(assignment, /^\$\("#modal-file-list"\)\.innerHTML = detailLink\(row\) \+/, "상세 링크가 첨부 유무 분기 밖에 있지 않다");
  // planLinks도 같은 링크를 그리면 발주계획 모달에 링크가 두 번 나온다.
  const plan = APP.slice(APP.indexOf("function planLinks("));
  assert.ok(!plan.slice(0, plan.indexOf("\n}")).includes("detailUrl"), "planLinks가 상세 링크를 중복해서 그린다");
});

test("본공고 모달은 공공 API의 입찰 진행 일정을 순서대로 표시한다", () => {
  assert.match(HTML, /id="schedule-tab"[^>]*data-tab="schedule"/);
  assert.match(HTML, /id="schedule-content"[^>]*hidden/);
  const { scheduleItems, renderBidSchedule } = evaluate("scheduleItems", "renderBidSchedule", "html");
  const row = {
    closeAt: "2026-09-10 18:00:00",
    bidSchedule: {
      bidNtceDt: "2026-08-27 09:00:00",
      bidBeginDt: "2026-09-08 09:00:00",
      opengDt: "2026-09-11 10:00:00",
    },
  };
  assert.deepEqual(scheduleItems(row), [
    ["공고 게시", "2026-08-27 09:00:00"],
    ["입찰서 제출 시작", "2026-09-08 09:00:00"],
    ["입찰서 제출 마감", "2026-09-10 18:00:00"],
    ["개찰 예정", "2026-09-11 10:00:00"],
  ]);
  const rendered = renderBidSchedule(row);
  assert.match(rendered, /입찰서 제출 시작/);
  assert.match(rendered, /2026-09-11 10:00:00/);
  assert.match(rendered, /실제 개찰 처리 시각이 아니라/);
});

test("과거 백필 스키마 버전은 메인·검색 워커의 CSV 캐시 키에 함께 붙는다", () => {
  assert.match(APP, /dataSchemaVersion = String\(index\.schemaVersion \|\| ""\)/);
  assert.match(APP, /worker\.postMessage\(\{[^}]*dataSchemaVersion/);
  assert.match(APP, /\?v=\$\{encodeURIComponent\(dataSchemaVersion\)\}/);
  assert.match(SEARCH_WORKER, /\?v=\$\{encodeURIComponent\(dataSchemaVersion\)\}/);
});

test("입찰 일정 탭은 본공고에서만 보인다", () => {
  const openModal = sourceOf("openModal");
  assert.match(openModal, /\$\("#schedule-tab"\)\.disabled = row\.mode !== "bid"/);
  const selectTab = sourceOf("selectTab");
  assert.match(selectTab, /\$\("#schedule-content"\)\.hidden = tab !== "schedule"/);
});

test("내려받은 CSV는 머리글과 칸 수가 같다", () => {
  // 열이 하나만 어긋나도 값이 옆 칸으로 밀려 들어가는데, 눈으로는 파일을 열기 전까지 모른다.
  // 바깥에서 끌어다 쓰는 것들을 인자로 가려 끼우고 실제로 돌려 본다.
  let captured = null;
  const build = new Function("filtered", "downloadRows", "MODE_NAMES", "normalizeFiles", "numberOf", `${sourceOf("downloadCsv")}\nreturn downloadCsv;`);
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
