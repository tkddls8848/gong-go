// 배포본은 Worker가 R2를 중계하고, 로컬은 devserver가 저장소의 data/를 제공한다.
const $ = (s) => document.querySelector(s), DATA_BASE = "/data", REFRESH_API = "/api/refresh", ASK_API = "/api/ask", LIVE_API = "/api/live", POLL_SLOW_MS = 5000, POLL_FAST_MS = 2000, MAX_ROWS = 200000;
// dispatch는 받아들여졌는데 실행이 끝내 목록에 뜨지 않는 경우의 한도. 이게 없으면 영원히 폴링한다.
const REFRESH_WAIT_LIMIT_MS = 120000;
// CSV 스캔은 search-worker.js가 맡는다. 여기서는 워커를 몇 개 띄우고 각자 몇 개씩
// 동시에 받게 할지만 정한다(둘을 곱한 값이 예전 LOAD_CONCURRENCY 자리다).
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)), FETCH_CONCURRENCY = 12;
const LIVE_TYPES = ["물품", "외자", "용역", "공사"], LIVE_CONCURRENCY = 4, LIVE_MAX_PAGE = 200;
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
// 관심 기관은 이름 붙인 프리셋 여러 벌로 브라우저 localStorage에 보관한다. 정적 배포라 서버에
// 사용자별 저장소가 없고, 인증도 공유 비밀번호 하나뿐이라 서버에 둬도 "누구 것"인지 가릴 수 없다.
const INST_STORAGE_KEY = "gong-go:institutions"; // 구 형식. 마이그레이션에서만 읽는다.
const PRESET_STORAGE_KEY = "gong-go:institution-presets";
const INDEX_STORAGE_KEY = "gong-go:index-updated-at";
const DEFAULT_PRESET = "기본";
// activePreset이 null이면 고급검색이 만든 임시 목록이다. 이때는 저장하지 않는다 — 자연어 질의가
// 사용자가 공들여 만든 프리셋을 조용히 덮어쓰면 되돌릴 방법이 없다.
let presets = [], activePreset = DEFAULT_PRESET, institutionList = [], searchTimer = null, refreshRunId = null, refreshRange = null, refreshSince = null, liveController = null;
function cleanInstitutions(list) { return Array.isArray(list) ? list.map((inst) => ({ name: String(inst?.name || ""), code: String(inst?.code || "") })).filter((inst) => inst.name || inst.code) : []; }
function normalizePresets(list) { return Array.isArray(list) ? list.map((preset) => ({ name: String(preset?.name || "").trim(), institutions: cleanInstitutions(preset?.institutions) })).filter((preset) => preset.name) : []; }
// 구 형식(단일 목록)이 남아 있으면 "기본" 프리셋으로 옮긴다. 기존 사용자의 칩이 그대로 살아난다.
function legacyInstitutions() {
  try { const saved = JSON.parse(localStorage.getItem(INST_STORAGE_KEY)); if (Array.isArray(saved)) return cleanInstitutions(saved); } catch {}
  return DEFAULT_INSTITUTIONS.map((inst) => ({ ...inst }));
}
function loadPresets() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)); } catch {}
  presets = normalizePresets(saved?.presets);
  if (!presets.length) presets = [{ name: DEFAULT_PRESET, institutions: legacyInstitutions() }];
  activePreset = presets.some((preset) => preset.name === saved?.active) ? saved.active : presets[0].name;
  institutionList = currentPreset().institutions.map((inst) => ({ ...inst }));
}
function currentPreset() { return presets.find((preset) => preset.name === activePreset) || presets[0]; }
function savePresets() { try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ version: 1, active: activePreset, presets })); } catch {} }
// renderInstitutions()가 렌더할 때마다 부른다 = 칩 편집이 곧 활성 프리셋 저장이다.
function saveInstitutions() {
  if (activePreset === null) return;
  const preset = currentPreset();
  if (preset) preset.institutions = institutionList.map((inst) => ({ ...inst }));
  savePresets();
}
// 프리셋을 갈아탈 때마다 쓴다. 임시 상태에서 빠져나오는 경로이기도 하다.
function usePreset(name) { activePreset = name; institutionList = currentPreset().institutions.map((inst) => ({ ...inst })); savePresets(); renderPresets(); renderInstitutions(); }
function renderPresets() {
  const select = $("#inst-preset"), transient = activePreset === null;
  select.innerHTML = `${transient ? '<option value="" selected>(고급검색)</option>' : ""}${presets.map((preset) => `<option value="${html(preset.name)}"${!transient && preset.name === activePreset ? " selected" : ""}>${html(preset.name)}</option>`).join("")}`;
  $("#preset-delete").disabled = transient || presets.length <= 1;
}
let filtered = [], fileIndex = [], dataSchemaVersion = "", page = 1, searchVersion = 0, currentRow = null, currentAnalysis = null, viewMode = "pre";
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
else { loadIndex(true).then(({ changed }) => applyFilters({ revalidateRecent: changed })).catch((error) => { $("#status").textContent = error.message; renderRows([]); }); resumeRefresh(); }

