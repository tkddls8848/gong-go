function verifyExtraction(result, markdown) {
  const expected = ecrIds(result.요구사항목록);
  const actual = new Set((result.ecr || []).map((item) => String(item.id || "").trim()).filter(Boolean));
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  const errors = [];
  const warnings = [];
  if (missing.length) errors.push(`상세 추출 누락: ${missing.join(", ")}`);
  if (unexpected.length) errors.push(`총괄표에 없는 ECR: ${unexpected.join(", ")}`);
  const declared = Number.isInteger(result.요구사항수) ? result.요구사항수 : null;
  if (declared !== null && declared !== expected.size) errors.push(`총괄표 ECR 수 불일치: 선언 ${declared}, 목록 ${expected.size}`);
  for (const item of result.ecr || []) {
    const excerpt = normalize(item.세부내용_원문).slice(0, 40);
    if (excerpt.length < 40) { errors.push(`${item.id}: 세부내용_원문이 너무 짧음`); continue; }
    if (!normalize(markdown).includes(excerpt)) errors.push(`${item.id}: 세부내용_원문이 변환 Markdown에서 확인되지 않음`);
  }
  const loose = new Set((String(markdown).match(/[A-Z]{2,4}[-–][A-Z0-9-]+/g) || []).map((id) => id.replace("–", "-")));
  const absentInText = [...expected].filter((id) => !loose.has(id));
  if (absentInText.length) warnings.push(`변환 텍스트에서 확인되지 않은 ID(경고): ${absentInText.join(", ")}`);
  return { verified: errors.length === 0, errors, warnings, expectedIds: [...expected], actualIds: [...actual], missing };
}
function ecrIds(items) { return new Set((items || []).map((item) => String(item.ID || item.id || "").trim()).filter((id) => /^ECR[-–]/i.test(id))); }
function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

module.exports = { verifyExtraction, ecrIds, normalize };
