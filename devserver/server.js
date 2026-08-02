// 로컬 개발 전용 서버. 저장소 루트를 정적 서빙하면서 갱신 버튼용 수집기 실행 API를 붙인다.
// 배포(Cloudflare Pages)는 정적 서빙만 하므로 /api/refresh는 로컬에서만 존재한다.
const http = require("node:http");
const { spawn } = require("node:child_process");
const { ROOT, DATA_DIR, fs, path, readJson } = require("../shared/pipeline-utils");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8788;
const LOG_LIMIT = 60;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".csv": "text/csv; charset=utf-8", ".gz": "application/gzip",
};

// 진행 중인 수집 작업은 한 번에 하나만 둔다. 브라우저는 이 상태를 폴링해서 진행률을 보여준다.
let job = null;

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname === "/api/refresh") return await handleRefresh(request, response);
    await serveStatic(url.pathname, response);
  } catch (error) {
    send(response, 500, { message: error.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`로컬 서버: http://${HOST}:${PORT}/public/`);
  console.log(`수집기 실행: POST http://${HOST}:${PORT}/api/refresh`);
});

async function handleRefresh(request, response) {
  if (request.method === "GET") return send(response, 200, status());
  if (request.method !== "POST") return send(response, 405, { message: "GET 또는 POST만 지원합니다." });
  if (job?.running) return send(response, 409, { message: "이미 갱신이 진행 중입니다.", ...status() });
  const range = await refreshRange();
  if (!range) return send(response, 400, { message: "data/index.json이 없어 갱신 범위를 정할 수 없습니다. 먼저 npm run collect를 실행하세요." });
  start(range);
  return send(response, 202, status());
}

// 보유 데이터의 마지막 날짜부터 오늘까지만 다시 받는다. 마지막 날짜를 포함시키는 이유는
// 그날 데이터가 수집 시점 이후에 더 등록됐을 수 있기 때문이다.
async function refreshRange() {
  const index = await readJson(path.join(DATA_DIR, "index.json"), null);
  const dates = (index?.files || []).map((file) => file.date).filter(Boolean).sort();
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

async function serveStatic(pathname, response) {
  const target = path.join(ROOT, decodeURIComponent(pathname).replace(/^\/+/, ""));
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(ROOT) && !resolved.startsWith(path.resolve(ROOT) + path.sep)) return send(response, 403, { message: "허용되지 않은 경로입니다." });
  let file = resolved;
  try { if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html"); } catch { return send(response, 404, { message: "찾을 수 없습니다." }); }
  let body;
  try { body = await fs.readFile(file); } catch { return send(response, 404, { message: "찾을 수 없습니다." }); }
  // .csv.gz는 원본 바이트 그대로 보낸다. Content-Encoding을 붙이면 브라우저가 먼저 풀어버려
  // 프런트의 DecompressionStream과 이중 처리로 깨진다(배포계획서 5장과 동일한 제약).
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(body);
}

function send(response, code, value) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
