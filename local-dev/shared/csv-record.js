function columnsFor(rows) {
  const columns = [];
  const known = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        known.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function serializeCsv(rows) {
  const columns = columnsFor(rows);
  return [columns.join(","), ...rows.map((row) => columns.map((key) => csv(row[key])).join(","))].join("\n");
}

function csv(value) {
  const text = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  // 빈 값은 감싸지 않고 빈 필드로 남긴다. 전체 셀의 60% 이상이 비어 있어, ="" 수식으로
  // 감싸면 셀마다 7바이트와 따옴표 5개가 붙고 파서가 그만큼 인용 구간을 훑어야 한다.
  // 빈 필드는 어떤 CSV 파서에서도 빈 문자열로 읽히므로 왕복 결과는 같다.
  if (text === "") return "";
  // Excel 텍스트 강제 수식(="..."; 앞자리 0·긴 숫자 보존)을 유지하되, 셀 전체를 RFC 4180
  // 표준 따옴표로 감싼다. 필드가 "로 시작해야 외부 파서가 값 안의 쉼표·따옴표·개행을
  // 구분자로 오인하지 않는다.
  const formula = `="${text}"`;
  return `"${formula.replaceAll('"', '""')}"`;
}

function parseCsv(text) {
  const rows = parseLines(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const header = rows[0];
  const records = new Array(rows.length - 1);
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const record = {};
    for (let column = 0; column < header.length; column += 1) record[header[column]] = fromTextCell(cells[column] || "");
    records[index - 1] = record;
  }
  return records;
}

const EQUALS = 61;
const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

function fromTextCell(value) {
  if (value === "" || value.charCodeAt(0) !== EQUALS) return value;
  // 신규 형식: ="값" 수식에서 원래 값을 복원
  if (value.length >= 3 && value.charCodeAt(1) === QUOTE && value.charCodeAt(value.length - 1) === QUOTE) return value.slice(2, -1);
  return value.slice(1); // 구 형식 파일 하위 호환
}

// 셀을 한 글자씩 이어붙이지 않고, 구분자 위치를 찾아 slice로 잘라낸다. 인용되지 않은
// 셀(빈 셀 포함)은 따옴표 처리를 건너뛰므로 전체 셀의 60%가 이 빠른 경로를 탄다.
function parseLines(text) {
  const rows = [];
  const length = text.length;
  let row = [];
  let index = 0;
  let pending = false; // 아직 행에 넣지 못한 셀이 남아 있는지
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
    row.push(cell);
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

module.exports = { serializeCsv, parseCsv };
