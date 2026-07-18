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
  return `="${text.replaceAll('"', '""')}"`;
}

function parseCsv(text) {
  const rows = parseLines(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, index) => [key, fromTextCell(cells[index] || "")])));
}

function fromTextCell(value) { return value.startsWith("=") ? value.slice(1) : value; }

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
