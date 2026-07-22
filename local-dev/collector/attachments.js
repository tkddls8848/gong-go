// 관심 본공고의 제안요청서/과업내용서만 로컬 data/files에 내려받는다.
const { ROOT, DATA_DIR, fs, path, mapPool, readJson, readCsvGz, noticeNumber, rowDate, institution, title, normalizeFiles, safeFileName, writeJson } = require("./pipeline-utils");

const CONFIG_FILE = path.join(ROOT, "analyze.config.json");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const ERROR_FILE = path.join(DATA_DIR, "download-errors.json");

main().catch((error) => { console.error(`첨부 다운로드 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const config = await readJson(CONFIG_FILE);
  if (!config) throw new Error("analyze.config.json을 찾지 못했습니다.");
  const limit = numberFlag("--limit", config.maxNoticesPerRun ?? 50);
  const dryRun = process.argv.includes("--dry-run");
  const pattern = new RegExp(config.fileNamePattern || ".", "i");
  const index = await readJson(INDEX_FILE, { files: [] });
  const begin = String(config.begin || "0000-01-01").replaceAll("-", "");
  const mode = config.mode || "bid";
  const files = (index.files || []).filter((file) => file.mode === mode && file.date.replaceAll("-", "") >= begin);
  const rows = (await Promise.all(files.map((file) => readCsvGz(path.join(DATA_DIR, file.path)))).then((sets) => sets.flat()))
    .filter((row) => noticeNumber(row) && (!config.institutions?.length || config.institutions.some((name) => institution(row).includes(name))))
    .sort((a, b) => rowDate(b).localeCompare(rowDate(a)));
  const notices = new Map();
  for (const row of rows) if (!notices.has(noticeNumber(row))) notices.set(noticeNumber(row), row);
  const selected = [...notices.values()].slice(0, limit).map((row) => ({ row, files: normalizeFiles(row).filter((file) => pattern.test(file.name)) })).filter((entry) => entry.files.length);
  const total = selected.reduce((sum, entry) => sum + entry.files.length, 0);
  console.log(`대상 공고 ${selected.length}건, 첨부 ${total}건${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) return;
  const errors = [];
  const jobs = selected.flatMap(({ row, files }) => files.map((file, index) => ({ row, file, index })));
  await mapPool(jobs, Math.max(1, Number(config.concurrency) || 4), async (job) => {
    try { await download(job); } catch (error) { const entry = { notice: noticeNumber(job.row), title: title(job.row), url: job.file.url, name: job.file.name, error: error.message }; errors.push(entry); console.error(`실패 ${entry.notice}: ${entry.name} — ${entry.error}`); }
  });
  await writeJson(ERROR_FILE, errors);
  console.log(`완료: ${jobs.length - errors.length}/${jobs.length}건 다운로드, 실패 ${errors.length}건`);
}
async function download({ row, file, index }) {
  const notice = safeFileName(noticeNumber(row), "unknown");
  const name = `${String(index + 1).padStart(2, "0")}_${safeFileName(file.name, `attachment_${index + 1}`)}`;
  const destination = path.join(DATA_DIR, "files", "bid", notice, name);
  try { if ((await fs.stat(destination)).size > 0) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(file.url, { redirect: "follow" });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (/^text\/html\b/i.test(contentType)) throw new Error(`HTML 응답 수신 (${contentType})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("빈 응답");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data);
}
function numberFlag(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 ? Math.max(0, Number(process.argv[index + 1]) || 0) : fallback; }