// index.json은 갱신 직후에도 최신이어야 하므로 매번 캐시를 우회한다. 파일 1개라 호출량에
// 영향이 없다. 일반 수집 시각은 CSV URL에 붙이지 않는다 — 매시 모든 과거 캐시가 날아간다.
// 대신 과거 백필처럼 봉인 파일의 스키마 자체가 바뀐 때만 schemaVersion이 한 번 바뀐다.
async function loadIndex(initial) {
  const [index, analysis] = await Promise.all([getJson(`${DATA_BASE}/index.json?t=${Date.now()}`), getJson(`${DATA_BASE}/analysis-index.json`).catch(() => ({ entries: [] }))]);
  let previous = "";
  try { previous = localStorage.getItem(INDEX_STORAGE_KEY) || ""; localStorage.setItem(INDEX_STORAGE_KEY, index.updatedAt || ""); } catch {}
  fileIndex = index.files || [];
  dataSchemaVersion = String(index.schemaVersion || "");
  analyses.clear(); (analysis.entries || []).forEach((entry) => analyses.set(entry.notice, entry));
  renderDataStatus(index);
  if (initial) { defaultRange(); $("#status").textContent = `${fileIndex.length}개 CSV를 찾았습니다.`; }
  return { index, changed: Boolean(previous && index.updatedAt && previous !== index.updatedAt) };
}
function renderDataStatus(index) { const { begin, end } = dataRange(), total = totalCount(); $("#data-range").textContent = end ? `${begin} ~ ${end}` : "없음"; $("#data-count").textContent = end ? `${format(fileIndex.length)}개 파일 · ${format(total)}건` : ""; $("#last-crawl").textContent = `마지막 크롤링 ${stamp(index?.updatedAt)}`; $("#updated-at").textContent = `updated ${stamp(index?.updatedAt)}`; renderTodaySummary(); }

