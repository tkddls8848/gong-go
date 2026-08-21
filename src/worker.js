// 인증 후 정적 자산, R2 데이터, GitHub Actions 갱신 API, 자연어 질의 해석을 제공한다.

// shared/는 CommonJS지만 wrangler(esbuild)가 ESM 진입점에서 import할 수 있게 번들한다.
// nl-filter.js는 Node 내장 모듈을 쓰지 않으므로 Worker 런타임에서 그대로 돈다.
import { ASK_SCHEMA, buildPrompt, kstToday, normalizeAsk, ruleParse } from "../shared/nl-filter.js";

const COOKIE_NAME = "gong_gate";
const LOGIN_PATH = "/__gate/login";
const LOGOUT_PATH = "/__gate/logout";
const DATA_PREFIX = "/data/";
const REFRESH_PATH = "/api/refresh";
const ASK_PATH = "/api/ask";
// JSON schema 모드를 지원하면서 한국어 파싱이 가장 나은 축이다. 실패하면 규칙 파서로 내려간다 —
// 8B를 중간에 두지 않은 이유는 한국어에서 기관명을 뭉개 조용히 틀린 답을 내기 때문이다.
const ASK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// 한국어 조회 질의가 이보다 길 이유가 없다. 길수록 토큰 비용과 프롬프트 주입 표면만 커진다.
const ASK_MAX_CHARS = 200;
const ASK_TIMEOUT_MS = 12000;
const RELAY_PREFIX = "/api/relay/";
// 중계가 열어 주는 경로. 이 목록에 없으면 통과시키지 않는다 — 임의 URL을 받아 주면
// 이 Worker가 그대로 공개 프록시가 된다. 수집기가 쓰는 세 서비스만 적는다.
const RELAY_ALLOW = /^\/1230000\/(ao\/HrcspSsstndrdInfoService|ad\/BidPublicInfoService|ao\/OrderPlanSttusService)\/[A-Za-z]{1,60}$/;
const RELAY_ORIGIN = "https://apis.data.go.kr";
const KEY = /^(index\.json|analysis-index\.json|(pre|bid|plan)\/\d{4}\/\d{2}(\/\d{2})?\.csv\.gz|analysis\/bid\/[^/]{1,160}\.json)$/;
const RECENT_DAYS = 40;
const GITHUB_API = "https://api.github.com/repos/tkddls8848/gong-go";
const WORKFLOW = "collect.yml";
// 운영 브랜치. 크론과 갱신 버튼이 이 ref로 워크플로를 걸고, 상태 조회도 이 브랜치의
// 실행만 본다. 저장소 기본 브랜치와 같아야 한다 — GitHub의 schedule은 기본 브랜치의
// 워크플로만 돌기 때문에, 어긋나면 매시 갱신과 새벽 재수집이 서로 다른 코드로 돈다.
const WORKFLOW_REF = "main";
const DAY_MS = 86400000;
// dispatch 기준 시각을 이만큼 앞으로 당겨 둔다. GitHub의 created 필터는 초 단위라, 요청 직후의
// 시각을 그대로 쓰면 반올림이나 시계 오차로 자기 실행을 걸러 내고 영영 기다리게 된다.
const DISPATCH_MARGIN_MS = 2000;

// 갱신 버튼 남용을 막는 한도. 매시 크론(하루 10회)은 여기 걸리지 않는다 — 버튼만 사람이
// 얼마든지 눌러 나라장터 API의 하루 호출량을 태울 수 있는 자리라 그쪽만 세면 된다.
// 비밀번호가 공유 자격이라 로그인마다 다른 값을 못 받으므로(tokenFor 참고) 세션별로 나눌
// 수 없다 — 대신 시스템 전체를 하나로 세는 쪽이 "하루 한도를 넘기지 않는다"는 목적에 맞다.
const REFRESH_COOLDOWN_MS = 3 * 60 * 1000;
const REFRESH_DAILY_LIMIT = 20;
// R2에 남긴 상태는 KEY 화이트리스트에 들지 않아 /data/로는 절대 안 보인다(serveData 참고).
const REFRESH_LIMIT_KEY = "_meta/refresh-limit.json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 중계는 사람용 비밀번호 게이트와 별개다. 수집기(GitHub Actions)가 쓰는 기계 경로라
    // 자체 토큰으로만 인증하고, 로그인 화면을 돌려주지 않는다.
    if (url.pathname.startsWith(RELAY_PREFIX)) return handleRelay(request, env, url);

    const password = env.GATE_PASSWORD;

    if (!password) return new Response("GATE_PASSWORD is not configured", { status: 500 });

    const secure = url.protocol === "https:";

    if (url.pathname === LOGOUT_PATH) {
      return redirect("/", clearCookie(COOKIE_NAME, secure));
    }

    if (request.method === "POST" && url.pathname === LOGIN_PATH) {
      return handleLogin(request, password, secure);
    }

    if (await isAuthenticated(request, password)) {
      return routeRequest(request, env);
    }

    const dest = safePath(url.pathname + url.search);
    return htmlResponse(loginPageHtml({ redirect: dest }), 401, {
      "Cache-Control": "no-store",
    });
  },

  // 업무 시간대 매시 갱신(wrangler.jsonc의 triggers.crons). 게이트와 무관한 경로다 —
  // 요청이 아니라 런타임이 부른다.
  //
  // scheduledTime은 "예정된 시각"이다. 호출이 조금 밀려도 이 값으로 날짜를 세야 09시 실행이
  // 09시 기준으로 남는다.
  async scheduled(event, env) {
    await dispatchCollect(env, event.scheduledTime);
  },
};

