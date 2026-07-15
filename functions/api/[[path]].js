// Cloudflare Pages Functions - 나라장터 오픈API 프록시
// 파일 위치: functions/api/[[path]].js
// 요청 예: /api/1230000/ao/HrcspSsstndrdInfoService/getPublicPrcureThngInfoThngPPSSrch?...
// 중계:   https://apis.data.go.kr/1230000/ao/.../getPublicPrcure...?...&ServiceKey=<env>

const UPSTREAM = "https://apis.data.go.kr";
const ALLOWED_PREFIXES = ["/1230000/ao/", "/1230000/ad/"];

export async function onRequestGet(context) {
  const { env, request } = context;

  // 1) 인증키 확인
  if (!env.SERVICE_KEY) {
    return json({ error: "서버에 SERVICE_KEY가 설정되지 않았습니다." }, 500);
  }

  // 2) /api 접두어를 떼고 실제 나라장터 경로만 추출
  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/api/, "");

  // 3) 허용된 경로만 통과
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return json({ error: `허용되지 않은 경로입니다: ${path}` }, 403);
  }

  // 4) 업스트림 URL 조립 (클라이언트 파라미터 복사, ServiceKey는 서버 것으로 강제)
  const target = new URL(UPSTREAM + path);
  for (const [k, v] of incoming.searchParams) {
    if (k.toLowerCase() === "servicekey") continue;
    target.searchParams.append(k, v);
  }
  target.searchParams.set("ServiceKey", env.SERVICE_KEY);

  // 5) 중계 요청
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    return json({ error: `업스트림 요청 실패: ${e.message}` }, 502);
  }

  // 6) 응답 본문 확보
  const body = await upstream.text();

  // 7) 나라장터가 JSON이 아닌 XML/HTML 에러를 준 경우, 진단용으로 감싸서 전달
  //    (프론트의 JSON.parse가 '<'에서 터지는 것을 방지)
  const contentType = upstream.headers.get("Content-Type") || "";
  const looksJson = body.trim().startsWith("{") || body.trim().startsWith("[");

  if (!looksJson) {
    return json(
      {
        error: "업스트림이 JSON이 아닌 응답을 반환했습니다.",
        upstreamStatus: upstream.status,
        upstreamContentType: contentType,
        upstreamBodyPreview: body.slice(0, 400),
      },
      502
    );
  }

  // 8) 정상 JSON은 그대로 전달
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}