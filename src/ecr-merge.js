// 구간마다 따로 받은 장비 항목을 요구사항 번호 하나로 모은다. 모델을 부르지 않는다.
// 한 표가 여러 구간으로 나뉘면 같은 장비가 구간 수만큼 돌아온다. 그대로 내보내면 같은 장비의
// 카드가 여러 장 생기고 규격이 카드마다 흩어진다. 같은 번호 안에서 종류와 이름이 같은 것만
// 한 장비로 합친다 — 이름이 다르면 다른 장비로 둔다. 잘못 합치는 것이 카드가 둘인 것보다 나쁘다.
import { tableName, requirementRanges } from "./ecr-source.js";
import { relabelFact, isQuantityLine, unitMismatch } from "./ecr-normalize.js";

const idKey = (id) => String(id).replace(/–/g, "-").replace(/\s/g, "").toUpperCase();
const squash = (text) => String(text || "").replace(/\s+/g, "");
const VERIFIED = "원문 확인";
// 번호와 구간 전체에 걸린 사유는 장비 이름을 붙이지 않는다. 어느 한 장비의 문제가 아니다.
const ID_NOTE = "요구사항 ID 원문 확인 필요";
const OVERFLOW_NOTE = /^장비 \d+개 중/;
const NAME_NOTE = "장비명 원문 확인 필요";
// 그 종류를 그 종류답게 만드는 항목. 이 항목의 규격이 있으면 제 규격을 가진 장비로 본다.
const OWN_FIELDS = { 서버: ["CPU", "메모리", "로컬 디스크"], 스토리지: ["Raw 용량", "Usable 용량", "디스크 구성", "컨트롤러"], 스위치: ["포트 수", "포트 속도", "스위칭 용량"] };
const quoteOf = (fact) => squash(fact.근거 || fact.값);

// 모델은 다른 장비의 규격 줄에서 장비를 지어내곤 한다. 교육포털 제안요청서에서 서버의 NIC 줄
// ("1G UTP 8Port, 10G SFP+ 6Port")로 스위치 둘을, 테이프 라이브러리의 "SAN 스위치 연결 기능 제공"으로
// SAN 스위치를 만들었다 — 지시문이 금하는데도 그랬다. 이런 장비는 제 줄이 없다: 가리킨 줄이 모두
// 같은 번호의 다른 종류 장비가 이미 가리킨 줄이다. 그런 장비는 싣지 않고, 뺐다는 것을 남긴다.
// 제 종류의 규격(스위치의 포트 수 등)을 갖고 이름도 원문에 있으면 실제 장비일 수 있어 그대로 둔다.
// 같은 종류끼리는 건드리지 않는다 — 운영·개발 서버가 규격 줄을 함께 쓰는 표가 있다.
function hostOf(device, devices) {
  // 원문 주석이 납품 포함을 명시한 SAN 스위치는 단순 연결 기능과 구분한다.
  if(device.종류==='스위치'&&device.규격.some(fact=>fact.추출==='원문 포함 구성'
    &&fact.항목==='종류'&&/^SAN\s*스위치$/i.test(fact.값)&&fact.검증===VERIFIED))return null;
  const quotes = device.규격.map(quoteOf).filter(Boolean);
  if (!quotes.length) return null;
  // NIC/HBA 부품을 독립 스위치로 생성한 경우, 같은 표의 서버가 그 인용을
  // 포함하면 제외한다. 서버와 부품이 같은 한 줄을 인용해도 판정할 수 있다.
  if (device.종류 === "스위치" && /\b(?:NIC|HBA)\b|\bFC\s*\d+\s*port/i.test(device.명칭)
      && !/스위치|switch/i.test(device.명칭)) {
    const server = devices.find(other => other.종류 === "서버" && quotes.every(quote => other.규격.some(fact => quoteOf(fact).includes(quote))));
    if (server) return server;
  }
  const own = Object.hasOwn(OWN_FIELDS, device.종류) && device.규격.some((fact) => OWN_FIELDS[device.종류].includes(fact.항목));
  if (!own && device.종류 === "스위치" && !/스위치|switch/i.test(device.명칭)) {
    const server = devices.find(other => other.종류 === "서버" && quotes.every(quote => other.규격.some(fact => quoteOf(fact).includes(quote))));
    if (server) return server;
  }
  if (own && !device.unnamed) return null;
  return devices.find((other) => other !== device && other.종류 !== device.종류
    && quotes.every((quote) => other.규격.some((fact) => quoteOf(fact).includes(quote)))
    // 숙주에게는 이 장비가 가리키지 않은 줄이 있어야 한다. 서로 똑같은 줄만 가리키면 어느 쪽이 진짜인지 모른다.
    && other.규격.some((fact) => quoteOf(fact) && !quotes.some((quote) => quote.includes(quoteOf(fact))))) || null;
}

