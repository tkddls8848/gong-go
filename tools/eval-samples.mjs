// Offline corpus diagnostics. No model responses are fabricated as accuracy labels.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requirementSections } from "../src/ecr-source.js";
import { sourceCoverage } from "../src/ecr-coverage.js";
import { splitDocument } from "../src/ecr.js";

globalThis.fetch = () => { throw new Error("Network is forbidden in offline evaluation"); };
const directory = path.resolve(process.argv[2] || "test-results/ecr-samples");
const output = path.resolve(process.argv[3] || path.join(directory, "evaluation.json"));
const entries = JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8"));
const results = entries.map((entry) => {
  if (entry.error) return entry;
  const { text } = JSON.parse(readFileSync(path.join(directory, `${entry.sha256}.json`), "utf8"));
  const selection = requirementSections(text);
  const coverage = sourceCoverage(selection);
  let chunks = null, splitError = null;
  try { chunks = splitDocument(text).length; } catch (error) { splitError = error.message; }
  // All IDs are an inventory for review, not equipment ground truth.
  const rawIds = [...new Set(text.match(/\bECR[-–][A-Z0-9]+(?:[-–][A-Z0-9]+)*/g) || [])];
  return { ...entry, chars: text.length, rawIds, ...coverage, sections: selection.sections.length,
    selectedChars: selection.sections.reduce((sum, s) => sum + s.text.length, 0),
    chunks, splitError, fallback: !selection.sections.length,
    uploadSupported: /\.(pdf|md|txt)$/i.test(entry.file) && entry.bytes <= 8 * 1024 * 1024,
    selected: selection.sections.map(({ id, text }) => ({ id, chars: text.length, head: text.slice(0, 180) })) };
});
const summary = { files: results.length, extracted: results.filter(r => !r.error).length,
  parseErrors: results.filter(r => r.error).length, withSelectedTables: results.filter(r => r.sections > 0).length,
  splitSuccess: results.filter(r => r.chunks !== null && r.chunks !== undefined).length,
  splitErrors: results.filter(r => r.splitError).length,
  fallback: results.filter(r => r.fallback).length,
  selectedIds: results.reduce((sum, r) => sum + (r.expectedIds?.length || 0), 0),
  selectedChars: results.reduce((sum, r) => sum + (r.selectedChars || 0), 0),
  chunks: results.reduce((sum, r) => sum + (r.chunks || 0), 0), remoteCalls: 0 };
writeFileSync(output, JSON.stringify({ summary, results }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`Report: ${output}`);
if (summary.parseErrors) process.exitCode = 1;
