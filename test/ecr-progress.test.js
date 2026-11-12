const test = require("node:test");
const assert = require("node:assert/strict");

const { createEcr } = require("../public/ecr-ui.js");
const { createAiAccess } = require("../public/ai-access.js");
const { createModal } = require("../public/notice-modal.js");
function screen() {
  const nodes = new Map(), requests = [];
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", value: "", files: [{ name: "rfp.md", size: 100 }], querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const context = { currentRow: { mode: "bid", number: "test" }, currentAnalysis: null,
    ecrBusy: false, aiUnlocked: false, ecrRun: 0,
    GongHttp: { requestJson: (url, options) => new Promise((resolve) => requests.push({
      url, resolve: async (response) => resolve({ response, data: await response.json() })
    })) } };
  const access = createAiAccess({ $, state: context, GongHttp: context.GongHttp });
  const controller = createEcr({ $, model: context, state: context, numberOf: (row) => row.number,
    GongHttp: context.GongHttp, showAiAccess: access.showAiAccess });
  const modal = createModal({ $, model: context, modal: { style: {} }, stopEcrAnalysis: controller.stopEcrAnalysis });
  context.closeModal = modal.closeModal;
  access.showAiAccess(true);
  return { $, requests, context, start: () => controller.startEcrAnalysis({ preventDefault() {} }), stop: controller.stopEcrAnalysis };
}

const reply = (data) => ({ ok: true, json: async () => data });

test("변환 요청 중 중지하면 뒤따르는 추론 요청을 보내지 않는다", async () => {
  const ui = screen(), run = ui.start();
  assert.equal(ui.$("#ecr-file").disabled, true);
  ui.stop();
  ui.requests[0].resolve(reply({ id: "job", total: 2 })); await run;
  assert.equal(ui.requests.length, 1);
  assert.match(ui.$("#ecr-progress").textContent, /추가 분석을 중지/);
  assert.equal(ui.$("#ecr-analyze-btn").disabled, false);
});