// 매시 크론과 갱신 버튼이 함께 쓰는 범위다. 오늘 하루로 줄이지 않는 이유는, 전날 마지막
// 실행 뒤에 등록된 공고가 어제 날짜로 남아 다음 날 새벽 전면 수집까지 안 들어오기 때문이다
// (.github/workflows/collect.yml).
//
// 35일 전면 재수집은 새벽 크론이 맡는다. 버튼까지 그 범위로 돌리면 사람이 기다리는 자리에서
// 26초로 끝날 일이 111초가 된다 — 버튼을 누르는 목적은 "지금 올라온 것"이다.
function collectRange(nowMs) { return { begin: kstToday(nowMs - DAY_MS), end: kstToday(nowMs) }; }

// 갱신 버튼과 같은 workflow_dispatch를 쓴다. repository_dispatch가 두 경로를 깔끔하게 갈라
// 주지만 Contents 쓰기를 요구하고, 이 토큰에는 Actions 쓰기만 있어 403이 난다. 권한을 넓히는
// 대신 같은 문을 쓴다 — 버튼과 섞이는 문제는 handleRefresh 쪽에서 본다.
async function dispatchCollect(env, scheduledTime) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN 시크릿이 없어 collect를 걸 수 없습니다.");
  const range = collectRange(scheduledTime);
  const response = await dispatchWorkflow(env, range);
  // 반드시 던진다. 삼켜 버리면 Cron Trigger는 성공으로 남고 갱신만 조용히 멈춘다.
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`collect 실행 요청 실패 (${response.status}): ${data.message || "응답 본문 없음"}`);
  }
  console.log(`collect 실행 요청 ${range.begin} ~ ${range.end}`);
}

function dispatchWorkflow(env, range) {
  return github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: WORKFLOW_REF, inputs: range }),
  });
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === REFRESH_PATH) return handleRefresh(request, env, url);
  // 게이트를 통과한 요청만 여기 온다. 인증 앞에 두면 남이 계정 요금을 태울 수 있다.
  if (url.pathname === ASK_PATH) return handleAsk(request, env);
  if (url.pathname.startsWith(DATA_PREFIX)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return serveData(request, env, url.pathname.slice(DATA_PREFIX.length));
  }
  return env.ASSETS.fetch(request);
}

