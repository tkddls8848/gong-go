// 배포본은 Worker가 R2를 중계하고, 로컬은 devserver가 저장소의 data/를 제공한다.
const $ = (s) => document.querySelector(s), DATA_BASE = "/data", REFRESH_API = "/api/refresh", POLL_MS = 5000, MAX_ROWS = 200000;
// CSV 스캔은 search-worker.js가 맡는다. 여기서는 워커를 몇 개 띄우고 각자 몇 개씩
// 동시에 받게 할지만 정한다(둘을 곱한 값이 예전 LOAD_CONCURRENCY 자리다).
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)), FETCH_CONCURRENCY = 12;
// 결과가 쌓이는 동안에도 첫 페이지를 미리 그린다. 다만 건수가 커지면 미리보기마다
// 정렬 비용이 붙으므로 이 한도를 넘으면 진행률만 갱신한다.
const PREVIEW_LIMIT = 30000, PREVIEW_MS = 700;
const Rows = self.GongRows;
let pageSize = 50;
// main 브랜치와 동일한 기본 관심 기관 목록. 코드를 비우면 기관명 정확 일치로 조회한다.
const DEFAULT_INSTITUTIONS = [
  { name: "국민건강보험공단", code: "" }, { name: "건강보험심사평가원", code: "" }, { name: "국민건강보험공단 일산병원", code: "" },
  { name: "보건복지부", code: "" }, { name: "한국사회보장정보원", code: "" }, { name: "국민연금공단", code: "" },
  { name: "한국고용정보원", code: "" }, { name: "재단법인자동차손해배상진흥원", code: "" }, { name: "공영홈쇼핑", code: "" },
];
const norm = Rows.norm;
// 관심 기관은 브라우저 localStorage에 보관한다. 정적 배포라 서버에 사용자별 저장소가 없다.
const INST_STORAGE_KEY = "gong-go:institutions";
let institutionList = loadInstitutions(), searchTimer = null, refreshRunId = null;
function loadInstitutions() {
  try { const saved = JSON.parse(localStorage.getItem(INST_STORAGE_KEY)); if (Array.isArray(saved)) return saved.map((inst) => ({ name: String(inst?.name || ""), code: String(inst?.code || "") })).filter((inst) => inst.name || inst.code); } catch {}
  return DEFAULT_INSTITUTIONS.map((inst) => ({ ...inst }));
}
function saveInstitutions() { try { localStorage.setItem(INST_STORAGE_KEY, JSON.stringify(institutionList)); } catch {} }
let filtered = [], fileIndex = [], page = 1, searchVersion = 0, currentRow = null, currentAnalysis = null, viewMode = "pre";
const analyses = new Map(), modal = $("#file-modal");
const MODE_SUBTITLES = {
  pre: "로컬 CSV에 저장한 사전공고를 조회합니다.",
  bid: "로컬 CSV에 저장한 본공고를 조회합니다.",
  // 발주계획 API는 구간 조회가 없다. 매 수집이 "지금 게시된 계획"만 떠 오므로 보유 범위는
  // 수집을 시작한 시점부터 쌓인다(collector.js의 snapshot 주석).
  plan: "수집 시점부터 쌓아 온 발주계획을 조회합니다. 게시일은 나라장터에 계획이 올라온 날입니다.",
};
const MODE_NAMES = { pre: "사전공고", bid: "본공고", plan: "발주계획" };

if (location.protocol === "file:") { $("#status").textContent = "CSV 조회는 웹 서버에서만 가능합니다. 저장소 루트에서 npm run serve 실행 후 http://localhost:8788/public/ 를 여세요."; renderRows([]); }
else { loadIndex(true).then(applyFilters).catch((error) => { $("#status").textContent = error.message; renderRows([]); }); resumeRefresh(); }

