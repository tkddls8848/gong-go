const test = require('node:test');
const assert = require('node:assert/strict');
const { planDevices, validateDevices } = require('./device-vision');
const { buildReport } = require('./device-runner');
const device = n => ({ key: `device-${n}`, name: `보안 업무${n}`, type: 'logical', kind: '서버', pages: [24],
  source: `보안 업무${n} 4 32 2`, expected: { CPU: '4', 메모리: '32', 수량: '2' }, requiredFields: ['CPU', '메모리', '수량'] });
const selection = { status: 'ready', pdf: 'sample.pdf', warnings: [], sections: [{ id: '장비-018', name: 'HCI', inventoryWarnings: [], inventory: Array.from({ length: 19 }, (_, i) => device(i + 1)) }] };
const good = { facts: [{ field: 'CPU', quote: '4 Core' }, { field: '메모리', quote: '32GB' }, { field: '수량', quote: '2' }] };

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

