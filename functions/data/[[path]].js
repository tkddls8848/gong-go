// R2 버킷을 게이트 뒤에서 중계한다. 허용 키 외에는 전부 404.
// functions/_middleware.js가 모든 요청보다 먼저 실행되므로 이 경로도 게이트 뒤에 있다.
//
// Content-Encoding은 절대 붙이지 않는다 — 프런트가 DecompressionStream으로 직접 해제하므로
// 여기서 붙이면 브라우저가 먼저 풀어 이중 처리로 깨진다(devserver/server.js와 같은 제약).
//
// (pre|bid)/YYYY/MM/DD.csv.gz (일별) 과 (pre|bid)/YYYY/MM.csv.gz (월별 봉인, collector/compact.js) 을
// 함께 받는다. state/·raw/ 프리픽스는 정규식에 없으므로 구조적으로 도달할 수 없다.
//
// analysis 키를 [\w-]+ 가 아니라 [^/]{1,160} 으로 둔 이유: analyzer/analyze.js의 safeNotice는
// <>:"/\|?* 와 제어문자만 걸러낸다. 공고번호에 점·공백·한글이 들어가면 [\w-]+ 는 404를 낸다.
// R2 키는 평면 문자열이라 /만 막으면 경로 탈출은 성립하지 않는다.
const KEY = /^(index\.json|analysis-index\.json|(pre|bid)\/\d{4}\/\d{2}(\/\d{2})?\.csv\.gz|analysis\/bid\/[^/]{1,160}\.json)$/;
const RECENT_DAYS = 40; // 크론 재수집 창(35일)보다 넉넉히

export async function onRequestGet({ request, env, params }) {
  const key = (Array.isArray(params.path) ? params.path : [params.path]).join("/");
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });

  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
    "Cache-Control": cacheControl(key),
    "ETag": object.httpEtag,
  });
  // onlyIf 조건이 맞으면 본문 없는 R2Object가 온다 = 클라이언트 캐시가 최신.
  if (!object.body) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

// 과거 날짜 파일은 불변이므로 오래 캐시하고, 재수집 창 안쪽만 짧게 잡는다.
// public이 아니라 private인 이유는 게이트 뒤 응답을 공유 캐시에 남기지 않기 위해서다.
function cacheControl(key) {
  if (key.endsWith("index.json")) return "private, max-age=60";
  // 월별 봉인 파일은 재수집 창 밖에서만 만들어지므로(compact.js) 언제나 불변이다.
  if (/^(pre|bid)\/\d{4}\/\d{2}\.csv\.gz$/.test(key)) return "private, max-age=31536000, immutable";
  const date = key.match(/(\d{4})\/(\d{2})\/(\d{2})\.csv\.gz$/);
  if (!date) return "private, max-age=3600";
  const days = (Date.now() - Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`)) / 86400000;
  return days > RECENT_DAYS ? "private, max-age=31536000, immutable" : "private, max-age=300";
}