// index.json은 갱신 직후에도 최신이어야 하므로 매번 캐시를 우회한다. 파일 1개라 호출량에
// 영향이 없다. 반대로 .csv.gz에는 캐시 무효화 토큰을 붙이지 않는다 — 쿼리스트링은 브라우저
// 캐시 키의 일부라, 수집이 끝날 때마다 모든 파일 URL이 새 URL이 되어 캐시가 통째로 날아간다.
// 과거 파일이 굳지 않게 하는 일은 서버가 ETag와 날짜별 Cache-Control로 이미 하고 있다
// (배포본은 functions/data/[[path]].js, 로컬은 devserver가 no-store).
async function loadIndex(initial) {
  const [index, analysis] = await Promise.all([getJson(`${DATA_BASE}/index.json?t=${Date.now()}`), getJson(`${DATA_BASE}/analysis-index.json`).catch(() => ({ entries: [] }))]);
  fileIndex = index.files || [];
  analyses.clear(); (analysis.entries || []).forEach((entry) => analyses.set(entry.notice, entry));
  renderDataStatus(index);
  if (initial) { defaultRange(); $("#status").textContent = `${fileIndex.length}개 CSV를 찾았습니다.`; }
  return index;
}
function renderDataStatus(index) { const { begin, end } = dataRange(), total = totalCount(); $("#data-range").textContent = end ? `${begin} ~ ${end}` : "없음"; $("#data-count").textContent = end ? `· ${format(fileIndex.length)}개 파일 · ${format(total)}건` : ""; $("#last-crawl").textContent = `마지막 크롤링 ${stamp(index?.updatedAt)}`; $("#updated-at").textContent = `updated ${stamp(index?.updatedAt)}`; }
// 항목이 구간이 된 뒤로 "며칠치"는 인덱스만으로 셀 수 없다(월별 봉인 항목 하나가 한 달을
// 덮는다). 보유 범위는 begin의 최소·end의 최대로 낸다.
function dataRange() { const begins = fileIndex.map((file) => file.begin).filter(Boolean).sort(), ends = fileIndex.map((file) => file.end).filter(Boolean).sort(); return { begin: begins[0] || "", end: ends.at(-1) || "" }; }
function totalCount() { return fileIndex.reduce((sum, file) => sum + (Number(file.count) || 0), 0); }
function stamp(value) { const date = new Date(value), pad = (part) => String(part).padStart(2, "0"); return value && !Number.isNaN(date.valueOf()) ? `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : "-"; }

$("#search").onclick = () => { page = 1; applyFilters(); }; $("#reset").onclick = () => { ["#q", "#business-type"].forEach((s) => { $(s).value = ""; }); defaultRange(); page = 1; applyFilters(); }; $("#q").onkeydown = (event) => { if (event.key === "Enter") { page = 1; applyFilters(); } };
// 사전공고/본공고는 조회 조건이 아니라 상단 토글로 전환한다(main 브랜치와 동일). 초기화 버튼은 건드리지 않는다.
$("#mode-toggle").onclick = (event) => { const button = event.target.closest(".mode-toggle-btn"); if (button && button.dataset.mode !== viewMode) applyMode(button.dataset.mode); };
function applyMode(key) { viewMode = key; document.querySelectorAll(".mode-toggle-btn").forEach((button) => { const active = button.dataset.mode === key; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }); $("#app-subtitle").textContent = MODE_SUBTITLES[key]; $("#close-col").textContent = key === "plan" ? "발주예정" : "마감일"; closeModal(); page = 1; applyFilters(); }
$("#previous").onclick = () => { if (page > 1) { page -= 1; renderRows(filtered); } }; $("#next").onclick = () => { if (page * pageSize < filtered.length) { page += 1; renderRows(filtered); } }; $("#download-btn").onclick = downloadCsv; $("#download-ecr-btn").onclick = downloadEcr;
$("#refresh-btn").onclick = startRefresh;
$("#page-size").onchange = () => { pageSize = Number($("#page-size").value) || 50; page = 1; renderRows(filtered); };
$("#add-row-btn").onclick = addInstitution;
$("#clear-inst-btn").onclick = () => { institutionList = []; renderInstitutions(); scheduleSearch(); };
// 등록된 관심 기관들을 현재 게시일 조건으로 즉시 조회한다(디바운스 없이 바로).
$("#inst-search-btn").onclick = () => { addInstitution(); clearTimeout(searchTimer); page = 1; applyFilters(); };
["#inst-name", "#inst-code"].forEach((selector) => $(selector).onkeydown = (event) => { if (event.key === "Enter") addInstitution(); });
renderInstitutions();

// 관심 기관은 칩으로 관리한다. 행 테이블은 세로로만 길어져 가로 공간이 남았다.
function renderInstitutions() {
  saveInstitutions();
  const box = $("#inst-chips");
  box.innerHTML = institutionList.length
    ? institutionList.map((inst, i) => `<span class="chip" data-index="${i}"><button class="chip-edit" type="button" title="클릭하면 입력창으로 되돌려 수정합니다">${html(inst.name || "(이름 없음)")}${inst.code ? ` <span class="chip-code">(${html(inst.code)})</span>` : ""}</button><button class="chip-remove" type="button" aria-label="삭제">&times;</button></span>`).join("")
    : '<span class="chip-empty">등록된 기관이 없습니다 — 전체 기관을 조회합니다.</span>';
  box.querySelectorAll(".chip-remove").forEach((button) => button.onclick = () => { institutionList.splice(Number(button.parentElement.dataset.index), 1); renderInstitutions(); scheduleSearch(); });
  box.querySelectorAll(".chip-edit").forEach((button) => button.onclick = () => { const [inst] = institutionList.splice(Number(button.parentElement.dataset.index), 1); $("#inst-name").value = inst.name; $("#inst-code").value = inst.code; renderInstitutions(); $("#inst-name").focus(); scheduleSearch(); });
  $("#inst-count").textContent = institutionList.length ? `${institutionList.length}곳 선택` : "전체 기관";
}
function addInstitution() {
  const name = $("#inst-name").value.trim(), code = $("#inst-code").value.trim();
  if (!name && !code) return;
  if (!institutionList.some((inst) => norm(inst.name) === norm(name) && inst.code === code)) institutionList.push({ name, code });
  $("#inst-name").value = ""; $("#inst-code").value = ""; $("#inst-name").focus();
  renderInstitutions(); scheduleSearch();
}
// 칩을 여러 개 연속으로 넣을 때 매번 전체 재조회가 돌지 않도록 묶는다.
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; applyFilters(); }, 400); }
// 사전공고 CSV에는 기관 코드 컬럼이 없다. 코드만 지정된 행은 본공고에서만 매칭된다.
// 실제 판정은 rows.js의 makeCriteria/accepts가 한다.
function collectInstitutions() { return institutionList.filter((inst) => inst.name || inst.code); }
$("#modal-close").onclick = closeModal; modal.onclick = (event) => { if (event.target === modal) closeModal(); }; document.onkeydown = (event) => { if (event.key === "Escape") closeModal(); }; $("#download-all-btn").onclick = downloadAll;
document.querySelectorAll(".modal-tab").forEach((button) => button.onclick = () => selectTab(button.dataset.tab));

// 보유 데이터가 수천 개 파일로 늘어난 뒤로는 전체를 한꺼번에 fetch할 수 없다.
// (1) 동시 요청을 묶고 (2) 파일을 읽는 즉시 필터링해 일치 행만 남긴다.
// 전부 메모리에 올린 뒤 거르면 수백만 행에서 브라우저가 죽는다.
//
// 그 일을 메인 스레드에서 하면 1년 조회 동안 화면이 통째로 멈춘다. 그래서 내려받기부터
// 조건 검사까지는 search-worker.js가 맡고, 여기서는 조건을 만들어 넘기고 결과만 그린다.
function modeOf(file) { return file.mode || String(file.path || "").split("/")[0]; }
function byPublishedDesc(a, b) { return String(b.publishedAt).localeCompare(String(a.publishedAt)); }

async function applyFilters() {
  const version = ++searchVersion;
  abortScan();
  const mode = viewMode;
  const begin = $("#begin").value || "0000-01-01", end = $("#end").value || "9999-12-31";
  // 지금 보고 있는 모드의 파일만 받는다. 예전에는 날짜만 보고 골라 사전공고·본공고·발주계획을
  // 모두 내려받아 gzip을 풀고 파싱한 뒤 버렸다 — 한 모드를 보는데 세 모드를 읽은 셈이다.
  // 항목의 구간과 조회 구간이 겹치면 받는다. 월별 봉인 항목은 한 달을 통째로 끌어오지만,
  // 워커가 행 단위로 다시 거르므로 결과는 정확하다 — 오버페치는 전송량 문제일 뿐이다.
  const files = fileIndex.filter((file) => modeOf(file) === mode && file.end >= begin && file.begin <= end);
  const institutions = collectInstitutions();
  const criteria = { q: $("#q").value.trim().toLowerCase(), type: $("#business-type").value, institutions, from: begin.replaceAll("-", ""), to: end.replaceAll("-", "") };

  const progress = (state) => { $("#status").textContent = `${format(files.length)}개 CSV 중 ${format(state.done)}개 처리 · ${format(state.rows.length)}건 일치`; };
  let painted = 0;
  const onProgress = (state) => {
    progress(state);
    if (state.rows.length > PREVIEW_LIMIT || Date.now() - painted < PREVIEW_MS) return;
    painted = Date.now();
    filtered = state.rows.slice().sort(byPublishedDesc);
    renderRows(filtered);
  };

  progress({ done: 0, rows: [] });
  const state = await scanFiles(files, criteria, { begin, end }, version, onProgress);
  if (version !== searchVersion) return;

  filtered = state.rows.sort(byPublishedDesc);
  const parts = [`${format(files.length)}개 CSV에서 ${format(state.scanned)}건을 읽어 ${format(filtered.length)}건이 조건에 맞습니다.`];
  parts.push(institutions.length ? `관심 기관 ${institutions.length}곳으로 좁혔습니다.` : "기관 목록이 비어 있어 전체 기관을 조회했습니다.");
  if (state.capped) parts.push(`표시 한도 ${format(MAX_ROWS)}건에 도달해 나머지 파일은 읽지 않았습니다. 기간을 좁히거나 관심 기관을 지정하세요.`);
  if (state.failures) parts.push(`${format(state.failures)}개 파일을 읽지 못했습니다.`);
  $("#status").textContent = parts.join(" ");
  renderRows(filtered);
}

// 워커는 처음 검색할 때 만들어 두고 계속 쓴다. 만들지 못하는 환경에서는 빈 배열이 되고
// scanFiles가 메인 스레드 경로로 되돌아간다 — 느리지만 결과는 같다.
let workerPool = null, abortScan = () => {};
function pool() {
  if (workerPool) return workerPool;
  try { const url = new URL("search-worker.js", location.href); workerPool = Array.from({ length: POOL_SIZE }, () => new Worker(url)); }
  catch { workerPool = []; }
  return workerPool;
}

function scanFiles(files, criteria, span, version, onProgress) {
  const workers = pool();
  if (!workers.length) return scanInline(files, criteria, span, version, onProgress);
  const state = { rows: [], done: 0, scanned: 0, failures: 0, capped: false };
  const share = Math.max(1, Math.ceil(FETCH_CONCURRENCY / workers.length));
  return new Promise((resolve) => {
    let pending = 0;
    const detach = () => { for (const worker of workers) { worker.onmessage = null; worker.onerror = null; } abortScan = () => {}; };
    const finish = () => { detach(); resolve(state); };
    abortScan = () => { for (const worker of workers) worker.postMessage({ type: "cancel", version }); finish(); };
    // 워커 스크립트를 못 읽으면(구 배포본에 search-worker.js가 없는 경우 등) 아무 메시지도
    // 오지 않아 화면이 "0개 처리"에서 멈춘다. 그때는 풀을 버리고 메인 스레드로 되돌아간다.
    const fallback = () => { detach(); for (const worker of workers) worker.terminate(); workerPool = []; resolve(scanInline(files, criteria, span, version, onProgress)); };
    workers.forEach((worker, slot) => {
      // 날짜순 목록을 그대로 잘라 주면 한쪽 워커에만 큰 파일이 몰린다. 번갈아 나눠 준다.
      const mine = files.filter((_, index) => index % workers.length === slot);
      if (!mine.length) return;
      pending += 1;
      worker.onerror = fallback;
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.version !== version) return;
        if (message.type === "done") { pending -= 1; if (!pending) finish(); return; }
        state.done += message.done; state.scanned += message.scanned; state.failures += message.failures;
        for (const row of message.rows) state.rows.push(row);
        if (state.rows.length >= MAX_ROWS) { state.capped = true; onProgress(state); abortScan(); return; }
        onProgress(state);
      };
      worker.postMessage({ type: "search", version, base: DATA_BASE, files: mine, criteria, span, concurrency: share });
    });
    if (!pending) finish();
  });
}

// 워커를 못 쓰는 환경의 폴백. 예전 경로와 같지만 파싱·조건 검사는 rows.js를 쓴다.
async function scanInline(files, criteria, span, version, onProgress) {
  const parsed = Rows.makeCriteria(criteria);
  const state = { rows: [], done: 0, scanned: 0, failures: 0, capped: false };
  let cursor = 0;
  const scan = async () => {
    while (cursor < files.length && !state.capped) {
      if (version !== searchVersion) return;
      const file = files[cursor++];
      try {
        const text = await Rows.fetchCsvText(`${DATA_BASE}/${file.path}`);
        const result = Rows.scanText(text, modeOf(file), parsed, !(file.begin >= span.begin && file.end <= span.end));
        state.scanned += result.scanned;
        for (const row of result.matched) state.rows.push(row);
      } catch { state.failures += 1; }
      state.done += 1;
      if (state.rows.length >= MAX_ROWS) state.capped = true;
      if (state.done % 16 === 0) { onProgress(state); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length || 1) }, scan));
  return state;
}
function defaultRange() { const last = dataRange().end; if (!last) return; const end = new Date(`${last}T00:00:00`), begin = new Date(end); begin.setDate(begin.getDate() - 6); $("#begin").value = localDate(begin); $("#end").value = last; }

// 로컬은 수집기를 직접 실행하고, 배포본은 Worker가 GitHub Actions 수집 작업을 시작한다.
async function startRefresh() {
  setRefresh(true, "갱신을 시작하는 중입니다.");
  try {
    const response = await fetch(REFRESH_API, { method: "POST" }), state = await response.json().catch(() => ({}));
    // 404는 두 가지다 — Worker에 /api/refresh가 없거나(구 배포본), Worker가 GitHub이 준 404를
    // 그대로 전달한 것(워크플로 미등록·저장소 접근 실패). 뒤쪽은 message가 실려 오므로 그것을
    // 먼저 보여준다. 404를 무조건 "API 없음"으로 덮으면 진짜 원인이 가려진다.
    if (!response.ok && response.status !== 409) {
      throw new Error(state.message || (response.status === 404 ? "갱신 API가 없습니다." : `갱신 요청이 실패했습니다 (${response.status}).`));
    }
    refreshRunId = state.runId || null;
  } catch (error) { setRefresh(false, error.message, "error"); return; }
  pollRefresh();
}
function refreshUrl() { return refreshRunId ? `${REFRESH_API}?runId=${refreshRunId}` : REFRESH_API; }
function resumeRefresh() { getJson(REFRESH_API).then((state) => { if (state.running) { refreshRunId = state.runId || null; setRefresh(true, refreshText(state)); pollRefresh(); } }).catch(() => {}); }
async function pollRefresh() {
  for (;;) {
    let state;
    try { state = await getJson(refreshUrl()); } catch (error) { setRefresh(false, `갱신 상태를 확인하지 못했습니다: ${error.message}`, "error"); return; }
    if (!state.running) return finishRefresh(state);
    setRefresh(true, refreshText(state));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
async function finishRefresh(state) {
  refreshRunId = null;
  if (state.error) { setRefresh(false, `갱신 실패: ${state.error}`, "error"); return; }
  const beforePaths = new Set(fileIndex.map((file) => file.path)), beforeTotal = totalCount(), beforeLast = dataRange().end;
  try { await loadIndex(false); } catch (error) { setRefresh(false, `갱신은 끝났지만 목록을 다시 읽지 못했습니다: ${error.message}`, "error"); return; }
  const added = fileIndex.filter((file) => !beforePaths.has(file.path)).length, diff = totalCount() - beforeTotal, last = dataRange().end;
  // 새로 들어온 날짜가 현재 조회 종료일보다 뒤라면, 갱신 결과가 바로 보이도록 종료일을 늘린다.
  if (last && last > ($("#end").value || "")) $("#end").value = last;
  setRefresh(false, `갱신 완료 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"} · 새 파일 ${format(added)}개 · 총 ${format(totalCount())}건 (${diff >= 0 ? "+" : ""}${format(diff)})${last > beforeLast ? ` · 최신 ${last}` : ""}`, "done");
  page = 1; applyFilters();
}
function refreshText(state) { return `수집 중입니다 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"}${state.lastLine ? ` · ${state.lastLine}` : ""}`; }
function setRefresh(busy, text, kind = "") { const button = $("#refresh-btn"), box = $("#refresh-status"); button.disabled = busy; button.setAttribute("aria-busy", String(busy)); button.textContent = busy ? "갱신 중…" : "보유데이터 갱신"; box.hidden = !text; box.className = `refresh-status ${kind}`.trim(); box.textContent = text || ""; }
function renderRows(rows) { const pages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, pages); const visible = rows.slice((page - 1) * pageSize, page * pageSize); $("#result-summary").textContent = `${format(rows.length)}건`; $("#page-label").textContent = `${page} / ${pages}`; $("#previous").disabled = page === 1; $("#next").disabled = page === pages; $("#download-btn").disabled = !rows.length; $("#download-ecr-btn").disabled = !analyses.size; $("#results").innerHTML = visible.length ? visible.map((row, i) => { const files = normalizeFiles(row.files), analysis = analyses.get(numberOf(row)); return `<tr><td><span class="badge ${row.mode}">${MODE_NAMES[row.mode] || row.mode}</span></td><td>${html(numberOf(row))}</td><td>${html(row.businessType)}</td><td>${html(row.institution)}</td><td class="title"><button class="title-link" data-index="${i}" type="button">${html(row.title || "(사업명 없음)")}</button>${fileBadge(row, files)}${analysis ? `<span class="ecr-badge ${analysis.verified ? "" : "warning"}">ECR ${analysis.ecrCount}${analysis.verified ? "" : " · 확인 필요"}</span>` : ""}</td><td>${dateFormat(row.publishedAt)}</td><td>${row.mode === "plan" ? html(row.orderMonth || "-") : dateFormat(row.closeAt)}</td></tr>`; }).join("") : $("#empty-row").innerHTML; document.querySelectorAll(".title-link").forEach((button) => button.onclick = () => openModal(visible[Number(button.dataset.index)])); }
function modalSubtitle(row, files) {
  if (row.mode !== "plan") return `${row.institution || "-"} · ${row.businessType || "-"} · 번호 ${numberOf(row) || "-"} · 첨부 ${files.length}건`;
  const parts = [row.institution || "-", row.businessType || "-", `계획번호 ${numberOf(row) || "-"}`];
  if (row.orderMonth) parts.push(`발주예정 ${row.orderMonth}`);
  if (row.amount && Number(row.amount)) parts.push(`발주금액 ${format(Number(row.amount))}원`);
  if (row.contractMethod) parts.push(row.contractMethod);
  if (row.procureMethod) parts.push(row.procureMethod);
  return parts.join(" · ");
}
// 발주계획은 첨부 URL이 없으므로 나라장터 상세 페이지와, 이미 공고로 이어진 경우 그 공고번호를 건다.
function planLinks(row) {
  const items = [];
  if (row.detailUrl) items.push(`<li><span class="file-no">1.</span><a href="${html(row.detailUrl)}" target="_blank" rel="noopener noreferrer">나라장터 발주계획 상세 열기</a></li>`);
  const notices = String(row.linkedNotices || "").split(/[,\s]+/).filter(Boolean);
  if (notices.length) items.push(`<li><span class="empty-msg">연계 공고번호: ${notices.map(html).join(", ")}</span></li>`);
  items.push(`<li><span class="empty-msg">${row.hasAttachment ? "첨부파일이 있지만 API로는 제공되지 않습니다. 상세 페이지에서 받으세요." : "이 계획에는 첨부파일이 없습니다."}</span></li>`);
  return items.join("");
}
// 발주계획 API는 첨부파일 URL을 주지 않고 "첨부가 있는지"(atchFileExistnceYn)만 알려준다.
// 실제 파일은 상세 페이지에서 받아야 하므로 건수 대신 유무를 표시한다.
function fileBadge(row, files) {
  if (row.mode === "plan") return `<span class="file-badge ${row.hasAttachment ? "" : "empty"}">${row.hasAttachment ? "첨부 있음" : "첨부 없음"}</span>`;
  return `<span class="file-badge ${files.length ? "" : "empty"}">${files.length ? `첨부 ${files.length}` : "첨부 0"}</span>`;
}
function openModal(row) { currentRow = row; currentAnalysis = null; const files = normalizeFiles(row.files), entry = analyses.get(numberOf(row)); $("#modal-title").textContent = row.title || "(사업명 없음)"; $("#modal-subtitle").textContent = modalSubtitle(row, files); $("#modal-file-list").innerHTML = files.length ? files.map((file, i) => `<li><span class="file-no">${i + 1}.</span><a href="${html(file.url)}" target="_blank" rel="noopener noreferrer">${html(file.name)}</a></li>`).join("") : row.mode === "plan" ? planLinks(row) : '<li><span class="empty-msg">이 공고에는 API로 제공되는 첨부파일이 없습니다.</span></li>'; $("#download-all-btn").disabled = !files.length; $("#download-all-btn").textContent = files.length ? `전체 다운로드 (${files.length}건)` : "전체 다운로드"; $("#ecr-tab").disabled = !entry; $("#ecr-tab").textContent = entry ? `ECR 규격 (${entry.ecrCount})` : "ECR 규격"; $("#ecr-content").innerHTML = entry ? '<p class="hint">ECR 규격을 불러오려면 탭을 선택하세요.</p>' : '<p class="hint">이 공고에는 분석된 ECR 규격이 없습니다.</p>'; selectTab("files"); modal.style.display = "flex"; }
function closeModal() { modal.style.display = "none"; currentRow = null; currentAnalysis = null; }
function selectTab(tab) { document.querySelectorAll(".modal-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab)); $("#files-content").hidden = tab !== "files"; $("#ecr-content").hidden = tab !== "ecr"; if (tab === "ecr") loadEcr(); }
async function loadEcr() { const entry = analyses.get(numberOf(currentRow)); if (!entry) return; if (!currentAnalysis) { $("#ecr-content").innerHTML = '<p class="hint">ECR 규격을 불러오는 중입니다.</p>'; try { currentAnalysis = await getJson(`${DATA_BASE}/${entry.path}`); } catch (error) { $("#ecr-content").innerHTML = `<p class="warning-text">ECR 규격을 불러오지 못했습니다: ${html(error.message)}</p>`; return; } } renderEcr(currentAnalysis); }
function renderEcr(data) { const alerts = [...(data.누락 || []).map((id) => `누락: ${id}`), ...(data.verification?.errors || []), ...(data.ecr || []).flatMap((item) => (item.불확실 || []).map((text) => `${item.id}: ${text}`))]; const rows = (data.ecr || []).map((item, i) => `<tr class="ecr-row" data-index="${i}"><td>${html(item.id)}</td><td>${html(item.분류)}</td><td>${html(item.명칭)}</td><td>${html((item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", ") || "-")}</td><td>${html((item.산출물 || []).join(", ") || "-")}</td></tr><tr id="detail-${i}" class="ecr-detail" hidden><td colspan="5"><p><strong>세부내용 원문</strong></p><div class="detail-text">${html(item.세부내용_원문 || "-")}</div>${specTable(item.기본규격 || [])}</td></tr>`).join(""); $("#ecr-content").innerHTML = `${alerts.length ? `<div class="ecr-alert">${alerts.map(html).join("<br>")}</div>` : ""}<p class="ecr-status ${data.verified ? "verified" : "unverified"}">${data.verified ? "자동 검증 통과" : "자동 검증 미통과 — 원문 확인 필요"}</p><div class="ecr-scroll"><table class="ecr-table"><thead><tr><th>ID</th><th>분류</th><th>명칭</th><th>수량</th><th>산출물</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">추출된 ECR이 없습니다.</td></tr>'}</tbody></table></div>`; document.querySelectorAll(".ecr-row").forEach((row) => row.onclick = () => { const detail = $(`#detail-${row.dataset.index}`); detail.hidden = !detail.hidden; row.classList.toggle("expanded", !detail.hidden); }); }
function specTable(specs) { return specs.length ? `<p><strong>기본규격</strong></p><table class="nested-spec"><thead><tr><th>구분</th><th>항목</th><th>요구사항</th><th>수량</th></tr></thead><tbody>${specs.map((spec) => `<tr><td>${html(spec.구분)}</td><td>${html(spec.항목)}</td><td>${html(spec.요구사항)}</td><td>${html(spec.수량)}</td></tr>`).join("")}</tbody></table>` : ""; }
// 발주계획은 마감일이 없고 발주예정월이 그 자리를 대신한다. 첨부 열에는 URL이 없으므로 상세 링크를 넣는다.
function downloadCsv() { downloadRows([["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일/발주예정", "첨부파일"], ...filtered.map((row) => [MODE_NAMES[row.mode] || row.mode, numberOf(row), row.businessType, row.institution, row.title, row.publishedAt, row.mode === "plan" ? row.orderMonth : row.closeAt, row.mode === "plan" ? row.detailUrl || "" : normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | ")])], "gong-go"); }
async function downloadEcr() { const rows = [["공고번호", "사업명", "ID", "분류", "명칭", "수량", "산출물", "세부내용 원문", "검증"]]; for (const row of filtered) { const entry = analyses.get(numberOf(row)); if (!entry) continue; try { const data = await getJson(`${DATA_BASE}/${entry.path}`); (data.ecr || []).forEach((item) => rows.push([numberOf(row), row.title, item.id, item.분류, item.명칭, (item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", "), (item.산출물 || []).join(", "), item.세부내용_원문, data.verified ? "통과" : "원문 확인 필요"])); } catch {} } downloadRows(rows, "gong-go-ecr"); }
function downloadRows(rows, prefix) { const csv = rows.map((row) => row.map((value) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }).join(",")).join("\n"), blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `${prefix}_${localDate(new Date()).replaceAll("-", "")}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
async function downloadAll() { const files = normalizeFiles(currentRow?.files), button = $("#download-all-btn"); if (!files.length) return; button.disabled = true; for (let i = 0; i < files.length; i += 1) { button.textContent = `다운로드 중... (${i + 1}/${files.length})`; window.open(files[i].url, "_blank", "noopener,noreferrer"); if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 700)); } button.textContent = `전체 다운로드 완료 (${files.length}건)`; button.disabled = false; }
async function getJson(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url}을 찾지 못했습니다.`); return response.json(); }
// CSV 파싱과 행 모델(예전 parseCsv/displayRow/planRow/guess)은 rows.js로 옮겼다. 워커도 같은 것을 쓴다.
function normalizeFiles(files) { return Array.isArray(files) ? files : []; } function numberOf(row) { return row.announcementNumber || ""; } function dateKey(value) { return Rows.dateKey(value); } function dateFormat(value) { const v = dateKey(value); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "-"; } function format(value) { return new Intl.NumberFormat("ko-KR").format(value); } function localDate(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; } function html(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
