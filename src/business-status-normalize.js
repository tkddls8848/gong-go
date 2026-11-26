const AUTH_CODES = new Set(["20", "30", "31", "32"]);
const AUTH_TEXT = /SERVICE_KEY|Unauthorized|NOT_REGISTERED/i;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

export class UpstreamError extends Error {
  constructor(code = "upstream") {
    super(code === "not_authorized"
      ? "낙찰·계약과정 조회 권한이 없습니다. 서비스 키의 활용신청을 확인하세요."
      : "공고 진행 정보를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.");
    this.name = "UpstreamError";
    this.code = code === "not_authorized" ? code : "upstream";
  }
}

export function readItems(json) {
  const response = json?.response;
  const header = response?.header;
  if (!isRecord(header)) throw new UpstreamError();
  if (header.resultCode !== "00") {
    throw new UpstreamError(AUTH_CODES.has(String(header.resultCode)) || AUTH_TEXT.test(text(header.resultMsg)) ? "not_authorized" : "upstream");
  }
  const body = response.body;
  if (!isRecord(body)) throw new UpstreamError();
  let items = body.items;
  if (isRecord(items) && Object.hasOwn(items, "item")) items = items.item;
  if (items === "" || items === null) return [];
  // An absent items field is legitimate only when the envelope explicitly says zero.
  if (items === undefined) {
    if (num(body.totalCount) === 0) return [];
    throw new UpstreamError();
  }
  const rows = Array.isArray(items) ? items : isRecord(items) ? [items] : null;
  if (!rows || rows.some((row) => !isRecord(row) || Object.keys(row).length === 0)) throw new UpstreamError();
  return rows;
}

export async function readUpstreamPage(response) {
  let body;
  try { body = await response.text(); } catch { throw new UpstreamError(); }
  if (!response.ok) throw new UpstreamError(response.status === 401 || response.status === 403 || AUTH_TEXT.test(body) ? "not_authorized" : "upstream");
  let json;
  try { json = JSON.parse(body); } catch {
    throw new UpstreamError(AUTH_TEXT.test(body) ? "not_authorized" : "upstream");
  }
  const rows = readItems(json);
  const rawTotal = json.response.body.totalCount;
  const totalCount = num(rawTotal);
  if (rawTotal !== undefined && rawTotal !== null && rawTotal !== "" && totalCount === null) throw new UpstreamError();
  if (totalCount !== null && (!Number.isInteger(totalCount) || totalCount < rows.length || (!rows.length && totalCount > 0))) throw new UpstreamError();
  return { rows, totalCount };
}

export async function readUpstream(response) { return (await readUpstreamPage(response)).rows; }

export function num(value) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function noticeState(label) {
  switch (text(label)) {
    case "개찰완료": return "opened";
    case "유찰": return "failed";
    case "재입찰": return "rebid";
    default: return "other";
  }
}

export function parseWinners(value) {
  if (typeof value !== "string") return [];
  const winners = [];
  for (const match of value.matchAll(/\[([^\[\]]*)\]/g)) {
    const fields = match[1].split("^");
    if (fields.length < 6) continue;
    winners.push({ rank: num(fields[0]), name: text(fields[1]), bizno: text(fields[2]), amount: num(fields[4]), rate: num(fields[5]) });
  }
  return winners;
}

export function chainNotices(rows, max = 8) {
  if (!Number.isInteger(max) || max <= 0) return [];
  const notices = new Map();
  for (const row of rows) {
    const no = text(row.bidNtceNo);
    if (!no) continue;
    const previous = notices.get(no);
    if (previous && (num(previous.bidNtceOrd) ?? -1) > (num(row.bidNtceOrd) ?? -1)) continue;
    notices.set(no, row);
  }
  return [...notices.values()]
    .sort((a, b) => text(a.bidNtceDt).localeCompare(text(b.bidNtceDt)) || text(a.bidNtceNo).localeCompare(text(b.bidNtceNo)))
    .slice(-max)
    .map((row) => ({
      bidNtceNo: text(row.bidNtceNo), ord: text(row.bidNtceOrd), title: text(row.bidNtceNm),
      postedAt: text(row.bidNtceDt), method: text(row.cntrctCnclsMthdNm), bidMethod: text(row.bidMthdNm),
      state: "before", stateLabel: "", openedAt: "", reason: "", winners: parseWinners(row.bidwinrInfoList),
    }));
}

export function bidders(rows) {
  return rows.map((row) => ({
    rank: num(row.opengRank), name: text(row.prcbdrNm), bizno: text(row.prcbdrBizno),
    amount: num(row.bidprcAmt), rate: num(row.bidprcrt), remark: text(row.rmrk),
    techScore: num(row.techEvlVal), priceScore: num(row.bidPrceEvlVal), totalScore: num(row.totalEvlAmtVal),
  })).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}
