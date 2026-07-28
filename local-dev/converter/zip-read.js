// 의존성 없이 HWPX/DOCX/XLSX와 첨부 ZIP을 읽기 위한 최소 ZIP reader.
const zlib = require("node:zlib");

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function readZip(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? 5000;
  const maxSize = options.maxSize ?? 64 * 1024 * 1024;
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error(`ZIP 엔트리 수 제한 초과: ${count}`);
  const entries = new Map();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) throw new Error("손상된 ZIP central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!isSafePath(name)) continue;
    total += size;
    if (total > maxSize) throw new Error(`ZIP 해제 크기 제한 초과: ${total}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error(`손상된 ZIP local header: ${name}`);
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const compressed = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`지원하지 않는 ZIP 압축 방식 ${method}: ${name}`);
    if (data.length !== size) throw new Error(`ZIP 크기 불일치: ${name}`);
    entries.set(name, data);
  }
  return entries;
}
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= start; index -= 1) if (buffer.readUInt32LE(index) === EOCD) return index;
  throw new Error("ZIP EOCD를 찾지 못했습니다");
}
function isSafePath(name) { return !!name && !name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."); }

module.exports = { readZip, isSafePath };
