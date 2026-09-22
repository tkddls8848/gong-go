// 이 Worker의 AI 호출은 동일한 UTC 일일 예산을 공유한다. 다른 Worker의 사용량은 포함되지 않는다.
// 공식 단가(2026-09-22): https://developers.cloudflare.com/workers-ai/platform/pricing/
const RATES = {
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
};
export const DAILY_NEURONS = 8000;
export async function reserveNeurons(bucket, amount, now = Date.now()) {
  if (!bucket) throw new Error("AI 예산 저장소가 없습니다.");
  const date = new Date(now).toISOString().slice(0, 10);
  const key = `_meta/ai-budget/${date}.json`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const prior = await bucket.get(key);
    const used = prior ? (await prior.json()).reserved : 0;
    if (!Number.isFinite(used) || used < 0) throw new Error("AI 예산 상태를 확인할 수 없습니다.");
    if (used + amount > DAILY_NEURONS) throw Object.assign(new Error("오늘 AI 분석 예산을 모두 사용했습니다. 한국시간 오전 9시 이후 다시 시도하세요."), { status: 429 });
    const stored = await bucket.put(key, JSON.stringify({ date, reserved: used + amount }), {
      onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: "*" },
    });
    if (stored) return { date, reserved: used + amount, limit: DAILY_NEURONS };
  }
  throw Object.assign(new Error("동시에 분석 요청이 많습니다. 잠시 후 다시 시도하세요."), { status: 409 });
}
export async function runBudgeted(env, model, options) {
  const rates = RATES[model];
  if (!rates) throw new Error("무료 예산에 등록되지 않은 모델입니다.");
  // UTF-8 바이트 수는 텍스트 토큰 수의 보수적인 상한. 템플릿 여유와 25% 여유분을 포함한다.
  const bytes = new TextEncoder().encode(JSON.stringify(options)).length + 1024;
  const amount = Math.ceil((bytes * rates[0] + options.max_tokens * rates[1]) / 1e6 * 1.25);
  await reserveNeurons(env.DATA, amount);
  // 실패/시간 초과에도 반환하지 않는다. 실제 추론 비용이 이미 발생했을 수 있다.
  return env.AI.run(model, options);
}
