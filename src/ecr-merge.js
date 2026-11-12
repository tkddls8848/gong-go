// 구간마다 따로 받은 장비 항목을 요구사항 번호 하나로 모은다. 모델을 부르지 않는다.
// 한 표가 여러 구간으로 나뉘면 같은 장비가 구간 수만큼 돌아온다. 그대로 내보내면 같은 장비의
// 카드가 여러 장 생기고 규격이 카드마다 흩어진다. 같은 번호 안에서 종류와 이름이 같은 것만
// 한 장비로 합친다 — 이름이 다르면 다른 장비로 둔다. 잘못 합치는 것이 카드가 둘인 것보다 나쁘다.
import { tableName } from "./ecr-source.js";

const idKey = (id) => String(id).replace(/–/g, "-").replace(/\s/g, "").toUpperCase();
const squash = (text) => String(text || "").replace(/\s+/g, "");
const VERIFIED = "원문 확인";
// 번호와 구간 전체에 걸린 사유는 장비 이름을 붙이지 않는다. 어느 한 장비의 문제가 아니다.
const ID_NOTE = "요구사항 ID 원문 확인 필요";
const OVERFLOW_NOTE = /^장비 \d+개 중/;

// 같은 항목에서 한 인용이 다른 인용을 품으면 같은 규격이다(겹쳐 자른 구간, 5~6줄과 6줄).
// 긴 쪽을 남긴다. 다만 확인된 규격을 확인 못 한 규격으로 덮지는 않는다.
function addFact(facts, fact) {
  const text = squash(fact.근거 || fact.값), ok = fact.검증 === VERIFIED;
  if (!text) { facts.push(fact); return; }
  const quoteOf = (held) => squash(held.근거 || held.값);
  if (facts.some((held) => held.항목 === fact.항목 && quoteOf(held).includes(text) && (held.검증 === VERIFIED || !ok))) return;
  const covered = (held) => held.항목 === fact.항목 && !!quoteOf(held) && text.includes(quoteOf(held)) && (ok || held.검증 !== VERIFIED);
  const at = facts.findIndex(covered);
  if (at < 0) { facts.push(fact); return; }
  const kept = facts.filter((held, index) => index === at || !covered(held));
  kept[kept.indexOf(facts[at])] = fact;
  facts.splice(0, facts.length, ...kept);
}

// 겹쳐 자른 구간의 원문을 한 번만 싣는다. 이어지는 구간은 표 머리(번호·명칭)로 시작하고
// 앞 구간의 끝 몇 줄을 다시 싣는다. 둘 다 걷어 내고 새로 나온 부분만 잇는다.
const LAP_SCAN = 900;
const LAP_PROBE = 24;
// 앞글의 꼬리 가운데 뒷글의 머리와 똑같은 가장 긴 자리. 겹침은 대개 온전한 줄이라 줄 머리부터
// 견준다 — 한 줄짜리 짧은 겹침도 잡힌다. 긴 줄의 조각에서 시작한 겹침은 줄 머리가 아니므로
// 앞 24자가 나오는 자리를 따로 찾는다. 짧은 우연의 일치로 원문을 덜어 내지 않으려는 길이다.
function lapOf(whole, rest) {
  const tail = whole.slice(-LAP_SCAN), cut = whole.length - tail.length;
  for (let at = 0; at < tail.length;) {
    const lineStart = at > 0 || cut === 0 || whole[cut - 1] === "\n";
    if (lineStart && rest.startsWith(tail.slice(at))) return tail.length - at;
    const next = tail.indexOf("\n", at);
    if (next < 0) break;
    at = next + 1;
  }
  const probe = rest.slice(0, LAP_PROBE);
  if (probe.length < LAP_PROBE) return 0;
  for (let at = tail.indexOf(probe); at >= 0; at = tail.indexOf(probe, at + 1)) {
    if (rest.startsWith(tail.slice(at))) return tail.length - at;
  }
  return 0;
}
function stitch(texts) {
  let whole = "";
  for (const text of texts) {
    if (!whole) { whole = text; continue; }
    let offset = 0;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      if (!whole.startsWith(line, offset)) break;
      offset += line.length;
    }
    const rest = text.slice(offset);
    if (!rest) continue;
    const lap = lapOf(whole, rest);
    whole += (lap || whole.endsWith("\n") ? "" : "\n") + rest.slice(lap);
  }
  return whole;
}

// "rfp.pdf · 구간 3"과 "rfp.pdf · 구간 4"는 "rfp.pdf · 구간 3, 4"로 적는다.
function joinSources(list) {
  const parsed = list.map((text) => /^(.*) · 구간 (\d+)$/.exec(text));
  if (list.length > 1 && parsed.every((found) => found && found[1] === parsed[0][1])) return `${parsed[0][1]} · 구간 ${parsed.map((found) => found[2]).join(", ")}`;
  return list.join(", ");
}

// items는 구간 순서대로 이어 붙인 구간별 항목이다(항목마다 장비 하나). fieldOrder는 규격을 늘어놓는 순서다.
export function consolidate(items, { fieldOrder = [] } = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = idKey(item.id);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { id: item.id, name: item.명칭, sources: [], places: [], devices: new Map(), notes: [] });
    if (item.세부내용_원문 && !group.sources.includes(item.세부내용_원문)) group.sources.push(item.세부내용_원문);
    if (item.출처 && !group.places.includes(item.출처)) group.places.push(item.출처);
    for (const entry of item.장비요약 || []) {
      const deviceKey = `${entry.종류}|${squash(entry.명칭).toUpperCase()}`;
      let device = group.devices.get(deviceKey);
      if (!device) group.devices.set(deviceKey, device = { 종류: entry.종류, 명칭: entry.명칭, places: [], 규격: [] });
      if (entry.출처 && !device.places.includes(entry.출처)) device.places.push(entry.출처);
      for (const fact of entry.규격 || []) addFact(device.규격, fact);
    }
    group.notes.push({ name: item.장비요약?.[0]?.명칭 || item.명칭, messages: item.불확실 || [] });
  }
  const rank = (fact) => { const at = fieldOrder.indexOf(fact.항목); return at < 0 ? fieldOrder.length : at; };
  return [...groups.values()].map((group) => {
    const devices = [...group.devices.values()];
    const many = devices.length > 1;
    const notes = [];
    for (const { name, messages } of group.notes) for (const message of messages) {
      // 장비가 여럿이면 어느 장비의 사유인지 밝힌다. 묶기 전에는 카드가 장비를 가리켰다.
      const text = many && name && message !== ID_NOTE && !OVERFLOW_NOTE.test(message) ? `[${name}] ${message}` : message;
      if (!notes.includes(text)) notes.push(text);
    }
    const source = stitch(group.sources);
    // 요구사항 이름은 원문 표의 명칭 칸에서 읽는다. 못 읽으면 장비 이름으로 대신한다.
    const name = tableName(source) || (many ? `${devices[0].명칭} 외 ${devices.length - 1}종` : devices[0]?.명칭 || group.name);
    return {
      id: group.id, 분류: [...new Set(devices.map((device) => device.종류))].join("·"), 명칭: name,
      세부내용_원문: source, 기본규격: [], 산출물: [], 출처: joinSources(group.places), 불확실: notes,
      장비요약: devices.map((device) => ({
        종류: device.종류, 명칭: device.명칭, 출처: joinSources(device.places),
        // 정렬은 순서를 지킨다. 같은 항목의 규격은 원문에 나온 순서대로 남는다.
        규격: [...device.규격].sort((a, b) => rank(a) - rank(b)),
      })),
    };
  });
}
