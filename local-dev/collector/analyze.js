// Claude 2-pass ECR extractor. It is intentionally CLI-only: browser code never receives API keys.
const { ROOT, DATA_DIR, fs, path, loadEnv, mapPool, readJson, writeJson, readGzipText, sleep } = require("./pipeline-utils");
const { ECR_SCHEMA, SCHEMA_VERSION, SYSTEM_PROMPT, passAPrompt, passBPrompt } = require("./spec-schema");
const { verifyExtraction, ecrIds } = require("./verify");

const TEXT_ROOT = path.join(DATA_DIR, "text", "bid");
const ANALYSIS_ROOT = path.join(DATA_DIR, "analysis", "bid");
const STATE_FILE = path.join(DATA_DIR, "analysis-state.json");
const INDEX_FILE = path.join(DATA_DIR, "analysis-index.json");
const PROVIDER = valueFlag("--provider", "ollama");
const MODEL = valueFlag("--model", PROVIDER === "ollama" ? "qwen3.5-hermes-64k:latest" : "claude-opus-4-8");
const OLLAMA_CONTEXT = numberFlag("--ollama-context", 8192);
const MAX_TOKENS = 64000;

loadEnv(path.join(ROOT, ".env"));
main().catch((error) => { console.error(`분석 실패: ${error.message}`); process.exitCode = 1; });

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
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("collector/.env에 ANTHROPIC_API_KEY를 설정하세요.");
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
  const source = compactOllamaSource(documents, prompt);
  // 복잡한 JSON Schema grammar는 일부 Ollama 런타임에서 장문 입력과 함께 모델 연결을 종료시킨다.
  // JSON 모드와 아래 verifyExtraction의 원문·ID 대조를 함께 사용해 로컬 실험을 안정화한다.
  let response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: "10m", format: "json", options: { num_ctx: OLLAMA_CONTEXT }, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `${source}\n\n--- 분석 지시 ---\n${prompt}` }] }) });
  } catch (error) { throw new Error(`Ollama 요청 실패/시간 초과: ${error.message}`); }
  const data = await response.json();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${data.error || JSON.stringify(data)}`);
  return { json: data.message?.content || "", usage: { prompt_eval_count: data.prompt_eval_count, eval_count: data.eval_count, total_duration: data.total_duration }, stopReason: data.done_reason };
}
function compactOllamaSource(documents, prompt) {
  const source = documents.map((document) => `문서: ${document.name}\n\n${document.text}`).join("\n\n---\n\n");
  // 8k 컨텍스트에서도 총괄표와 상세 표를 각각 안정적으로 읽도록 필요한 문단만 보낸다.
  if (prompt.includes("요구사항 총괄표")) return source.slice(0, 6200);
  const ids = [...new Set(prompt.match(/ECR[-–][A-Z0-9-]+/g) || [])];
  if (!ids.length) return source.slice(0, 6200);
  const excerpts = ids.map((id) => {
    const index = source.lastIndexOf(id);
    if (index < 0) return `[${id} 원문을 찾지 못함]`;
    return source.slice(Math.max(0, index - 220), Math.min(source.length, index + 1350));
  });
  return excerpts.join("\n\n---\n\n");
}
function detailedEcrIds(markdown) {
  return [...new Set((String(markdown).match(/ECR-\d{3}(?!\d)/g) || []))];
}
function normalizeOllamaData(raw) {
  const list = raw.요구사항목록 || raw.requirementsList || raw.requirements || [];
  const rawEcr = raw.ecr || raw.ecrDetails || raw.equipmentRequirements || [];
  const requirement = (item) => ({ 구분: item.구분 || item.category || "", ID: item.ID || item.id || item.requirementId || item.reqNo || "", 명칭: item.명칭 || item.title || item.name || "" });
  const ecr = rawEcr.map((item) => ({ id: item.id || item.ID || item.requirementId || item.reqNo || "", 분류: item.분류 || item.category || "", 명칭: item.명칭 || item.title || item.name || "", 정의: item.정의 || item.definition || "", 세부내용_원문: item.세부내용_원문 || item.detailOriginal || item.details || item.detail || "", 기본규격: (item.기본규격 || item.basicSpecs || item.specifications || []).map((spec) => ({ 구분: spec.구분 || spec.category || "", 항목: spec.항목 || spec.item || "", 요구사항: spec.요구사항 || spec.requirement || spec.specification || "", 수량: spec.수량 || spec.quantity || "" })), 파생규격: { cpu: item.파생규격?.cpu || item.derivedSpecs?.cpu || "", ram: item.파생규격?.ram || item.derivedSpecs?.ram || "", gpu: item.파생규격?.gpu || item.derivedSpecs?.gpu || "", disk: item.파생규격?.disk || item.derivedSpecs?.disk || "", nic: item.파생규격?.nic || item.derivedSpecs?.nic || "", 기타: item.파생규격?.기타 || item.derivedSpecs?.other || "" }, 산출물: item.산출물 || item.deliverables || [], 출처: item.출처 || item.source || "", 불확실: item.불확실 || item.uncertainties || [] }));
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
    if (document.kind === "hwpx" && document.markdown) { const text = await readGzipText(path.join(DATA_DIR, document.markdown)); documents.push({ kind: "text", name: document.originalName, text }); markdowns.push(text); sourceFiles.push(document.source); }
    if (document.kind === "pdf") { const source = path.join(DATA_DIR, document.source); documents.push({ kind: "pdf", name: document.originalName, data: await fs.readFile(source) }); sourceFiles.push(document.source); }
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
