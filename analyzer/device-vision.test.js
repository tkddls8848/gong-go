const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planDevices, validateDevices, analyzeDevices } = require('./device-vision');
const { buildReport, runDevicePlan } = require('./device-runner');
const device = n => ({ key: `device-${n}`, name: `보안 업무${n}`, type: 'logical', kind: '서버', pages: [24],
  source: `보안 업무${n} 4 32 2`, expected: { CPU: '4', 메모리: '32', 수량: '2' }, requiredFields: ['CPU', '메모리', '수량'] });
const selection = { status: 'ready', pdf: 'sample.pdf', warnings: [], sections: [{ id: '장비-018', name: 'HCI', inventoryWarnings: [], inventory: Array.from({ length: 19 }, (_, i) => device(i + 1)) }] };
const good = { facts: [{ field: 'CPU', quote: '4 Core' }, { field: '메모리', quote: '32GB' }, { field: '수량', quote: '2' }] };

test('HCI 19행은 마지막 행까지 계획하고 각 요청은 최대 4행으로 제한한다', () => {
  const jobs = planDevices(selection, 30);
  assert.deepEqual(jobs.map(j => j.devices.length), [4, 4, 4, 4, 3]);
  assert.equal(jobs.at(-1).devices.at(-1).key, 'device-19');
  assert.throws(() => planDevices(selection, 23), /호출 한도/);
});

test('명칭이 같은 장비도 요구사항/키가 다르면 합치지 않는다', () => {
  const jobs = planDevices({ ...selection, sections: [...selection.sections, { ...selection.sections[0], id: '장비-019' }] }, 100);
  assert.equal(jobs.flatMap(j => j.devices).length, 38);
});

test('첫 행만 반환하면 나머지를 missing으로 유지하고 행별 수치도 대조한다', () => {
  const job = planDevices(selection, 30)[0];
  const results = validateDevices({ 'device-1': good }, job);
  assert.deepEqual(results.map(d => d.status), ['extracted-unverified', 'missing', 'missing', 'missing']);
  const wrong = validateDevices({ 'device-1': { facts: [{ field: 'CPU', quote: '24core x 2CPU' }, { field: '메모리', quote: '512GB' }, { field: '수량', quote: '24port' }] } }, job)[0];
  assert.deepEqual(wrong.mismatches, ['CPU', '메모리', '수량']);
  assert.ok(wrong.missingFields.includes('수량'));
  const report = buildReport(selection, planDevices(selection, 30), [{ devices: results }]);
  assert.equal(report.expectedDevices, 19);
  assert.equal(report.extractedDevices, 1);
  assert.equal(report.status, 'needs-review');
});

test('Ollama 고정 키 스키마는 모든 장비를 요구하며 원문 수치 텍스트를 보내지 않는다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'p.png'); fs.writeFileSync(image, 'image');
  const job = { id: '장비-018', name: 'HCI', pages: [24], devices: [{ ...device(1), source: 'PRIVATE-SOURCE 4 32 2' }, device(2)] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:11434/'));
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => url.endsWith('/show') ? { capabilities: ['vision'] }
      : { done: true, done_reason: 'stop', message: { content: JSON.stringify(Object.fromEntries(['device-1', 'device-2'].map(key => [key, { CPU: ['4 Core'], 메모리: ['32GB'], 수량: ['2'] }]))) } } };
  };
  const result = await analyzeDevices(job, [{ image }], { output: dir, fetchImpl });
  assert.equal(result.devices.length, 2);
  assert.deepEqual(calls[1].format.required, ['device-1', 'device-2']);
  assert.ok(!JSON.stringify(calls[1]).includes('PRIVATE-SOURCE'));
  const cached = await analyzeDevices(job, [{ image }], { output: dir, fetchImpl });
  assert.equal(cached.cached, true); assert.equal(calls.length, 2);
  assert.equal(calls[1].options.num_ctx, 8192);
  await analyzeDevices({ ...job, pages: [24, 25] }, [{ image }, { image }], { output: dir, fetchImpl });
  assert.equal(calls.at(-1).options.num_ctx, 16384, 'two images leave room for the full output');
});

test('메모리 증설의 도입구분에 장비 이름을 넣으면 재확인한다', () => {
  const target = { ...device(1), type: 'physical', name: 'DB서버 메모리 증설', expected: {}, requiredFields: ['도입구분'] };
  const job = { id: 'ECR-005', devices: [target] };
  const invalid = validateDevices({ 'device-1': { facts: [{ field: '도입구분', quote: 'DB 메모리' }] } }, job)[0];
  assert.ok(invalid.missingFields.includes('도입구분'));
  const valid = validateDevices({ 'device-1': { facts: [{ field: '도입구분', quote: '메모리 증설' }] } }, job)[0];
  assert.deepEqual(valid.missingFields, []);
});

test('DDR5와 RAM 용량은 별도 숫자이며 CPU 소수점 누락은 불일치로 잡는다', () => {
  const target = { ...device(1), expected: { 메모리: '128', CPU: ['3.2', '2', '16'] }, requiredFields: [] };
  const job = { id: 'ECR-004', devices: [target] };
  const result = validateDevices({ 'device-1': { facts: [
    { field: '메모리', quote: 'DDR5 128GB 이상' }, { field: 'CPU', quote: '32GHz, 2CPU, 16core 이상' }
  ] } }, job)[0];
  assert.deepEqual(result.mismatches, ['CPU']);
});

test('실패한 묶음의 개별 재확인은 한 번이며 이후 묶음과 누락 목록을 보존한다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const tiny = { ...selection, sections: [{ ...selection.sections[0], inventory: [device(1), device(2)] }] };
  const report = await runDevicePlan(tiny, { output: dir, maxCalls: 3, render: async () => [{ page: 24 }], analyze: async job => {
    calls++;
    if (job.devices.length > 1) throw new Error('truncated');
    return { devices: validateDevices({ [job.devices[0].key]: good }, job), seconds: 1 };
  } });
  assert.equal(calls, 3); assert.equal(report.extractedDevices, 2);
  assert.ok(fs.existsSync(path.join(dir, 'result.html')));
});

test('수량만 재확인해도 앞서 읽은 CPU·메모리는 보존하며 다른 장비에 합치지 않는다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tiny = { ...selection, sections: [{ ...selection.sections[0], inventory: [device(1)] }] };
  const report = await runDevicePlan(tiny, { output: dir, maxCalls: 2, render: async () => [{ page: 24 }], analyze: async (job, pages, options) => {
    if (options.retry) assert.deepEqual(options.focusFields, ['수량']);
    const facts = options.retry ? good.facts.slice(2) : good.facts.slice(0, 2);
    return { devices: validateDevices({ 'device-1': { facts } }, job), seconds: 1 };
  } });
  assert.equal(report.devices[0].status, 'extracted-unverified');
  assert.equal(report.devices[0].규격.length, 3);
});