// 장비가 하나뿐인 표에서 모델이 수량 줄을 놓치면 원문의 그 줄로 채운다. 수량을 밝혀 적은 줄
// ("도입 수량: 3대")이 표에 딱 하나일 때만이다 — 둘 이상이면 어느 것이 이 장비의 수량인지 모른다.
// 줄은 이 번호의 표에서 그대로 가져온 것이라 원문 확인이고, 모델이 아니라 규칙이 골랐다는 것을 남긴다.
// 원문이 이 번호의 표 하나일 때만 한다. 번호 표를 찾지 못한 문서는 구간 전체가 원문으로 오고,
// 거기에는 다른 표의 수량 줄이 섞여 있을 수 있다.
function quantityFact(source, id) {
  const ranges = requirementRanges(source);
  if (ranges.length !== 1 || idKey(ranges[0].id) !== idKey(id)) return null;
  const sourceRows = source.split("\n").map(line => line.trim());
  const labelled = sourceRows.filter(isQuantityLine);
  const standalone = /수\s*량/.test(source) ? sourceRows.filter(line => /^\d+\s*(?:대|식|EA|set)\s*$/i.test(line)) : [];
  const lines = [...new Set(labelled.length ? labelled : standalone)];
  return lines.length === 1 ? { 항목: "수량", 값: lines[0], 근거: lines[0], 검증: VERIFIED, 추출: "규칙" } : null;
}

// 수량이 장비명 바로 뒤에만 적힌 표: "L4스위치(6식)", "OOB 스위치 (2식)", "NAS 스토리지 메인 구축/1식".
// 이 번호의 원문에서 장비명 뒤에 붙은 수량이 한 가지일 때만 쓴다 — 둘 이상이면 어느 것인지 모른다.
// 이름 앞뒤의 괄호 구분명은 떼고 찾는다. 두 글자 이하의 이름("DB")은 다른 줄과 섞이기 쉬워 찾지 않는다.
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function headerQuantity(source, name) {
  const base = squash(String(name).replace(/\s*\([^()]*\)\s*$/, "").replace(/^\s*\([^()]*\)\s*/, ""));
  if ([...base].length < 3) return null;
  // 이름과 수량 사이에 짧은 말("NAS 스토리지 메인 구축/1식")이 끼어도 같은 줄의 열두 글자 안이면 본다.
  const pattern = new RegExp(`${[...base].map(reEscape).join("\\s*")}[^\\n\\d()/:：]{0,12}?\\s*(?:[(（\\[]\\s*|[/:：]\\s*)(?:(?:구축|도입|교체|증설|신규)\\s*[/:：]?\\s*)?(\\d{1,4})\\s*(대|식|EA|개|sets?|노드)\\s*[)）\\]]?`, "gi");
  const found = [...source.matchAll(pattern)];
  const values = new Set(found.map((match) => `${match[1]}${match[2]}`));
  if (values.size !== 1) return null;
  const quote = found[0][0].trim();
  return { 항목: "수량", 값: `${found[0][1]}${found[0][2]}`, 근거: quote, 검증: VERIFIED, 추출: "장비명 수량" };
}