async function handleRefresh(request, env, url) {
  if (!env.GITHUB_TOKEN) return jsonResponse({ message: "GITHUB_TOKEN 시크릿이 설정되지 않았습니다." }, 501);
  if (request.method === "POST") {
    const prior = await readRefreshState(env);
    const limited = refreshLimitError(prior);
    if (limited) return jsonResponse({ message: limited.message }, 429, { "Retry-After": String(limited.retryAfterSec) });

    // 매시 크론과 같은 어제~오늘이다. 예전에는 비워 보내 35일 기본값으로 갔는데, 사람이
    // 기다리는 자리에서 111초를 쓰던 것이 26초로 줄었다. 35일은 새벽 크론이 맡는다.
    const dispatchedAt = new Date(Date.now() - DISPATCH_MARGIN_MS).toISOString();
    const range = collectRange(Date.now());
    const response = await dispatchWorkflow(env, range);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return jsonResponse({ message: data.message || `GitHub Actions 실행 요청 실패 (${response.status})` }, response.status);
    }
    await writeRefreshState(env, nextRefreshState(prior));
    // workflow_dispatch는 204 No Content다 — 실행 id를 주지 않는다. 그래서 시각을 돌려주고
    // 아래 조회가 그 시각 이후에 만들어진 실행만 보게 한다. 이게 없으면 GitHub이 실행을
    // 만들기 전에 도착한 첫 폴링이 직전 실행(크론이나 앞선 버튼)을 집어, 남의 결과를 내
    // 갱신의 결과로 보고한다 — 직전이 실패였으면 멀쩡한 수집 중에 "갱신 실패"가 뜬다.
    return jsonResponse({ running: true, range, dispatchedAt, lastLine: "GitHub Actions 실행을 요청했습니다." }, 202);
  }
  if (request.method !== "GET") return jsonResponse({ message: "GET 또는 POST만 지원합니다." }, 405, { Allow: "GET, POST" });

  const runId = url.searchParams.get("runId");
  const since = url.searchParams.get("since");
  // 실행 id를 알면 그것만 본다. 매시 크론도 같은 workflow_dispatch를 쓰므로 "최신 1건"을
  // 계속 물으면 폴링 도중 대상이 크론 실행으로 갈아탄다.
  const pinned = runId && /^\d+$/.test(runId);
  const scoped = isTimestamp(since);
  const endpoint = pinned
    ? `/actions/runs/${runId}`
    : `/actions/workflows/${WORKFLOW}/runs?branch=${WORKFLOW_REF}&event=workflow_dispatch&per_page=1`
      + (scoped ? `&created=${encodeURIComponent(`>=${since}`)}` : "");
  const response = await github(env, endpoint);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return jsonResponse({ message: data.message || `GitHub Actions 상태 조회 실패 (${response.status})` }, response.status);
  const run = pinned ? data : data.workflow_runs?.[0];
  // since를 준 조회에서 아직 실행이 없는 것은 "실행 없음"이 아니라 "등록 대기"다.
  // 여기서 완료로 답하면 사용자가 방금 건 갱신이 시작도 전에 끝난 것으로 보인다.
  if (!run) return jsonResponse(scoped ? { running: true, waiting: true, lastLine: "실행이 등록되기를 기다리는 중입니다." } : { running: false });
  const running = run.status !== "completed";
  return jsonResponse({
    running,
    runId: run.id,
    runUrl: run.html_url,
    startedAt: run.run_started_at || run.created_at,
    finishedAt: running ? null : run.updated_at,
    error: !running && run.conclusion !== "success" ? `GitHub Actions가 ${run.conclusion || "실패"} 상태로 끝났습니다.` : null,
    lastLine: running ? `GitHub Actions ${run.status}` : `GitHub Actions ${run.conclusion}`,
  });
}

// 오늘(KST) 누적 횟수와 마지막 시각만 R2에 남긴다. env.DATA가 비어 있거나(로컬 테스트) R2가
// 잠깐 응답하지 않으면 막지 않고 열어 둔다 — 이 한도는 정확한 잠금이 아니라 남용을 줄이는
// 안전판이라, 읽기가 실패했다고 정상 사용자의 갱신까지 막을 이유는 없다. 동시에 두 요청이
// 들어오면 마지막에 쓴 값이 이기는 단순한 read-modify-write다. 비밀번호를 공유하는 소수만
// 쓰는 화면이라 그 정도 경합은 실제로 일어나지 않는다.
async function readRefreshState(env) {
  try {
    const object = await env.DATA.get(REFRESH_LIMIT_KEY);
    return object ? await object.json() : null;
  } catch { return null; }
}
async function writeRefreshState(env, state) {
  try { await env.DATA.put(REFRESH_LIMIT_KEY, JSON.stringify(state)); } catch {}
}
// 날짜가 바뀌었으면(KST) 어제 카운트는 버린다 — 하루 한도는 KST 하루 기준이다.
function refreshLimitError(state) {
  const today = kstToday(Date.now());
  const sameDay = state?.date === today;
  const lastAt = sameDay ? Date.parse(state.lastAt || "") : NaN;
  if (!Number.isNaN(lastAt)) {
    const waitMs = REFRESH_COOLDOWN_MS - (Date.now() - lastAt);
    if (waitMs > 0) {
      const retryAfterSec = Math.ceil(waitMs / 1000);
      return { message: `너무 자주 눌렀습니다. ${retryAfterSec}초 뒤에 다시 시도하세요.`, retryAfterSec };
    }
  }
  const count = sameDay ? state.count || 0 : 0;
  if (count >= REFRESH_DAILY_LIMIT) {
    return { message: `오늘 갱신 버튼 사용 한도(${REFRESH_DAILY_LIMIT}회)에 도달했습니다. 자동 갱신은 그대로 진행됩니다.`, retryAfterSec: DAY_MS / 1000 };
  }
  return null;
}
function nextRefreshState(prior) {
  const today = kstToday(Date.now());
  const count = prior?.date === today ? (prior.count || 0) + 1 : 1;
  return { date: today, count, lastAt: new Date(Date.now()).toISOString() };
}