// "오늘"은 브라우저 로컬 날짜다. 데이터의 날짜는 KST 벽시계 문자열이라 KST 밖에서 열면 하루 어긋난다.
function today() { return localDate(new Date()); }
function todayKey() { return today().replaceAll("-", ""); }
function isToday(value) { return dateKey(value) === todayKey(); }
// 일별 인덱스 항목은 begin === end === 그 날짜다(shared/pipeline-utils.js의 indexEntry).
// 그래서 파일을 하나도 내려받지 않고 오늘 건수를 세 모드 모두 셀 수 있다.
function todayFile(mode) { const date = today(); return fileIndex.find((file) => modeOf(file) === mode && file.begin === date && file.end === date); }
// 오늘 건수는 레일의 유형 줄에 붙는다. 버튼은 index.html에 고정으로 있고 여기서는 숫자만
// 갈아 끼운다 — 매번 다시 그리면 클릭 핸들러도 매번 다시 걸어야 한다.
function renderTodaySummary() {
  const box = $("#today-summary");
  box.hidden = !fileIndex.length;
  if (fileIndex.length) box.textContent = `오늘 ${today()}`;
  document.querySelectorAll(".today-jump").forEach((button) => {
    const file = todayFile(button.dataset.mode);
    button.textContent = fileIndex.length && file ? format(Number(file.count) || 0) : "-";
    button.title = `게시일을 오늘 하루로 좁혀 ${MODE_NAMES[button.dataset.mode]}를 봅니다`;
  });
}
// 게시일을 오늘 하루로 좁힌다. 모드를 함께 주면 그 모드로 갈아탄 뒤 한 번만 조회한다.
function jumpToToday(mode) {
  $("#begin").value = today(); $("#end").value = today();
  if (mode && mode !== viewMode) { setMode(mode); closeModal(); }
  page = 1; applyFilters();
}
// 항목이 구간이 된 뒤로 "며칠치"는 인덱스만으로 셀 수 없다(월별 봉인 항목 하나가 한 달을
// 덮는다). 보유 범위는 begin의 최소·end의 최대로 낸다.
function dataRange() { const begins = fileIndex.map((file) => file.begin).filter(Boolean).sort(), ends = fileIndex.map((file) => file.end).filter(Boolean).sort(); return { begin: begins[0] || "", end: ends.at(-1) || "" }; }
function totalCount() { return fileIndex.reduce((sum, file) => sum + (Number(file.count) || 0), 0); }
function stamp(value) { const date = new Date(value), pad = (part) => String(part).padStart(2, "0"); return value && !Number.isNaN(date.valueOf()) ? `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : "-"; }

$("#search").onclick = () => { page = 1; applyFilters(); }; $("#reset").onclick = () => { ["#q", "#business-type", "#nl-query"].forEach((s) => { $(s).value = ""; }); $("#inst-loose").checked = false; setNl(false, ""); defaultRange(); page = 1; applyFilters(); }; $("#q").onkeydown = (event) => { if (event.key === "Enter") { page = 1; applyFilters(); } };
// 사전공고/본공고는 조회 조건이 아니라 레일의 유형 목록으로 전환한다. 초기화 버튼은 건드리지 않는다.
// 오늘 건수는 같은 줄에 있지만 별개의 버튼이라 여기 걸린 위임에 잡히지 않는다(제 핸들러가 있다).
$("#mode-toggle").onclick = (event) => { const button = event.target.closest(".mode-toggle-btn"); if (button && button.dataset.mode !== viewMode) applyMode(button.dataset.mode); };
document.querySelectorAll(".today-jump").forEach((button) => button.onclick = () => jumpToToday(button.dataset.mode));

// 레일은 접을 수 있다. 넓은 화면에서는 접힌 상태를 기억하고(표에 248px을 더 주려고 접는
// 것이므로 다음에도 그대로여야 한다), 좁은 화면에서는 서랍이라 늘 닫힌 채로 연다.
const RAIL_STORAGE_KEY = "gong-go:rail-collapsed";
const railNarrow = () => window.matchMedia("(max-width: 900px)").matches;
function setRail(collapsed, remember) {
  document.body.classList.toggle("rail-collapsed", collapsed);
  $("#rail-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("#rail-open").setAttribute("aria-expanded", String(!collapsed));
  $("#rail-restore").setAttribute("aria-expanded", String(!collapsed));
  if (remember && !railNarrow()) { try { localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? "1" : ""); } catch {} }
}
$("#rail-toggle").onclick = () => setRail(true, true);
$("#rail-open").onclick = () => setRail(false, true);
$("#rail-restore").onclick = () => setRail(false, true);
$("#rail-scrim").onclick = () => setRail(true, false);
setRail(railNarrow() || (() => { try { return localStorage.getItem(RAIL_STORAGE_KEY) === "1"; } catch { return false; } })(), false);

// 조회 줄의 ☰. 자주 쓰지 않는 동작(초기화·고급검색·내보내기·갱신)을 여기 모아 두고, 줄에는
// 검색어·업무·게시일·검색만 남긴다. 예전에는 이 자리가 레일을 펼치는 버튼 하나였는데
// 넓은 화면에서는 레일이 이미 펼쳐져 있어 눌러도 아무 일도 하지 않았다.
// 항목을 고르면 바로 닫는다 — 하나 고르고 나면 볼 일이 끝나는 메뉴다.
function setMenu(open) {
  $("#menu-panel").hidden = !open;
  $("#menu-btn").setAttribute("aria-expanded", String(open));
  $("#menu-btn").classList.toggle("active", open);
}
$("#menu-btn").onclick = () => setMenu($("#menu-panel").hidden);
$("#menu-panel").onclick = (event) => { if (event.target.closest("button:not(:disabled)")) setMenu(false); };
// 바깥을 누르거나 Esc로도 닫는다. 모달의 Esc 처리는 document.onkeydown 자리를 쓰고 있어
// 여기서는 addEventListener로 따로 건다(그 자리를 빼앗으면 모달이 닫히지 않는다).
document.addEventListener("click", (event) => { if (!event.target.closest(".menu")) setMenu(false); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") setMenu(false); });
// 상태와 DOM만 바꾸는 부분을 떼어 둔다. 고급검색은 모드·기간·검색어를 다 채운 뒤 한 번만
// 조회해야 하므로 모드 전환이 그 자리에서 조회를 걸면 안 된다.
// 켜짐 표시는 버튼을 감싼 줄(.mode-row)에도 건다. 오늘 건수가 버튼이라 유형 버튼 안에 넣을
// 수 없어서, 줄 전체가 켜진 것처럼 보이게 하려면 부모가 그 상태를 알아야 한다.
function setMode(key) { viewMode = key; document.querySelectorAll(".mode-toggle-btn").forEach((button) => { const active = button.dataset.mode === key; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.parentElement.classList.toggle("active", active); }); $("#app-subtitle").textContent = MODE_SUBTITLES[key]; $("#close-col").textContent = key === "plan" ? "발주예정" : "마감일"; }
function applyMode(key) { setMode(key); closeModal(); page = 1; applyFilters(); }
$("#previous").onclick = () => { if (page > 1) { page -= 1; renderRows(filtered); } }; $("#next").onclick = () => { if (page * pageSize < filtered.length) { page += 1; renderRows(filtered); } }; $("#download-btn").onclick = downloadCsv; $("#download-ecr-btn").onclick = downloadEcr;
$("#refresh-btn").onclick = startRefresh; $("#menu-refresh").onclick = startRefresh;
$("#page-size").onchange = () => { pageSize = Number($("#page-size").value) || 50; page = 1; renderRows(filtered); };
$("#add-row-btn").onclick = addInstitution;
$("#clear-inst-btn").onclick = () => { institutionList = []; renderInstitutions(); scheduleSearch(); };
// 등록된 관심 기관들을 현재 게시일 조건으로 즉시 조회한다(디바운스 없이 바로).
$("#inst-search-btn").onclick = () => { addInstitution(); clearTimeout(searchTimer); page = 1; applyFilters(); };
["#inst-name", "#inst-code"].forEach((selector) => $(selector).onkeydown = (event) => { if (event.key === "Enter") addInstitution(); });
$("#inst-loose").onchange = () => { page = 1; applyFilters(); };
// 칩과 부분일치는 늘 보이고, 기관을 더하거나 프리셋을 관리하는 도구만 접어 둔다.
// 고급검색 토글과 같은 방식이다 — 여는 순간 바로 입력할 수 있게 초점을 옮긴다.
$("#inst-edit-toggle").onclick = () => {
  const panel = $("#inst-editor"), open = panel.hidden;
  panel.hidden = !open;
  $("#inst-edit-toggle").setAttribute("aria-pressed", String(open));
  $("#inst-edit-toggle").classList.toggle("active", open);
  if (open) $("#inst-name").focus();
};
$("#today-btn").onclick = () => jumpToToday();
$("#inst-preset").onchange = () => { const name = $("#inst-preset").value; if (name) { usePreset(name); scheduleSearch(); } };
$("#preset-new").onclick = () => {
  const name = (prompt("새 프리셋 이름을 입력하세요. 지금 칩 목록이 그대로 복사됩니다.", nextPresetName()) || "").trim();
  if (!name) return;
  if (presets.some((preset) => preset.name === name)) { $("#status").textContent = `이미 "${name}" 프리셋이 있습니다.`; return; }
  presets.push({ name, institutions: institutionList.map((inst) => ({ ...inst })) });
  usePreset(name);
};
$("#preset-delete").onclick = () => {
  if (activePreset === null || presets.length <= 1 || !confirm(`"${activePreset}" 프리셋을 지울까요?`)) return;
  presets = presets.filter((preset) => preset.name !== activePreset);
  usePreset(presets[0].name);
  scheduleSearch();
};
function nextPresetName() { for (let i = presets.length + 1; ; i += 1) if (!presets.some((preset) => preset.name === `프리셋 ${i}`)) return `프리셋 ${i}`; }
loadPresets();
renderPresets();
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
// localeCompare를 쓰지 않는다. 게시일은 고정 형식의 숫자·구분자 문자열이라 코드유닛 비교와
// 결과가 같은데, localeCompare는 호출마다 ICU 대조를 타 20만 행 정렬에서 377ms가 걸렸다
// (같은 입력에 일반 비교는 119ms, 정렬 결과는 동일).
function byPublishedDesc(a, b) { const x = a.publishedAt, y = b.publishedAt; return x < y ? 1 : x > y ? -1 : 0; }

async function applyFilters({ revalidateRecent = false } = {}) {
  const version = ++searchVersion;
  abortScan();
  if (liveController) liveController.abort();
  const mode = viewMode;
  const begin = $("#begin").value || "0000-01-01", end = $("#end").value || "9999-12-31";
  // 지금 보고 있는 모드의 파일만 받는다. 예전에는 날짜만 보고 골라 사전공고·본공고·발주계획을
  // 모두 내려받아 gzip을 풀고 파싱한 뒤 버렸다 — 한 모드를 보는데 세 모드를 읽은 셈이다.
  // 항목의 구간과 조회 구간이 겹치면 받는다. 월별 봉인 항목은 한 달을 통째로 끌어오지만,
  // 워커가 행 단위로 다시 거르므로 결과는 정확하다 — 오버페치는 전송량 문제일 뿐이다.
  const files = fileIndex
    .filter((file) => modeOf(file) === mode && file.end >= begin && file.begin <= end)
    // 갱신 직후에는 지금 조회할 최근 일별 파일만 같은 URL로 조건부 재검증한다. 쿼리 토큰을
    // 붙이면 과거 파일까지 전부 새 캐시 키가 되지만 cache:no-cache는 기존 ETag를 써 304를 받을 수 있다.
    .map((file) => revalidateRecent && isRecentDaily(file) ? { ...file, revalidate: true } : file);
  const institutions = collectInstitutions();
  const criteria = { q: $("#q").value.trim().toLowerCase(), type: $("#business-type").value, institutions, from: begin.replaceAll("-", ""), to: end.replaceAll("-", ""), loose: $("#inst-loose").checked };

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
  parts.push(institutions.length ? `관심 기관 ${institutions.length}곳으로 좁혔습니다${criteria.loose ? "(부분일치)" : ""}.` : "기관 목록이 비어 있어 전체 기관을 조회했습니다.");
  // 오늘 하루만 보는데 그 모드의 오늘 파일이 아직 없으면 0건이 나온다. 조건을 잘못 준 것으로
  // 오해하지 않도록 사유를 밝힌다.
  if (criteria.from === criteria.to && criteria.from === todayKey() && !todayFile(mode)) parts.push(`오늘(${today()}) ${MODE_NAMES[mode]} 데이터가 아직 없습니다. 수집은 09~18시 매시(KST)에 돕니다.`);
  if (state.capped) parts.push(`표시 한도 ${format(MAX_ROWS)}건에 도달해 나머지 파일은 읽지 않았습니다. 기간을 좁히거나 관심 기관을 지정하세요.`);
  if (state.failures) parts.push(`${format(state.failures)}개 파일을 읽지 못했습니다.`);
  const storedStatus = parts.join(" ");
  $("#status").textContent = storedStatus;
  renderRows(filtered);
  // 저장 데이터는 여기까지 기다린 즉시 확정해서 보여 준다. 최신 조회는 별도 요청으로 흘려
  // 보내므로 나라장터가 느리거나 실패해도 이미 보이는 결과를 지우거나 막지 않는다.
  void mergeLiveResults({ mode, begin, end, criteria, version, storedRows: filtered.slice(), storedStatus });
}

function recentLiveSpan(begin, end) {
  const now = new Date(), yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const first = begin > localDate(yesterday) ? begin : localDate(yesterday);
  const last = end < localDate(now) ? end : localDate(now);
  return first <= last ? { begin: first, end: last } : null;
}

function liveItems(data) {
  const body = data?.response?.body;
  if (!body) throw new Error(data?.response?.header?.resultMsg || "공공 API 응답에 본문이 없습니다.");
  const value = body.items;
  const items = Array.isArray(value) ? value : Array.isArray(value?.item) ? value.item : value?.item ? [value.item] : [];
  const size = Math.max(1, Number(body.numOfRows) || 100);
  return { items, totalPages: Math.min(LIVE_MAX_PAGE, Math.max(1, Math.ceil((Number(body.totalCount) || 0) / size))) };
}

async function fetchLivePage(mode, businessType, span, pageNo, signal) {
  const params = new URLSearchParams({ mode, businessType, begin: span.begin, end: span.end, pageNo: String(pageNo) });
  const response = await fetch(`${LIVE_API}?${params}`, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `최신 정보 응답 오류 (${response.status})`);
  return liveItems(data);
}

function mergeRows(storedRows, liveRows) {
  const rows = new Map(storedRows.map((row) => [`${row.mode}:${numberOf(row)}`, row]));
  for (const row of liveRows) rows.set(`${row.mode}:${numberOf(row)}`, { ...row, live: true });
  return [...rows.values()].sort(byPublishedDesc);
}

async function mergeLiveResults({ mode, begin, end, criteria, version, storedRows, storedStatus }) {
  const span = recentLiveSpan(begin, end);
  if (!span) return;
  const controller = new AbortController();
  liveController = controller;
  const parsed = Rows.makeCriteria(criteria);
  const types = criteria.type ? [criteria.type] : LIVE_TYPES;
  const liveRows = [];
  let pagesDone = 0, pagesTotal = types.length, failures = 0, scanned = 0, firstError = "";

  const paint = () => {
    if (version !== searchVersion || controller.signal.aborted) return;
    filtered = mergeRows(storedRows, liveRows);
    $("#status").textContent = `${storedStatus} 저장 결과를 먼저 표시했습니다. 최신 정보 확인 중 ${format(pagesDone)}/${format(pagesTotal)}페이지…`;
    renderRows(filtered);
  };
  paint();

  const first = await Promise.all(types.map(async (businessType) => {
    try {
      const result = await fetchLivePage(mode, businessType, span, 1, controller.signal);
      const found = Rows.scanObjects(result.items, mode, parsed, true);
      scanned += found.scanned;
      for (const row of found.matched) liveRows.push(row);
      pagesDone += 1;
      pagesTotal += result.totalPages - 1;
      paint();
      return Array.from({ length: result.totalPages - 1 }, (_, index) => ({ businessType, pageNo: index + 2 }));
    } catch (error) {
      if (error.name === "AbortError") return [];
      if (!firstError) firstError = error.message;
      failures += 1; pagesDone += 1; paint();
      return [];
    }
  }));

  const pending = first.flat();
  let cursor = 0;
  const scan = async () => {
    while (cursor < pending.length && !controller.signal.aborted) {
      const task = pending[cursor++];
      try {
        const result = await fetchLivePage(mode, task.businessType, span, task.pageNo, controller.signal);
        const found = Rows.scanObjects(result.items, mode, parsed, true);
        scanned += found.scanned;
        for (const row of found.matched) liveRows.push(row);
      } catch (error) {
        if (error.name === "AbortError") return;
        if (!firstError) firstError = error.message;
        failures += 1;
      }
      pagesDone += 1; paint();
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, pending.length || 1) }, scan));
  if (version !== searchVersion || controller.signal.aborted) return;
  filtered = mergeRows(storedRows, liveRows);
  const storedIds = new Set(storedRows.map((row) => `${row.mode}:${numberOf(row)}`));
  const liveIds = new Set(liveRows.map((row) => `${row.mode}:${numberOf(row)}`));
  const added = [...liveIds].filter((id) => !storedIds.has(id)).length;
  const note = failures
    ? `최신 정보 일부만 반영 · 새 공고 ${format(added)}건, 실패 ${format(failures)}페이지 (${firstError}).`
    : `최신 정보 확인 완료 · ${format(scanned)}건 확인, 조건 일치 ${format(liveIds.size)}건 중 새 공고 ${format(added)}건.`;
  $("#status").textContent = `${storedStatus} ${note}`;
  renderRows(filtered);
  if (liveController === controller) liveController = null;
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
      worker.postMessage({ type: "search", version, base: DATA_BASE, dataSchemaVersion, files: mine, criteria, span, concurrency: share });
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
        const suffix = dataSchemaVersion ? `?v=${encodeURIComponent(dataSchemaVersion)}` : "";
        const text = await Rows.fetchCsvText(`${DATA_BASE}/${file.path}${suffix}`, file.revalidate ? { cache: "no-cache" } : undefined);
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
    // dispatch 시각. 상태 조회가 이 뒤에 만들어진 실행만 보게 해서, 아직 등록되지 않은 내
    // 실행 대신 직전 실행(크론이나 앞선 버튼)의 결과를 받아 오는 일을 막는다.
    // 로컬 devserver는 이 값을 주지 않고 자기 작업 상태를 직접 답하므로 그대로 null이다.
    refreshSince = state.dispatchedAt || null;
    // 범위는 시작 응답에만 실려 온다. 상태 조회는 GitHub의 실행 정보만 되돌려주므로,
    // 여기서 붙들지 않으면 진행·완료 문구의 구간이 계속 "-"로 남는다.
    refreshRange = state.range || null;
  } catch (error) { setRefresh(false, error.message, "error"); return; }
  pollRefresh();
}
function refreshUrl() {
  if (refreshRunId) return `${REFRESH_API}?runId=${refreshRunId}`;
  return refreshSince ? `${REFRESH_API}?since=${encodeURIComponent(refreshSince)}` : REFRESH_API;
}
function withRange(state) { return state.range || !refreshRange ? state : { ...state, range: refreshRange }; }
function resumeRefresh() { getJson(REFRESH_API).then((state) => { if (state.running) { refreshRunId = state.runId || null; setRefresh(true, refreshText(state)); pollRefresh(); } }).catch(() => {}); }
async function pollRefresh() {
  const startedAt = Date.now();
  for (;;) {
    let state;
    try { state = withRange(await getJson(refreshUrl())); } catch (error) { setRefresh(false, `갱신 상태를 확인하지 못했습니다: ${error.message}`, "error"); return; }
    // 실행 id를 처음 본 순간 거기에 고정한다. 이후 폴링은 그 실행만 보므로, 도중에 매시
    // 크론이 새 실행을 걸어도 대상이 갈아타지 않는다.
    if (state.runId && !refreshRunId) refreshRunId = String(state.runId);
    // waiting은 "dispatch는 됐는데 실행이 아직 목록에 없다"는 뜻이다. 보통 몇 초면 끝나지만
    // 끝내 뜨지 않으면(워크플로 미등록 등) 여기서 끊는다.
    if (state.waiting && Date.now() - startedAt > REFRESH_WAIT_LIMIT_MS) {
      setRefresh(false, "갱신을 요청했지만 GitHub Actions 실행이 등록되지 않았습니다. Actions 탭에서 확인하세요.", "error");
      return;
    }
    if (!state.running) return finishRefresh(state);
    setRefresh(true, refreshText(state));
    await new Promise((resolve) => setTimeout(resolve, pollDelay(state)));
  }
}
async function finishRefresh(state) {
  // state.range는 pollRefresh가 이미 채워 넘겼으므로 여기서 비워도 아래 문구는 온전하다.
  refreshRunId = null; refreshRange = null; refreshSince = null;
  if (state.error) { setRefresh(false, `갱신 실패: ${state.error}`, "error"); return; }
  const beforePaths = new Set(fileIndex.map((file) => file.path)), beforeTotal = totalCount(), beforeLast = dataRange().end;
  try { await loadIndex(false); } catch (error) { setRefresh(false, `갱신은 끝났지만 목록을 다시 읽지 못했습니다: ${error.message}`, "error"); return; }
  const added = fileIndex.filter((file) => !beforePaths.has(file.path)).length, diff = totalCount() - beforeTotal, last = dataRange().end;
  // 새로 들어온 날짜가 현재 조회 종료일보다 뒤라면, 갱신 결과가 바로 보이도록 종료일을 늘린다.
  if (last && last > ($("#end").value || "")) $("#end").value = last;
  setRefresh(false, `갱신 완료 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"} · 새 파일 ${format(added)}개 · 총 ${format(totalCount())}건 (${diff >= 0 ? "+" : ""}${format(diff)})${last > beforeLast ? ` · 최신 ${last}` : ""}`, "done");
  page = 1; applyFilters({ revalidateRecent: true });
}
// 초반을 촘촘히 보고, 길어진 실행만 느슨하게 본다. 예전에는 이게 뒤집혀 있어 60초를 넘겨야
// 촘촘해졌는데, 버튼 실행(어제~오늘)은 30초대에 끝나므로 사실상 언제나 5초 간격만 썼다 —
// 이미 끝난 실행을 최대 5초 늦게 봤다. 60초를 넘기는 것은 35일 재수집이거나 큐에 걸린 쪽이라
// 그때는 느슨해도 된다. startedAt이 아직 없는 동안(dispatch 직후 실행 등록 대기)도 촘촘한
// 쪽으로 떨어진다 — 그 구간이야말로 빨리 찾아야 하는 자리다.
function pollDelay(state) { const started = Date.parse(state.startedAt || ""); return !Number.isNaN(started) && Date.now() - started >= 60000 ? POLL_SLOW_MS : POLL_FAST_MS; }
function isRecentDaily(file) { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 40); return /^(pre|bid|plan)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/.test(file.path || "") && file.end >= localDate(cutoff); }
function refreshText(state) { return `수집 중입니다 · ${state.range ? `${state.range.begin} ~ ${state.range.end}` : "-"}${state.lastLine ? ` · ${state.lastLine}` : ""}`; }
function setRefresh(busy, text, kind = "") { const button = $("#refresh-btn"), box = $("#refresh-status"); button.disabled = busy; button.setAttribute("aria-busy", String(busy)); button.textContent = busy ? "갱신 중…" : "보유데이터 갱신"; box.hidden = !text; box.className = `refresh-status ${kind}`.trim(); box.textContent = text || ""; document.querySelectorAll(".empty-refresh, #menu-refresh").forEach((other) => { other.disabled = busy; other.textContent = button.textContent; }); }

