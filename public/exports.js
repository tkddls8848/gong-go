// 현재 검색 결과와 저장 ECR의 CSV 내보내기, 첨부 다운로드.
(function (scope) {
  "use strict";
  function createExports({
    model, analyses, $, downloadRows, MODE_NAMES, normalizeFiles, numberOf,
    GongHttp = scope.GongHttp, EquipmentSummary = scope.EquipmentSummary,
    window = scope.window, DATA_BASE = "/data"
  } = {}) {
    // 발주계획은 마감일이 없고 발주예정월이 그 자리를 대신하며, 첨부 URL도 없어 그 칸이 빈다.
    // 나라장터 링크는 모드마다 자리가 달라지지 않도록 전용 열로 뺐다.
    function downloadCsv() { downloadRows([["유형", "공고번호", "업무", "수요기관", "사업명(공고명)", "게시일", "마감일/발주예정", "첨부파일", "나라장터 링크"], ...model.filtered.map((row) => [MODE_NAMES[row.mode] || row.mode, numberOf(row), row.businessType, row.institution, row.title, row.publishedAt, row.mode === "plan" ? row.orderMonth : row.closeAt, row.mode === "plan" ? "" : normalizeFiles(row.files).map((file) => `${file.name} (${file.url})`).join(" | "), row.detailUrl || ""])], "gong-go"); }
    async function downloadEcr() {
      const rows = [["공고번호", "사업명", "ID", "분류", "명칭", "수량", "산출물", "세부내용 원문", "검증", "장비 요구사항", "근거", "미추출 번호", "제외/불확실", "검증 오류", "검증 경고", "번호 대조", "분석일", "분석 모델", "출처"]];
      // 내보내기 중 화면 검색/분석 목록이 바뀌어도 시작 시점의 대상과 경로를 유지한다.
      const targets = model.filtered.flatMap((row) => { const entry = analyses.get(numberOf(row)); return entry ? [{ row: { ...row }, path: entry.path }] : []; });
      if (!targets.length) { window.alert("현재 검색 결과에 저장된 ECR 분석이 없습니다."); return; }
      for (const { row, path } of targets) {
        try {
          const { response, data } = await GongHttp.requestJson(path.startsWith("/api/") ? path : `${DATA_BASE}/${path}`, { cache: "no-store" }, 30000, "read");
          if (!response.ok) throw new Error("저장 결과를 조회하지 못했습니다. 잠시 후 다시 시도하세요.");
          EquipmentSummary.validate(data);
          const items = data.ecr;
          // 0건 분석도 공고 행과 경고를 남긴다. 빈 파일을 '요구사항 없음'으로 오인하지 않게 한다.
          for (const item of items.length ? items : [{ 명칭: "추출된 ECR 없음" }]) {
            // 동일 요구사항 안의 여러 장비를 평탄화하면 수량·근거의 소속이 사라진다.
            // CSV 열과 요구사항당 한 행은 유지하되 장비 순번·종류·명칭으로 연결한다.
            const equipment = (item.장비요약 || []).map((entry, index) => ({ entry, label: `[장비 ${index + 1} | ${entry.종류 || "분류 확인 필요"} | ${entry.명칭 || "명칭 확인 필요"}]` }));
            const facts = equipment.flatMap(({ entry, label }) => entry.규격.map((fact) => ({ fact, label })));
            const requirements = equipment.length
              ? equipment.map(({ entry, label }) => `${label}\n${entry.규격.length ? entry.규격.map((fact) => `${fact.항목 || "항목 확인 필요"}: ${fact.값 || "미기재"}`).join("\n") : "추출 규격 없음 — 원문 확인 필요"}`).join("\n\n")
              : (item.기본규격 || []).map((spec) => `${spec.구분 || "구분 미기재"} | ${spec.항목 || "항목 미기재"}: ${spec.요구사항 || "미기재"}`).join("\n");
            rows.push([numberOf(row), row.title, item.id, item.분류, item.명칭,
              facts.filter(({ fact }) => fact.항목 === "수량").map(({ fact, label }) => `${label} ${fact.값 || "미기재"}`).join("\n") || (item.기본규격 || []).map((spec) => spec.수량).filter((value) => value !== undefined && value !== "").join(", "),
              (item.산출물 || []).join(", "), item.세부내용_원문, !items.length ? "추출 결과 없음 — 원문 확인 필요" : EquipmentSummary.isVerified(data) ? "통과" : "원문 확인 필요",
              requirements, equipment.map(({ entry, label }) => `${label}\n출처: ${entry.출처 || item.출처 || (data.sourceFiles || []).join(", ") || "확인 필요"}\n${entry.규격.map((fact) => `${fact.항목 || "항목 확인 필요"}: ${fact.근거 || "근거 없음"} (${fact.검증 || "확인 필요"})`).join("\n")}`).join("\n\n"),
              [...new Set([...(data.누락 || []), ...(data.coverage?.missingIds || [])])].join(", "),
              (item.불확실 || []).join("\n"), (data.verification?.errors || []).join("\n"), (data.verification?.warnings || []).join("\n"),
              data.coverage?.status === "matched" ? "번호 일치 — 규격 완전성 미검증" : data.coverage?.status === "partial" ? "미추출 번호 있음" : "번호 대조 불가",
              data.analyzedAt || "", data.model || "", item.출처 || (data.sourceFiles || []).join(", ")]);
          }
        } catch (error) { window.alert(`ECR 내보내기 실패: ${error.message}`); return; }
      }
      downloadRows(rows, "gong-go-ecr");
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
    return { downloadCsv, downloadEcr, downloadAll };
  }
  const api = { createExports };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  scope.GongExports = api;
})(typeof self === "undefined" ? globalThis : self);
