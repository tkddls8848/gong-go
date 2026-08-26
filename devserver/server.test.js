// 로컬 개발 서버의 정적 서빙 판정. 서버를 띄우지 않고 경로 결정만 확인한다 —
// require.main 가드 덕분에 require해도 포트를 잡지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveStatic, liveTarget, SERVE_ROOTS, TYPES } = require("./server");

const ROOT = path.resolve(__dirname, "..");
const inside = (...parts) => path.join(ROOT, ...parts);

test("여는 곳은 public/과 data/ 둘뿐이다", () => {
  assert.deepEqual(SERVE_ROOTS, [inside("public"), inside("data")]);
});

test("화면이 읽는 경로는 그대로 열린다", () => {
  assert.deepEqual(resolveStatic("/public/app.js"), { file: inside("public", "app.js") });
  assert.deepEqual(resolveStatic("/public/"), { file: inside("public") });
  assert.deepEqual(resolveStatic("/data/index.json"), { file: inside("data", "index.json") });
  assert.deepEqual(resolveStatic("/data/bid/2026/08/11.csv.gz"), { file: inside("data", "bid", "2026", "08", "11.csv.gz") });
  // 한글 파일명처럼 인코딩된 경로도 풀어서 연다.
  assert.deepEqual(resolveStatic("/public/%EA%B7%9C%EA%B2%A9.html"), { file: inside("public", "규격.html") });
});

test("루트는 /public/으로 넘긴다", () => {
  // 서빙 루트를 public/으로 좁혔으니 /를 그냥 열면 아무것도 없다.
  assert.deepEqual(resolveStatic("/"), { redirect: "/public/" });
});

test("허용 디렉터리 밖은 열지 않는다", () => {
  // 저장소 루트가 그대로 열려 있던 때는 이 전부가 GET 한 번에 나왔다.
  const denied = [
    "/.env", "/.git/config", "/package.json", "/collector/sync.config.json", "/wrangler.jsonc",
    "/public/../.env",                 // 상위로 한 칸
    "/public/../../.env",              // 저장소 밖
    "/%2e%2e/.env",                    // 인코딩한 상위 이동
    "/public%2f..%2f.env",
    "/data/../.env",
    "/publicX/app.js",                 // 접두사만 같은 형제 디렉터리
    "/data-backup/index.json",
  ];
  for (const pathname of denied) assert.deepEqual(resolveStatic(pathname), { status: 403 }, pathname);
});

test("역슬래시로도 빠져나갈 수 없다", () => {
  // 문자열 앞부분만 보고 판정하던 방식은 %5C에 뚫린다. Windows에서는 실제 경로 구분자다.
  for (const pathname of ["/public%5C..%5C.env", "/%5C.env", "/public/..%5C.env"]) {
    assert.deepEqual(resolveStatic(pathname), { status: 403 }, pathname);
  }
});

test("깨진 퍼센트 인코딩은 500이 아니라 404다", () => {
  // decodeURIComponent가 던지면 원인이 서버 오류처럼 보인다.
  assert.deepEqual(resolveStatic("/public/%ZZ"), { status: 404 });
  assert.deepEqual(resolveStatic("/%E0%A4%A"), { status: 404 });
});

test("gz는 Content-Encoding이 아니라 gzip 본문으로 나간다", () => {
  // 헤더를 붙이면 브라우저가 먼저 풀어 프런트의 DecompressionStream과 이중 처리로 깨진다.
  assert.equal(TYPES[".gz"], "application/gzip");
  assert.equal(TYPES[".json"], "application/json; charset=utf-8");
});

test("로컬 최신 조회도 배포 Worker와 같은 제한으로 공공 API 주소를 만든다", () => {
  const url = new URL("http://localhost/api/live?mode=pre&businessType=용역&begin=2026-08-16&end=2026-08-17&pageNo=3");
  const target = new URL(liveTarget(url, "decoded+/key"));
  assert.equal(target.pathname, "/1230000/ao/HrcspSsstndrdInfoService/getPublicPrcureThngInfoServcPPSSrch");
  assert.equal(target.searchParams.get("ServiceKey"), "decoded+/key");
  assert.equal(target.searchParams.get("pageNo"), "3");
  assert.equal(target.searchParams.get("inqryBgnDt"), "202608160000");
  assert.throws(() => liveTarget(new URL("http://localhost/api/live?mode=pre&businessType=용역&begin=2026-08-01&end=2026-08-17"), "key"), /연속 2일/);
});
