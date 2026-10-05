// PDF text locates equipment sections locally; only selected page images reach Ollama.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { analyzeTargets } = require("./ollama-pdf");
const { planDevices } = require("./device-vision");
const { runDevicePlan } = require("./device-runner");
const compact = s => String(s || "").replace(/\s+/g, "").normalize("NFKC");

function planJobs(selection, maxCalls = 8) {
  if (selection.status !== "ready") throw new Error("장비 구간을 확정하지 못했습니다. selection.json을 확인하세요. 전체 문서 분석은 실행하지 않습니다.");
  const jobs = [];
  for (const [index, section] of selection.sections.entries()) {
    // At most two adjacent pages per image request; one-page overlap preserves table continuation.
    for (let offset = 0; offset < section.pages.length; offset++) {
      const pages = section.pages.slice(offset, offset + 2);
      jobs.push({ key: `section-${index + 1}-p${pages[0]}`, id: section.id, name: section.name, pages,
        expectedDevices: section.expectedDevices || [], section: index });
      if (offset + 2 >= section.pages.length) break;
    }
  }
  if (!jobs.length || jobs.length * 2 > maxCalls) throw new Error(`선별된 이미지 요청 ${jobs.length}개와 수량 재확인을 합친 최대 ${jobs.length * 2}회가 허용 범위(1~${maxCalls}) 밖입니다. 분석하지 않았습니다.`);
  return jobs;
}

function summarize(selection, jobs, reports) {
  const review = selection.sections.map((section, index) => {
    const items = reports.flatMap((report, j) => jobs[j].section === index ? report.ecr : []);
    const found = new Set(items.flatMap(item => item.장비요약.map(eq => compact(eq.명칭))));
    const missingDevices = (section.expectedDevices || []).filter(name => !found.has(compact(name)));
    return { id: section.id, name: section.name, pages: section.pages, expectedDevices: section.expectedDevices,
      inventoryWarnings: section.inventoryWarnings || [],
      missingDevices, items: items.length, warning: missingDevices.length ? "원문 장비명이 결과에 없습니다. 표 잘림·모델 누락·명칭 차이를 확인하세요. 자동으로 다른 페이지의 규격을 섞지 않습니다." : "장비명 대조만 수행했습니다. 규격 완전성은 확인 필요합니다." };
  });
  return { verified: false, status: review.some(r => r.missingDevices.length || !r.items || r.inventoryWarnings.length) ? "needs-review" : "extracted-unverified",
    source: selection.pdf, totalPages: selection.totalPages, selectedPages: selection.selectedPages,
    selectedCount: selection.selectedCount, imageJobs: jobs.length, maxInferenceRequests: jobs.length * 2,
    allResponsesCached: reports.every(report => report.cached),
    coverage: review, results: reports, warnings: selection.warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const pdf = args.shift(), destination = args.shift();
  if (!pdf || !destination) throw new Error("Usage: node analyzer/analyze-pdf.js <pdf> <output-dir> [--deps directory] [--model qwen3.5:4b] [--max-pages 12] [--max-calls 8] [--run]");
  const options = { "--model": "qwen3.5:4b", "--max-pages": "12", "--max-calls": "8" };
  let run = false;
  while (args.length) {
    const key = args.shift();
    if (key === "--run") { run = true; continue; }
    if (!["--deps", "--model", "--max-pages", "--max-calls"].includes(key) || !args.length) throw new Error(`Unknown/incomplete option: ${key}`);
    options[key] = args.shift();
  }
  const maxCalls = Number(options["--max-calls"]);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 500) throw new Error("--max-calls must be 1..500");
  const output = path.resolve(destination);
  const deps = options["--deps"] ? ["--deps", path.resolve(options["--deps"])] : [];
  const python = process.env.PYTHON || "python";
  const callPython = (script, argv) => execFileSync(python, ["-X", "utf8", "-B", path.join(__dirname, script), ...argv], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  console.log(callPython("pdf_selection.py", [path.resolve(pdf), output, ...deps, "--max-pages", options["--max-pages"]]).trim());
  const selection = JSON.parse(fs.readFileSync(path.join(output, "selection.json"), "utf8"));
  if (selection.sections.every(s => s.inventory?.length)) {
    const jobs = planDevices(selection, maxCalls);
    fs.writeFileSync(path.join(output, "jobs.json"), JSON.stringify(jobs, null, 2));
    console.log(JSON.stringify({ mode: 'per-device', jobs: jobs.length, devices: jobs.reduce((n, j) => n + j.devices.length, 0), run }));
    if (!run) return;
    const report = await runDevicePlan(selection, { output, maxCalls, model: options['--model'], render: async pages => {
      const directory = path.join(output, 'images');
      callPython('pdf-pages.py', [path.resolve(pdf), directory, ...deps, '--pages', pages.join(','), '--dpi', '200', '--table-crops']);
      return JSON.parse(fs.readFileSync(path.join(directory, 'pages.json'), 'utf8')).pages.map(p => ({ ...p, image: path.resolve(directory, p.image) }));
    } });
    console.log(JSON.stringify({ status: report.status, extracted: report.extractedDevices, expected: report.expectedDevices, report: path.join(output, 'result.html') }));
    return;
  }
  const jobs = planJobs(selection, maxCalls);
  fs.writeFileSync(path.join(output, "jobs.json"), JSON.stringify({ jobs, maxInferenceRequests: jobs.length * 2 }, null, 2));
  console.log(JSON.stringify({ totalPages: selection.totalPages, selectedPages: selection.selectedPages,
    baseRequests: jobs.length, maximumWithQuantityRetries: jobs.length * 2, run }));
  if (!run) return;
  const reports = [];
  for (const job of jobs) {
    const directory = path.join(output, job.key);
    console.log(callPython("pdf-pages.py", [path.resolve(pdf), directory, ...deps, "--pages", job.pages.join(","), "--dpi", "200"]).trim());
    reports.push(await analyzeTargets(path.join(directory, "pages.json"), {
      model: options["--model"], targetIds: job.id ? [job.id] : [], output: path.join(directory, "result")
    }));
    console.log(JSON.stringify({ section: job.id || job.name, pages: job.pages, items: reports.at(-1).ecr.length }));
  }
  const report = summarize(selection, jobs, reports);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, coverage: report.coverage, report: path.join(output, "report.json") }));
}
module.exports = { planJobs, summarize };
if (require.main === module) main().catch(error => { console.error(error.stderr || error.message); process.exitCode = 1; });
