// 조회 화면(app.js)과 검색 워커(search-worker.js)가 함께 쓰는 CSV 파서와 행 모델.
// 문서에서는 <script>로, 워커에서는 importScripts로 읽히므로 self에 붙인다.
//
// 여기가 1년 조회의 비용이 거의 전부 몰리는 곳이다. 설계 원칙은 두 가지다.
//   1. 셀을 문자열 배열로만 읽고, 조건을 통과한 행만 객체로 만든다.
//   2. 조건 검사는 컬럼 이름이 아니라 파일마다 한 번 구한 컬럼 번호로 한다.
(function (scope) {
  "use strict";

  const QUOTE = 34, COMMA = 44, LF = 10, CR = 13, EQUALS = 61;

  // shared/csv-record.js와 같은 slice 기반 파서. 예전 프런트 파서는 셀을 한 글자씩
  // 이어붙여(cell += text[i++]) 1년 조회에서 수천만 번의 문자열 재할당을 냈다.
  function parseLines(text) {
    const rows = [];
    const length = text.length;
    let row = [], index = 0, pending = false;
    while (index < length) {
      let cell;
      if (text.charCodeAt(index) === QUOTE) {
        index += 1;
        let start = index;
        cell = "";
        for (;;) {
          const quote = text.indexOf('"', index);
          if (quote === -1) { cell += text.slice(start); index = length; break; }
          if (text.charCodeAt(quote + 1) === QUOTE) { cell += text.slice(start, quote + 1); index = quote + 2; start = index; continue; }
          cell += text.slice(start, quote);
          index = quote + 1;
          break;
        }
      } else {
        let end = index;
        while (end < length) { const code = text.charCodeAt(end); if (code === COMMA || code === LF || code === CR) break; end += 1; }
        cell = text.slice(index, end);
        index = end;
      }
      row.push(unformula(cell));
      pending = true;
      const code = text.charCodeAt(index);
      if (code === COMMA) { index += 1; continue; }
      if (code === LF || code === CR) {
        if (code === CR && text.charCodeAt(index + 1) === LF) index += 1;
        index += 1;
        if (row.some(Boolean)) rows.push(row);
        row = [];
        pending = false;
      }
    }
    if (pending) rows.push(row);
    return rows;
  }

  // Excel 텍스트 강제 수식(="...")을 벗긴다. 대부분의 셀은 첫 글자가 =가 아니라 여기서 끝난다.
  function unformula(value) {
    if (value.length < 3 || value.charCodeAt(0) !== EQUALS) return value;
    return value.charCodeAt(1) === QUOTE && value.charCodeAt(value.length - 1) === QUOTE ? value.slice(2, -1) : value;
  }

  function parseTable(text) {
    const rows = parseLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return { header: rows.length ? rows[0] : [], rows: rows.slice(1) };
  }

  // 화면이 쓰는 값마다 원본 컬럼 후보를 앞선 것부터 적는다. 빈 값이면 다음 후보로 넘어간다
  // (예전 displayRow의 `row.rlDminsttNm || row.dminsttNm || ""`과 같은 규칙이다).
  const FIELDS = {
    pre: { number: ["bfSpecRgstNo"], institution: ["rlDminsttNm", "dminsttNm"], code: ["dminsttCd"], type: ["bsnsDivNm"], title: ["prdctClsfcNoNm", "bidNtceNm"], published: ["rgstDt", "bidNtceDt"], close: ["opninRgstClseDt", "bidClseDt"] },
    bid: { number: ["bidNtceNo"], institution: ["rlDminsttNm", "dminsttNm"], code: ["dminsttCd"], type: ["ntceKindNm"], title: ["prdctClsfcNoNm", "bidNtceNm"], published: ["rgstDt", "bidNtceDt"], close: ["opninRgstClseDt", "bidClseDt"] },
    plan: { number: ["orderPlanUntyNo"], institution: ["orderInsttNm", "totlmngInsttNm"], code: ["orderInsttCd"], type: ["bsnsDivNm"], title: ["bizNm", "prdctClsfcNoNm"], published: ["nticeDt"], close: [] },
  };
  // 첨부 URL·이름 컬럼은 번호가 붙은 계열이다. 발주계획에는 아예 없다(상세 링크만 준다).
  const FILE_SERIES = { pre: { url: "specDocFileUrl", name: "specDocFileNm", count: 5 }, bid: { url: "ntceSpecDocUrl", name: "ntceSpecFileNm", count: 10 } };
  const PLAN_EXTRA = ["orderYear", "orderMnth", "sumOrderAmt", "cntrctMthdNm", "prcrmntMethd", "orderPlanDtlUrl", "atchFileExistnceYn", "bidNtceNoList"];

  // 파일 하나당 한 번만 부른다. 이후 행 검사는 문자열 비교 없이 배열 첨자만 쓴다.
  function columnsFor(header, mode) {
    const at = new Map();
    for (let i = 0; i < header.length; i += 1) if (!at.has(header[i])) at.set(header[i], i);
    const pick = (names) => (names || []).map((name) => at.get(name)).filter((index) => index !== undefined);
    const fields = FIELDS[mode] || FIELDS.bid;
    const columns = { mode, number: pick(fields.number), institution: pick(fields.institution), code: pick(fields.code), type: pick(fields.type), title: pick(fields.title), published: pick(fields.published), close: pick(fields.close), files: [], extra: {} };
    const series = FILE_SERIES[mode];
    if (series) {
      for (let i = 1; i <= series.count; i += 1) {
        const url = at.get(`${series.url}${i}`);
        if (url !== undefined) columns.files.push({ url, name: at.get(`${series.name}${i}`), slot: i - 1 });
      }
    }
    if (mode === "plan") for (const name of PLAN_EXTRA) columns.extra[name] = at.get(name);
    return columns;
  }

  function first(cells, indexes) {
    for (let i = 0; i < indexes.length; i += 1) { const value = cells[indexes[i]]; if (value) return value; }
    return "";
  }

  const norm = (value) => String(value ?? "").replace(/\s+/g, "").trim();
  const dateKey = (value) => String(value || "").replace(/\D/g, "").slice(0, 8);
  // 발주계획은 업무구분을 세분해서 준다("용역"이 아니라 "기술용역"·"일반용역"). 드롭다운의
  // 네 갈래로 고를 수 있어야 하므로 접미사 일치를 허용한다.
  function typeMatches(selected, value) { if (!selected) return true; const text = String(value || ""); return text === selected || text.endsWith(selected); }

  // 조회 조건을 행마다 다시 계산하지 않도록 한 번에 펼쳐 둔다. 특히 관심 기관은 예전에
  // 행마다 norm()을 기관 수만큼 돌려 조회 1회에 수백만 번의 공백 제거를 냈다.
  //
  // 기관 판정 규칙은 예전 matchesInstitutions와 같다 — 행에 코드가 있으면 코드를 가진
  // 항목과는 코드로만 맞추고, 코드가 없는 항목과는 기관명으로 맞춘다.
  function makeCriteria({ q = "", type = "", institutions = [], from = "00000000", to = "99999999" } = {}) {
    const list = institutions.filter((inst) => inst.name || inst.code);
    return {
      q: q.trim().toLowerCase(),
      type,
      from,
      to,
      everyInstitution: list.length === 0,
      codes: new Set(list.filter((inst) => inst.code).map((inst) => String(inst.code).trim())),
      names: new Set(list.filter((inst) => inst.name).map((inst) => norm(inst.name))),
      namesWithoutCode: new Set(list.filter((inst) => inst.name && !inst.code).map((inst) => norm(inst.name))),
    };
  }

  // 값이 싼 조건부터 본다. checkDate가 false면 파일 구간이 조회 구간 안에 통째로 들어와
  // 그 파일의 모든 행이 날짜 조건을 이미 만족한다는 뜻이다(호출자가 판단한다).
  function accepts(criteria, cells, columns, checkDate) {
    if (criteria.type && !typeMatches(criteria.type, first(cells, columns.type))) return false;
    if (checkDate) { const date = dateKey(first(cells, columns.published)); if (date < criteria.from || date > criteria.to) return false; }
    if (!criteria.everyInstitution) {
      const code = first(cells, columns.code).trim();
      const name = norm(first(cells, columns.institution));
      if (!(code ? criteria.codes.has(code) || criteria.namesWithoutCode.has(name) : criteria.names.has(name))) return false;
    }
    if (criteria.q && !`${first(cells, columns.number)} ${first(cells, columns.institution)} ${first(cells, columns.title)}`.toLowerCase().includes(criteria.q)) return false;
    return true;
  }

  // 빈 슬롯은 아예 건드리지 않는다. 예전에는 첨부가 없는 행에서도 슬롯 5~10개마다
  // guess()가 new URL("")로 예외를 던졌다 — 행 한 개에 예외 열 번이 1년 조회에서
  // 수백만 번이 되어 파싱보다 비쌌다.
  function filesOf(cells, columns) {
    const files = [];
    for (const column of columns.files) {
      const url = cells[column.url] || "";
      if (!/^https?:/i.test(url)) continue;
      files.push({ url, name: (column.name === undefined ? "" : cells[column.name]) || guessName(url, column.slot) });
    }
    return files;
  }

  function guessName(url, slot) {
    try { const params = new URL(url).searchParams; return decodeURIComponent(params.get("fileNm") || params.get("orgFileNm") || params.get("fileName") || `첨부파일 ${slot + 1}`); }
    catch { return `첨부파일 ${slot + 1}`; }
  }

  // 조건을 통과한 행만 여기까지 온다.
  function buildRow(cells, columns) {
    const row = {
      mode: columns.mode,
      announcementNumber: first(cells, columns.number),
      institution: first(cells, columns.institution),
      dminsttCd: first(cells, columns.code).trim(),
      businessType: first(cells, columns.type),
      title: first(cells, columns.title),
      publishedAt: first(cells, columns.published),
    };
    if (columns.mode !== "plan") { row.closeAt = first(cells, columns.close); row.files = filesOf(cells, columns); return row; }
    // 발주계획에는 마감일도 첨부 URL도 없다. 발주예정월과 상세 링크가 그 자리를 대신한다.
    const extra = (name) => { const index = columns.extra[name]; return index === undefined ? "" : cells[index] || ""; };
    const year = extra("orderYear"), month = extra("orderMnth");
    row.closeAt = "";
    row.orderMonth = year && month ? `${year}-${String(month).padStart(2, "0")}` : "";
    row.amount = extra("sumOrderAmt");
    row.contractMethod = extra("cntrctMthdNm");
    row.procureMethod = extra("prcrmntMethd");
    row.detailUrl = extra("orderPlanDtlUrl");
    row.hasAttachment = extra("atchFileExistnceYn") === "Y";
    row.linkedNotices = extra("bidNtceNoList");
    row.files = [];
    return row;
  }

  // 파일 하나를 읽어 조건에 맞는 행만 돌려준다. 워커와 폴백 경로가 함께 쓴다.
  function scanText(text, mode, criteria, checkDate) {
    const table = parseTable(text);
    const columns = columnsFor(table.header, mode);
    const matched = [];
    for (const cells of table.rows) if (accepts(criteria, cells, columns, checkDate)) matched.push(buildRow(cells, columns));
    return { matched, scanned: table.rows.length };
  }

  async function fetchCsvText(url) {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${url} 응답 오류 (${response.status})`);
    return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
  }

  scope.GongRows = { parseTable, columnsFor, first, makeCriteria, accepts, buildRow, scanText, fetchCsvText, norm, dateKey, typeMatches };
})(typeof self === "undefined" ? globalThis : self);
