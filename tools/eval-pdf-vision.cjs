// Manually reviewed, partial field checks on actual local Ollama vision output.
const fs = require("node:fs");
const path = require("node:path");
const { analyzeTargets } = require("../analyzer/ollama-pdf");
const norm = text => String(text).replace(/\s+/g, "").toLowerCase();

function score(report, label) {
  if (!Array.isArray(label.ids) || !Array.isArray(label.facts)) throw new Error("Explicit ID and field labels are required (including empty negative labels)");
  const missing = label.facts.filter(expected => !report.ecr.some(item => item.id === expected.id
    && (expected.scope === undefined || item.적용구분 === expected.scope)
    && item.장비요약.some(device => device.규격.some(fact => fact.항목 === expected.field
      && expected.contains.every(value => norm(fact.값).includes(norm(value)))))));
  const unexpectedIds = [...new Set(report.ecr.map(item => item.id))].filter(id => !label.ids.includes(id));
  const missingIds = label.ids.filter(id => !report.ecr.some(item => item.id === id));
  return { checkedFacts: label.facts.length, matchedFacts: label.facts.length - missing.length, missing,
    unexpectedIds, missingIds, passed: !missing.length && !unexpectedIds.length && !missingIds.length };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node tools/eval-pdf-vision.cjs <cases.json> [model] [output-directory]");
  const cases = JSON.parse(fs.readFileSync(file, "utf8"));
  const model = process.argv[3] || "qwen3.5:4b";
  const output = path.resolve(process.argv[4] || "test-results/ecr-vision/evaluation");
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  for (const [index, entry] of cases.entries()) {
    try {
      const report = await analyzeTargets(path.resolve(path.dirname(file), entry.manifest), { model,
        targetIds: entry.targetIds || [], output: path.join(output, String(index + 1)) });
      const metrics = score(report, entry);
      results.push({ name: entry.name, ...metrics, seconds: report.seconds, cached: report.cached });
      console.log(`${entry.name}: ${metrics.matchedFacts}/${metrics.checkedFacts} checked fields; ${metrics.passed ? "PASS" : "FAIL"}`);
    } catch (error) { results.push({ name: entry.name, error: error.message, passed: false }); console.log(`${entry.name}: ERROR ${error.message}`); }
    fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ model, labelScope: "Manually reviewed selected fields; not whole-document accuracy", results }, null, 2) + "\n");
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
module.exports = { score };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
