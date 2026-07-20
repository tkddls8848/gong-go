// ============================================================
// app.js — 엔진(날짜·동시성·네트워크) + UI(DOM·모달·표·토글) 배선
//  · 앱 골격이라 자주 바뀌지 않음. 상수·API 모드 변경은 config.js 참고
//  · config.js가 먼저 로드되어 상수 / MODES / currentMode / norm / guessFileName 을 전역 제공
// ============================================================
 
const pad2 = (n) => String(n).padStart(2, "0");
 
// ============================================================
// DOM 참조
// ============================================================
const appTitle = document.getElementById("app-title");
const appSubtitle = document.getElementById("app-subtitle");
const periodLabel = document.getElementById("period-label");
const resultsHintEl = document.getElementById("results-hint");
 
const modeToggle = document.getElementById("mode-toggle");
const modeToggleBtns = modeToggle.querySelectorAll(".mode-toggle-btn");
 
const institutionsBody = document.getElementById("institutions-body");
const addRowBtn = document.getElementById("add-row-btn");
const searchBtn = document.getElementById("search-btn");
const statusArea = document.getElementById("status-area");
const resultsPanel = document.getElementById("results-panel");
const resultsBody = document.getElementById("results-body");
const downloadBtn = document.getElementById("download-btn");
const beginDateInput = document.getElementById("begin-date");
const endDateInput = document.getElementById("end-date");
const titleFilterInput = document.getElementById("title-filter");
const noticeNoInput = document.getElementById("notice-no-filter");
 
const fileModal = document.getElementById("file-modal");
const modalTitle = document.getElementById("modal-title");
const modalSubtitle = document.getElementById("modal-subtitle");
const modalFileList = document.getElementById("modal-file-list");
const modalClose = document.getElementById("modal-close");
const downloadAllBtn = document.getElementById("download-all-btn");
 
let lastResultRows = [];
let currentModalRow = null;
 
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
 
// ============================================================
// 날짜 유틸
// ============================================================
function toDateInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
 
function toYmd(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}
 
function parseDateValue(v) {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d);
}
 
function addDays(date, n) {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}
 
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000) + 1; // 양끝 포함
}
 
// ============================================================
// 조회 기간
// ============================================================
function initDateRange() {
  const now = new Date();
  const weekAgo = addDays(now, -6);
  endDateInput.value = toDateInputValue(now);
  beginDateInput.value = toDateInputValue(weekAgo);
  endDateInput.max = toDateInputValue(now);
  beginDateInput.max = toDateInputValue(now);
}
 
function resolveDateRange() {
  const beginVal = beginDateInput.value;
  const endVal = endDateInput.value;
 
  if (!beginVal || !endVal) {
    return { error: "조회 시작일과 종료일을 모두 지정해주세요." };
  }
  if (beginVal > endVal) {
    return { error: "조회 시작일이 종료일보다 늦습니다." };
  }
 
  const now = new Date();
  const todayVal = toDateInputValue(now);
  if (endVal > todayVal) {
    return { error: "종료일은 오늘 이후로 지정할 수 없습니다." };
  }
 
  return {
    beginDate: parseDateValue(beginVal),
    endDate: parseDateValue(endVal),
    todayVal,
    label: `${beginVal} ~ ${endVal}`,
  };
}
 
