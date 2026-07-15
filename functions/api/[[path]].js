const UPSTREAM = "https://apis.data.go.kr";
const ALLOWED_PREFIXES = ["/1230000/ao/", "/1230000/ad/"];

export default async function handler(req, res) {
  const key = process.env.G2B_SERVICE_KEY;
  if (!key) return res.status(500).json({ error: "G2B_SERVICE_KEY 미설정" });

  const incoming = new URL(req.url, "http://localhost");
  const path = incoming.pathname.replace(/^\/api/, "");

  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return res.status(403).json({ error: "허용되지 않은 경로" });
  }

  const target = new URL(UPSTREAM + path);
  for (const [k, v] of incoming.searchParams) {
    if (k.toLowerCase() === "servicekey") continue;
    target.searchParams.append(k, v);
  }
  target.searchParams.set("ServiceKey", key);

  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: "application/json" },
    });
    const body = await upstream.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: `업스트림 실패: ${e.message}` });
  }
}