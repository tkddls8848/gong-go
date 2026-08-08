// DATA_BASE는 절대경로다. 배포본(Cloudflare Pages)에서는 functions/data/[[path]].js가 R2를
// 중계하고, 로컬에서는 devserver가 저장소 루트를 서빙하므로 같은 경로가 data/를 가리킨다.
const $ = (s) => document.querySelector(s), DATA_BASE = "/data", REFRESH_API = "/api/refresh", POLL_MS = 2000, LOAD_CONCURRENCY = 12, MAX_ROWS = 200000;
let pageSize = 50;
// main 브랜치와 동일한 기본 관심 기관 목록. 코드를 비우면 기관명 정확 일치로 조회한다.
const DEFAULT_INSTITUTIONS = [
  { name: "국민건강보험공단", code: "" }, { name: "건강보험심사평가원", code: "" }, { name: "국민건강보험공단 일산병원", code: "" },
  { name: "보건복지부", code: "" }, { name: "한국사회보장정보원", code: "" }, { name: "국민연금공단", code: "" },
  { name: "한국고용정보원", code: "" }, { name: "재단법인자동차손해배상진흥원", code: "" }, { name: "공영홈쇼핑", code: "" },
];
const norm = (value) => String(value ?? "").replace(/\s+/g, "").trim();
// 관심 기관은 브라우저 localStorage에 보관한다. 정적 배포라 서버에 사용자별 저장소가 없다.
const INST_STORAGE_KEY = "gong-go:institutions";
let institutionList = loadInstitutions(), searchTimer = null;
function loadInstitutions() {
  try { const saved = JSON.parse(localStorage.getItem(INST_STORAGE_KEY)); if (Array.isArray(saved)) return saved.map((inst) => ({ name: String(inst?.name || ""), code: String(inst?.code || "") })).filter((inst) => inst.name || inst.code); } catch {}
  return DEFAULT_INSTITUTIONS.map((inst) => ({ ...inst }));
}
function saveInstitutions() { try { localStorage.setItem(INST_STORAGE_KEY, JSON.stringify(institutionList)); } catch {} }
let records = [], filtered = [], fileIndex = [], page = 1, searchVersion = 0, currentRow = null, currentAnalysis = null, viewMode = "pre";
const analyses = new Map(), modal = $("#file-modal");
const MODE_SUBTITLES = { pre: "로컬 CSV에 저장한 사전공고를 조회합니다.", bid: "로컬 CSV에 저장한 본공고를 조회합니다." };

if (location.protocol === "file:") { $("#status").textContent = "CSV 조회는 웹 서버에서만 가능합니다. 저장소 루트에서 npm run serve 실행 후 http://localhost:8788/public/ 를 여세요."; renderRows([]); }
else { loadIndex(true).then(applyFilters).catch((error) => { $("#status").textContent = error.message; renderRows([]); }); resumeRefresh(); }

// index.json은 갱신 직후에도 최신이어야 하므로 매번 캐시를 우회한다. 파일 1개라 호출량에
// 영향이 없다. 반대로 .csv.gz에는 캐시 무효화 토큰을 붙이지 않는다 — 쿼리스트링은 브라우저
// 캐시 키의 일부라, 수집이 끝날 때마다 모든 파일 URL이 새 URL이 되어 캐시가 통째로 날아간다.
// 과거 파일이 굳지 않게 하는 일은 서버가 ETag와 날짜별 Cache-Control로 이미 하고 있다
// (배포본은 functions/data/[[path]].js, 로컬은 devserver가 no-store).
async function loadIndex(initial) {
  const [index, analysis] = await Promise.all([getJson(`${DATA_BASE}/index.json?t=${Date.now()}`), getJson(`${DATA_BASE}/analysis-index.json`).catch(() => ({ entries: [] }))]);
  // 항목 스키마는 {mode, begin, end, path, count}다. 일별 항목은 begin === end이고 월별
  // 봉인 항목은 한 달을 덮는다. 구 인덱스({date})가 남아 있어도 읽히도록 여기서 메운다.
  fileIndex = (index.files || []).map((file) => ({ ...file, begin: file.begin || file.date, end: file.end || file.date }));
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
function applyMode(key) { viewMode = key; document.querySelectorAll(".mode-toggle-btn").forEach((button) => { const active = button.dataset.mode === key; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); }); $("#app-subtitle").textContent = MODE_SUBTITLES[key]; closeModal(); page = 1; applyFilters(); }
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
function collectInstitutions() { return institutionList.filter((inst) => inst.name || inst.code); }
// 사전공고 CSV에는 기관 코드 컬럼이 없다. 코드만 지정된 행은 본공고에서만 매칭된다.
function matchesInstitutions(row, list) {
  if (!list.length) return true;
  const name = norm(row.institution), code = String(row.dminsttCd || "").trim();
  return list.some((inst) => (inst.code && code) ? code === inst.code : inst.name ? norm(inst.name) === name : false);
}
$("#modal-close").onclick = closeModal; modal.onclick = (event) => { if (event.target === modal) closeModal(); }; document.onkeydown = (event) => { if (event.key === "Escape") closeModal(); }; $("#download-all-btn").onclick = downloadAll;
document.querySelectorAll(".modal-tab").forEach((button) => button.onclick = () => selectTab(button.dataset.tab));

