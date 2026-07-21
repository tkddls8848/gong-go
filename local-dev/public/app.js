const $ = (selector) => document.querySelector(selector);
const PAGE_SIZE = 50;
let records = [];
let filtered = [];
let page = 1;
let fileIndex = [];
let searchVersion = 0;
let currentModalRow = null;
const fileModal = $("#file-modal");
const modalTitle = $("#modal-title");
const modalSubtitle = $("#modal-subtitle");
const modalFileList = $("#modal-file-list");
const modalClose = $("#modal-close");
const downloadAllBtn = $("#download-all-btn");
const downloadBtn = $("#download-btn");

const DATA_BASE = "../collector/data";

if (location.protocol === "file:") {
  $("#status").textContent = "CSV 조회는 웹 서버에서만 가능합니다. C:\\gong-go\\local-dev에서 python -m http.server 8788 실행 후 http://localhost:8788/public/ 를 여세요.";
  renderRows([]);
} else fetch(`${DATA_BASE}/index.json`)
  .then((response) => { if (!response.ok) throw new Error("CSV 경로를 찾지 못했습니다. C:\\gong-go\\local-dev에서 python -m http.server 8788을 실행했는지 확인하세요."); return response.json(); })
  .then((index) => { fileIndex = index.files || []; setDefaultSearchRange(); $("#status").textContent = `${fileIndex.length}개 일자별 CSV를 찾았습니다.`; applyFilters(); })
  .catch((error) => { $("#status").textContent = error.message; renderRows([]); });