// 자연어 질의를 조회 조건으로만 바꾼다. 공고 본문은 모델에 넣지 않는다 — 데이터는 R2의 gzip
// CSV 수십만 건이라 먹일 수 있는 대상이 아니고, 조회는 브라우저의 워커 스캔이 그대로 맡는다.
//
// 안전성의 핵심: 사용자 질의는 언제나 user 턴에만 들어가고, 모델 출력은 JSON schema로 강제된 뒤
// normalizeAsk가 enum·정규식·달력 유효성으로 한 번 더 거른다. 그래서 질의가 아무리 적대적이어도
// 나올 수 있는 최악은 "이상하지만 구조적으로 유효한 조회 조건"이다. 임의 입력이 그대로 어딘가로
// 흘러가는 경로가 없다 — RELAY_ALLOW와 같은 원칙이다.
async function handleAsk(request, env) {
  if (request.method !== "POST") return jsonResponse({ message: "POST만 지원합니다." }, 405, { Allow: "POST" });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ message: "요청 본문을 읽을 수 없습니다." }, 400); }
  const query = String(body?.q ?? "").replace(/\s+/g, " ").trim();
  if (query.length < 2) return jsonResponse({ message: "찾고 싶은 내용을 한 문장으로 적어 주세요." }, 400);
  if (query.length > ASK_MAX_CHARS) return jsonResponse({ message: `질의는 ${ASK_MAX_CHARS}자까지만 받습니다.` }, 400);

  // 시계는 Worker가 소유한다. 데이터의 날짜가 KST 벽시계라 사용자 PC 시계나 타임존이
  // 틀려도 결과가 흔들리면 안 된다.
  const today = kstToday(Date.now());
  const mode = body?.mode;
  let parsed = null, source = "rule", fallbackNote = "";
  if (env.AI) {
    try { parsed = await askModel(env, query, today); source = ASK_MODEL; }
    catch (error) { fallbackNote = `AI 해석이 실패해 규칙 기반으로 대신 읽었습니다(${error.message}).`; }
  } else {
    fallbackNote = "AI 바인딩(AI)이 없어 규칙 기반으로 읽었습니다.";
  }
  if (!parsed) {
    parsed = ruleParse(query, today);
    // 규칙 파서까지 못 알아들으면 그때만 실패다. 바인딩이 아예 없으면 501, 모델이 죽은 것이면 502.
    if (!parsed) return jsonResponse({ message: `질의를 해석하지 못했습니다. ${fallbackNote}`.trim() }, env.AI ? 502 : 501);
  }
  const result = normalizeAsk(parsed, { today, mode });
  return jsonResponse({ ...result, notes: fallbackNote ? [...result.notes, fallbackNote] : result.notes, source });
}

async function askModel(env, query, today) {
  let timer;
  try {
    const result = await Promise.race([
      env.AI.run(ASK_MODEL, {
        messages: [{ role: "system", content: buildPrompt(today) }, { role: "user", content: query }],
        // 스키마는 schema가 아니라 json_schema 아래다. JSON 모드는 스트리밍을 지원하지 않으므로
        // stream을 켜면 안 된다.
        response_format: { type: "json_schema", json_schema: ASK_SCHEMA },
        temperature: 0,
        max_tokens: 256,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("모델 응답이 너무 느립니다.")), ASK_TIMEOUT_MS); }),
    ]);
    // JSON 모드는 response에 객체를 바로 싣기도 하고 문자열로 싣기도 한다. 한쪽만 처리하면
    // 모델이나 런타임 버전에 따라 간헐적으로 실패한다.
    const value = result?.response;
    return typeof value === "string" ? JSON.parse(value) : value;
  } finally { clearTimeout(timer); }
}