// 보유 데이터가 수천 개 파일로 늘어난 뒤로는 전체를 한꺼번에 fetch할 수 없다.
// (1) 동시 요청을 LOAD_CONCURRENCY로 묶고 (2) 파일을 읽는 즉시 필터링해 일치 행만 남긴다.
// 전부 메모리에 올린 뒤 거르면 수백만 행에서 브라우저가 죽는다.
async function applyFilters() {
  const version = ++searchVersion, q = $("#q").value.trim().toLowerCase(), mode = viewMode, type = $("#business-type").value;
  const begin = $("#begin").value || "0000-01-01", end = $("#end").value || "9999-12-31";
  // 항목의 구간과 조회 구간이 겹치면 받는다. 월별 봉인 항목은 한 달을 통째로 끌어오지만,
  // 아래 match()가 행 단위로 다시 거르므로 결과는 정확하다 — 오버페치는 전송량 문제일 뿐이다.
  const files = fileIndex.filter((file) => file.end >= begin && file.begin <= end);
  const from = begin.replaceAll("-", ""), to = end.replaceAll("-", ""), institutions = collectInstitutions();
  const match = (row) => { const date = dateKey(row.publishedAt); return (!mode || mode === row.mode) && (!type || type === row.businessType) && matchesInstitutions(row, institutions) && (!q || `${numberOf(row)} ${row.institution} ${row.title}`.toLowerCase().includes(q)) && date >= from && date <= to; };

  const collected = []; let cursor = 0, done = 0, scanned = 0, failures = 0, capped = false;
  const progress = () => { $("#status").textContent = `${format(files.length)}개 일자별 CSV 중 ${format(done)}개 처리 · ${format(collected.length)}건 일치`; };
  progress();
  const worker = async () => {
    while (cursor < files.length && !capped) {
      if (version !== searchVersion) return;
      const file = files[cursor++];
      try { const rows = await getGzipCsv(`${DATA_BASE}/${file.path}`); scanned += rows.length; for (const row of rows) if (match(row)) collected.push(row); }
      catch { failures += 1; }
      done += 1;
      if (collected.length >= MAX_ROWS) capped = true;
      if (done % 40 === 0) { progress(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, files.length || 1) }, worker));
  if (version !== searchVersion) return;

  records = collected;
  filtered = collected.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const parts = [`${format(files.length)}개 CSV에서 ${format(scanned)}건을 읽어 ${format(filtered.length)}건이 조건에 맞습니다.`];
  parts.push(institutions.length ? `관심 기관 ${institutions.length}곳으로 좁혔습니다.` : "기관 목록이 비어 있어 전체 기관을 조회했습니다.");
  if (capped) parts.push(`표시 한도 ${format(MAX_ROWS)}건에 도달해 나머지 파일은 읽지 않았습니다. 기간을 좁히거나 관심 기관을 지정하세요.`);
  if (failures) parts.push(`${format(failures)}개 파일을 읽지 못했습니다.`);
  $("#status").textContent = parts.join(" ");
  renderRows(filtered);
}
function defaultRange() { const last = dataRange().end; if (!last) return; const end = new Date(`${last}T00:00:00`), begin = new Date(end); begin.setDate(begin.getDate() - 6); $("#begin").value = localDate(begin); $("#end").value = last; }

