// 번호 대조는 규격의 완전성 검증과 다르다. 일치하더라도 verified로 승격하지 않는다.
const key = (id) => String(id).replace(/–/g, "-").replace(/\s/g, "").toUpperCase();
const unique = (ids) => [...new Map(ids.map((id) => [key(id), id])).values()];

export function sourceCoverage(selection) {
  const expectedIds = unique(selection.sections.map((section) => section.id));
  const selected = new Set(expectedIds.map(key));
  return { expectedIds, excludedIds: unique(selection.ids).filter((id) => !selected.has(key(id))) };
}

// 누락 번호만 다시 분석할 때는 앞선 분석에서 이미 추출한 번호(matched)와 앞서 나온 불일치 번호
// (unexpected)를 이어받아 문서 전체 기준으로 다시 대조한다. 이어받은 번호는 같은 사람이 같은 파일로
// 받은 직전 결과에서 오며 표시용 대조에만 쓴다. 대상 번호 목록에 없는 것은 matched로 세지 않는다.
export function compareCoverage(manifest, items, carry = {}) {
  if (!manifest || !Array.isArray(manifest.expectedIds)) return { status: "unknown", warnings: ["이 작업에는 분석 대상 번호 목록이 저장되어 있지 않아 누락 여부를 대조하지 못했습니다."] };
  const expectedIds = unique(manifest.expectedIds);
  const expected = new Set(expectedIds.map(key));
  // 항목 이름만 있고 유효 규격이 하나도 없으면 그 번호를 추출 완료로 세지 않는다.
  const usable = new Set(items.filter((item) => (item.장비요약 || []).some((entry) => (entry.규격 || []).some((fact) => fact.값 && fact.검증 === "원문 확인")))
    .filter((item) => !(item.불확실 || []).some((message) => message.includes("요구사항 ID 원문 확인 필요"))).map((item) => key(item.id)));
  for (const id of carry.matched || []) if (expected.has(key(id))) usable.add(key(id));
  const matchedIds = expectedIds.filter((id) => usable.has(key(id)));
  const missingIds = expectedIds.filter((id) => !usable.has(key(id)));
  const unexpectedIds = unique([...(carry.unexpected || []), ...items.map((item) => item.id)]).filter((id) => !expected.has(key(id)));
  const excludedIds = manifest.excludedIds || [];
  const warnings = [];
  if (!expectedIds.length) warnings.push("번호가 붙은 장비 상세 표를 식별하지 못했습니다. 추출 결과가 비어 있어도 장비 요구사항이 없다고 판단할 수 없습니다.");
  if (missingIds.length) warnings.push(`분석 대상 중 유효 규격을 추출하지 못한 번호: ${missingIds.join(", ")}. 원문 확인이 필요합니다.`);
  if (excludedIds.length) warnings.push(`문서에서 발견했지만 상세 장비 표로 선별되지 않은 번호: ${excludedIds.join(", ")}. 제외가 적절한지 확인하세요.`);
  if (unexpectedIds.length && expectedIds.length) warnings.push(`선별된 대상 번호와 일치하지 않는 추출 번호: ${unexpectedIds.join(", ")}. 원문 확인이 필요합니다.`);
  return { status: !expectedIds.length ? "unknown" : missingIds.length ? "partial" : "matched", expectedIds, matchedIds, missingIds, excludedIds, unexpectedIds, warnings };
}
