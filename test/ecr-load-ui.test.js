const test = require("node:test");
const assert = require("node:assert/strict");

const { createEcr } = require("../public/ecr-ui.js");
function screen() {
  const requests = [], renders = [], nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", insertAdjacentHTML() {} }); return nodes.get(id); };
  const context = { currentRow: { announcementNumber: "one" }, currentAnalysis: null, ecrBusy: false, aiUnlocked: false, ecrRun: 0 };
  const controller = createEcr({
    $, model: context, state: context, numberOf: (row) => row.announcementNumber,
    renderEcr: (data) => renders.push(data), EquipmentSummary: { ...require("../public/equipment.js"), render: () => "" },
    GongHttp: { requestJson: (...args) => { requests.push(args); return new Promise(() => {}); } },
  });
  return { context, requests, renders, $, load: controller.loadEcr };
}

test("ECR 탭은 서버에 저장된 결과를 조회하지 않고 파일 분석을 안내한다", () => {
  const ui = screen();
  ui.load();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.renders.length, 0);
  assert.match(ui.$("#ecr-content").innerHTML, /제안요청서 파일을 올려/);
});

test("이번에 분석한 결과가 있으면 그대로 다시 그린다", () => {
  const ui = screen();
  ui.context.currentAnalysis = { provider: "workers-ai", ecr: [] };
  ui.load();
  assert.equal(ui.requests.length, 0);
  assert.deepEqual(ui.renders, [ui.context.currentAnalysis]);
});

test("공고가 닫힌 상태에서는 아무것도 그리지 않는다", () => {
  const ui = screen(); ui.context.currentRow = null;
  ui.load();
  assert.equal(ui.$("#ecr-content").innerHTML, "");
  assert.equal(ui.renders.length, 0);
});
