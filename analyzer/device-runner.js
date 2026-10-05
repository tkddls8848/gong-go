const fs = require('node:fs');
const path = require('node:path');
const { planDevices, analyzeDevices, validateDevices } = require('./device-vision');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
// Logical inventory accepts only the explicit Core / Mem(GB) / quantity header.
const displayValue = (device, fact) => device.유형 === 'logical' && /^\d+$/.test(fact.값)
  ? fact.항목 === 'CPU' ? `${fact.값} Core` : fact.항목 === '메모리' ? `${fact.값} GB` : fact.값 : fact.값;

function buildReport(selection, jobs, results) {
  const devices = selection.sections.flatMap((section, index) => section.inventory.map(device => {
    const result = results.flatMap((r, j) => jobs[j].section === index ? r.devices : []).find(d => d.key === device.key);
    const failed = results.find((r, j) => jobs[j].section === index && jobs[j].devices.some(d => d.key === device.key) && r.error);
    return result || { id: section.id, 요구사항명: section.name, key: device.key, 명칭: device.name, 분류: device.kind, 유형: device.type, pages: device.pages,
      status: failed ? 'error' : 'not-analyzed', missingFields: device.requiredFields, mismatches: [], 규격: [], 불확실: failed ? [failed.error] : [] };
  }));
  const coverage = selection.sections.map(section => {
    const items = devices.filter(d => d.id === section.id);
    return { id: section.id, name: section.name, expected: items.length, extracted: items.filter(d => d.규격.length).length,
      unresolved: items.filter(d => d.status !== 'extracted-unverified').map(d => d.명칭), warnings: section.inventoryWarnings };
  });
  return { schemaVersion: 3, provider: 'ollama-vision', verified: false, source: selection.pdf, sourceSha256: selection.sha256,
    models: [...new Set(results.map(r => r.model).filter(Boolean))],
    status: devices.some(d => d.status !== 'extracted-unverified') || coverage.some(c => c.warnings?.length) ? 'needs-review' : 'extracted-unverified',
    totalPages: selection.totalPages, selectedPages: selection.selectedPages, jobs: jobs.length, completedJobs: results.length,
    expectedDevices: devices.length, extractedDevices: devices.filter(d => d.규격.length).length,
    seconds: results.reduce((s, r) => s + (r.seconds || 0), 0), secondsMeaning: '원시 응답의 모델 처리 시간 합계 (캐시 응답 포함, 이번 실행 벽시계 시간이 아님)', coverage, devices, results,
    warnings: ['장비 목록과 필수 규격 대조 결과이며 모든 규격의 정확성을 보증하지 않습니다. PDF 변환 시 표 머리글 겹침이 있으면 원본 HWP와 대조하세요.',
      '물리 장비와 HCI 논리 서버를 별도 행으로 표시합니다. 행 수는 구매 대수 합계가 아닙니다.', ...selection.warnings] };
}

