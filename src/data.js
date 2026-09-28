const KEY = /^(index\.json|(pre|bid|plan)\/\d{4}\/\d{2}(\/\d{2})?\.csv\.gz)$/;
const RECENT_DAYS = 40;
export async function serveData(request, env, encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });

  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
    "Cache-Control": cacheControl(key),
    ETag: object.httpEtag,
  });
  // Content-Encoding은 절대 붙이지 않는다. 프런트가 gzip을 직접 해제하므로 이중 해제가 된다.
  // onlyIf 조건이 맞으면 본문 없는 R2Object가 온다 = 클라이언트 캐시가 최신.
  if (!object.body) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(object.body, { headers });
}

function cacheControl(key) {
  if (key === "index.json") return "private, max-age=60";
  if (/^(pre|bid)\/\d{4}\/\d{2}\.csv\.gz$/.test(key)) {
    return "private, max-age=31536000, immutable";
  }
  const date = key.match(/(\d{4})\/(\d{2})\/(\d{2})\.csv\.gz$/);
  if (!date) return "private, max-age=3600";
  const days = (Date.now() - Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`)) / 86400000;
  return days > RECENT_DAYS ? "private, max-age=31536000, immutable" : "private, max-age=300";
}
