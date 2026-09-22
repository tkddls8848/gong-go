// 분석 결과의 장비 요약 계약. 화면은 저장된 결과만 읽으며 모델을 호출하지 않는다.
const FIELDS = ["용도", "수량", "도입구분", "CPU", "메모리", "로컬 디스크", "NIC/HBA", "이중화", "유지보수", "종류", "Raw 용량", "Usable 용량", "디스크 구성", "프로토콜", "컨트롤러", "성능", "복제", "라이선스", "기타 조건"];
const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const string = { type: "string" };
const EQUIPMENT_SCHEMA = { type: "array", items: object({
  종류: { type: "string", enum: ["서버", "스토리지"] }, 명칭: string, 출처: string,
  규격: { type: "array", items: object({ 항목: { type: "string", enum: FIELDS }, 값: string, 근거: string }) },
}) };
const EQUIPMENT_PROMPT = `각 ECR의 장비요약에는 실제 도입/증설 대상 서버와 스토리지만 넣어라. 단순 언급이나 소프트웨어 요구사항은 제외한다. 한 ECR에 여러 장비가 있으면 장비별로 분리한다. 각 장비는 종류(서버/스토리지), 명칭, 출처(문서명과 확인 가능한 페이지/절), 규격 배열을 가진다. 규격은 항목, 값, 근거로 구성한다. 항목은 ${FIELDS.join(", ")} 중 선택한다. 값은 원문 표현을 그대로 발췌하고 근거에는 그 값을 포함한 연속된 원문 문장/표 행을 복사한다. 장비당/전체, 이상/이하, 신규/증설, Raw/Usable, 단위와 적용 조건을 값에 보존한다. 합산하거나 단위 변환하거나 Raw를 Usable로 추정하지 않는다. 같은 항목에 여러 조건이 있으면 별도 규격으로 모두 남긴다. 미기재 항목은 규격 배열에서 생략한다. 서버 로컬 디스크를 별도 스토리지 장비로 만들지 않는다. 해당 장비가 없으면 장비요약은 빈 배열이다.`;
const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
function verifyEquipment(items, markdown) {
  const errors = [];
  const source = normalize(markdown);
  for (const item of items || []) {
    if (!Array.isArray(item.장비요약)) { errors.push(`${item.id}: 장비요약 형식 누락 — 재분석 필요`); continue; }
    for (const equipment of item.장비요약) {
      if (!equipment || !["서버", "스토리지"].includes(equipment.종류) || typeof equipment.명칭 !== "string" || !Array.isArray(equipment.규격)) {
        errors.push(`${item.id}: 장비요약 형식 오류`); continue;
      }
      for (const fact of equipment.규격) {
        if (!fact || typeof fact !== "object" || Array.isArray(fact)) { errors.push(`${item.id}: 요약 규격 형식 오류`); continue; }
        const evidence = normalize(fact?.근거), value = normalize(fact?.값);
        const valid = FIELDS.includes(fact?.항목) && !!value && !!evidence && evidence.includes(value) && source.includes(evidence) && normalize(item.세부내용_원문).includes(evidence);
        fact.검증 = valid ? "원문 확인" : "확인 필요";
        if (!valid) errors.push(`${item.id} / ${equipment.명칭} / ${fact?.항목 || "규격"}: 요약 근거를 ECR 원문과 대조할 수 없음`);
      }
    }
  }
  return errors;
}
module.exports = { EQUIPMENT_SCHEMA, EQUIPMENT_PROMPT, verifyEquipment };