// GitHub 러너(Azure 대역)에서는 apis.data.go.kr로 TCP 연결이 성립하지 않는다. 차단은 국가가
// 아니라 IP 대역 기준이라 Cloudflare 엣지에서는 통과한다 — 미국 LAX colo에서도 155~515ms로
// 응답이 온다. 그래서 수집기의 요청만 이 Worker가 대신 내보낸다.
// (docs/프로젝트-통합-문서.md 2부)
async function handleRelay(request, env, url) {
  if (!env.RELAY_TOKEN) return jsonResponse({ message: "RELAY_TOKEN 시크릿이 설정되지 않았습니다." }, 501);

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // 토큰이 비어 있으면 timingSafeEqual을 태우지 않는다 — 빈 문자열끼리 맞아 떨어지면 안 된다.
  if (!token || !timingSafeEqual(token, env.RELAY_TOKEN)) return jsonResponse({ message: "중계 토큰이 올바르지 않습니다." }, 401);
  if (request.method !== "GET") return jsonResponse({ message: "GET만 지원합니다." }, 405, { Allow: "GET" });

  const target = url.pathname.slice(RELAY_PREFIX.length - 1);
  if (!RELAY_ALLOW.test(target)) return jsonResponse({ message: "허용되지 않은 중계 경로입니다." }, 403);

  let upstream;
  const upstreamStarted = performance.now();
  try {
    upstream = await fetch(`${RELAY_ORIGIN}${target}${url.search}`, { headers: { Accept: request.headers.get("Accept") || "application/json" } });
  } catch (error) {
    // 여기서 실패하면 Cloudflare 쪽에서도 못 나간 것이다. 수집기가 원인을 볼 수 있게 사유를 실어 준다.
    return jsonResponse({ message: `중계 요청이 실패했습니다: ${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ""}` }, 502, {
      "Server-Timing": `upstream;dur=${(performance.now() - upstreamStarted).toFixed(1)}`,
    });
  }
  // 응답 본문은 그대로 흘려보내고 헤더는 새로 만든다. 상류의 쿠키·캐시 지시를 옮기면
  // 서비스키가 실린 URL이 어딘가에 캐시될 수 있다.
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Server-Timing": `upstream;dur=${(performance.now() - upstreamStarted).toFixed(1)}`,
  });
  // 429/503에서 상류가 준 대기 시간은 재시도 폭주를 막는 지시이므로 안전하게 전달한다.
  if (upstream.headers.has("Retry-After")) headers.set("Retry-After", upstream.headers.get("Retry-After"));
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

function github(env, path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "gong-go-worker",
      "X-GitHub-Api-Version": "2026-03-10",
      ...init.headers,
    },
  });
}

// since는 그대로 GitHub 질의에 실리므로 모양을 먼저 고정한다. RELAY_ALLOW와 같은 원칙이다 —
// 임의 입력을 상류로 흘리지 않는다. 우리가 만든 toISOString() 형식만 통과시킨다.
function isTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value); }

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

async function serveData(request, env, encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });

  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
    "Cache-Control": cacheControl(key),
    ETag: object.httpEtag,
  });
  // Content-Encoding은 절대 붙이지 않는다. 프런트가 gzip을 직접 해제하므로 이중 해제가 된다.
  // onlyIf 조건이 맞으면 본문 없는 R2Object가 온다 = 클라이언트 캐시가 최신.
  if (!object.body) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(object.body, { headers });
}

