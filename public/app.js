// Cloudflare Worker가 R2 데이터를 중계한다.
const $ = (s) => document.querySelector(s);
const Rows = self.GongRows;
const { numberOf, dateKey, dateFormat, format, localDate, html } = GongFormat;
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
const DEFAULT_PRESET = "기본";
// activePreset이 null이면 고급검색이 만든 임시 목록이다. 이때는 저장하지 않는다 — 자연어 질의가
// 사용자가 공들여 만든 프리셋을 조용히 덮어쓰면 되돌릴 방법이 없다.
let presets = [], activePreset = DEFAULT_PRESET, institutionList = [], searchTimer = null;
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
let page = 1;
const model = { filtered: [], fileIndex: [], dataSchemaVersion: "", searchVersion: 0, currentRow: null, currentAnalysis: null, viewMode: "pre" };
const modal = $("#file-modal");
const MODE_SUBTITLES = {
  pre: "로컬 CSV에 저장한 사전공고를 조회합니다.",
  bid: "로컬 CSV에 저장한 본공고를 조회합니다.",
  // 발주계획 API는 구간 조회가 없다. 매 수집이 "지금 게시된 계획"만 떠 오므로 보유 범위는
  // 수집을 시작한 시점부터 쌓인다(collector.js의 snapshot 주석).
  plan: "수집 시점부터 쌓아 온 발주계획을 조회합니다. 게시일은 나라장터에 계획이 올라온 날입니다.",
};
const MODE_NAMES = { pre: "사전공고", bid: "본공고", plan: "발주계획" };


// 기능 모듈 조립. 요청 세대·취소 상태는 각 모듈 인스턴스에 속한다.
const resetPage = () => { page = 1; };
const { getJson } = GongHttp;
const { modalSubtitle, detailLink, attachmentWarnings, planLinks, fileBadge,
  renderBidSchedule, normalizeFiles, wireEcrEntrypoints } =
  GongNoticeView.createNoticeView({ html, numberOf, format, document, openModal: (...args) => openModal(...args) });
const { loadIndex } = GongIndex.createIndex({ model, $, getJson, renderDataStatus, defaultRange });
const scanner = GongScan.createScanner({ model });
const { applyFilters } = GongSearch.createSearch({
  model, $, scanner, renderRows, collectInstitutions, todayFile, MODE_NAMES, format, numberOf
});
const { startRefresh, resumeRefresh } = GongRefresh.createRefresh({
  model, $, getJson, totalCount, dataRange, loadIndex, format, resetPage, applyFilters
});
const { runNlQuery } = GongNlQuery.createNlQuery({
  model, $, collectInstitutions, setNl, applyNlFilter, applyFilters, resetPage
});
const ecrState = { ecrBusy: false, aiUnlocked: false, ecrRun: 0 };
const { showAiAccess, refreshAiAccess, unlockAiAccess, lockAiAccess } =
  GongAiAccess.createAiAccess({ $, state: ecrState });
const { renderEcr } = GongEcrView.createEcrView({ $, html });
const { loadEcr, stopEcrAnalysis, startEcrAnalysis } = GongEcr.createEcr({
  model, state: ecrState, $, numberOf, renderEcr, showAiAccess
});
const { openModal, closeModal, selectTab, modalKeydown } = GongModal.createModal({
  model, $, modal, html, normalizeFiles, modalSubtitle, detailLink,
  attachmentWarnings, planLinks, renderBidSchedule, stopEcrAnalysis, refreshAiAccess, loadEcr
});
const { downloadCsv, downloadEcr, downloadAll } = GongExports.createExports({
  model, $, downloadRows, MODE_NAMES, normalizeFiles, numberOf
});
$("#ai-unlock-form").onsubmit = unlockAiAccess;
$("#ai-lock-btn").onclick = lockAiAccess;
$("#ecr-stop-btn").onclick = stopEcrAnalysis;
$("#ecr-upload-form").onsubmit = startEcrAnalysis;
function modeOf(file) { return file.mode || String(file.path || "").split("/")[0]; }

if (location.protocol === "file:") { $("#status").textContent = "배포된 서비스 주소에서 접속해 주세요."; renderRows([]); }
else { loadIndex(true).then(({ changed, stale }) => { if (!stale) return applyFilters({ revalidateRecent: changed }); }).catch((error) => { $("#status").textContent = error.message; renderRows([]); }); resumeRefresh(); }

// 실제 인덱스의 가장 이른 날짜를 조회 범위로 사용한다.
// 날짜 입력의 min으로 그 바닥을 알려 준다. max는 두지 않는다 — 오늘치 파일이 아직 없어도
// /api/live가 최신 공고를 얹으므로 오늘을 고를 수 있어야 한다.
function renderDataStatus(index) {
  const { begin, end } = dataRange(), total = totalCount();
  if (begin) {
    $("#begin").min = begin;
    $("#end").min = begin;
  }
  $("#data-range").textContent = end ? `${begin} ~ ${end}` : "\uC5C6\uC74C";
  $("#data-count").textContent = end ? `${format(model.fileIndex.length)}\uAC1C \uD30C\uC77C \xB7 ${format(total)}\uAC74` : "";
  $("#last-crawl").textContent = `\uB9C8\uC9C0\uB9C9 \uD06C\uB864\uB9C1 ${stamp(index?.updatedAt)}`;
  $("#updated-at").textContent = `updated ${stamp(index?.updatedAt)}`;
  renderTodaySummary();
}

