const test = require("node:test");
const assert = require("node:assert/strict");
const { createModal } = require("../public/notice-modal.js");
const { createNoticeView } = require("../public/notice-view.js");
const { html, numberOf, format } = require("../public/format.js");

test("모달 인스턴스는 주입한 상태·표시 함수를 사용하고 닫을 때 분석과 포커스를 정리한다", () => {
  const nodes = new Map(), model = { currentRow: null, currentAnalysis: { old: true } };
  let stopped = 0, restored = 0, loaded = 0, refreshed = 0;
  const opener = { isConnected: true, focus() { restored++; } };
  const document = { activeElement: opener, querySelectorAll: () => [] };
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { focus() { document.activeElement = this; } });
    return nodes.get(id);
  };
  const view = createNoticeView({ html, numberOf, format, document });
  const modal = { style: { display: "none" }, contains: () => false };
  const controller = createModal({
    model, $, modal, document, html, numberOf, ...view,
    stopEcrAnalysis() { stopped++; },
    refreshAiAccess() { refreshed++; },
    loadEcr() { loaded++; },
  });
  const row = { mode: "bid", title: "테스트", announcementNumber: "one",
    files: [{ name: "<img src=x>", url: "https://example.test/file?a=1&b=2" }, { name: "제안요청서.hwp", url: "https://www.g2b.go.kr/rfp", source: "제안요청정보", kind: "<b>제안요청서" }] };
  controller.openModal(row);
  assert.equal(model.currentRow, row);
  assert.equal(model.currentAnalysis, null);
  assert.equal(modal.style.display, "flex");
  assert.equal($(".app").inert, true);
  assert.equal(document.activeElement, $("#modal-close"));
  assert.match($("#modal-file-list").innerHTML, /&lt;img src=x&gt;/);
  assert.match($("#modal-file-list").innerHTML, /a=1&amp;b=2/);
  // 제안요청정보 첨부는 출처·문서 구분 표식을 달고, 표식도 이스케이프한다. 공고 첨부에는 표식이 없다.
  assert.match($("#modal-file-list").innerHTML, /<span class="file-tag">제안요청정보·&lt;b&gt;제안요청서<\/span>/);
  assert.equal(($("#modal-file-list").innerHTML.match(/file-tag/g) || []).length, 1);
  controller.selectTab("ecr");
  assert.equal(loaded, 1);
  assert.equal(refreshed, 1);
  controller.closeModal();
  assert.equal(model.currentRow, null);
  assert.equal(modal.style.display, "none");
  assert.equal($(".app").inert, false);
  assert.equal(restored, 1);
  assert.equal(stopped, 3); // open, files tab, close
});
