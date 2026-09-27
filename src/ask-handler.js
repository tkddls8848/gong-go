import { ASK_SCHEMA, buildPrompt, kstToday, normalizeAsk, ruleParse } from "./ask.js";
import { runBudgeted } from "./ai-budget.js";
import { hasAiAccess } from "./ai-access.js";
import { jsonResponse } from "./http.js";

// JSON schema 모드를 지원하면서 한국어 파싱이 가장 나은 축이다. 실패하면 규칙 파서로 내려간다 —
// 8B를 중간에 두지 않은 이유는 한국어에서 기관명을 뭉개 조용히 틀린 답을 내기 때문이다.
const ASK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// 한국어 조회 질의가 이보다 길 이유가 없다. 길수록 토큰 비용과 프롬프트 주입 표면만 커진다.
const ASK_MAX_CHARS = 200;
const ASK_TIMEOUT_MS = 12000;
// 자연어 질의를 조회 조건으로만 바꾼다. 공고 본문은 모델에 넣지 않는다 — 데이터는 R2의 gzip
// CSV 수십만 건이라 먹일 수 있는 대상이 아니고, 조회는 브라우저의 워커 스캔이 그대로 맡는다.
//
// 안전성의 핵심: 사용자 질의는 언제나 user 턴에만 들어가고, 모델 출력은 JSON schema로 강제된 뒤
// normalizeAsk가 enum·정규식·달력 유효성으로 한 번 더 거른다. 그래서 질의가 아무리 적대적이어도
// 나올 수 있는 최악은 "이상하지만 구조적으로 유효한 조회 조건"이다. 임의 입력이 그대로 어딘가로
// 흘러가는 경로가 없다 — RELAY_ALLOW와 같은 원칙이다.
export async function handleAsk(request, env) {
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
  if (env.AI && await hasAiAccess(request, env)) {
    try { parsed = await askModel(env, query, today); source = ASK_MODEL; }
    catch (error) { fallbackNote = `AI 해석이 실패해 규칙 기반으로 대신 읽었습니다(${error.message}).`; }
  } else {
    fallbackNote = env.AI ? "AI 분석이 잠겨 있어 규칙 기반으로 읽었습니다. ECR 분석에서 잠금을 해제할 수 있습니다." : "AI 바인딩(AI)이 없어 규칙 기반으로 읽었습니다.";
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
      runBudgeted(env, ASK_MODEL, {
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