// 공고 데이터와 자연어 검색 서버 모두 한국시간 날짜를 사용한다.
function today() { return GongDates.kstDate(); }
function todayKey() { return today().replaceAll("-", ""); }
function isToday(value) { return dateKey(value) === todayKey(); }
// 일별 인덱스 항목은 begin === end === 그 날짜다(collector/store.js의 indexEntry).
// 그래서 파일을 하나도 내려받지 않고 오늘 건수를 세 모드 모두 셀 수 있다.
function todayFile(mode) { const date = today(); return model.fileIndex.find((file) => modeOf(file) === mode && file.begin === date && file.end === date); }
// 오늘 건수는 레일의 유형 줄에 붙는다. 버튼은 index.html에 고정으로 있고 여기서는 숫자만
// 갈아 끼운다 — 매번 다시 그리면 클릭 핸들러도 매번 다시 걸어야 한다.
function renderTodaySummary() {
  const box = $("#today-summary");
  box.hidden = !model.fileIndex.length;
  if (model.fileIndex.length) box.textContent = `오늘 ${today()}`;
  document.querySelectorAll(".today-jump").forEach((button) => {
    const file = todayFile(button.dataset.mode);
    button.textContent = model.fileIndex.length && file ? format(Number(file.count) || 0) : "-";
    button.title = `게시일을 오늘 하루로 좁혀 ${MODE_NAMES[button.dataset.mode]}를 봅니다`;
  });
}
// 게시일을 오늘 하루로 좁힌다. 모드를 함께 주면 그 모드로 갈아탄 뒤 한 번만 조회한다.
function jumpToToday(mode) {
  $("#begin").value = today(); $("#end").value = today();
  if (mode && mode !== model.viewMode) { setMode(mode); closeModal(); }
  page = 1; applyFilters();
}
// 항목이 구간이 된 뒤로 "며칠치"는 인덱스만으로 셀 수 없다(월별 봉인 항목 하나가 한 달을
// 덮는다). 보유 범위는 begin의 최소·end의 최대로 낸다.
function dataRange() { const begins = model.fileIndex.map((file) => file.begin).filter(Boolean).sort(), ends = model.fileIndex.map((file) => file.end).filter(Boolean).sort(); return { begin: begins[0] || "", end: ends.at(-1) || "" }; }
function totalCount() { return model.fileIndex.reduce((sum, file) => sum + (Number(file.count) || 0), 0); }
function stamp(value) { const date = new Date(value), pad = (part) => String(part).padStart(2, "0"); return value && !Number.isNaN(date.valueOf()) ? `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : "-"; }

$("#search").onclick = () => { page = 1; applyFilters(); }; $("#reset").onclick = () => { ["#q", "#business-type", "#nl-query"].forEach((s) => { $(s).value = ""; }); $("#inst-loose").checked = false; setNl(false, ""); defaultRange(); page = 1; applyFilters(); }; $("#q").onkeydown = (event) => { if (event.key === "Enter") { page = 1; applyFilters(); } };
// 사전공고/본공고는 조회 조건이 아니라 레일의 유형 목록으로 전환한다. 초기화 버튼은 건드리지 않는다.
// 오늘 건수는 같은 줄에 있지만 별개의 버튼이라 여기 걸린 위임에 잡히지 않는다(제 핸들러가 있다).
$("#mode-toggle").onclick = (event) => { const button = event.target.closest(".mode-toggle-btn"); if (button && button.dataset.mode !== model.viewMode) applyMode(button.dataset.mode); };
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
function setMode(key) {
  model.viewMode = key;
  document.querySelectorAll(".mode-toggle-btn").forEach((button) => {
    const active = button.dataset.mode === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.parentElement.classList.toggle("active", active);
  });
  $("#app-subtitle").textContent = MODE_SUBTITLES[key];
  $("#close-col").textContent = key === "plan" ? "\uBC1C\uC8FC\uC608\uC815" : "\uB9C8\uAC10\uC77C";
}
function applyMode(key) { setMode(key); closeModal(); page = 1; applyFilters(); }
$("#previous").onclick = () => { if (page > 1) { page -= 1; renderRows(model.filtered); } }; $("#next").onclick = () => { if (page * pageSize < model.filtered.length) { page += 1; renderRows(model.filtered); } }; $("#download-btn").onclick = downloadCsv; $("#download-ecr-btn").onclick = downloadEcr;
$("#refresh-btn").onclick = startRefresh; $("#menu-refresh").onclick = startRefresh;
$("#page-size").onchange = () => { pageSize = Number($("#page-size").value) || 50; page = 1; renderRows(model.filtered); };
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
  const toggle = $("#inst-edit-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "프리셋 닫기" : "프리셋 열기";
  toggle.classList.toggle("active", open);
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
$("#modal-close").onclick = closeModal; modal.onclick = (event) => { if (event.target === modal) closeModal(); }; document.onkeydown = modalKeydown; $("#download-all-btn").onclick = downloadAll;
document.querySelectorAll(".modal-tab").forEach((button) => button.onclick = () => selectTab(button.dataset.tab));

function defaultRange() { const last = dataRange().end; if (!last) return; $("#begin").value = GongDates.shiftDay(last, -6); $("#end").value = last; }

// 고급검색. Worker의 Workers AI가 자연어를 조회 조건으로만 바꾸고, 조회 자체는 평소와 똑같이
// 워커 스캔이 한다 — 데이터가 R2의 gzip CSV 수십만 건이라 모델에 먹일 수 있는 대상이 아니다.
$("#advanced-toggle").onclick = () => { const panel = $("#advanced-panel"), open = panel.hidden; panel.hidden = !open; $("#advanced-toggle").setAttribute("aria-pressed", String(open)); $("#advanced-toggle").classList.toggle("active", open); if (open) $("#nl-query").focus(); };
$("#nl-run").onclick = runNlQuery;
$("#nl-query").onkeydown = (event) => { if (event.key === "Enter") runNlQuery(); };
function setNl(busy, text, kind = "") {
  const button = $("#nl-run"), box = $("#nl-status");
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? "\uD574\uC11D \uC911\u2026" : "\uD574\uC11D\uD574\uC11C \uC870\uD68C";
  box.hidden = !text;
  box.className = `nl-status ${kind}`.trim();
  box.textContent = text || "";
}
// 해석 결과를 실제 컨트롤에 그대로 채운다. 사용자가 무엇으로 검색됐는지 눈으로 보고 고칠 수 있어야 한다.
function applyNlFilter(state) {
  const filter = state.filter || {}, notes = [...(state.notes || [])];
  if (filter.mode && MODE_NAMES[filter.mode] && filter.mode !== model.viewMode) { setMode(filter.mode); closeModal(); }
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
  if (!model.fileIndex.some((file) => modeOf(file) === model.viewMode && file.end >= $("#begin").value && file.begin <= $("#end").value)) notes.push(`${MODE_NAMES[model.viewMode]}에는 이 기간의 보유 데이터가 없습니다.`);
  setNl(false, [`해석: ${state.explain || "-"}`, ...notes].join(" · "), "done");
}
function renderRows(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages);
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  $("#result-summary").textContent = `${format(rows.length)}\uAC74`;
  $("#page-label").textContent = `${page} / ${pages}`;
  $("#previous").disabled = page === 1;
  $("#next").disabled = page === pages;
  $("#download-btn").disabled = !rows.length;
  $("#results").innerHTML = visible.length ? visible.map((row, i) => {
    const files = normalizeFiles(row.files);
    return `<tr><td>${html(numberOf(row))}</td><td>${html(row.businessType)}</td><td>${html(row.institution)}</td><td class="title"><button class="title-link" data-index="${i}" type="button">${html(row.title || "(\uC0AC\uC5C5\uBA85 \uC5C6\uC74C)")}</button>${row.live ? '<span class="live-badge">\uCD5C\uC2E0 \uD655\uC778</span>' : ""}${fileBadge(row, files)}</td><td>${dateFormat(row.publishedAt)}${isToday(row.publishedAt) ? '<span class="today-badge">\uC624\uB298</span>' : ""}</td><td>${row.mode === "plan" ? html(row.orderMonth || "-") : dateFormat(row.closeAt)}</td></tr>`;
  }).join("") : $("#empty-row").innerHTML;
  document.querySelectorAll(".title-link").forEach((button) => button.onclick = () => openModal(visible[Number(button.dataset.index)]));
  wireEcrEntrypoints(visible);
  wireEmptyRefresh();
}
// 빈 결과 안내에도 갱신 버튼이 있다. 템플릿을 통째로 다시 그리므로 매번 다시 걸고, 지금
// 갱신이 도는 중이면 레일의 버튼과 같이 잠가 둔다 — 둘을 눌러 두 번 dispatch되면 안 된다.
function wireEmptyRefresh() { document.querySelectorAll(".empty-refresh").forEach((button) => { button.onclick = startRefresh; button.disabled = $("#refresh-btn").disabled; button.textContent = $("#refresh-btn").textContent; }); }
function downloadRows(rows, prefix) {
  const csv = GongCsv.serialize(rows);
  downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${prefix}_${localDate(/* @__PURE__ */ new Date()).replaceAll("-", "")}.csv`);
}
// CSV\uC640 \uD504\uB9AC\uC14B JSON\uC774 \uD568\uAED8 \uC4F4\uB2E4.
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