// 갱신은 로컬 개발 서버(npm run serve)의 /api/refresh가 수집기를 돌리는 방식이다.
// 정적 배포본에는 이 엔드포인트가 없으므로 버튼은 안내 문구만 남기고 실패한다.
async function startRefresh() {
  setRefresh(true, "갱신을 시작하는 중입니다.");
  try {
    const response = await fetch(REFRESH_API, { method: "POST" }), state = await response.json().catch(() => ({}));
    if (response.status === 404 || response.status === 501) throw new Error("갱신 API가 없습니다. 저장소 루트에서 npm run serve로 로컬 개발 서버를 실행한 뒤 다시 시도하세요.");
    if (!response.ok && response.status !== 409) throw new Error(state.message || `갱신 요청이 실패했습니다 (${response.status}).`);
  } catch (error) { setRefresh(false, error.message, "error"); return; }
  pollRefresh();
}
function resumeRefresh() { getJson(REFRESH_API).then((state) => { if (state.running) { setRefresh(true, refreshText(state)); pollRefresh(); } }).catch(() => {}); }
async function pollRefresh() {
  for (;;) {
    let state;
    try { state = await getJson(REFRESH_API); } catch (error) { setRefresh(false, `갱신 상태를 확인하지 못했습니다: ${error.message}`, "error"); return; }
    if (!state.running) return finishRefresh(state);
    setRefresh(true, refreshText(state));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
async function finishRefresh(state) {
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
function renderRows(rows) { const pages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, pages); const visible = rows.slice((page - 1) * pageSize, page * pageSize); $("#result-summary").textContent = `${format(rows.length)}건`; $("#page-label").textContent = `${page} / ${pages}`; $("#previous").disabled = page === 1; $("#next").disabled = page === pages; $("#download-btn").disabled = !rows.length; $("#download-ecr-btn").disabled = !analyses.size; $("#results").innerHTML = visible.length ? visible.map((row, i) => { const files = normalizeFiles(row.files), analysis = analyses.get(numberOf(row)); return `<tr><td><span class="badge ${row.mode}">${row.mode === "pre" ? "사전공고" : "본공고"}</span></td><td>${html(numberOf(row))}</td><td>${html(row.businessType)}</td><td>${html(row.institution)}</td><td class="title"><button class="title-link" data-index="${i}" type="button">${html(row.title || "(사업명 없음)")}</button><span class="file-badge ${files.length ? "" : "empty"}">${files.length ? `첨부 ${files.length}` : "첨부 0"}</span>${analysis ? `<span class="ecr-badge ${analysis.verified ? "" : "warning"}">ECR ${analysis.ecrCount}${analysis.verified ? "" : " · 확인 필요"}</span>` : ""}</td><td>${dateFormat(row.publishedAt)}</td><td>${dateFormat(row.closeAt)}</td></tr>`; }).join("") : $("#empty-row").innerHTML; document.querySelectorAll(".title-link").forEach((button) => button.onclick = () => openModal(visible[Number(button.dataset.index)])); }
function openModal(row) { currentRow = row; currentAnalysis = null; const files = normalizeFiles(row.files), entry = analyses.get(numberOf(row)); $("#modal-title").textContent = row.title || "(사업명 없음)"; $("#modal-subtitle").textContent = `${row.institution || "-"} · ${row.businessType || "-"} · 번호 ${numberOf(row) || "-"} · 첨부 ${files.length}건`; $("#modal-file-list").innerHTML = files.length ? files.map((file, i) => `<li><span class="file-no">${i + 1}.</span><a href="${html(file.url)}" target="_blank" rel="noopener noreferrer">${html(file.name)}</a></li>`).join("") : '<li><span class="empty-msg">이 공고에는 API로 제공되는 첨부파일이 없습니다.</span></li>'; $("#download-all-btn").disabled = !files.length; $("#download-all-btn").textContent = files.length ? `전체 다운로드 (${files.length}건)` : "전체 다운로드"; $("#ecr-tab").disabled = !entry; $("#ecr-tab").textContent = entry ? `ECR 규격 (${entry.ecrCount})` : "ECR 규격"; $("#ecr-content").innerHTML = entry ? '<p class="hint">ECR 규격을 불러오려면 탭을 선택하세요.</p>' : '<p class="hint">이 공고에는 분석된 ECR 규격이 없습니다.</p>'; selectTab("files"); modal.style.display = "flex"; }
function closeModal() { modal.style.display = "none"; currentRow = null; currentAnalysis = null; }
function selectTab(tab) { document.querySelectorAll(".modal-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab)); $("#files-content").hidden = tab !== "files"; $("#ecr-content").hidden = tab !== "ecr"; if (tab === "ecr") loadEcr(); }
async function loadEcr() { const entry = analyses.get(numberOf(currentRow)); if (!entry) return; if (!currentAnalysis) { $("#ecr-content").innerHTML = '<p class="hint">ECR 규격을 불러오는 중입니다.</p>'; try { currentAnalysis = await getJson(`${DATA_BASE}/${entry.path}`); } catch (error) { $("#ecr-content").innerHTML = `<p class="warning-text">ECR 규격을 불러오지 못했습니다: ${html(error.message)}</p>`; return; } } renderEcr(currentAnalysis); }
function renderEcr(data) { const alerts = [...(data.누락 || []).map((id) => `누락: ${id}`), ...(data.verification?.errors || []), ...(data.ecr || []).flatMap((item) => (item.불확실 || []).map((text) => `${item.id}: ${text}`))]; const rows = (data.ecr || []).map((item, i) => `<tr class="ecr-row" data-index="${i}"><td>${html(item.id)}</td><td>${html(item.분류)}</td><td>${html(item.명칭)}</td><td>${html((item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", ") || "-")}</td><td>${html((item.산출물 || []).join(", ") || "-")}</td></tr><tr id="detail-${i}" class="ecr-detail" hidden><td colspan="5"><p><strong>세부내용 원문</strong></p><div class="detail-text">${html(item.세부내용_원문 || "-")}</div>${specTable(item.기본규격 || [])}</td></tr>`).join(""); $("#ecr-content").innerHTML = `${alerts.length ? `<div class="ecr-alert">${alerts.map(html).join("<br>")}</div>` : ""}<p class="ecr-status ${data.verified ? "verified" : "unverified"}">${data.verified ? "자동 검증 통과" : "자동 검증 미통과 — 원문 확인 필요"}</p><div class="ecr-scroll"><table class="ecr-table"><thead><tr><th>ID</th><th>분류</th><th>명칭</th><th>수량</th><th>산출물</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">추출된 ECR이 없습니다.</td></tr>'}</tbody></table></div>`; document.querySelectorAll(".ecr-row").forEach((row) => row.onclick = () => { const detail = $(`#detail-${row.dataset.index}`); detail.hidden = !detail.hidden; row.classList.toggle("expanded", !detail.hidden); }); }
function specTable(specs) { return specs.length ? `<p><strong>기본규격</strong></p><table class="nested-spec"><thead><tr><th>구분</th><th>항목</th><th>요구사항</th><th>수량</th></tr></thead><tbody>${specs.map((spec) => `<tr><td>${html(spec.구분)}</td><td>${html(spec.항목)}</td><td>${html(spec.요구사항)}</td><td>${html(spec.수량)}</td></tr>`).join("")}</tbody></table>` : ""; }
function downloadCsv() { downloadRows([["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일", "첨부파일"], ...filtered.map((row) => [row.mode === "pre" ? "사전공고" : "본공고", numberOf(row), row.businessType, row.institution, row.title, row.publishedAt, row.closeAt, normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | ")])], "gong-go"); }
async function downloadEcr() { const rows = [["공고번호", "사업명", "ID", "분류", "명칭", "수량", "산출물", "세부내용 원문", "검증"]]; for (const row of filtered) { const entry = analyses.get(numberOf(row)); if (!entry) continue; try { const data = await getJson(`${DATA_BASE}/${entry.path}`); (data.ecr || []).forEach((item) => rows.push([numberOf(row), row.title, item.id, item.분류, item.명칭, (item.기본규격 || []).map((spec) => spec.수량).filter(Boolean).join(", "), (item.산출물 || []).join(", "), item.세부내용_원문, data.verified ? "통과" : "원문 확인 필요"])); } catch {} } downloadRows(rows, "gong-go-ecr"); }
function downloadRows(rows, prefix) { const csv = rows.map((row) => row.map((value) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }).join(",")).join("\n"), blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `${prefix}_${localDate(new Date()).replaceAll("-", "")}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
async function downloadAll() { const files = normalizeFiles(currentRow?.files), button = $("#download-all-btn"); if (!files.length) return; button.disabled = true; for (let i = 0; i < files.length; i += 1) { button.textContent = `다운로드 중... (${i + 1}/${files.length})`; window.open(files[i].url, "_blank", "noopener,noreferrer"); if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 700)); } button.textContent = `전체 다운로드 완료 (${files.length}건)`; button.disabled = false; }
async function getJson(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url}을 찾지 못했습니다.`); return response.json(); } async function getGzipCsv(url) { const response = await fetch(url); if (!response.ok || !response.body) throw new Error(`${url} 응답 오류 (${response.status})`); return parseCsv(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text()); }
function parseCsv(text) { const lines = csvLines(text.replace(/^\uFEFF/, "")), header = lines.shift() || []; return lines.map((cells) => displayRow(Object.fromEntries(header.map((key, i) => [key, unformula(cells[i] || "")])))); } function unformula(value) { return value.charCodeAt(0) !== 61 ? value : value[1] === '"' && value.at(-1) === '"' ? value.slice(2, -1) : value.slice(1); } function csvLines(text) { const rows = []; let row = [], i = 0, pending = false; while (i < text.length) { let cell = ""; if (text[i] === '"') { i += 1; while (i < text.length) { if (text[i] === '"' && text[i + 1] === '"') { cell += '"'; i += 2; } else if (text[i] === '"') { i += 1; break; } else cell += text[i++]; } } else { while (i < text.length && !",\r\n".includes(text[i])) cell += text[i++]; } row.push(cell); pending = true; if (text[i] === ",") { i += 1; continue; } if (text[i] === "\r") i += 1; if (text[i] === "\n") i += 1; if (row.some(Boolean)) rows.push(row); row = []; pending = false; } if (pending) rows.push(row); return rows; }
function displayRow(row) { if (row.mode) return { ...row, files: json(row.files, []) }; const pre = !row.bidNtceNo, prefix = pre ? "specDocFileUrl" : "ntceSpecDocUrl", count = pre ? 5 : 10; return { ...row, mode: pre ? "pre" : "bid", announcementNumber: pre ? row.bfSpecRgstNo || "" : row.bidNtceNo || "", institution: row.rlDminsttNm || row.dminsttNm || "", businessType: pre ? row.bsnsDivNm || "" : row.ntceKindNm || "", title: row.prdctClsfcNoNm || row.bidNtceNm || "", publishedAt: row.rgstDt || row.bidNtceDt || "", closeAt: row.opninRgstClseDt || row.bidClseDt || "", files: Array.from({ length: count }, (_, i) => row[`${prefix}${i + 1}`]).filter(Boolean) }; } function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } } function normalizeFiles(files) { return (Array.isArray(files) ? files : []).map((file, i) => typeof file === "string" ? { url: file, name: guess(file, i) } : { url: file.url || "", name: file.name || guess(file.url, i) }).filter((file) => /^https?:/i.test(file.url)); } function guess(url, i) { try { const q = new URL(url).searchParams; return decodeURIComponent(q.get("fileNm") || q.get("orgFileNm") || q.get("fileName") || `첨부파일 ${i + 1}`); } catch { return `첨부파일 ${i + 1}`; } } function numberOf(row) { return row.announcementNumber || ""; } function dateKey(value) { return String(value || "").replace(/\D/g, "").slice(0, 8); } function dateFormat(value) { const v = dateKey(value); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "-"; } function format(value) { return new Intl.NumberFormat("ko-KR").format(value); } function localDate(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; } function html(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
