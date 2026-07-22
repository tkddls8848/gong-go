// 다운로드한 첨부를 HWPX/Markdown으로 정규화한다. HWP 변환은 한글 COM을 PowerShell에서만 호출한다.
const { ROOT, DATA_DIR, fs, path, mapPool, readJson, writeJson, writeGzipText } = require("./pipeline-utils");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { readZip } = require("./zip-read");
const { hwpxToMarkdown } = require("./hwpx-table");
const execFileAsync = promisify(execFile);

const FILES_ROOT = path.join(DATA_DIR, "files", "bid");
const NORM_ROOT = path.join(DATA_DIR, "norm", "bid");
const TEXT_ROOT = path.join(DATA_DIR, "text", "bid");
const PS_SCRIPT = path.join(ROOT, "hwp-to-hwpx.ps1");
const HWP_TIMEOUT = numberFlag("--hwp-timeout-ms", 120000);

main().catch((error) => { console.error(`변환 실패: ${error.message}`); process.exitCode = 1; });

async function main() {
  const limit = numberFlag("--limit", Infinity);
  const concurrency = numberFlag("--concurrency", 1);
  const notices = await directories(FILES_ROOT);
  const selected = notices.slice(0, limit);
  console.log(`변환 대상 공고 ${selected.length}건, 동시 ${concurrency}`);
  await mapPool(selected, concurrency, convertNotice);
}
async function convertNotice(notice) {
  const sourceDir = path.join(FILES_ROOT, notice);
  const files = (await fs.readdir(sourceDir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(sourceDir, entry.name));
  const documents = [];
  for (let index = 0; index < files.length; index += 1) {
    try { documents.push(...await convertFile(files[index], notice, index + 1)); }
    catch (error) {
      documents.push({ kind: "error", source: relative(files[index]), originalName: path.basename(files[index]), reason: error.message });
      console.error(`${notice}: ${path.basename(files[index])} 변환 실패 — ${error.message}`);
    }
  }
  await writeJson(path.join(TEXT_ROOT, notice, "manifest.json"), { notice, convertedAt: new Date().toISOString(), documents });
  console.log(`${notice}: ${documents.filter((entry) => entry.kind === "hwpx").length} HWPX, ${documents.filter((entry) => entry.kind === "pdf").length} PDF, ${documents.filter((entry) => entry.reason).length} 건너뜀`);
}
async function convertFile(source, notice, sequence, depth = 0, displayName = path.basename(source)) {
  const extension = path.extname(displayName).toLowerCase();
  const id = String(sequence).padStart(2, "0");
  if (extension === ".hwp") {
    const target = path.join(NORM_ROOT, notice, `${id}.hwpx`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT, source, target], { windowsHide: true, timeout: HWP_TIMEOUT });
    return convertHwpx(target, notice, id, source, displayName, true);
  }
  if (extension === ".hwpx") return convertHwpx(source, notice, id, source, displayName, false);
  if (extension === ".pdf") return [{ kind: "pdf", source: relative(source), originalName: displayName, bytes: (await fs.stat(source)).size }];
  if (extension === ".zip" && depth < 2) return convertZip(source, notice, sequence, depth, displayName);
  return [{ kind: "skipped", source: relative(source), originalName: displayName, reason: `지원하지 않는 확장자 ${extension || "없음"}`, bytes: (await fs.stat(source)).size }];
}
async function convertHwpx(hwpxFile, notice, id, source, originalName, converted) {
  const result = hwpxToMarkdown(await fs.readFile(hwpxFile));
  const markdownFile = path.join(TEXT_ROOT, notice, `${id}.md.gz`);
  await writeGzipText(markdownFile, result.markdown);
  return [{ kind: "hwpx", source: relative(source), converted: converted ? relative(hwpxFile) : undefined, markdown: relative(markdownFile), originalName, bytes: (await fs.stat(hwpxFile)).size, chars: result.markdown.length, stats: result.stats }];
}
async function convertZip(source, notice, sequence, depth, originalName) {
  const entries = readZip(await fs.readFile(source));
  const output = [];
  let child = 0;
  for (const [name, data] of entries) {
    const extension = path.extname(name).toLowerCase();
    if (![".hwp", ".hwpx", ".pdf", ".zip"].includes(extension)) continue;
    child += 1;
    const temporary = path.join(NORM_ROOT, notice, `zip-${String(sequence).padStart(2, "0")}-${child}${extension}`);
    await fs.mkdir(path.dirname(temporary), { recursive: true }); await fs.writeFile(temporary, data);
    output.push(...await convertFile(temporary, notice, Number(`${sequence}${child}`), depth + 1, name));
  }
  return output.length ? output : [{ kind: "skipped", source: relative(source), originalName, reason: "ZIP 안에 지원 문서가 없음", bytes: (await fs.stat(source)).size }];
}
async function directories(root) { try { return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
function relative(file) { return path.relative(DATA_DIR, file).replaceAll("\\", "/"); }
function numberFlag(flag, fallback) { const index = process.argv.indexOf(flag); return index >= 0 ? Math.max(1, Number(process.argv[index + 1]) || 1) : fallback; }