$("#search").addEventListener("click", () => { page = 1; applyFilters(); });
$("#reset").addEventListener("click", () => { ["#q", "#mode", "#business-type"].forEach((selector) => { $(selector).value = ""; }); setDefaultSearchRange(); page = 1; applyFilters(); });
$("#q").addEventListener("keydown", (event) => { if (event.key === "Enter") { page = 1; applyFilters(); } });
$("#previous").addEventListener("click", () => { if (page > 1) { page -= 1; renderRows(filtered); } });
$("#next").addEventListener("click", () => { if (page * PAGE_SIZE < filtered.length) { page += 1; renderRows(filtered); } });
$("#mode").addEventListener("change", () => { page = 1; applyFilters(); });
downloadBtn.addEventListener("click", downloadFilteredRows);
modalClose.addEventListener("click", closeFileModal);
fileModal.addEventListener("click", (event) => { if (event.target === fileModal) closeFileModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeFileModal(); });
downloadAllBtn.addEventListener("click", downloadAllFiles);
async function applyFilters() {
  const version = ++searchVersion;
  const q = $("#q").value.trim().toLowerCase();
  const mode = $("#mode").value;
  const type = $("#business-type").value;
  const begin = $("#begin").value || "0000-01-01";
  const end = $("#end").value || "9999-12-31";
  const files = fileIndex.filter((file) => file.date >= begin && file.date <= end);
  $("#status").textContent = `${files.length}개 일자별 CSV를 불러오는 중입니다.`;
  try {
    const loaded = (await Promise.all(files.map((file) => fetchCsvGz(`${DATA_BASE}/${file.path}`).then(parseCsv)))).flat();
    if (version !== searchVersion) return;
    records = loaded;
  } catch (error) {
    if (version === searchVersion) $("#status").textContent = `CSV를 불러오지 못했습니다: ${error.message}`;
    return;
  }
  const beginValue = begin.replaceAll("-", "");
  const endValue = end.replaceAll("-", "");
  filtered = records.filter((row) => {
    const publishedDate = dateKey(row.publishedAt);
    const number = displayNumber(row);
    return (!mode || row.mode === mode) && (!type || row.businessType === type) && (!q || `${number} ${row.institution} ${row.title}`.toLowerCase().includes(q)) && publishedDate >= beginValue && publishedDate <= endValue;
  }).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  $("#status").textContent = `${files.length}개 일자별 CSV에서 ${format(records.length)}건을 불러왔습니다.`;
  renderRows(filtered);
}
function setDefaultSearchRange() { const last = fileIndex.at(-1)?.date; if (!last) return; const end = new Date(`${last}T00:00:00`); const begin = new Date(end); begin.setDate(begin.getDate() - 6); $("#begin").value = localDateValue(begin); $("#end").value = last; }
function renderRows(rows) { const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); page = Math.min(page, pageCount); const visible = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE); $("#result-summary").textContent = `${format(rows.length)}건`; $("#page-label").textContent = `${page} / ${pageCount}`; $("#previous").disabled = page === 1; $("#next").disabled = page === pageCount; downloadBtn.disabled = !rows.length; $("#results").innerHTML = visible.length ? visible.map((row, index) => { const number = displayNumber(row); const files = normalizeFiles(row.files); return `<tr><td><span class="badge ${row.mode}">${row.mode === "pre" ? "사전공고" : "본공고"}</span></td><td>${escapeHtml(number)}</td><td>${escapeHtml(row.businessType)}</td><td>${escapeHtml(row.institution)}</td><td class="title"><button class="title-link" data-row-index="${index}" type="button">${escapeHtml(row.title || "(사업명 없음)")}</button><span class="file-badge ${files.length ? "" : "empty"}">${files.length ? `첨부 ${files.length}` : "첨부 0"}</span></td><td>${formatDate(row.publishedAt)}</td><td>${formatDate(row.closeAt)}</td></tr>`; }).join("") : $("#empty-row").innerHTML; document.querySelectorAll(".title-link").forEach((button) => button.addEventListener("click", () => openFileModal(visible[Number(button.dataset.rowIndex)]))); }
function csvCell(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function downloadFilteredRows() { if (!filtered.length) return; const headers = ["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일", "첨부파일"]; const lines = [headers.join(","), ...filtered.map((row) => [row.mode === "pre" ? "사전공고" : "본공고", displayNumber(row), row.businessType, row.institution, row.title, row.publishedAt, row.closeAt, normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | ")].map(csvCell).join(","))]; const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `gong-go_${localDateValue(new Date()).replaceAll("-", "")}.csv`; document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url); }
async function fetchCsvGz(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) return "";
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
}
function parseCsv(text) { const lines = parseLines(text.replace(/^\uFEFF/, "")); const header = lines.shift() || []; const records = new Array(lines.length); for (let index = 0; index < lines.length; index += 1) { const cells = lines[index]; const record = {}; for (let column = 0; column < header.length; column += 1) record[header[column]] = fromTextCell(cells[column] || ""); records[index] = displayRow(record); } return records; }
function fromTextCell(value) { if (value === "" || value.charCodeAt(0) !== 61) return value; if (value.length >= 3 && value.charCodeAt(1) === 34 && value.charCodeAt(value.length - 1) === 34) return value.slice(2, -1); return value.slice(1); }
// \uC140\uC744 \uD55C \uAE00\uC790\uC529 \uC774\uC5B4\uBD99\uC774\uC9C0 \uC54A\uACE0 \uAD6C\uBD84\uC790 \uC704\uCE58\uB97C \uCC3E\uC544 slice\uB85C \uC798\uB77C\uB0B8\uB2E4. \uC778\uC6A9\uB418\uC9C0 \uC54A\uC740 \uC140(\uBE48 \uC140 \uD3EC\uD568)\uC740 \uB530\uC634\uD45C \uCC98\uB9AC\uB97C \uAC74\uB108\uB6F4\uB2E4.
function parseLines(text) { const rows = []; const length = text.length; let row = [], index = 0, pending = false; while (index < length) { let cell; if (text.charCodeAt(index) === 34) { index += 1; let start = index; cell = ""; for (;;) { const quote = text.indexOf('"', index); if (quote === -1) { cell += text.slice(start); index = length; break; } if (text.charCodeAt(quote + 1) === 34) { cell += text.slice(start, quote + 1); index = quote + 2; start = index; continue; } cell += text.slice(start, quote); index = quote + 1; break; } } else { let end = index; while (end < length) { const code = text.charCodeAt(end); if (code === 44 || code === 10 || code === 13) break; end += 1; } cell = text.slice(index, end); index = end; } row.push(cell); pending = true; const code = text.charCodeAt(index); if (code === 44) { index += 1; continue; } if (code === 10 || code === 13) { if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1; index += 1; if (row.some(Boolean)) rows.push(row); row = []; pending = false; } } if (pending) rows.push(row); return rows; }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function displayRow(row) {
  if (row.mode) return { ...row, files: safeJson(row.files, []) };
  const mode = row.bidNtceNo ? "bid" : "pre";
  const prefix = mode === "pre" ? "specDocFileUrl" : "ntceSpecDocUrl";
  const count = mode === "pre" ? 5 : 10;
  return {
    ...row,
    mode,
    announcementNumber: mode === "bid" ? row.bidNtceNo || "" : row.bfSpecRgstNo || "",
    institution: row.rlDminsttNm || row.dminsttNm || "",
    businessType: mode === "bid" ? row.ntceKindNm || "" : row.bsnsDivNm || "",
    title: row.prdctClsfcNoNm || row.bidNtceNm || "",
    publishedAt: row.rgstDt || row.bidNtceDt || "",
    closeAt: row.opninRgstClseDt || row.bidClseDt || "",
    files: Array.from({ length: count }, (_, index) => row[`${prefix}${index + 1}`]).filter(Boolean),
  };
}
function format(value) { return new Intl.NumberFormat("ko-KR").format(value); }
function formatDate(value) { const text = dateKey(value); return text.length === 8 ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : "-"; }
function displayNumber(row) { return row.announcementNumber || ""; }
function normalizeFiles(files) { return (Array.isArray(files) ? files : []).map((file, index) => typeof file === "string" ? { url: file, name: guessFileName(file, index) } : { url: file.url || "", name: file.name || guessFileName(file.url, index) }).filter((file) => /^https?:/i.test(file.url)); }
function guessFileName(url, index) { try { const parsed = new URL(url); const name = parsed.searchParams.get("fileNm") || parsed.searchParams.get("orgFileNm") || parsed.searchParams.get("fileName"); if (name) return decodeURIComponent(name); const sequence = parsed.searchParams.get("fileSeq") || parsed.searchParams.get("seq"); return `첨부파일 ${sequence || index + 1}`; } catch { return `첨부파일 ${index + 1}`; } }
function openFileModal(row) { currentModalRow = row; const files = normalizeFiles(row.files); modalTitle.textContent = row.title || "(사업명 없음)"; modalSubtitle.textContent = `${row.institution || "-"} · ${row.businessType || "-"} · 번호 ${displayNumber(row) || "-"} · 첨부 ${files.length}건`; modalFileList.innerHTML = files.length ? files.map((file, index) => `<li><span class="file-no">${index + 1}.</span><a href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.name)}</a></li>`).join("") : '<li><span class="empty-msg">이 공고에는 API로 제공되는 첨부파일이 없습니다.</span></li>'; downloadAllBtn.disabled = !files.length; downloadAllBtn.textContent = files.length ? `전체 다운로드 (${files.length}건)` : "전체 다운로드"; fileModal.style.display = "flex"; }
function closeFileModal() { fileModal.style.display = "none"; currentModalRow = null; }
async function downloadAllFiles() { const files = normalizeFiles(currentModalRow?.files); if (!files.length) return; downloadAllBtn.disabled = true; for (let index = 0; index < files.length; index += 1) { downloadAllBtn.textContent = `다운로드 중... (${index + 1}/${files.length})`; window.open(files[index].url, "_blank", "noopener,noreferrer"); if (index < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 700)); } downloadAllBtn.textContent = `전체 다운로드 완료 (${files.length}건)`; downloadAllBtn.disabled = false; }
function dateKey(value) { return String(value || "").replace(/\D/g, "").slice(0, 8); }
function localDateValue(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
