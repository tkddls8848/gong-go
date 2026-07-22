const assert = require("node:assert/strict");
const test = require("node:test");
const { hwpxToMarkdown } = require("./hwpx-table");

test("keeps non-numeric ECR IDs, bullets and merged HWPX table cells", () => {
  const ids = Array.from({ length: 42 }, (_, index) => `ECR-${["COM", "HW", "NW", "SW"][index % 4]}-${String(index + 1).padStart(2, "0")}`);
  const bullets = Array.from({ length: 179 }, () => "◦ 보존").join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><hp:sec xmlns:hp="urn:hancom"><hp:p><hp:run><hp:t>${ids.join(" ")}${bullets}</hp:t></hp:run></hp:p><hp:tbl><hp:tr><hp:tc colSpan="2"><hp:p><hp:run><hp:t>세부내용</hp:t></hp:run></hp:p></hp:tc></hp:tr><hp:tr><hp:tc><hp:p><hp:run><hp:t>CPU</hp:t></hp:run></hp:p></hp:tc><hp:tc><hp:p><hp:run><hp:t>16 core</hp:t></hp:run></hp:p></hp:tc></hp:tr></hp:tbl></hp:sec>`;
  const { markdown, stats } = hwpxToMarkdown(zip({ "Contents/section0.xml": xml }));
  assert.equal(ids.filter((id) => markdown.includes(id)).length, 42);
  assert.equal(stats.bullets, 179);
  assert.match(markdown, /\| 세부내용 \| 세부내용 \|/);
  assert.match(markdown, /\| CPU \| 16 core \|/);
});

function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, source] of Object.entries(files)) {
    const file = Buffer.from(source, "utf8"), nameBytes = Buffer.from(name, "utf8"), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(file.length, 18); local.writeUInt32LE(file.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, file);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(file.length, 20); central.writeUInt32LE(file.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes); offset += local.length + nameBytes.length + file.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0), eocd = Buffer.alloc(22), count = Object.keys(files).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10); eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
