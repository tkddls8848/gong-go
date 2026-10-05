"""Offline diagnostic text extraction; never uploads documents or performs OCR.

HWP record/control layout: https://tech.hancom.com/python-hwp-parsing-2/
This is a text reader, not a rendering-equivalent replacement for AI.toMarkdown.
"""
import argparse
import hashlib
import json
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

VERSION = "local-text-v1"
LIMIT = 64 * 1024 * 1024


def paragraph_text(data):
    # Inline/extended controls occupy eight UTF-16 code units, including payload.
    wide_controls = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23}
    result = bytearray()
    pos = 0
    while pos + 2 <= len(data):
        code = struct.unpack_from("<H", data, pos)[0]
        if code in wide_controls:
            result.extend(("\t" if code == 9 else " ").encode("utf-16le"))
            pos += 16
        else:
            if code in (10, 13):
                result.extend("\n".encode("utf-16le"))
            elif code >= 32:
                result.extend(data[pos:pos + 2])
            pos += 2
    return result.decode("utf-16le").strip()


def hwp_text(file):
    import olefile
    with olefile.OleFileIO(file) as ole:
        header = ole.openstream("FileHeader").read()
        if not header.startswith(b"HWP Document File"):
            raise ValueError("Unsupported HWP header")
        flags = struct.unpack_from("<I", header, 36)[0]
        if flags & 6:
            raise ValueError("Encrypted/distribution HWP is unsupported")
        streams = sorted((p for p in ole.listdir() if len(p) == 2 and p[0] == "BodyText" and re.fullmatch(r"Section\d+", p[1])), key=lambda p: int(p[1][7:]))
        if not streams:
            raise ValueError("HWP has no BodyText sections")
        paragraphs = []
        for stream in streams:
            data = ole.openstream(stream).read()
            if flags & 1:
                inflater = zlib.decompressobj(-15)
                data = inflater.decompress(data, LIMIT + 1)
                if len(data) > LIMIT or not inflater.eof:
                    raise ValueError("Oversized or incomplete HWP section")
            pos = 0
            while pos < len(data):
                if pos + 4 > len(data):
                    raise ValueError("Truncated HWP record")
                record = struct.unpack_from("<I", data, pos)[0]
                pos += 4
                size = record >> 20
                if size == 0xFFF:
                    size = struct.unpack_from("<I", data, pos)[0]
                    pos += 4
                if pos + size > len(data):
                    raise ValueError("Truncated HWP payload")
                if record & 0x3FF == 67:
                    text = paragraph_text(data[pos:pos + size])
                    if text:
                        paragraphs.append(text)
                pos += size
        return "\n".join(paragraphs), {"sections": len(streams), "extractor": "HWP5 BodyText/olefile"}


def hwpx_text(file):
    with zipfile.ZipFile(file) as archive:
        names = sorted((n for n in archive.namelist() if re.fullmatch(r"Contents/section\d+\.xml", n)), key=lambda n: int(re.search(r"section(\d+)", n)[1]))
        if not names:
            raise ValueError("HWPX has no section XML")
        parts = []
        # Traverse document order once: nested table paragraphs must not be repeated.
        def visit(node):
            tag = node.tag.rsplit("}", 1)[-1]
            if tag == "t" and node.text:
                parts.append(node.text)
            if tag == "lineBreak":
                parts.append("\n")
            if tag == "tab":
                parts.append("\t")
            for child in node:
                visit(child)
                if tag == "t" and child.tail:
                    parts.append(child.tail)
            if tag in ("p", "tc"):
                parts.append("\n")
        for name in names:
            if archive.getinfo(name).file_size > LIMIT:
                raise ValueError("Oversized HWPX section")
            visit(ET.fromstring(archive.read(name)))
        return "".join(parts), {"sections": len(names), "extractor": "HWPX section XML"}


def extract(file):
    with file.open("rb") as stream:
        signature = stream.read(8)
    # Some supplied .hwpx files are actually HWP5 OLE containers.
    if signature == bytes.fromhex("d0cf11e0a1b11ae1"):
        return hwp_text(file)
    if signature.startswith(b"PK"):
        return hwpx_text(file)
    if not signature.startswith(b"%PDF-"):
        raise ValueError("Unsupported file signature (extension may be incorrect)")
    from pypdf import PdfReader
    reader = PdfReader(file)
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("Encrypted PDF")
    return "\f".join(page.extract_text() or "" for page in reader.pages), {"pages": len(reader.pages), "extractor": "pypdf 6.19.0 plain"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--deps", type=Path)
    args = parser.parse_args()
    if args.deps:
        sys.path.insert(0, str(args.deps.resolve()))
    args.output.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in args.directory.rglob("*") if p.is_file() and p.suffix.lower() in {".hwp", ".hwpx", ".pdf"})
    results = []
    for index, file in enumerate(files):
        sha = hashlib.sha256(file.read_bytes()).hexdigest()
        cached = args.output / (sha + ".json")
        entry = {"file": str(file.resolve()), "sha256": sha, "bytes": file.stat().st_size, "version": VERSION}
        try:
            prior = json.loads(cached.read_text("utf-8")) if cached.exists() else {}
            if prior.get("version") == VERSION and not prior.get("error"):
                entry.update(prior)
                entry["file"] = str(file.resolve())
            else:
                text, meta = extract(file)
                if not text.strip():
                    raise ValueError("No text extracted; OCR may be required")
                entry.update(meta, text=text)
                cached.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
        except Exception as error:
            entry["error"] = str(error)
        results.append({k: v for k, v in entry.items() if k != "text"})
        if (index + 1) % 25 == 0:
            print(f"Extracted {index + 1}/{len(files)}", flush=True)
    (args.output / "index.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"files": len(results), "errors": sum("error" in r for r in results), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
