const { createRefresh } = require("../../public/refresh.js");
const { createHttp } = require("../../public/http.js");

// 실제 컨트롤러를 DOM과 지연 가능한 통신에 연결한다.
function refreshScreen(options = {}) {
  const requests = [], statuses = [], texts = [], nodes = new Map();
  const context = {
    refreshRevision: 0, refreshRunId: null, refreshRange: null, refreshSince: null,
    fileIndex: [], page: 2, ...options.initial,
  };
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "2026-09-01", disabled: false, className: "", setAttribute() {} });
    return nodes.get(id);
  };
  Object.defineProperty($("#refresh-status"), "textContent", {
    set(text) {
      texts.push(text);
      statuses.push([$("#refresh-btn").disabled, text, $("#refresh-status").className]);
    },
  });
  const GongHttp = createHttp({
    setTimeout: (fn, ms) => setTimeout(fn, options.timeoutMs ?? ms),
    fetch: (_url, requestOptions) => new Promise((resolve, reject) => requests.push({ options: requestOptions, resolve, reject })),
  });
  const controller = createRefresh({
    model: context, state: context, $, GongHttp, document: { querySelectorAll: () => [] },
    getJson: options.getJson || (() => Promise.resolve({ running: false })),
    loadIndex: options.loadIndex || (() => Promise.resolve({ changed: true })),
    totalCount: () => 1, dataRange: () => ({ end: "2026-09-10" }), format: String,
    resetPage: () => { context.page = 1; }, applyFilters: options.applyFilters || (() => {}),
  });
  Object.assign(context, controller);
  return { context, requests, statuses, texts, $, controller, button: $("#refresh-btn"), input: $("#end") };
}
module.exports = { refreshScreen };
