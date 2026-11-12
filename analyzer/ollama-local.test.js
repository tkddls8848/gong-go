const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requestVision } = require('./ollama-local');

test('로컬 장비 분석도 cloud 및 원격/비시각 모델을 추론 전에 거절한다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(requestVision({ model: 'vision:cloud' }, dir, () => assert.fail('network')), /Cloud/);
  for (const info of [{ capabilities: ['vision'], remote_host: 'remote' }, { capabilities: ['completion'] }]) {
    await assert.rejects(requestVision({ model: 'local' }, dir, async url => {
      assert.ok(url.endsWith('/api/show'));
      return { ok: true, json: async () => info };
    }), /local vision/);
  }
});