function cacheControl(key) {
  if (key === "index.json" || key === "analysis-index.json") return "private, max-age=60";
  if (/^(pre|bid)\/\d{4}\/\d{2}\.csv\.gz$/.test(key)) {
    return "private, max-age=31536000, immutable";
  }
  const date = key.match(/(\d{4})\/(\d{2})\/(\d{2})\.csv\.gz$/);
  if (!date) return "private, max-age=3600";
  const days = (Date.now() - Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`)) / 86400000;
  return days > RECENT_DAYS ? "private, max-age=31536000, immutable" : "private, max-age=300";
}

async function isAuthenticated(request, password) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[COOKIE_NAME];
  if (token) {
    const expected = await tokenFor(password);
    if (timingSafeEqual(token, expected)) return true;
  }
  return false;
}

async function handleLogin(request, password, secure) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(loginPageHtml({ error: "요청을 읽을 수 없습니다." }), 400, {
      "Cache-Control": "no-store",
    });
  }

  const submitted = String(form.get("password") || "");
  const dest = safePath(String(form.get("redirect") || "/"));
  if (!timingSafeEqual(submitted, password)) {
    return htmlResponse(loginPageHtml({ redirect: dest, error: "비밀번호가 올바르지 않습니다." }), 401, {
      "Cache-Control": "no-store",
    });
  }

  const token = await tokenFor(password);
  return redirect(dest, buildCookie(COOKIE_NAME, token, { secure }));
}

async function tokenFor(password) {
  const data = new TextEncoder().encode("gong-gate:v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ba[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function buildCookie(name, value, { secure }) {
  // Max-Age/Expires 없는 세션 쿠키: 브라우저를 닫으면 만료된다.
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie(name, secure) {
  const attrs = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// 백슬래시도 막는다. "/\evil.com"은 여기서 통과해도 브라우저가 URL 정규화 단계에서
// "//evil.com"으로 바꿔 프로토콜-상대 URL이 되므로, 로그인에 성공한 요청이 외부로 튕긴다.
function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  if (path.startsWith("//") || path.includes("\\")) return "/";
  return path;
}

function redirect(location, setCookie) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

function htmlResponse(html, status, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginPageHtml({ redirect = "/", error = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#151a21" />
<title>접근 확인</title>
<style>
  /* 조회 화면(public/style.css)과 같은 규칙·같은 색을 쓴다. 여기 값이 어긋나면 들어가는
     순간 화면이 번쩍이고 서로 다른 앱을 지나온 것처럼 보인다. Worker가 문자열로 내려주는
     페이지라 style.css를 공유할 수 없어 토큰을 그대로 옮겨 적는다. */
  * { box-sizing: border-box; }
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: #151a21; color: #e7ebf1; font-family: "Pretendard", "Noto Sans KR", system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
  .card { display: flex; flex-direction: column; width: 100%; max-width: 340px; }
  .brand { display: flex; align-items: center; gap: 10px; padding-bottom: 26px; }
  .brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 34px; height: 34px; border-radius: 10px; background: #1b212b; }
  .brand-mark svg { width: 17px; height: 17px; fill: none; stroke: #a5afbd; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .brand-name { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-tag { margin-top: 2px; color: #8a94a2; font-size: 12px; }
  h1 { margin: 0 0 7px; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  p.sub { margin: 0 0 26px; font-size: 13px; line-height: 1.65; color: #8a94a2; }
  label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: #8a94a2; }
  input[type="password"] { width: 100%; height: 44px; padding: 0 13px; font-family: inherit; font-size: 15px;
    border: 1px solid transparent; border-radius: 10px; background: #1b212b; color: #e7ebf1; outline: none; }
  input[type="password"]:focus { border-color: #2c4b7a; background: #1d232d; box-shadow: 0 0 0 3px rgba(72, 128, 224, .22); }
  button { height: 44px; margin-top: 14px; border: 0; border-radius: 10px; background: #3a72d8; color: #fff;
    font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2f62c4; }
  .error input[type="password"] { border-color: #6b3a3d; background: #2b1a1c; }
  .error-text { display: flex; align-items: center; gap: 6px; margin: 9px 0 0; font-size: 12px; color: #ef9a9a; }
  .error-text svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .note { margin: 22px 0 0; font-size: 12px; line-height: 1.6; color: #79828f; }
</style>
</head>
<body>
  <form class="card${error ? " error" : ""}" method="POST" action="${LOGIN_PATH}">
    <div class="brand">
      <span class="brand-mark"><svg viewBox="0 0 20 20"><rect x="4" y="8.8" width="12" height="7.9" rx="2.2"></rect><path d="M7 8.8V6.5a3 3 0 0 1 6 0v2.3"></path><path d="M10 12.1v1.7"></path></svg></span>
      <div>
        <div class="brand-name">나라장터 조회</div>
        <div class="brand-tag">수집한 CSV에서 공고를 찾습니다</div>
      </div>
    </div>
    <h1>접근 확인</h1>
    <p class="sub">이 화면은 비밀번호로 보호되어 있습니다.<br />공유받은 비밀번호를 입력하세요.</p>
    <label for="pw">비밀번호</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required />
    ${error ? `<p class="error-text"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle><path d="M8 5v3.4M8 10.8v.2"></path></svg>${esc(error)}</p>` : ""}
    <input type="hidden" name="redirect" value="${esc(redirect)}" />
    <button type="submit">들어가기</button>
    <p class="note">이 페이지는 검색엔진에 노출되지 않습니다.</p>
  </form>
</body>
</html>`;
}
