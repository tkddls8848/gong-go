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
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, index) => [key, fromTextCell(cells[index] || "")])));
}

function fromTextCell(value) {
  const match = /^="([\s\S]*)"$/.exec(value);
  if (match) return match[1]; // 신규 형식: ="값" 수식에서 원래 값을 복원
  return value.startsWith("=") ? value.slice(1) : value; // 구 형식 파일 하위 호환
}

function parseLines(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += char;
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

module.exports = { serializeCsv, parseCsv };
