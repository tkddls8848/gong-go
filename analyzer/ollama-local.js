const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Cache keys include the entire request (images, schema, instructions, model).
async function requestVision(body, output, fetchImpl = fetch) {
  if (/cloud/i.test(body.model)) throw new Error('Cloud models are not allowed');
  fs.mkdirSync(output, { recursive: true });
  const key = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const file = path.join(output, `${key}.json`);
  let response, cached = fs.existsSync(file);
  if (cached) response = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const post = async (route, data, timeout) => {
      const result = await fetchImpl(`http://127.0.0.1:11434/api/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        signal: AbortSignal.timeout(timeout), redirect: 'error'
      });
      if (!result.ok) {
        const detail = typeof result.text === 'function' ? (await result.text()).slice(0, 500) : '';
        throw new Error(`Ollama HTTP ${result.status}${detail ? ': ' + detail : ''}`);
      }
      return result.json();
    };
    const info = await post('show', { model: body.model }, 10000);
    if (info.remote_host || info.remote_model || !info.capabilities?.includes('vision')) throw new Error('A local vision model is required');
    response = await post('chat', body, 240000);
    if (response.error) throw new Error(response.error);
    fs.writeFileSync(file, JSON.stringify(response, null, 2));
  }
  if (!response.done || response.done_reason === 'length') throw new Error('Incomplete output; reduce devices per request');
  return { response, cached };
}
module.exports = { requestVision };
