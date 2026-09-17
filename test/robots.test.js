// robots.txt와 게이트의 순서 계약.
//
// 이 저장소에서 robots.txt는 "public/에 파일을 두면 끝"이 아니다. src/worker.js의 fetch가
// 모든 경로를 비밀번호 게이트로 먼저 막으므로, 예외를 두지 않으면 크롤러는 robots.txt
// 자리에서도 401 로그인 페이지를 받는다. 그러면 규칙을 읽지 못한 채 돌아가고, 파일을 둔
// 일이 통째로 헛것이 된다. 눈으로는 절대 드러나지 않는 종류의 고장이라 — 사람은 로그인해서
// 보니 늘 멀쩡하다 — 여기서 순서를 붙들어 둔다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const ROBOTS = fs.readFileSync(path.join(root, "public", "robots.txt"), "utf8");
const WORKER = fs.readFileSync(path.join(root, "src", "worker.js"), "utf8");

// 찾지 못한 표식은 -1이 되어 위치 비교를 조용히 통과시킨다. 여기서 끊는다.
const at = (needle) => {
  const index = WORKER.indexOf(needle);
  assert.notEqual(index, -1, `src/worker.js에 ${needle}가 없다`);
  return index;
};

test("robots.txt는 모든 크롤러를 전면 차단한다", () => {
  const groups = ROBOTS.split(/\n(?=User-agent:)/i);
  const wildcard = groups.find((group) => /^User-agent:\s*\*\s*$/im.test(group));
  assert.ok(wildcard, "User-agent: * 그룹이 없다");
  assert.match(wildcard, /^Disallow:\s*\/\s*$/im, "* 그룹이 Disallow: / 가 아니다");
});

test("이름이 적힌 그룹은 하나도 빠짐없이 Disallow: / 를 갖는다", () => {
  // 규약은 "가장 구체적인 그룹 하나만 따른다"이다. 자기 이름이 적힌 그룹을 찾은 크롤러는
  // 맨 위의 * 그룹을 아예 읽지 않으므로, 이름만 적고 Disallow를 빠뜨린 그룹은 막는 것이
  // 아니라 그 크롤러 하나에게만 문을 열어 주는 셈이 된다.
  for (const group of ROBOTS.split(/\n(?=User-agent:)/i).slice(1)) {
    const name = group.match(/^User-agent:\s*(.+?)\s*$/im)[1];
    assert.match(group, /^Disallow:\s*\/\s*$/im, `${name} 그룹에 Disallow: / 가 없다`);
  }
});

test("주요 AI 수집기는 이름으로 적혀 있다", () => {
  // 목록 전체를 검사하지는 않는다 — 크롤러 이름은 계속 늘어나고, 그때마다 테스트를 고치게
  // 하면 목록을 늘리는 쪽이 번거로워진다. 빠지면 곤란한 것들만 붙들어 둔다.
  for (const name of ["GPTBot", "ClaudeBot", "CCBot", "PerplexityBot", "Google-Extended", "Bytespider", "Applebot-Extended", "meta-externalagent"]) {
    assert.match(ROBOTS, new RegExp(`^User-agent:\\s*${name}\\s*$`, "im"), `${name}이 목록에 없다`);
  }
});

test("worker는 게이트보다 먼저 robots.txt를 내보낸다", () => {
  const robots = at("if (url.pathname === ROBOTS_PATH) return env.ASSETS.fetch(request);");
  // isAuthenticated가 게이트다. 이 뒤로 가면 크롤러는 401 로그인 페이지를 받는다.
  assert.ok(robots < at("if (await isAuthenticated(request, password))"), "robots.txt 분기가 게이트 뒤에 있다");
  // GATE_PASSWORD 미설정 시의 500보다도 앞이어야 한다. 시크릿이 빠진 배포에서도
  // "오지 말라"는 말은 나가야 한다.
  assert.ok(robots < at('return new Response("GATE_PASSWORD is not configured"'), "robots.txt 분기가 설정 확인 뒤에 있다");
});

test("ROBOTS_PATH는 실제로 배포되는 파일을 가리킨다", () => {
  const value = WORKER.match(/const ROBOTS_PATH = "([^"]+)";/);
  assert.ok(value, "ROBOTS_PATH 상수가 없다");
  // wrangler.jsonc의 assets.directory가 public/이라 경로는 public/ 아래 이름 그대로다.
  assert.equal(value[1], "/robots.txt");
  assert.ok(fs.existsSync(path.join(root, "public", "robots.txt")), "public/robots.txt가 없다");
});

test("로그인 페이지는 헤더로도 색인하지 말라고 말한다", () => {
  // robots.txt를 읽지 않고 링크를 타고 들어온 크롤러가 실제로 받는 것은 이 401 페이지다.
  assert.match(WORKER, /"X-Robots-Tag":\s*"noindex, nofollow, noarchive"/);
  assert.match(WORKER, /<meta name="robots" content="noindex, nofollow" \/>/);
});
