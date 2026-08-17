// 로컬 개발 전용 서버. 저장소 루트를 정적 서빙하면서 갱신 버튼용 수집기 실행 API를 붙인다.
// 배포본의 같은 API는 Worker가 GitHub Actions를 실행한다.
const http = require("node:http");
const { spawn } = require("node:child_process");
const { ROOT, DATA_DIR, fs, path, readJson } = require("../shared/pipeline-utils");
const { kstToday, normalizeAsk, ruleParse } = require("../shared/nl-filter");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8788;
const LOG_LIMIT = 60;
// 정적 서빙을 여는 디렉터리. 조회 화면은 /public/의 자산과 /data/의 CSV·인덱스만 읽는다.
const SERVE_ROOTS = ["public", "data"].map((name) => path.resolve(ROOT, name));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".csv": "text/csv; charset=utf-8", ".gz": "application/gzip",
};

// 진행 중인 수집 작업은 한 번에 하나만 둔다. 브라우저는 이 상태를 폴링해서 진행률을 보여준다.
let job = null;

if (require.main === module) {
  http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (url.pathname === "/api/refresh") return await handleRefresh(request, response);
      if (url.pathname === "/api/ask") return await handleAsk(request, response);
      await serveStatic(url.pathname, response);
    } catch (error) {
      send(response, 500, { message: error.message });
    }
  }).listen(PORT, HOST, () => {
    console.log(`로컬 서버: http://${HOST}:${PORT}/public/`);
    console.log(`수집기 실행: POST http://${HOST}:${PORT}/api/refresh`);
  });
}

async function handleRefresh(request, response) {
  if (request.method === "GET") return send(response, 200, status());
  if (request.method !== "POST") return send(response, 405, { message: "GET 또는 POST만 지원합니다." });
  if (job?.running) return send(response, 409, { message: "이미 갱신이 진행 중입니다.", ...status() });
  const range = await refreshRange();
  if (!range) return send(response, 400, { message: "data/index.json이 없어 갱신 범위를 정할 수 없습니다. 먼저 npm run collect를 실행하세요." });
  start(range);
  return send(response, 202, status());
}

// 로컬에는 Workers AI 바인딩이 없다. 배포본이 모델 실패 시 쓰는 것과 같은 규칙 파서로만 답한다.
// 화면 통합을 로컬에서 개발할 수 있게 하는 것이 목적이고, 해석 정확도는 배포본이 책임진다.
// 여기에 AI 호출을 붙이지 않는 이유는 로컬 서버에 인증이 없어서다(아무나 계정 요금을 태울 수 있다).
async function handleAsk(request, response) {
  if (request.method !== "POST") return send(response, 405, { message: "POST만 지원합니다." });
  let body;
  try { body = await readJsonBody(request); } catch (error) { return send(response, 400, { message: `요청 본문을 읽을 수 없습니다: ${error.message}` }); }
  const query = String(body?.q ?? "").replace(/\s+/g, " ").trim();
  if (query.length < 2 || query.length > 200) return send(response, 400, { message: "질의 길이가 올바르지 않습니다." });
  const today = kstToday(Date.now());
  const parsed = ruleParse(query, today);
  if (!parsed) return send(response, 501, { message: "로컬 서버는 규칙 기반 해석만 합니다. 이 질의는 배포본에서 시도하세요." });
  const result = normalizeAsk(parsed, { today, mode: body?.mode });
  return send(response, 200, { ...result, notes: [...result.notes, "로컬 서버라 규칙 기반으로 읽었습니다."], source: "rule" });
}

// devserver는 지금까지 요청 본문을 읽은 적이 없다. 4KB를 넘기면 끊는다.
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; if (text.length > 4096) reject(new Error("본문이 너무 큽니다.")); });
    request.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

// 보유 데이터의 마지막 날짜부터 오늘까지만 다시 받는다. 마지막 날짜를 포함시키는 이유는
// 그날 데이터가 수집 시점 이후에 더 등록됐을 수 있기 때문이다.
async function refreshRange() {
  const index = await readJson(path.join(DATA_DIR, "index.json"), null);
  // 인덱스 항목은 구간({begin,end})이다. 월별 봉인 항목이 섞여 있어도 마지막 날짜는 end가 정한다.
  const dates = (index?.files || []).map((file) => file.end || file.date).filter(Boolean).sort();
  if (!dates.length) return null;
  return { begin: dates.at(-1), end: today() };
}

function start(range) {
  const args = ["collector/collector.js", `--begin=${range.begin}`, `--end=${range.end}`, "--no-resume"];
  job = { running: true, range, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null, log: [] };
  const child = spawn(process.execPath, args, { cwd: ROOT });
  child.stdout.on("data", (chunk) => append(chunk));
  child.stderr.on("data", (chunk) => append(chunk));
  child.on("error", (error) => { job.running = false; job.error = error.message; job.finishedAt = new Date().toISOString(); });
  child.on("close", (code) => { job.running = false; job.exitCode = code; job.finishedAt = new Date().toISOString(); if (code !== 0 && !job.error) job.error = `수집기가 종료 코드 ${code}로 끝났습니다.`; });
}

function append(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) job.log.push(line.trim());
  if (job.log.length > LOG_LIMIT) job.log = job.log.slice(-LOG_LIMIT);
}

function status() {
  if (!job) return { running: false, startedAt: null, finishedAt: null, exitCode: null, error: null, range: null, lastLine: "", log: [] };
  return { ...job, lastLine: job.log.at(-1) || "" };
}

// 요청 경로를 서빙할 절대경로로 바꾼다. 디스크는 보지 않으므로 순수 함수다.
// 저장소 루트를 통째로 열면 .env(SERVICE_KEY·R2 자격증명·GATE_PASSWORD·GITHUB_TOKEN·
// ANTHROPIC_API_KEY)와 .git이 함께 노출된다. 127.0.0.1 바인딩이라도 같은 PC의 다른
// 프로세스와 DNS rebinding이 남으므로, 화면이 실제로 읽는 두 디렉터리만 연다.
// 판정은 해석된 절대경로로 한다 — 문자열 앞부분만 보면 %5C(역슬래시)로 빠져나갈 수 있다.
function resolveStatic(pathname) {
  let decoded;
  // 잘못된 퍼센트 인코딩은 500이 아니라 404다. 여기서 던지면 원인이 서버 오류처럼 보인다.
  try { decoded = decodeURIComponent(pathname); } catch { return { status: 404 }; }
  if (decoded === "/") return { redirect: "/public/" };
  const resolved = path.resolve(path.join(ROOT, decoded.replace(/^\/+/, "")));
  if (!SERVE_ROOTS.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))) return { status: 403 };
  return { file: resolved };
}

async function serveStatic(pathname, response) {
  const target = resolveStatic(pathname);
  if (target.redirect) return redirect(response, target.redirect);
  if (target.status === 404) return send(response, 404, { message: "찾을 수 없습니다." });
  if (target.status === 403) return send(response, 403, { message: "허용되지 않은 경로입니다." });
  let file = target.file;
  try { if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html"); } catch { return send(response, 404, { message: "찾을 수 없습니다." }); }
  let body;
  try { body = await fs.readFile(file); } catch { return send(response, 404, { message: "찾을 수 없습니다." }); }
  // .csv.gz는 원본 바이트 그대로 보낸다. Content-Encoding을 붙이면 브라우저가 먼저 풀어버려
  // 프런트의 DecompressionStream과 이중 처리로 깨진다(배포계획서 5장과 동일한 제약).
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function send(response, code, value) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }

module.exports = { resolveStatic, SERVE_ROOTS, TYPES };
