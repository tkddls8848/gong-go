// 현재 검색 결과와 이번 ECR 분석 결과의 CSV 내보내기, 첨부 다운로드.
(function (scope) {
  "use strict";
  function createExports({
    model, $, downloadRows, MODE_NAMES, normalizeFiles, numberOf,
    EquipmentSummary = scope.EquipmentSummary, window = scope.window
  } = {}) {
    // 발주계획은 마감일이 없고 발주예정월이 그 자리를 대신하며, 첨부 URL도 없어 그 칸이 빈다.
    // 나라장터 링크는 모드마다 자리가 달라지지 않도록 전용 열로 뺐다.
    function downloadCsv() { downloadRows([["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일/발주예정", "첨부파일", "나라장터 링크"], ...model.filtered.map((row) => [MODE_NAMES[row.mode] || row.mode, numberOf(row), row.businessType, row.institution, row.title, row.publishedAt, row.mode === "plan" ? row.orderMonth : row.closeAt, row.mode === "plan" ? "" : normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | "), row.detailUrl || ""])], "gong-go"); }
    // 서버에 저장된 결과는 없다. 지금 모달에 보이는 이번 분석 결과만 CSV로 내려받는다.
    // 공고번호는 파일명에 있으므로 열은 규격번호·요청내용·스펙·비고만 둔다. 근거·모델 등은 화면에서 본다.
    // 정규화 수치는 스펙 원문에서 읽은 수와 단위다. 비교·정렬용으로 마지막 열에 덧붙인다.
    function downloadEcr() {
      const rows = [["규격번호", "요청내용", "스펙", "비고", "정규화 수치"]];
      const row = model.currentRow, data = model.currentAnalysis;
      if (!row || !data) { window.alert("내보낼 ECR 분석 결과가 없습니다. 먼저 제안요청서를 분석하세요."); return; }
      try {
        EquipmentSummary.validate(data);
        const items = data.ecr, check = EquipmentSummary.isVerified(data) ? "" : "원문 확인 필요";
        // 0건 분석도 행을 남긴다. 빈 파일을 '요구사항 없음'으로 오인하지 않게 한다.
        if (!items.length) rows.push(["", "추출된 ECR 없음", "", "추출 결과 없음 — 원문 확인 필요", ""]);
        for (const item of items) {
          const equipment = item.장비요약 || [];
          // 한 요구사항에 장비가 여럿이면 규격이 어느 장비 것인지 머리줄로 묶는다.
          const spec = equipment.length
            ? equipment.map((entry) => {
              const lines = entry.규격.length ? entry.규격.map((fact) => `${fact.항목 || "항목 확인 필요"}: ${fact.값 || "미기재"}`) : ["추출 규격 없음"];
              return equipment.length > 1 ? [`[${entry.명칭 || entry.종류 || "명칭 확인 필요"}]`, ...lines].join("\n") : lines.join("\n");
            }).join("\n\n")
            : (item.기본규격 || []).map((entry) => `${entry.항목 || entry.구분 || "항목 미기재"}: ${entry.요구사항 || "미기재"}${entry.수량 !== undefined && entry.수량 !== "" ? ` (수량 ${entry.수량})` : ""}`).join("\n");
          const numbers = equipment.flatMap((entry) => entry.규격.map((fact) => [fact.항목, EquipmentSummary.normalized(fact)]).filter(([, text]) => text).map(([field, text]) => `${equipment.length > 1 ? `[${entry.명칭 || entry.종류 || "명칭 확인 필요"}] ` : ""}${field || "항목 확인 필요"}: ${text}`));
          rows.push([item.id || "", item.명칭 || item.분류 || "", spec, [check, ...(item.불확실 || [])].filter(Boolean).join("\n"), numbers.join("\n")]);
        }
        // 원문에는 있는데 뽑지 못한 번호도 행으로 남겨 빠진 줄을 표에서 바로 보이게 한다.
        for (const id of new Set([...(data.누락 || []), ...(data.coverage?.missingIds || [])])) rows.push([id, "", "", "미추출 — 원문 확인 필요", ""]);
      } catch (error) { window.alert(`ECR 내보내기 실패: ${error.message}`); return; }
      downloadRows(rows, `gong-go-ecr-${numberOf(row)}`);
    }
    // 장비 한 종이 한 줄, 규격 항목이 한 열이다. 여러 공고의 장비를 나란히 놓고 비교하거나 견적 양식에
    // 옮기기 쉬운 모양이다. 규격번호별로 한 칸에 모아 적는 위의 CSV는 그대로 둔다 — 열 구성을 믿고
    // 쓰는 곳이 있을 수 있다. 값은 원문 표현 그대로이고 합산·환산하지 않는다.
    const LAST_FIELDS = ["프로토콜", "이중화", "라이선스", "유지보수", "기타 조건"];
    function downloadEquipment() {
      const row = model.currentRow, data = model.currentAnalysis;
      if (!row || !data) { window.alert("내보낼 ECR 분석 결과가 없습니다. 먼저 제안요청서를 분석하세요."); return; }
      let rows;
      try {
        EquipmentSummary.validate(data);
        // 열은 화면의 종류별 항목을 모은 것이다. 어느 종류에나 붙는 조건은 뒤로 모은다.
        const known = [...new Set(Object.values(EquipmentSummary.fields).flat())];
        const columns = [...known.filter((field) => !LAST_FIELDS.includes(field)), ...LAST_FIELDS.filter((field) => known.includes(field))];
        const header = ["규격번호", "요청내용", "장비 종류", "장비명", ...columns, "그 밖의 항목", "핵심 미기재", "비고", "정규화 수치", "출처"];
        const blank = (first, note) => [first, ...Array(header.length - 1).fill("")].map((cell, index) => (index === header.indexOf("비고") ? note : cell));
        const text = (fact) => `${fact.값 || "미기재"}${fact.검증 === "원문 확인" ? "" : " (확인 필요)"}`;
        rows = [header];
        const list = EquipmentSummary.devices(data);
        if (!list.length) rows.push(blank("", "추출된 장비 없음 — 원문 확인 필요"));
        for (const { item, entry, specs, missing } of list) {
          const others = specs.filter((fact) => !columns.includes(fact.항목)).map((fact) => `${fact.항목 || "항목 확인 필요"}: ${text(fact)}`);
          // 장비가 여럿인 번호의 사유는 "[장비 이름] …"으로 온다. 이 장비의 것과 번호 전체에 걸린 것만 싣는다.
          const notes = (item.불확실 || []).filter((message) => !/^\[[^\]]+\] /.test(message) || message.startsWith(`[${entry.명칭}] `));
          const numbers = specs.map((fact) => [fact.항목, EquipmentSummary.normalized(fact)]).filter(([, value]) => value).map(([field, value]) => `${field}: ${value}`);
          rows.push([
            item.id || "", item.명칭 || "", entry.종류 || "", entry.명칭 || "",
            ...columns.map((field) => specs.filter((fact) => fact.항목 === field).map(text).join("\n")),
            others.join("\n"), missing.join(", "), notes.join("\n"), numbers.join("\n"), entry.출처 || item.출처 || "",
          ]);
        }
        // 장비 요약이 없는 구형 항목과 뽑지 못한 번호도 줄로 남긴다. 빠진 줄이 표에서 보여야 한다.
        for (const item of data.ecr) if (!Array.isArray(item.장비요약) || !item.장비요약.length) rows.push(blank(item.id || "", "장비 요약 없음 — 원문 확인 필요").map((cell, index) => (index === 1 ? item.명칭 || "" : cell)));
        for (const id of new Set([...(data.누락 || []), ...(data.coverage?.missingIds || [])])) rows.push(blank(id, "미추출 — 원문 확인 필요"));
      } catch (error) { window.alert(`ECR 내보내기 실패: ${error.message}`); return; }
      downloadRows(rows, `gong-go-ecr-devices-${numberOf(row)}`);
    }
    async function downloadAll() {
      const files = normalizeFiles(model.currentRow?.files), button = $("#download-all-btn");
      if (!files.length) return;
      button.disabled = true;
      for (let i = 0; i < files.length; i += 1) {
        button.textContent = `\uB2E4\uC6B4\uB85C\uB4DC \uC911... (${i + 1}/${files.length})`;
        window.open(files[i].url, "_blank", "noopener,noreferrer");
        if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 700));
      }
      button.textContent = `\uC804\uCCB4 \uB2E4\uC6B4\uB85C\uB4DC \uC644\uB8CC (${files.length}\uAC74)`;
      button.disabled = false;
    }
    return { downloadCsv, downloadEcr, downloadEquipment, downloadAll };
  }
  const api = { createExports };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongExports = api;
})(typeof self === "undefined" ? globalThis : self);
