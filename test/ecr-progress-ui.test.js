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
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("변환 요청 중 중지하면 뒤따르는 추론 요청을 보내지 않는다", async () => {
  const ui = screen(), run = ui.start();
  assert.equal(ui.$("#ecr-file").disabled, true);
  ui.stop();
  ui.requests[0].resolve(reply({ id: "job", total: 2 })); await run;
  assert.equal(ui.requests.length, 1);
  assert.match(ui.$("#ecr-progress").textContent, /추가 분석을 중지/);
  assert.equal(ui.$("#ecr-analyze-btn").disabled, false);
});

test("진행 중인 구간에서 중지해도 응답 완료까지 중복 실행을 허용하지 않는다", async () => {
  const ui = screen(), run = ui.start();
  ui.requests[0].resolve(reply({ id: "job", total: 2 })); await flush();
  assert.equal(ui.requests.length, 2);
  ui.stop(); await ui.start();
  assert.equal(ui.requests.length, 2);
  ui.requests[1].resolve(reply({ retry: true, message: "다시 분석" })); await run;
  assert.equal(ui.requests.length, 2);
  assert.match(ui.$("#ecr-progress").textContent, /추가 분석을 중지/);
  assert.equal(ui.$("#ecr-stop-btn").hidden, true);
});

test("닫은 뒤 같은 공고 객체를 다시 열어도 이전 작업은 이어지지 않는다", async () => {
  const ui = screen(), row = ui.context.currentRow, run = ui.start();
  ui.context.closeModal();
  ui.context.currentRow = row;
  ui.requests[0].resolve(reply({ id: "job", total: 3 })); await run;
  assert.equal(ui.requests.length, 1);
});

test("중단한 요청 종료 후 같은 파일로 새 작업을 시작할 수 있다", async () => {
  const ui = screen(), first = ui.start();
  ui.stop(); ui.requests[0].resolve(reply({ id: "job", total: 1 })); await first;
  const second = ui.start();
  ui.requests[1].resolve(reply({ id: "job", total: 1 })); await flush();
  ui.requests[2].resolve(reply({ completed: 1, total: 1 })); await second;
  assert.equal(ui.requests.length, 3);
  assert.match(ui.requests[2].url, /action=step/);
});

test("통신 계층 실패 뒤 처리 중 상태를 해제하고 재시작을 허용한다", async () => {
  const ui = screen();
  ui.context.GongHttp.requestJson = async () => { throw new Error("응답 대기 시간이 초과되었습니다."); };
  await ui.start();
  assert.equal(ui.$("#ecr-analyze-btn").disabled, false);
  assert.equal(ui.$("#ecr-file").disabled, false);
  assert.equal(ui.$("#ecr-stop-btn").hidden, true);
  assert.match(ui.$("#ecr-progress").textContent, /대기 시간이 초과/);
});