// 서버·스토리지·스위치가 아닌데 모델이 그중 하나로 분류해 내는 것들. 실문서 표본에서 장비 수보다 많았다.
// 이름에 서버·스토리지·스위치가 함께 있으면 대상으로 둔다("방화벽 부하분산용 L7 스위치").
const NOT_TARGET = [
  { reason: "PC/모니터", test: /\bPC\b|개인용\s*컴퓨터|노트북|모니터/i, keep: /서버|스토리지|스위치|\bserver\b|\bstorage\b|\bswitch\b/i },
  { reason: "보안 장비", test: /방화벽|firewall|\bIPS\b|\bIDS\b|DDoS|\bWAF\b|\bVPN\b|\bUTM\b|망\s*연계/i, keep: /스위치|\bswitch\b/i },
  { reason: "전화 장비", test: /전화기|확장\s*버튼|미디어\s*게이트웨이/i, keep: /서버|스토리지|스위치|\bserver\b|\bswitch\b/i },
  { reason: "랙·KVM", test: /^(?:system\s*)?rack$|^랙$|\bKVM\b/i, keep: /서버|스토리지|\bserver\b|\bstorage\b/i },
  { reason: "소프트웨어·라이선스", test: /라이선스|라이센스|licen[cs]e|분리\s*발주|(?:S\/W|SW)\s*(?:증설|이관|도입)|소프트웨어/i, keep: /^$/ },
  // "스위치 N/W card"처럼 모델이 종류 이름을 붙여도 서버 표의 카드 열이다.
  { reason: "서버 부품 열 머리글", test: /N\/?W\s*card|네트워크\s*카드|랜\s*카드|FC\s*(?:및|카드)|어댑터|adapter|^\([^()]*\)\s*(?:포트|ports?)$/i, keep: /^$/ },
  { reason: "기존 장비", test: /^\(?\s*기존|^노후(?!.*(?:교체|증설|신규|도입))/, keep: /^$/ },
  { reason: "규격 조각", test: /^(?:core|cores|코어|cpu|memory|메모리|mem|disk|디스크|port|포트|ea|[*·\-–]+)$/i, keep: /^$/ },
];
const notTarget = (device) => NOT_TARGET.find(({ test, keep }) => test.test(device.명칭.trim()) && !keep.test(device.명칭))?.reason || "";

// 설치 장소나 망 이름만 덧붙인 같은 장비("x86 서버"와 "x86 서버 (국방망)")는 한 장비다.
// 같은 종류에 바탕 이름의 장비가 있고, 그 이름에 다른 구분을 붙인 장비가 없으며, 서로의 핵심 규격이
// 엇갈리지 않을 때만 합친다. 망마다 규격이 다른 표는 핵심 규격이 엇갈려 그대로 남는다.
const PLACE = /^(?:국방망|인터넷망|업무망|행정망|내부망|외부망|폐쇄망|DMZ|주\s*센터|백업\s*센터|DR\s*센터)$/i;
function placeVariant(device, devices) {
  const found = /^\s*\(([^()]+)\)\s*(.+)$/.exec(device.명칭) || /^(.+?)\s*\(([^()]+)\)\s*$/.exec(device.명칭);
  if (!found) return null;
  const [place, base] = /^\s*\(/.test(device.명칭) ? [found[1], found[2]] : [found[2], found[1]];
  if (!PLACE.test(place.trim())) return null;
  const target = devices.find((other) => other !== device && other.종류 === device.종류 && squash(other.명칭) === squash(base));
  if (!target) return null;
  const variants = devices.filter((other) => other !== device && other !== target && other.종류 === device.종류 && squash(other.명칭).includes(squash(base)));
  if (variants.length) return null;
  const own = OWN_FIELDS[device.종류] || [];
  const clash = device.규격.some((fact) => own.includes(fact.항목) && target.규격.some((held) => held.항목 === fact.항목)
    && !target.규격.some((held) => held.항목 === fact.항목 && squash(held.값) === squash(fact.값)));
  return clash ? null : target;
}

// 같은 항목에서 한 인용이 다른 인용을 품으면 같은 규격이다(겹쳐 자른 구간, 5~6줄과 6줄).
// 긴 쪽을 남긴다. 다만 확인된 규격을 확인 못 한 규격으로 덮지는 않는다.
function addFact(facts, fact) {
  const text = squash(fact.근거 || fact.값), ok = fact.검증 === VERIFIED;
  if (!text) { facts.push(fact); return; }
  const quoteOf = (held) => squash(held.근거 || held.값);
  // 같은 근거 문장에서도 서로 다른 값(CPU 속도와 장착 수량)을 뽑는다.
  // 근거 포함만으로 지우면 뒤에 나온 조건이 사라지므로 값까지 포함해야 중복이다.
  const value = squash(fact.값);
  if (facts.some((held) => held.항목 === fact.항목 && quoteOf(held).includes(text) && squash(held.값).includes(value) && (held.검증 === VERIFIED || !ok))) return;
  const covered = (held) => held.항목 === fact.항목 && !!quoteOf(held) && text.includes(quoteOf(held)) && value.includes(squash(held.값)) && (ok || held.검증 !== VERIFIED);
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
export function consolidate(items, { fieldOrder = [], verifiedOnly = false } = {}) {
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
      if (!device) group.devices.set(deviceKey, device = { 종류: entry.종류, 명칭: entry.명칭, places: [], 규격: [], unnamed: false });
      if (entry.출처 && !device.places.includes(entry.출처)) device.places.push(entry.출처);
      if ((item.불확실 || []).includes(NAME_NOTE)) device.unnamed = true;
      for (const fact of entry.규격 || []) {
        if (verifiedOnly && fact.검증 !== VERIFIED) {
          group.notes.push({ name: entry.명칭, device, messages: [`${fact.항목}: 원문 근거를 검증하지 못해 규격에서 제외함`] });
          continue;
        }
        const relabeled = relabelFact(entry.종류, fact, item.세부내용_원문 || '');
        // 표 머리("고유번호 ECR-B-004-01", "요구사항 명칭 …")나 쪽 번호("- 62 -")는 규격 값이 아니다.
        // 원문에 그대로 있어 근거 검증은 통과하지만 장비의 규격으로 싣지 않는다.
        if (/^\s*(?:요구\s*사항\s*)?(?:고유\s*번호|분\s*류|명\s*칭)\s|^\s*[-–]\s*\d{1,4}\s*[-–]?\s*$|^\s*\d{1,4}\s*[-–]\s*$/.test(String(relabeled.값)) && relabeled.항목 !== "수량") {
          group.notes.push({ name: entry.명칭, device, messages: [`${relabeled.항목}: 표 머리나 쪽 번호를 값으로 가리켜 제외함`] });
          continue;
        }
        if (unitMismatch(relabeled.항목, relabeled.값)) {
          const shown = String(relabeled.값).replace(/\s+/g, " ").slice(0, 40);
          group.notes.push({ name: entry.명칭, device, messages: [`${relabeled.항목}: 값 "${shown}"의 단위가 항목과 맞지 않아(표 열 밀림 의심) 제외함`] });
          continue;
        }
        addFact(device.규격, relabeled);
      }
    }
    const first = item.장비요약?.[0];
    group.notes.push({ name: first?.명칭 || item.명칭, device: first ? group.devices.get(`${first.종류}|${squash(first.명칭).toUpperCase()}`) : null, messages: item.불확실 || [] });
  }
  const rank = (fact) => { const at = fieldOrder.indexOf(fact.항목); return at < 0 ? fieldOrder.length : at; };
  return [...groups.values()].map((group) => {
    const listed = [...group.devices.values()];
    const merged = new Map();
    for (const device of listed) {
      const target = placeVariant(device, listed.filter((other) => !merged.has(other)));
      if (!target) continue;
      merged.set(device, target);
      for (const fact of device.규격) addFact(target.규격, fact);
      for (const place of device.places) if (!target.places.includes(place)) target.places.push(place);
    }
    const all = listed.filter((device) => !merged.has(device));
    // 소프트웨어·솔루션 목록 표("서버보안 2식", "DB 접근제어 1식", "OS 백업 25식")를 모델이 행마다 서버로 낸다.
    // 제 종류의 핵심 규격도, 장비임을 뜻하는 이름도 없는 항목이 한 번호에 셋 이상 몰려 있으면 품목 목록으로 본다.
    // 하나둘뿐이면 규격을 별도 배포하는 실제 장비일 수 있어 그대로 둔다.
    const bare = all.filter((device) => !device.규격.some((fact) => (OWN_FIELDS[device.종류] || []).includes(fact.항목))
      // 장비 이름은 끝말이 장비다("관리 서버", "WORM스토리지"). "서버보안", "서버 접근제어"는 소프트웨어다.
      && !/(?:서버|스토리지|스위치|server|storage|switch)\s*(?:\([^()]*\))?\s*(?:#?\d+)?$|HCI|NAS|SAN|VTL|L[2-7]\b|어플라이언스|appliance|라이브러리/i.test(device.명칭.trim()));
    const listRows = new Set(bare.length >= 3 ? bare : []);
    const notTargetOf = (device) => notTarget(device) || (listRows.has(device) ? "규격 없는 품목 목록(소프트웨어·솔루션 추정)" : "");
    const nonTargets=all.filter(device=>notTargetOf(device));
    const eligible=all.filter(device=>!nonTargets.includes(device));
    const hosts = new Map(eligible.map((device) => [device, hostOf(device, eligible)]));
    const unsupportedParts = all.filter(device => !device.규격.length && (verifiedOnly || device.종류 === '스위치' && /\b(?:NIC|HBA)\b|\bFC\b/i.test(device.명칭) && !/스위치|switch/i.test(device.명칭)));
    const devices = all.filter((device) => !hosts.get(device) && !unsupportedParts.includes(device) && !nonTargets.includes(device));
    const many = devices.length > 1;
    const notes = [];
    for(const device of nonTargets)notes.push(`장비 "${device.명칭}": 서버·스토리지·스위치가 아닌 ${notTargetOf(device)} 항목이므로 장비 요약에서 제외함`);
    for (const [device, target] of merged) notes.push(`장비 "${device.명칭}": 설치 장소만 다른 "${target.명칭}"과 같은 장비로 합침`);
    for (const device of unsupportedParts) notes.push(`장비 "${device.명칭}": 유효한 원문 규격이 없어 장비 요약에서 제외함`);
    for (const { name, device, messages } of group.notes) for (const message of messages) {
      const shared = message === ID_NOTE || OVERFLOW_NOTE.test(message);
      // 싣지 않은 장비의 사유는 함께 내려놓는다. 번호와 구간 전체에 걸린 사유만 남긴다.
      if (!shared && device && hosts.get(device)) continue;
      // 장비가 여럿이면 어느 장비의 사유인지 밝힌다. 묶기 전에는 카드가 장비를 가리켰다.
      const text = many && name && !shared ? `[${name}] ${message}` : message;
      if (!notes.includes(text)) notes.push(text);
    }
    // 대괄호로 시작하지 않게 적는다. 대괄호 머리는 "그 장비의 사유"라는 뜻이라, 싣지 않은 장비의
    // 이름으로 시작하면 장비별 CSV의 어느 줄에도 실리지 않는다.
    for (const [device, host] of hosts) if (host) notes.push(`장비 "${device.명칭}": "${host.명칭}"의 규격 줄만 가리켜 별도 장비에서 제외함`);
    const source = stitch(group.sources);
    if (devices.length === 1 && !devices[0].규격.some((fact) => fact.항목 === "수량" && /\d+\s*(?:대|식|EA|set|개)/i.test(fact.값))) {
      const quantity = quantityFact(source, group.id);
      if (quantity) {
        devices[0].규격 = devices[0].규격.filter(fact => fact.항목 !== '수량');
        devices[0].규격.push(quantity);
      }
    }
    for (const device of devices) {
      if (device.규격.some((fact) => fact.항목 === "수량" && /\d\s*(?:대|식|EA|set|개|노드)/i.test(fact.값))) continue;
      const quantity = headerQuantity(source, device.명칭);
      if (quantity) device.규격 = [...device.규격.filter((fact) => fact.항목 !== "수량"), quantity];
    }
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
