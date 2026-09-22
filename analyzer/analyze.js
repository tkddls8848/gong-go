// Claude 2-pass ECR extractor. It is intentionally CLI-only: browser code never receives API keys.
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { ECR_SCHEMA, SCHEMA_VERSION, SYSTEM_PROMPT, passAPrompt, passBPrompt } = require("./spec-schema");
const { verifyExtraction, ecrIds } = require("./verify");
const { verifyEquipment } = require("./equipment");
const { completeSource } = require("./source");

// 분석기가 쓰는 경로·입출력 헬퍼. 다른 모듈과 공유하지 않는다 — 분석은 파이프라인의 맨 끝이라
// 여기 사정으로 수집·업로드가 멈출 이유가 없다(README 모듈 경계).
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

function loadEnv(file = path.join(ROOT, ".env")) {
  try {
    for (const line of fsSync.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index], index); }
  }));
  return results;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8"); }
// converter가 쓴 Markdown은 gzip이다. 읽기만 하므로 여기에는 쓰기 짝을 두지 않는다.
async function readGzipText(file) { return zlib.gunzipSync(await fs.readFile(file)).toString("utf8"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const TEXT_ROOT = path.join(DATA_DIR, "text", "bid");
const ANALYSIS_ROOT = path.join(DATA_DIR, "analysis", "bid");
const STATE_FILE = path.join(DATA_DIR, "analysis-state.json");
const INDEX_FILE = path.join(DATA_DIR, "analysis-index.json");
const PROVIDER = valueFlag("--provider", "ollama");
const MODEL = valueFlag("--model", PROVIDER === "ollama" ? "qwen3.5-hermes-64k:latest" : "claude-opus-4-8");
const OLLAMA_CONTEXT = numberFlag("--ollama-context", 65536);
const MAX_TOKENS = 64000;

if (require.main === module) {
  loadEnv(path.join(ROOT, ".env"));
  main().catch((error) => { console.error(`분석 실패: ${error.message}`); process.exitCode = 1; });
}

async function main() {
  const limit = numberFlag("--limit", Infinity);
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const manifests = (await directories(TEXT_ROOT)).slice(0, limit);
  const state = await readJson(STATE_FILE, { completed: {}, failed: {} });
  const targets = [];
  for (const notice of manifests) {
    if (!force && state.completed?.[notice]?.schemaVersion === SCHEMA_VERSION) continue;
    const input = await sourceForNotice(notice);
    if (input.documents.length) targets.push({ notice, ...input });
  }
  const estimate = estimateCost(targets);
  const cost = PROVIDER === "ollama" ? "로컬 Ollama · API 비용 없음" : `예상 $${estimate.cost.toFixed(2)}`;
  console.log(`분석 대상 ${targets.length}건 · 입력 약 ${format(estimate.tokens)} tokens · ${cost}${PROVIDER === "ollama" ? ` · context ${format(OLLAMA_CONTEXT)}` : ""}`);
  if (dryRun || !targets.length) return;
  if (!["ollama", "anthropic"].includes(PROVIDER)) throw new Error(`지원하지 않는 provider: ${PROVIDER}`);
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("루트의 .env에 ANTHROPIC_API_KEY를 설정하세요.");
  if (PROVIDER === "anthropic" && !process.argv.includes("--yes")) await confirm();
  const concurrency = numberFlag("--concurrency", 1);
  await mapPool(targets, concurrency, async (target) => {
    try {
      const analysis = await analyzeNotice(target);
      await writeJson(path.join(ANALYSIS_ROOT, `${safeNotice(target.notice)}.json`), analysis);
      state.completed[target.notice] = { schemaVersion: SCHEMA_VERSION, analyzedAt: analysis.analyzedAt, verified: analysis.verified };
      delete state.failed[target.notice];
      console.log(`${target.notice}: ECR ${analysis.ecr.length}, ${analysis.verified ? "검증 통과" : "검증 실패"}`);
    } catch (error) {
      process.exitCode = 1;
      state.failed[target.notice] = { at: new Date().toISOString(), error: error.message };
      console.error(`${target.notice}: ${error.message}`);
    }
    await writeJson(STATE_FILE, state);
  });
  await writeIndex();
}
async function analyzeNotice(target) {
  const usage = [];
  const passA = await requestExtraction(target.documents, passAPrompt(), false);
  usage.push(passA.usage);
  let expected = [...ecrIds(passA.data.요구사항목록)];
  // 소형 로컬 모델은 총괄표의 목록을 일부만 옮기는 경향이 있다. 원문에 실제로
  // 표기된 3자리 상세 ID를 보조 집합으로 사용해 Pass B의 누락 검출을 유지한다.
  const sourceIds = PROVIDER === "ollama" ? detailedEcrIds(target.markdown) : [];
  if (sourceIds.length > expected.length) {
    expected = sourceIds;
    passA.data.요구사항목록 = sourceIds.map((ID) => ({ 구분: "시스템 장비 구성 요구사항", ID, 명칭: "" }));
    passA.data.요구사항수 = sourceIds.length;
  }
  if (!expected.length) throw new Error("Pass A에서 ECR 총괄 ID를 찾지 못했습니다.");
  const chunkSize = PROVIDER === "ollama" ? 2 : 15;
  const chunks = expected.length > chunkSize ? chunkIds(expected, chunkSize) : [expected];
  const ecrById = new Map();
  let last = null;
  for (const ids of chunks) {
    const passB = await requestExtraction(target.documents, passBPrompt(ids), chunks.length > 1);
    usage.push(passB.usage); last = passB.data;
    for (const item of passB.data.ecr || []) if (item?.id) ecrById.set(item.id, item);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const missing = expected.filter((id) => !ecrById.has(id));
    if (!missing.length) break;
    const retry = await requestExtraction(target.documents, passBPrompt(missing), true);
    usage.push(retry.usage); last = retry.data;
    for (const item of retry.data.ecr || []) if (item?.id) ecrById.set(item.id, item);
  }
  const data = { ...passA.data, ecr: expected.map((id) => ecrById.get(id)).filter(Boolean), 누락: expected.filter((id) => !ecrById.has(id)), 기타요구사항: passA.data.기타요구사항 || last?.기타요구사항 || [] };
  const verification = verifyExtraction(data, target.markdown);
  verification.errors.push(...verifyEquipment(data.ecr, target.markdown));
  verification.verified = verification.errors.length === 0;
  data.누락 = [...new Set([...(data.누락 || []), ...verification.missing])];
  return { ...data, verified: verification.verified, verification, provider: PROVIDER, model: MODEL, usage, analyzedAt: new Date().toISOString(), sourceFiles: target.sourceFiles, schemaVersion: SCHEMA_VERSION };
}
async function requestExtraction(documents, prompt, cache) {
  const response = PROVIDER === "ollama" ? await requestOllama(documents, prompt) : await requestAnthropic({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: ECR_SCHEMA } },
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [...documentBlocks(documents, cache), { type: "text", text: prompt }] }],
  });
  const text = response.json || response.text;
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`모델 JSON 파싱 실패: ${String(text).slice(0, 240)}`); }
  if (PROVIDER === "ollama") data = normalizeOllamaData(data);
  if (response.stopReason === "refusal") throw new Error("모델이 요청을 거절했습니다.");
  if (response.stopReason === "max_tokens") throw new Error("max_tokens에 도달했습니다. ID 구간 분할을 확인하세요.");
  return { data, usage: response.usage || {} };
}
async function requestOllama(documents, prompt) {
  if (documents.some((document) => document.kind === "pdf")) throw new Error("Ollama 분석은 PDF 원문 대신 변환된 Markdown이 필요합니다.");
  const instructions = `${SYSTEM_PROMPT}\nJSON 출력 구조: ${JSON.stringify(ECR_SCHEMA)}`;
  const source = completeSource(documents, `${instructions}\n${prompt}`, OLLAMA_CONTEXT);
  // 복잡한 JSON Schema grammar는 일부 Ollama 런타임에서 장문 입력과 함께 모델 연결을 종료시킨다.
  // JSON 모드와 아래 verifyExtraction의 원문·ID 대조를 함께 사용해 로컬 실험을 안정화한다.
  let response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: "10m", format: "json", options: { num_ctx: OLLAMA_CONTEXT, num_predict: 8192 }, messages: [{ role: "system", content: instructions }, { role: "user", content: `${source}\n\n--- 분석 지시 ---\n${prompt}` }] }) });
  } catch (error) { throw new Error(`Ollama 요청 실패/시간 초과: ${error.message}`); }
  const data = await response.json();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${data.error || JSON.stringify(data)}`);
  return { json: data.message?.content || "", usage: { prompt_eval_count: data.prompt_eval_count, eval_count: data.eval_count, total_duration: data.total_duration }, stopReason: data.done_reason === "length" ? "max_tokens" : data.done_reason };
}
// 문서마다 ID 부여 규칙이 다르다. `ECR-001` 도 있고 `ECR-A-001-01` 처럼 갈래와 일련번호를
// 겹쳐 쓰는 것도 있다(2025년 노후 인프라 교체 사업). 그래서 자릿수를 박지 않고 마디로 읽는다.
//
// 마디를 겹쳐 쓰는 문서에서는 `ECR-A-001` 이 상세 요구사항이 아니라 `ECR-A-001-01` 들을
// 묶는 이름으로 한 번만 나온다. 그것까지 기대 목록에 넣으면 본문에 상세가 없어 늘 누락으로
// 잡힌다. 다른 ID의 앞마디인 것은 묶음으로 보고 뺀다 — 남는 것이 잎이다.
function detailedEcrIds(markdown) {
  const found = [...new Set((String(markdown).match(/ECR-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) || []))];
  return found.filter((id) => !found.some((other) => other !== id && other.startsWith(`${id}-`)));
}
function normalizeOllamaData(raw) {
  const list = raw.요구사항목록 || raw.requirementsList || raw.requirements || [];
  const rawEcr = raw.ecr || raw.ecrDetails || raw.equipmentRequirements || [];
  const requirement = (item) => ({ 구분: item.구분 || item.category || "", ID: item.ID || item.id || item.requirementId || item.reqNo || "", 명칭: item.명칭 || item.title || item.name || "" });
  const ecr = rawEcr.map((item) => ({ id: item.id || item.ID || item.requirementId || item.reqNo || "", 분류: item.분류 || item.category || "", 명칭: item.명칭 || item.title || item.name || "", 정의: item.정의 || item.definition || "", 세부내용_원문: item.세부내용_원문 || item.detailOriginal || item.details || item.detail || "", 기본규격: (item.기본규격 || item.basicSpecs || item.specifications || []).map((spec) => ({ 구분: spec.구분 || spec.category || "", 항목: spec.항목 || spec.item || "", 요구사항: spec.요구사항 || spec.requirement || spec.specification || "", 수량: spec.수량 || spec.quantity || "" })), 파생규격: { cpu: item.파생규격?.cpu || item.derivedSpecs?.cpu || "", ram: item.파생규격?.ram || item.derivedSpecs?.ram || "", gpu: item.파생규격?.gpu || item.derivedSpecs?.gpu || "", disk: item.파생규격?.disk || item.derivedSpecs?.disk || "", nic: item.파생규격?.nic || item.derivedSpecs?.nic || "", 기타: item.파생규격?.기타 || item.derivedSpecs?.other || "" }, 산출물: item.산출물 || item.deliverables || [], 출처: item.출처 || item.source || "", 불확실: item.불확실 || item.uncertainties || [] }));
  ecr.forEach((item, index) => { item.장비요약 = rawEcr[index].장비요약; });
  return { 사업개요: raw.사업개요 || raw.businessOverview || { 사업명: "", 수요기관: "", 사업기간: "", 예산: "", 계약방식: "" }, ID부여규칙: raw.ID부여규칙 || raw.requirementIdRule || "", 요구사항수: raw.요구사항수 ?? raw.requirementCount ?? null, 요구사항목록: list.map(requirement), ecr, 누락: raw.누락 || raw.missing || [], 기타요구사항: (raw.기타요구사항 || raw.otherRequirements || []).map(requirement) };
}
function documentBlocks(documents, cache) {
  return documents.map((document) => {
    const block = document.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: document.data.toString("base64") } }
      : { type: "text", text: `문서: ${document.name}\n\n${document.text}` };
    if (cache) block.cache_control = { type: "ephemeral" };
    return block;
  });
}
async function requestAnthropic(payload) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.text();
      if (!response.ok) { const error = new Error(`Anthropic HTTP ${response.status}: ${body.slice(0, 500)}`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
      return parseSse(body);
    } catch (error) { lastError = error; if (!error.retryable || attempt === 3) break; await sleep(800 * 2 ** attempt); }
  }
  throw lastError;
}
function parseSse(body) {
  let json = ""; let text = ""; let usage; let stopReason;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
    if (event.type === "content_block_delta") { json += event.delta?.partial_json || ""; text += event.delta?.text || ""; }
    if (event.type === "message_delta") { stopReason = event.delta?.stop_reason || stopReason; usage = { ...usage, ...event.usage }; }
    if (event.type === "message_start") usage = event.message?.usage || usage;
  }
  return { json, text, usage, stopReason };
}
async function sourceForNotice(notice) {
  const manifest = await readJson(path.join(TEXT_ROOT, notice, "manifest.json"));
  if (!manifest) return { documents: [], markdown: "", sourceFiles: [] };
  const documents = []; const sourceFiles = []; const markdowns = [];
  for (const document of manifest.documents || []) {
    if (document.markdown) { const text = await readGzipText(path.join(DATA_DIR, document.markdown)); documents.push({ kind: "text", name: document.originalName, text }); markdowns.push(text); sourceFiles.push(document.source); }
    else if (document.kind === "pdf") { const source = path.join(DATA_DIR, document.source); documents.push({ kind: "pdf", name: document.originalName, data: await fs.readFile(source) }); sourceFiles.push(document.source); }
  }
  return { documents, markdown: markdowns.join("\n\n"), sourceFiles };
}
async function writeIndex() {
  let files = []; try { files = await fs.readdir(ANALYSIS_ROOT); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const data = await readJson(path.join(ANALYSIS_ROOT, file));
    if (!data) continue;
    entries.push({ notice: file.slice(0, -5), path: `analysis/bid/${file}`, ecrCount: (data.ecr || []).length, verified: !!data.verified, analyzedAt: data.analyzedAt, schemaVersion: data.schemaVersion });
  }
  await writeJson(INDEX_FILE, { updatedAt: new Date().toISOString(), entries: entries.sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt)) });
}
function estimateCost(targets) { const chars = targets.reduce((sum, target) => sum + target.documents.reduce((inner, document) => inner + (document.text?.length || Math.ceil(document.data?.length / 2)), 0), 0); const tokens = Math.ceil(chars / 1.2); return { tokens, cost: tokens / 1000000 * 5 + targets.length * 0.08 }; }
async function confirm() { if (!process.stdin.isTTY) throw new Error("비대화형 실행에서는 비용 확인을 위해 --yes가 필요합니다."); await new Promise((resolve, reject) => { process.stdout.write("예상 비용을 승인하려면 yes를 입력하세요: "); process.stdin.once("data", (input) => String(input).trim().toLowerCase() === "yes" ? resolve() : reject(new Error("사용자가 취소했습니다."))); }); }
async function directories(root) { try { return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
function chunkIds(ids, size) { return Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => ids.slice(index * size, (index + 1) * size)); }
function safeNotice(value) { return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"); }
function numberFlag(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 ? Math.max(1, Number(process.argv[index + 1]) || 1) : fallback; }
function valueFlag(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; }
function format(value) { return new Intl.NumberFormat("ko-KR").format(value); }
module.exports = { analyzeNotice };