// 고급검색. Worker의 Workers AI가 자연어를 조회 조건으로만 바꾸고, 조회 자체는 평소와 똑같이
// 워커 스캔이 한다 — 데이터가 R2의 gzip CSV 수십만 건이라 모델에 먹일 수 있는 대상이 아니다.
$("#advanced-toggle").onclick = () => { const panel = $("#advanced-panel"), open = panel.hidden; panel.hidden = !open; $("#advanced-toggle").setAttribute("aria-pressed", String(open)); $("#advanced-toggle").classList.toggle("active", open); if (open) $("#nl-query").focus(); };
$("#nl-run").onclick = runNlQuery;
$("#nl-query").onkeydown = (event) => { if (event.key === "Enter") runNlQuery(); };
function setNl(busy, text, kind = "") { const button = $("#nl-run"), box = $("#nl-status"); button.disabled = busy; button.setAttribute("aria-busy", String(busy)); button.textContent = busy ? "해석 중…" : "해석해서 조회"; box.hidden = !text; box.className = `nl-status ${kind}`.trim(); box.textContent = text || ""; }
async function runNlQuery() {
  const query = $("#nl-query").value.trim();
  if (query.length < 2) { setNl(false, "찾고 싶은 내용을 한 문장으로 적어 주세요.", "error"); return; }
  setNl(true, "질의를 해석하는 중입니다.");
  let state;
  try {
    const response = await fetch(ASK_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: query, mode: viewMode }) });
    state = await response.json().catch(() => ({}));
    // 서버가 준 message를 항상 먼저 보여준다(startRefresh와 같은 규칙). 404는 구 배포본이다.
    if (!response.ok) throw new Error(state.message || (response.status === 404 ? "고급검색 API가 없습니다. 배포본이 오래된 것 같습니다." : `고급검색이 실패했습니다 (${response.status}).`));
  } catch (error) { setNl(false, error.message, "error"); return; }
  applyNlFilter(state);
  page = 1; applyFilters();
}
// 해석 결과를 실제 컨트롤에 그대로 채운다. 사용자가 무엇으로 검색됐는지 눈으로 보고 고칠 수 있어야 한다.
function applyNlFilter(state) {
  const filter = state.filter || {}, notes = [...(state.notes || [])];
  if (filter.mode && MODE_NAMES[filter.mode] && filter.mode !== viewMode) { setMode(filter.mode); closeModal(); }
  if (filter.begin) $("#begin").value = filter.begin;
  if (filter.end) $("#end").value = filter.end;
  $("#business-type").value = filter.type || "";
  $("#q").value = filter.q || "";
  // 기관을 뽑았으면 칩을 그것으로 갈아 끼운다. activePreset을 null로 두면 이 목록은 저장되지
  // 않아서, 사용자가 만들어 둔 프리셋이 자연어 질의 한 번에 덮이는 일이 없다.
  if (filter.institutions?.length) {
    activePreset = null;
    institutionList = filter.institutions.map((name) => ({ name, code: "" }));
    renderPresets(); renderInstitutions();
    notes.push("관심 기관을 이 질의의 기관으로 임시 교체했습니다. 저장된 프리셋은 그대로입니다.");
  }
  $("#inst-loose").checked = Boolean(filter.looseInstitution);
  // 보유 범위 밖을 물으면 0건이 나온다. 해석 실패로 오해하지 않도록 미리 알린다(특히 발주계획).
  if (!fileIndex.some((file) => modeOf(file) === viewMode && file.end >= $("#begin").value && file.begin <= $("#end").value)) notes.push(`${MODE_NAMES[viewMode]}에는 이 기간의 보유 데이터가 없습니다.`);
  setNl(false, [`해석: ${state.explain || "-"}`, ...notes].join(" · "), "done");
}
function renderRows(rows) { const pages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, pages); const visible = rows.slice((page - 1) * pageSize, page * pageSize); $("#result-summary").textContent = `${format(rows.length)}건`; $("#page-label").textContent = `${page} / ${pages}`; $("#previous").disabled = page === 1; $("#next").disabled = page === pages; $("#download-btn").disabled = !rows.length; $("#download-ecr-btn").disabled = !analyses.size; $("#results").innerHTML = visible.length ? visible.map((row, i) => { const files = normalizeFiles(row.files), analysis = analyses.get(numberOf(row)); return `<tr><td>${html(numberOf(row))}</td><td>${html(row.businessType)}</td><td>${html(row.institution)}</td><td class="title"><button class="title-link" data-index="${i}" type="button">${html(row.title || "(사업명 없음)")}</button>${row.live ? '<span class="live-badge">최신 확인</span>' : ""}${fileBadge(row, files)}${analysis ? `<span class="ecr-badge ${analysis.verified ? "" : "warning"}">ECR ${analysis.ecrCount}${analysis.verified ? "" : " · 확인 필요"}</span>` : ""}</td><td>${dateFormat(row.publishedAt)}${isToday(row.publishedAt) ? '<span class="today-badge">오늘</span>' : ""}</td><td>${row.mode === "plan" ? html(row.orderMonth || "-") : dateFormat(row.closeAt)}</td></tr>`; }).join("") : $("#empty-row").innerHTML; document.querySelectorAll(".title-link").forEach((button) => button.onclick = () => openModal(visible[Number(button.dataset.index)])); wireEmptyRefresh(); }
// 빈 결과 안내에도 갱신 버튼이 있다. 템플릿을 통째로 다시 그리므로 매번 다시 걸고, 지금
// 갱신이 도는 중이면 레일의 버튼과 같이 잠가 둔다 — 둘을 눌러 두 번 dispatch되면 안 된다.
function wireEmptyRefresh() { document.querySelectorAll(".empty-refresh").forEach((button) => { button.onclick = startRefresh; button.disabled = $("#refresh-btn").disabled; button.textContent = $("#refresh-btn").textContent; }); }
function modalSubtitle(row, files) {
  if (row.mode !== "plan") return `${row.institution || "-"} · ${row.businessType || "-"} · 번호 ${numberOf(row) || "-"} · 첨부 ${files.length}건`;
  const parts = [row.institution || "-", row.businessType || "-", `계획번호 ${numberOf(row) || "-"}`];
  if (row.orderMonth) parts.push(`발주예정 ${row.orderMonth}`);
  if (row.amount && Number(row.amount)) parts.push(`발주금액 ${format(Number(row.amount))}원`);
  if (row.contractMethod) parts.push(row.contractMethod);
  if (row.procureMethod) parts.push(row.procureMethod);
  return parts.join(" · ");
}
// 본공고와 발주계획은 나라장터 상세화면 링크를 API가 필드로 준다(bidNtceDtlUrl/orderPlanDtlUrl).
// 사전규격정보서비스에는 그 필드가 없어 사전공고에서는 늘 빈 문자열이 된다.
// 번호를 매기지 않는 이유: 본공고는 첨부 1..N과 한 목록에 서므로 "1."이 두 번 나온다.
function detailLink(row) {
  if (!row.detailUrl) return "";
  const label = row.mode === "plan" ? "나라장터 발주계획 상세 열기" : "나라장터 공고 상세 열기";
  return `<li><span class="file-no">&#8599;</span><a href="${html(row.detailUrl)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
}
// 발주계획은 첨부 URL이 없으므로 이어진 공고번호와 첨부 유무만 덧붙인다(상세 링크는 detailLink가 그린다).
function planLinks(row) {
  const items = [];
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
function scheduleItems(row) {
  const schedule = row.bidSchedule || {};
  return [
    ["공고 게시", schedule.bidNtceDt],
    ["입찰참가자격 등록 마감", schedule.bidQlfctRgstDt],
    ["공동수급협정 마감", schedule.cmmnSpldmdAgrmntClseDt],
    ["입찰서 제출 시작", schedule.bidBeginDt],
    ["입찰서 제출 마감", schedule.bidClseDt || row.closeAt],
    ["개찰 예정", schedule.opengDt],
  ].filter((item) => item[1]);
}
function renderBidSchedule(row) {
  const items = scheduleItems(row);
  if (!items.length) return '<p class="schedule-empty">저장된 입찰 일정이 없습니다. 다음 데이터 갱신부터 공공 API의 일정 정보가 함께 저장됩니다.</p>';
  return `<ol class="schedule-list">${items.map(([label, value]) => `<li class="schedule-item"><span class="schedule-dot" aria-hidden="true"></span><span class="schedule-label">${html(label)}</span><time class="schedule-time">${html(value)}</time></li>`).join("")}</ol><p class="schedule-note">개찰 예정은 실제 개찰 처리 시각이 아니라 개찰을 시작할 수 있는 최초 시각입니다.</p>`;
}
function openModal(row) { currentRow = row; currentAnalysis = null; const files = normalizeFiles(row.files), entry = analyses.get(numberOf(row)); $("#modal-title").textContent = row.title || "(사업명 없음)"; $("#modal-subtitle").textContent = modalSubtitle(row, files); $("#modal-file-list").innerHTML = detailLink(row) + (files.length ? files.map((file, i) => `<li><span class="file-no">${i + 1}.</span><a href="${html(file.url)}" target="_blank" rel="noopener noreferrer">${html(file.name)}</a></li>`).join("") : row.mode === "plan" ? planLinks(row) : '<li><span class="empty-msg">이 공고에는 API로 제공되는 첨부파일이 없습니다.</span></li>'); $("#download-all-btn").disabled = !files.length; $("#download-all-btn").textContent = files.length ? `전체 다운로드 (${files.length}건)` : "전체 다운로드"; $("#schedule-tab").disabled = row.mode !== "bid"; $("#schedule-content").innerHTML = row.mode === "bid" ? renderBidSchedule(row) : ""; $("#ecr-tab").disabled = !entry; $("#ecr-tab").textContent = entry ? `ECR 규격 (${entry.ecrCount})` : "ECR 규격"; $("#ecr-content").innerHTML = entry ? '<p class="hint">ECR 규격을 불러오려면 탭을 선택하세요.</p>' : '<p class="hint">이 공고에는 분석된 ECR 규격이 없습니다.</p>'; selectTab("files"); modal.style.display = "flex"; }
function closeModal() { modal.style.display = "none"; currentRow = null; currentAnalysis = null; }
function selectTab(tab) { document.querySelectorAll(".modal-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab)); $("#files-content").hidden = tab !== "files"; $("#schedule-content").hidden = tab !== "schedule"; $("#ecr-content").hidden = tab !== "ecr"; if (tab === "ecr") loadEcr(); }
async function loadEcr() { const entry = analyses.get(numberOf(currentRow)); if (!entry) return; if (!currentAnalysis) { $("#ecr-content").innerHTML = '<p class="hint">ECR 규격을 불러오는 중입니다.</p>'; try { currentAnalysis = await getJson(`${DATA_BASE}/${entry.path}`); } catch (error) { $("#ecr-content").innerHTML = `<p class="warning-text">ECR 규격을 불러오지 못했습니다: ${html(error.message)}</p>`; return; } } renderEcr(currentAnalysis); }
function renderEcr(data) { const alerts = [...(data.누락 || []).map((id) => `누락: ${id}`), ...(data.verification?.errors || []), ...(data.ecr || []).flatMap((item) => (item.불확실 || []).map((text) => `${item.id}: ${text}`))]; const rows = (data.ecr || []).map((item, i) => `<tr class="ecr-row" data-index="${i}"><td>${html(item.id)}</td><td>${html(item.분류)}</td><td>${html(item.명칭)}</td><td>${html((item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", ") || "-")}</td><td>${html((item.산출물 || []).join(", ") || "-")}</td></tr><tr id="detail-${i}" class="ecr-detail" hidden><td colspan="5"><p><strong>세부내용 원문</strong></p><div class="detail-text">${html(item.세부내용_원문 || "-")}</div>${specTable(item.기본규격 || [])}</td></tr>`).join(""); $("#ecr-content").innerHTML = `${alerts.length ? `<div class="ecr-alert">${alerts.map(html).join("<br>")}</div>` : ""}<p class="ecr-status ${data.verified ? "verified" : "unverified"}">${data.verified ? "자동 검증 통과" : "자동 검증 미통과 — 원문 확인 필요"}</p><div class="ecr-scroll"><table class="ecr-table"><thead><tr><th>ID</th><th>분류</th><th>명칭</th><th>수량</th><th>산출물</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">추출된 ECR이 없습니다.</td></tr>'}</tbody></table></div>`; document.querySelectorAll(".ecr-row").forEach((row) => row.onclick = () => { const detail = $(`#detail-${row.dataset.index}`); detail.hidden = !detail.hidden; row.classList.toggle("expanded", !detail.hidden); }); }
function specTable(specs) { return specs.length ? `<p><strong>기본규격</strong></p><table class="nested-spec"><thead><tr><th>구분</th><th>항목</th><th>요구사항</th><th>수량</th></tr></thead><tbody>${specs.map((spec) => `<tr><td>${html(spec.구분)}</td><td>${html(spec.항목)}</td><td>${html(spec.요구사항)}</td><td>${html(spec.수량)}</td></tr>`).join("")}</tbody></table>` : ""; }
// 발주계획은 마감일이 없고 발주예정월이 그 자리를 대신하며, 첨부 URL도 없어 그 칸이 빈다.
// 나라장터 링크는 모드마다 자리가 달라지지 않도록 전용 열로 뺐다.
function downloadCsv() { downloadRows([["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일/발주예정", "첨부파일", "나라장터 링크"], ...filtered.map((row) => [MODE_NAMES[row.mode] || row.mode, numberOf(row), row.businessType, row.institution, row.title, row.publishedAt, row.mode === "plan" ? row.orderMonth : row.closeAt, row.mode === "plan" ? "" : normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | "), row.detailUrl || ""])], "gong-go"); }
async function downloadEcr() { const rows = [["공고번호", "사업명", "ID", "분류", "명칭", "수량", "산출물", "세부내용 원문", "검증"]]; for (const row of filtered) { const entry = analyses.get(numberOf(row)); if (!entry) continue; try { const data = await getJson(`${DATA_BASE}/${entry.path}`); (data.ecr || []).forEach((item) => rows.push([numberOf(row), row.title, item.id, item.분류, item.명칭, (item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", "), (item.산출물 || []).join(", "), item.세부내용_원문, data.verified ? "통과" : "원문 확인 필요"])); } catch {} } downloadRows(rows, "gong-go-ecr"); }
function downloadRows(rows, prefix) { const csv = rows.map((row) => row.map((value) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }).join(",")).join("\n"); downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${prefix}_${localDate(new Date()).replaceAll("-", "")}.csv`); }
// CSV\uC640 \uD504\uB9AC\uC14B JSON\uC774 \uD568\uAED8 \uC4F4\uB2E4.
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
async function downloadAll() { const files = normalizeFiles(currentRow?.files), button = $("#download-all-btn"); if (!files.length) return; button.disabled = true; for (let i = 0; i < files.length; i += 1) { button.textContent = `다운로드 중... (${i + 1}/${files.length})`; window.open(files[i].url, "_blank", "noopener,noreferrer"); if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 700)); } button.textContent = `전체 다운로드 완료 (${files.length}건)`; button.disabled = false; }
async function getJson(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url}을 찾지 못했습니다.`); return response.json(); }
// CSV 파싱과 행 모델(예전 parseCsv/displayRow/planRow/guess)은 rows.js로 옮겼다. 워커도 같은 것을 쓴다.
function normalizeFiles(files) { return Array.isArray(files) ? files : []; } function numberOf(row) { return row.announcementNumber || ""; } function dateKey(value) { return Rows.dateKey(value); } function dateFormat(value) { const v = dateKey(value); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "-"; } function format(value) { return new Intl.NumberFormat("ko-KR").format(value); } function localDate(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; } function html(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
