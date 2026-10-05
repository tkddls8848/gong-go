"use strict";
const convertUi = GongConvertUi.createConversionUi({
  $: (selector) => document.querySelector(selector), converter: GongHwp.createConverter()
});
document.querySelector("#convert-form").onsubmit = convertUi.start;
document.querySelector("#convert-cancel").onclick = convertUi.cancel;
document.querySelector("#convert-file").onchange = convertUi.clearResult;
window.addEventListener("pagehide", convertUi.dispose);