function endTimeFor(date, todayVal) {
  if (toDateInputValue(date) === todayVal) {
    const now = new Date();
    return `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  }
  return "2359";
}
 
function buildDateChunks(beginDate, endDate, chunkDays, todayVal) {
  const chunks = [];
  let cursor = new Date(beginDate);
 
  while (cursor <= endDate) {
    let chunkEnd = addDays(cursor, chunkDays - 1);
    if (chunkEnd > endDate) chunkEnd = new Date(endDate);
 
    chunks.push({ begin: new Date(cursor), end: new Date(chunkEnd), todayVal });
    cursor = addDays(chunkEnd, 1);
  }
 
  return chunks;
}
 
// ============================================================
// 동시 실행 워커 풀 (결과는 입력 순서 그대로 반환)
// ============================================================
async function runPool(tasks, limit, onProgress) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  let done = 0;
 
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { items: [], error: `요청 실패 (${e.message})` };
      }
      done++;
      if (onProgress) onProgress(done, tasks.length);
    }
  }
 
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}
 
// ============================================================
// 나라장터 API 호출 (단일 기간) - 현재 모드 설정 사용
// ============================================================
async function fetchNotices(mode, operation, inst, inqryBgnDt, inqryEndDt, filters) {
  const allItems = [];
  let pageNo = 1;
  let totalPages = 1;

  while (pageNo <= totalPages) {
    const params = new URLSearchParams({
      type: "json",
      pageNo: String(pageNo),
      numOfRows: String(NUM_OF_ROWS),
      inqryDiv: mode.inqryDiv,
      inqryBgnDt,
      inqryEndDt,
    });

    if (inst.code) {
      params.set("dminsttCd", inst.code);
    } else {
      params.set("dminsttNm", inst.name);
    }

    // 조회조건 개별 필터(사업명/공고번호)를 지원 API 파라미터로 전달
    for (const [uiKey, def] of Object.entries(mode.searchFields || {})) {
      const val = filters && filters[uiKey];
      if (val) params.set(def.param, val);
    }

    const url = `${mode.baseUrl}/${operation}?${params.toString()}`;
 
    let data;
    let lastError = "";
    let receivedResponse = false;

    // Cloudflare Pages can receive a transient 504 from the upstream API when
    // several institution/date requests are in flight. Retry those responses
    // before treating this institution/date chunk as failed.
    for (let attempt = 0; attempt <= API_RETRY_COUNT; attempt += 1) {
      try {
        const resp = await fetch(url);
        data = await resp.json();
        receivedResponse = true;

        const upstreamStatus = Number(data?.upstreamStatus || 0);
        const retryable =
          resp.status === 429 ||
          resp.status >= 500 ||
          upstreamStatus === 429 ||
          upstreamStatus >= 500;

        if (!retryable) {
          lastError = "";
          break;
        }
        lastError = data?.error || JSON.stringify(data);
      } catch (e) {
        lastError = `요청 실패 (${e.message})`;
      }

      if (attempt < API_RETRY_COUNT) {
        await sleep(API_RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }

    if (!receivedResponse || lastError) {
      return {
        items: allItems,
        error: `${inst.name}: ${lastError || "일시적인 API 오류"}`,
        rawMsg: lastError,
        transient: true,
      };
    }
 
    const body = data?.response?.body;
    if (!body) {
      const msg = data?.response?.header?.resultMsg || JSON.stringify(data);
      return { items: allItems, error: `${inst.name}: ${msg}`, rawMsg: msg };
    }
 
    const items = body.items;
    if (!items) break;
 
    let itemList;
    if (Array.isArray(items)) {
      itemList = items;
    } else if (items.item) {
      itemList = Array.isArray(items.item) ? items.item : [items.item];
    } else {
      itemList = [];
    }
    allItems.push(...itemList);

    // totalCount is the number of matching notices, not the number returned
    // in this page. For example, totalCount=1000 and numOfRows=999 requires
    // requests for page 1 and page 2.
    const totalCount = Number(body.totalCount || 0);
    const pageSize = Number(body.numOfRows) || NUM_OF_ROWS;
    totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 1;
    pageNo += 1;
  }
 
  return { items: allItems, error: null };
}
 
function isRangeError(res) {
  const msg = res.rawMsg || res.error || "";
  return /기간|범위|초과|개월|일자|PERIOD|RANGE/i.test(msg);
}

function shouldSplitChunk(res) {
  return isRangeError(res) || res.transient;
}
 
// ============================================================
// 적응형 조회: 기간 초과 또는 일시적 오류가 나면 기간을 축소해 재시도
// ============================================================
async function fetchChunkAdaptive(mode, operation, inst, chunk, filters, depth = 0) {
  const inqryBgnDt = `${toYmd(chunk.begin)}0000`;
  const inqryEndDt = `${toYmd(chunk.end)}${endTimeFor(chunk.end, chunk.todayVal)}`;

  const res = await fetchNotices(mode, operation, inst, inqryBgnDt, inqryEndDt, filters);
 
  const spanDays = daysBetween(chunk.begin, chunk.end);
  const splittable = spanDays > 1 && depth < MAX_SPLIT_DEPTH;
 
  if (!res.error || !shouldSplitChunk(res) || !splittable) {
    return res;
  }
 
  // A 30-day API request that exceeds the allowed period is retried as a
  // 28-day range plus the remaining days, rather than two 15-day ranges.
  // If a 28-day (or shorter) range still fails, keep the existing halving
  // fallback so the request can continue to converge.
  const leftDays =
    spanDays > RANGE_ERROR_FALLBACK_DAYS
      ? RANGE_ERROR_FALLBACK_DAYS
      : Math.floor(spanDays / 2);
  mode.effectiveRangeDays = Math.min(mode.effectiveRangeDays, leftDays);

  const midEnd = addDays(chunk.begin, leftDays - 1);
  const left = { begin: chunk.begin, end: midEnd, todayVal: chunk.todayVal };
  const right = { begin: addDays(midEnd, 1), end: chunk.end, todayVal: chunk.todayVal };
 
  // Keep fallback requests sequential. Running both alongside the other
  // queued jobs can cause the same upstream timeout again.
  const a = await fetchChunkAdaptive(mode, operation, inst, left, filters, depth + 1);
  const b = await fetchChunkAdaptive(mode, operation, inst, right, filters, depth + 1);
 
  return {
    items: [...a.items, ...b.items],
    error: a.error || b.error || null,
  };
}
 
// ============================================================
// 화면 - 기관 목록 관리
// ============================================================
function createInstitutionRow(name = "", code = "") {
  const tr = document.createElement("tr");
 
  const nameTd = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "inst-name";
  nameInput.placeholder = "기관명";
  nameInput.value = name;
  nameTd.appendChild(nameInput);
 
  const codeTd = document.createElement("td");
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.className = "inst-code";
  codeInput.placeholder = "수요기관코드 (권장)";
  codeInput.value = code;
  codeTd.appendChild(codeInput);
 
  const removeTd = document.createElement("td");
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "삭제";
  removeBtn.addEventListener("click", () => tr.remove());
  removeTd.appendChild(removeBtn);
 
  tr.appendChild(nameTd);
  tr.appendChild(codeTd);
  tr.appendChild(removeTd);
  return tr;
}
 
function initInstitutions() {
  DEFAULT_INSTITUTIONS.forEach((inst) => {
    institutionsBody.appendChild(createInstitutionRow(inst.name, inst.code));
  });
}
 
addRowBtn.addEventListener("click", () => {
  institutionsBody.appendChild(createInstitutionRow());
});
 
function collectInstitutions() {
  const rows = institutionsBody.querySelectorAll("tr");
  const result = [];
  rows.forEach((row) => {
    const name = row.querySelector(".inst-name").value.trim();
    const code = row.querySelector(".inst-code").value.trim();
    if (name || code) {
      result.push({ name: name || code, code });
    }
  });
  return result;
}
 
function collectBusinessTypes() {
  const checkboxes = document.querySelectorAll(".bsns-checkbox:checked");
  return Array.from(checkboxes).map((cb) => cb.value);
}

// 조회조건 개별 필터(사업명/공고번호) 입력값 수집 (빈 값은 제외)
function collectFilters() {
  const filters = {};
  const title = titleFilterInput.value.trim();
  const noticeNo = noticeNoInput.value.trim();
  if (title) filters["사업명"] = title;
  if (noticeNo) filters["공고번호"] = noticeNo;
  return filters;
}

// API가 필터 파라미터를 무시하는 경우를 대비한 클라이언트 보조필터
function rowMatchesFilters(row, filters, mode) {
  for (const [uiKey, def] of Object.entries(mode.searchFields || {})) {
    const q = norm(filters[uiKey]).toLowerCase();
    if (!q) continue;
    const val = norm(row[def.column]).toLowerCase();
    if (!val.includes(q)) return false;
  }
  return true;
}
 
function showStatus(message, type = "info") {
  statusArea.innerHTML = `<div class="status-box status-${type}">${message}</div>`;
}
 
function clearStatus() {
  statusArea.innerHTML = "";
}
 
function showProgress(current, total) {
  const percent = Math.round((current / total) * 100);
  statusArea.innerHTML = `
    <div class="status-box status-info">
      <span class="spinner"></span>조회 중... (${current}/${total} 완료 · 동시 ${CONCURRENCY}건 처리)
      <div class="progress-bar-container">
        <div class="progress-bar-fill" style="width: ${percent}%;"></div>
      </div>
    </div>
  `;
}
 
// ============================================================
// 첨부파일 모달 (_files = [{url, name}, ...] 통일 구조)
// ============================================================
function openFileModal(row) {
  currentModalRow = row;
  const files = row._files || [];
 
  modalTitle.textContent = row["사업명"] || "(사업명 없음)";
  modalSubtitle.textContent = `${row["수요기관명"]} · ${row["업무구분"]} · 공고번호 ${row["입찰공고번호"] || "-"} · 첨부 ${files.length}건`;
 
  modalFileList.innerHTML = "";
 
  if (files.length === 0) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "empty-msg";
    span.textContent = "이 공고에는 API로 제공되는 첨부파일이 없습니다. 나라장터에서 직접 확인해주세요.";
    li.appendChild(span);
    modalFileList.appendChild(li);
    downloadAllBtn.disabled = true;
  } else {
    files.forEach((file, idx) => {
      const li = document.createElement("li");
 
      const no = document.createElement("span");
      no.className = "file-no";
      no.textContent = `${idx + 1}.`;
 
      const a = document.createElement("a");
      a.href = file.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = file.name;
 
      li.appendChild(no);
      li.appendChild(a);
      modalFileList.appendChild(li);
    });
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = `전체 다운로드 (${files.length}건)`;
  }
 
  fileModal.style.display = "flex";
}
 
function closeFileModal() {
  fileModal.style.display = "none";
  currentModalRow = null;
  downloadAllBtn.disabled = false;
  downloadAllBtn.textContent = "전체 다운로드";
}
 
modalClose.addEventListener("click", closeFileModal);
 
fileModal.addEventListener("click", (e) => {
  if (e.target === fileModal) closeFileModal();
});
 
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fileModal.style.display !== "none") closeFileModal();
});
 
downloadAllBtn.addEventListener("click", async () => {
  if (!currentModalRow) return;
  const files = currentModalRow._files || [];
  if (!files.length) return;
 
  downloadAllBtn.disabled = true;
  let blocked = 0;
 
  for (let i = 0; i < files.length; i++) {
    downloadAllBtn.textContent = `다운로드 중... (${i + 1}/${files.length})`;
    const win = window.open(files[i].url, "_blank", "noopener,noreferrer");
    if (!win) blocked++;
    if (i < files.length - 1) await sleep(DOWNLOAD_INTERVAL);
  }
 
  downloadAllBtn.textContent = blocked
    ? `팝업 차단됨 (${blocked}건) - 팝업 허용 후 재시도`
    : `전체 다운로드 완료 (${files.length}건)`;
  downloadAllBtn.disabled = false;
});
 
// ============================================================
// 결과 표
// ============================================================
function renderResults(rows) {
  resultsBody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
 
    COLUMNS.forEach((key) => {
      const td = document.createElement("td");
 
      if (key === "사업명") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "title-link";
        btn.textContent = row[key] || "(사업명 없음)";
        btn.addEventListener("click", () => openFileModal(row));
        td.appendChild(btn);
 
        const count = (row._files || []).length;
        const badge = document.createElement("span");
        badge.className = count ? "file-badge" : "file-badge empty";
        badge.textContent = count ? `첨부 ${count}` : "첨부 0";
        td.appendChild(badge);
      } else {
        td.textContent = row[key] || "";
      }
 
      tr.appendChild(td);
    });
 
    resultsBody.appendChild(tr);
  });
  resultsPanel.style.display = rows.length ? "block" : "none";
}
 
function rowsToCsv(rows) {
  const headers = [...COLUMNS, "첨부파일"];
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    const cells = COLUMNS.map((h) => escapeCell(row[h]));
    const fileText = (row._files || []).map((f) => `${f.name} (${f.url})`).join(" | ");
    cells.push(escapeCell(fileText));
    lines.push(cells.join(","));
  });
  return "﻿" + lines.join("\n");
}
 
downloadBtn.addEventListener("click", () => {
  if (!lastResultRows.length) return;
  const csv = rowsToCsv(lastResultRows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  a.href = url;
  a.download = `g2b_${currentMode.csvName}_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
 
// ============================================================
// 조회 실행 (병렬) - 현재 모드 사용
// ============================================================
searchBtn.addEventListener("click", async () => {
  const mode = currentMode;
  clearStatus();
  resultsPanel.style.display = "none";
 
  const institutions = collectInstitutions();
  const businessTypes = collectBusinessTypes();
  const filters = collectFilters();

  if (institutions.length === 0) {
    showStatus("관심 기관을 한 개 이상 입력해주세요.", "error");
    return;
  }
  if (businessTypes.length === 0) {
    showStatus("업무구분을 한 개 이상 선택해주세요.", "error");
    return;
  }
 
  const range = resolveDateRange();
  if (range.error) {
    showStatus(range.error, "error");
    return;
  }
 
  const chunks = buildDateChunks(
    range.beginDate,
    range.endDate,
    mode.effectiveRangeDays,
    range.todayVal
  );
 
  searchBtn.disabled = true;
 
  const jobs = [];
  for (const inst of institutions) {
    for (const bsnsDiv of businessTypes) {
      for (const chunk of chunks) {
        jobs.push({ inst, bsnsDiv, chunk });
      }
    }
  }
 
  const startedAt = performance.now();
  showProgress(0, jobs.length);
 
  try {
    const tasks = jobs.map(
      ({ inst, bsnsDiv, chunk }) => () =>
        fetchChunkAdaptive(mode, mode.operations[bsnsDiv], inst, chunk, filters)
    );
    const results = await runPool(tasks, CONCURRENCY, showProgress);
 
    const rows = [];
    const errors = [];
    const seen = new Set();
    let duplicateCount = 0;
 
    results.forEach((res, i) => {
      const { inst, bsnsDiv } = jobs[i];
      if (res.error) errors.push(res.error);
 
      for (const item of res.items) {
        // 공고번호 기준 중복 제거. 하위기관 공고도 결과에 포함한다.
        const key = mode.dedupKey(item);
        if (key && seen.has(key)) {
          duplicateCount++;
          continue;
        }
        if (key) seen.add(key);
 
        const row = mode.mapRow(item, bsnsDiv);
        if (!rowMatchesFilters(row, filters, mode)) continue;
        row._files = mode.extractFiles(item);
        rows.push(row);
      }
    });
 
    if (mode.sortDesc) {
      rows.sort((a, b) => (b["입찰공고일시"] || "").localeCompare(a["입찰공고일시"] || ""));
    }
    lastResultRows = rows;
    renderResults(rows);
 
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const fileCount = rows.reduce((sum, r) => sum + (r._files || []).length, 0);
 
    let statusHtml = `${range.label} 기간의 ${mode.resultNoun} ${rows.length}건 (첨부파일 ${fileCount}건)을 조회했습니다.`;
    statusHtml += ` (요청 ${jobs.length}건`;
    if (chunks.length > 1) statusHtml += ` · 기간 ${chunks.length}개로 분할`;
    statusHtml += ` · ${elapsed}초)`;
 
    if (mode.effectiveRangeDays < MAX_RANGE_DAYS) {
      statusHtml += ` <em>· API 기간제한이 축소되어 ${mode.effectiveRangeDays}일 단위로 자동 재분할했습니다.</em>`;
    }
    if (duplicateCount) {
      statusHtml += ` (공고번호 중복 ${duplicateCount}건 제외)`;
    }
    if (errors.length) {
      statusHtml += `<details class="error-details"><summary>오류/경고 ${errors.length}건 (클릭해서 보기)</summary>${errors
        .map((e) => `<div>${e}</div>`)
        .join("")}</details>`;
    }
    showStatus(statusHtml, rows.length ? "success" : "info");
  } catch (e) {
    showStatus(`예상치 못한 오류가 발생했습니다: ${e.message}`, "error");
  } finally {
    searchBtn.disabled = false;
  }
});
 
function applyMode(key) {
  currentMode = MODES[key];

  // 상단 토글버튼 활성 상태 갱신
  modeToggleBtns.forEach((btn) => {
    const active = btn.dataset.mode === key;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  // 헤더/문구 갱신
  appTitle.textContent = currentMode.title;
  appSubtitle.textContent = currentMode.subtitle;
  periodLabel.textContent = currentMode.periodLabel;
  resultsHintEl.textContent = currentMode.resultsHint;
  document.title = `${currentMode.title}`;
 
  // 모드가 바뀌면 이전 결과는 무효 → 초기화
  lastResultRows = [];
  titleFilterInput.value = "";
  noticeNoInput.value = "";
  resultsBody.innerHTML = "";
  resultsPanel.style.display = "none";
  clearStatus();
  closeFileModal();
}
 
modeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-toggle-btn");
  if (btn && btn.dataset.mode !== currentMode.key) applyMode(btn.dataset.mode);
});
 
// ============================================================
// 초기화
// ============================================================
initInstitutions();
initDateRange();
applyMode("pre"); // 기본: 사전공고
 
