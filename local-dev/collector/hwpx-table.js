const { readZip } = require("./zip-read");

function hwpxToMarkdown(input) {
  const entries = Buffer.isBuffer(input) ? readZip(input) : input;
  const names = [...entries.keys()].filter((name) => /^Contents\/section\d+\.xml$/i.test(name)).sort(natural);
  if (!names.length) throw new Error("HWPX section XML을 찾지 못했습니다");
  const stats = { sections: names.length, tables: 0, rows: 0, cells: 0, bullets: 0 };
  const parts = [];
  for (const name of names) {
    const xml = entries.get(name).toString("utf8");
    const blocks = topBlocks(xml, ["hp:p", "hp:tbl"]);
    parts.push(`<!-- ${name} -->`);
    for (const block of blocks) {
      if (block.tag === "hp:p") {
        const text = textOf(block.xml);
        if (text) { stats.bullets += (text.match(/◦/g) || []).length; parts.push(text); }
      } else {
        const table = tableOf(block.xml, stats);
        if (table.length) parts.push(markdownTable(table));
      }
    }
  }
  return { markdown: parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", stats };
}

function topBlocks(xml, tags) {
  const found = [];
  const pattern = new RegExp(`<(${tags.map(escape).join("|")})(?:\\s[^>]*)?>`, "g");
  let match;
  while ((match = pattern.exec(xml))) {
    const tag = match[1];
    const end = matchingEnd(xml, tag, match.index);
    found.push({ tag, xml: xml.slice(match.index, end), index: match.index });
    pattern.lastIndex = end;
  }
  return found;
}
function matchingEnd(xml, tag, start) {
  const pattern = new RegExp(`<\\/?${escape(tag)}(?:\\s[^>]*)?>`, "g");
  pattern.lastIndex = start;
  let depth = 0; let match;
  while ((match = pattern.exec(xml))) {
    if (match[0][1] === "/") { depth -= 1; if (!depth) return pattern.lastIndex; }
    else if (!/\/>$/.test(match[0])) depth += 1;
  }
  throw new Error(`닫히지 않은 XML 태그: ${tag}`);
}
function tableOf(xml, stats) {
  stats.tables += 1;
  const rows = topBlocks(xml, ["hp:tr"]);
  const grid = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = topBlocks(rows[rowIndex].xml, ["hp:tc"]);
    const target = grid[rowIndex] || (grid[rowIndex] = []);
    let column = 0;
    for (const cell of cells) {
      while (target[column] !== undefined) column += 1;
      const attrs = cell.xml.slice(0, cell.xml.indexOf(">") + 1);
      const colSpan = Math.max(1, numberAttr(attrs, "colSpan"));
      const rowSpan = Math.max(1, numberAttr(attrs, "rowSpan"));
      const value = textOf(cell.xml);
      stats.cells += 1;
      for (let y = 0; y < rowSpan; y += 1) {
        const line = grid[rowIndex + y] || (grid[rowIndex + y] = []);
        for (let x = 0; x < colSpan; x += 1) line[column + x] = value;
      }
      column += colSpan;
    }
    stats.rows += 1;
  }
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
}
function numberAttr(startTag, name) { const match = startTag.match(new RegExp(`\\b${name}=["'](\\d+)["']`, "i")); return match ? Number(match[1]) : 1; }
function textOf(xml) {
  const text = xml.replace(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/gi, " ").replace(/<[^>]+>/g, " ");
  return decodeXml(text).replace(/[\t\r\n ]+/g, " ").replace(/ *([◦•]) */g, " $1 ").trim();
}
function markdownTable(rows) {
  if (!rows.length || !rows[0].length) return "";
  const escaped = rows.map((row) => row.map((cell) => String(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>") || " "));
  const header = escaped[0];
  const body = escaped.length > 1 ? escaped.slice(1) : [];
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}
function decodeXml(value) { return value.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec))).replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function natural(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }

module.exports = { hwpxToMarkdown, textOf, tableOf };
