import { kstToday } from "./kst-date.js";
import { jsonResponse } from "./http.js";

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
// 새로 걸기 전에 훑어 볼 최근 실행 수. 끝나지 않은 실행은 언제나 목록 앞쪽에 있으므로
// 몇 건만 봐도 충분하다.
const RUNNING_LOOKBACK = 5;

// 갱신 버튼 남용을 막는 한도. 매시 크론(하루 10회)은 여기 걸리지 않는다 — 버튼만 사람이
// 얼마든지 눌러 나라장터 API의 하루 호출량을 태울 수 있는 자리라 그쪽만 세면 된다.
// 비밀번호가 공유 자격이라 로그인마다 다른 값을 못 받으므로(tokenFor 참고) 세션별로 나눌
// 수 없다 — 대신 시스템 전체를 하나로 세는 쪽이 "하루 한도를 넘기지 않는다"는 목적에 맞다.
const REFRESH_COOLDOWN_MS = 3 * 60 * 1000;
const REFRESH_DAILY_LIMIT = 20;
// R2에 남긴 상태는 KEY 화이트리스트에 들지 않아 /data/로는 절대 안 보인다(serveData 참고).
const REFRESH_LIMIT_KEY = "_meta/refresh-limit.json";
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
export async function dispatchCollect(env, scheduledTime) {
  if (!env.GITHUB_PAT_TOKEN) throw new Error("GITHUB_PAT_TOKEN 시크릿이 없어 collect를 걸 수 없습니다.");
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

// 아직 끝나지 않은 collect 실행 하나. 없으면 null이다.
//
// event를 가리지 않는다. concurrency group은 이벤트와 무관하게 하나로 묶이므로, 새벽
// schedule 실행(35일 재수집)도 버튼을 그 뒤에 줄 세운다 — 상태 조회(아래)가 event로 거르는
// 것과 다른 이유다. 거기서는 "내가 건 실행"을 집어야 하고, 여기서는 "나를 막을 실행"을 찾는다.
//
// 조회가 실패하면 막지 않고 null로 답해 예전 경로(그냥 dispatch)로 내려간다. 최악이라도
// 지금까지처럼 큐에서 기다릴 뿐이고, 상태 조회 한 번이 실패했다고 갱신 자체를 못 하게 될
// 이유는 없다.
async function runningCollect(env) {
  const response = await github(env, `/actions/workflows/${WORKFLOW}/runs?branch=${WORKFLOW_REF}&per_page=${RUNNING_LOOKBACK}`);
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data.workflow_runs?.find((run) => run.status !== "completed") || null;
}
export async function handleRefresh(request, env, url) {
  if (!env.GITHUB_PAT_TOKEN) return jsonResponse({ message: "GITHUB_PAT_TOKEN 시크릿이 설정되지 않았습니다." }, 501);
  if (request.method === "POST") {
    const prior = await readRefreshState(env);
    const limited = refreshLimitError(prior);
    if (limited) return jsonResponse({ message: limited.message }, 429, { "Retry-After": String(limited.retryAfterSec) });

    // 이미 도는 실행이 있으면 새로 걸지 않고 거기 붙는다. collect.yml의 concurrency가
    // (group: collect, cancel-in-progress: false) 실행을 직렬화하므로, 지금 dispatch해 봐야
    // 앞 실행이 끝날 때까지 러너조차 잡지 못하고 줄을 선다 — 09시 정각 크론과 겹친 버튼이
    // 큐에서만 85초를 썼다(run 32709162111: run created 09:00:11, job created 09:01:36).
    // 매시 크론과 버튼은 어차피 같은 어제~오늘을 받으므로 새 실행을 걸 이유도 없다.
    //
    // 한도·쿨다운보다 뒤에 둔다. 한도를 넘긴 요청은 GitHub에 아무것도 묻지 않는다는 성질을
    // 그대로 지키기 위해서다. 여기 닿은 요청만 실행 하나를 조회한다.
    const running = await runningCollect(env);
    if (running) {
      // 붙는 것은 나라장터 API를 한 번도 더 부르지 않으므로 한도를 세지 않는다(상태를 쓰지 않는다).
      // 범위는 싣지 않는다 — workflow_dispatch의 inputs는 실행 정보로 되돌아오지 않아서,
      // 그 실행이 어느 구간을 받는 중인지 여기서는 알 수 없다. 지어내느니 비운다.
      // 화면은 409를 오류로 보지 않고 여기 실린 runId로 폴링을 이어 간다(public/app.js의 startRefresh).
      return jsonResponse({
        message: "이미 갱신이 진행 중입니다.",
        running: true,
        runId: running.id,
        runUrl: running.html_url,
        startedAt: running.run_started_at || running.created_at,
        lastLine: "이미 돌고 있는 수집에 붙었습니다.",
      }, 409);
    }

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
function github(env, path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_PAT_TOKEN}`,
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
