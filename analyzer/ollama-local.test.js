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

test('잘린 응답은 장비 목록 완료로 인정하지 않으며 재시도 지시는 별도 캐시 키다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetchImpl = async (url, options) => ({ ok: true, json: async () => url.endsWith('/show')
    ? { capabilities: ['vision'] } : { done: true, done_reason: JSON.parse(options.body).retry ? 'stop' : 'length' } });
  await assert.rejects(requestVision({ model: 'local' }, dir, fetchImpl), /Incomplete/);
  assert.equal((await requestVision({ model: 'local', retry: true }, dir, fetchImpl)).cached, false);
});
