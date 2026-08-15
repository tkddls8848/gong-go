const SCHEMA_VERSION = 1;

const ECR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["사업개요", "ID부여규칙", "요구사항목록", "ecr", "누락", "기타요구사항"],
  properties: {
    사업개요: { type: "object", additionalProperties: false, required: ["사업명", "수요기관", "사업기간", "예산", "계약방식"], properties: { 사업명: { type: "string" }, 수요기관: { type: "string" }, 사업기간: { type: "string" }, 예산: { type: "string" }, 계약방식: { type: "string" } } },
    ID부여규칙: { type: "string" },
    요구사항수: { type: ["integer", "null"] },
    요구사항목록: { type: "array", items: { type: "object", additionalProperties: false, required: ["구분", "ID", "명칭"], properties: { 구분: { type: "string" }, ID: { type: "string" }, 명칭: { type: "string" } } } },
    ecr: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "분류", "명칭", "정의", "세부내용_원문", "기본규격", "파생규격", "산출물", "출처", "불확실"], properties: { id: { type: "string" }, 분류: { type: "string" }, 명칭: { type: "string" }, 정의: { type: "string" }, 세부내용_원문: { type: "string" }, 기본규격: { type: "array", items: { type: "object", additionalProperties: false, required: ["구분", "항목", "요구사항", "수량"], properties: { 구분: { type: "string" }, 항목: { type: "string" }, 요구사항: { type: "string" }, 수량: { type: "string" } } } }, 파생규격: { type: "object", additionalProperties: false, required: ["cpu", "ram", "gpu", "disk", "nic", "기타"], properties: { cpu: { type: "string" }, ram: { type: "string" }, gpu: { type: "string" }, disk: { type: "string" }, nic: { type: "string" }, 기타: { type: "string" } } }, 산출물: { type: "array", items: { type: "string" } }, 출처: { type: "string" }, 불확실: { type: "array", items: { type: "string" } } } } },
    누락: { type: "array", items: { type: "string" } },
    기타요구사항: { type: "array", items: { type: "object", additionalProperties: false, required: ["구분", "ID", "명칭"], properties: { 구분: { type: "string" }, ID: { type: "string" }, 명칭: { type: "string" } } } }
  }
};

const SYSTEM_PROMPT = `당신은 공공 정보화사업 제안요청서에서 시스템 장비 구성 요구사항(ECR)을 원문 충실하게 구조화하는 분석가다. 추측하거나 빈 값을 지어내지 말고, 확인할 수 없는 값은 빈 문자열/빈 배열과 불확실 사유로 남겨라. ID는 문서 표기를 한 글자도 바꾸지 않는다. 세부내용_원문은 요약하지 말고 해당 셀의 원문을 보존한다.`;
function passAPrompt() { return `문서 전체에서 요구사항 총괄표를 찾아 사업개요, ID부여규칙, 요구사항목록을 작성하라. ECR로 시작하는 요구사항은 요구사항목록에 모두 넣고, 그 외(PER/SER/TER 등)는 기타요구사항에 넣어라. 총괄표가 ECR 요구사항수를 명시하면 요구사항수에 정수로 넣고, 없으면 null로 둬라. ecr은 빈 배열, 누락은 빈 배열로 반환하라.`; }
function passBPrompt(ids) { return `다음 ECR ID의 상세 요구사항만 문서에서 찾아 ecr에 빠짐없이 채워라: ${ids.join(", ")}. ID를 새로 만들거나 정규화하지 말고, 원문에서 찾지 못한 ID는 누락에 넣어라. 요구사항목록에는 이 ECR ID 목록을 그대로 넣어라. 세부내용_원문 앞부분은 문서에서 실제로 연속해 있는 텍스트여야 한다.`; }

module.exports = { SCHEMA_VERSION, ECR_SCHEMA, SYSTEM_PROMPT, passAPrompt, passBPrompt };