function saveReport(report, output) {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const rows = [['요구사항', '장비', '유형', 'PDF쪽', '상태', '항목', '규격', '누락항목', '수치불일치']];
  for (const d of report.devices) for (const fact of d.규격.length ? d.규격 : [{ 항목: '', 값: '' }]) {
    rows.push([d.id, d.명칭, d.유형, d.pages.join(','), d.status, fact.항목, displayValue(d, fact), d.missingFields.join(','), d.mismatches.join(',')]);
  }
  fs.writeFileSync(path.join(output, 'equipment.csv'), '\ufeff' + rows.map(row => row.map(csv).join(',')).join('\r\n'));
  const cards = report.devices.map(d => {
    const source = path.relative(output, report.source).replace(/\\/g, '/');
    const review = d.missingFields.length || d.mismatches.length
      ? `<p class="warn">미추출: ${esc(d.missingFields.join(', '))} / 행 수치 대조 불일치: ${esc(d.mismatches.join(', '))}</p>` : '';
    const evidence = d.대조원문 ? `<details><summary>대조용 PDF 텍스트 (LLM에 전송하지 않음)</summary><pre>${esc(d.대조원문)}</pre></details>` : '';
    const common = d.공통규격_대조용텍스트 ? `<details><summary>UNIX 공통 규격 원문 (로컬 텍스트 추출)</summary><pre>${esc(d.공통규격_대조용텍스트)}</pre></details>` : '';
    return `<article><h3>${esc(d.id)} · ${esc(d.명칭)}</h3><p>${esc(d.요구사항명)} · ${esc(d.유형)} · <a href="${esc(source)}#page=${d.pages[0]}">PDF ${esc(d.pages.join(', '))}쪽</a> · ${esc(d.status)}</p>${review}<table>${d.규격.map(f => `<tr><th>${esc(f.항목)}</th><td>${esc(displayValue(d, f))}</td></tr>`).join('')}</table>${evidence}${common}</article>`;
  }).join('');
  fs.writeFileSync(path.join(output, 'result.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>전체 장비 규격 추출 결과</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:20px;background:#f5f7fa;color:#172636}article{background:white;padding:20px;margin:20px 0;border:1px solid #ccd6e0}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left;white-space:pre-wrap}th{width:130px}.warn{color:#a43a14}input{padding:12px;width:80%}</style><h1>전체 장비 규격 추출 결과</h1><p>장비 구간 ${report.coverage.length}개 · 장비/논리 서버 행 ${report.extractedDevices}/${report.expectedDevices}개 추출 · 요청 ${report.completedJobs}/${report.jobs}개 처리</p><p>${esc(report.warnings.join(' '))}</p><p><a href="equipment.csv">CSV</a> · <a href="report.json">JSON 및 원시 결과</a></p><input id="search" placeholder="UNIX, HCI, 장비 번호, 이름 검색"><main>${cards}</main><script>document.getElementById('search').addEventListener('input',function(){for(const card of document.querySelectorAll('article'))card.hidden=!card.textContent.toLowerCase().includes(this.value.toLowerCase())})</script></html>`);
}

async function runDevicePlan(selection, { output, maxCalls, model, render, analyze = analyzeDevices }) {
  const jobs = planDevices(selection, maxCalls), results = [];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'jobs.json'), JSON.stringify(jobs, null, 2));
  saveReport(buildReport(selection, jobs, results), output);
  // Render each selected page once. Jobs reuse images without sending document text.
  const pages = await render([...new Set(jobs.flatMap(j => j.pages))]);
  for (const job of jobs) {
    const options = { model, output: path.join(output, 'cache') };
    let result;
    try { result = await analyze(job, job.pages.map(p => pages.find(page => page.page === p)), options); }
    catch (error) { result = { devices: [], error: error.message, seconds: 0 }; }
    const retries = [];
    for (const device of job.devices) {
      const found = result.devices.find(d => d.key === device.key);
      if (found?.status === 'extracted-unverified') continue;
      // A single isolated retry covers omission, truncation and row/column mistakes.
      try {
        const focusFields = found?.규격.length ? [...new Set([...found.missingFields, ...found.mismatches])] : [];
        const isolated = { ...job, devices: [device] };
        const retry = await analyze(isolated, job.pages.map(p => pages.find(page => page.page === p)), { ...options, retry: true, focusFields });
        retries.push(retry);
        let candidate = retry.devices[0];
        if (found && focusFields.length && candidate) {
          const facts = [...found.규격.filter(f => !focusFields.includes(f.항목)), ...candidate.규격.filter(f => focusFields.includes(f.항목))]
            .map(f => ({ field: f.항목, quote: f.값 }));
          candidate = validateDevices({ [device.key]: { facts } }, isolated)[0];
        }
        const score = d => !d || d.status === 'missing' ? 1000 : d.missingFields.length + d.mismatches.length + d.불확실.length;
        if (score(candidate) < score(found)) result.devices = [...result.devices.filter(d => d.key !== device.key), candidate];
      } catch (error) { retries.push({ error: error.message }); }
    }
    result.retries = retries;
    result.seconds += retries.reduce((n, r) => n + (r.seconds || 0), 0);
    results.push(result);
    saveReport(buildReport(selection, jobs, results), output);
    console.log(JSON.stringify({ job: job.key, id: job.id, completed: results.length, total: jobs.length,
      devices: result.devices.length, expected: job.devices.length, retries: retries.length, error: result.error, seconds: result.seconds }));
  }
  return buildReport(selection, jobs, results);
}
module.exports = { buildReport, saveReport, runDevicePlan };
