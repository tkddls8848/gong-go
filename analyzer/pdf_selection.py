"""Local text-only page planning. No LLM/OCR/network and no whole-document fallback."""
import argparse
import bisect
import hashlib
import json
import re
import sys
from pathlib import Path
from pdf_inventory import inventory

VERSION = 1
ID = r"(?:[A-Z]{2,5}|장비|[가-힣]{2,10})[ \t]*[-–][ \t]*[A-Z0-9]+(?:[ \t]*[-–][ \t]*[A-Z0-9]+)*"
FIELD = re.compile(r"(?:요구\s*사항|고유|식별)\s*(?:고유\s*)?(?:번호|ID|코드)[ \t:|\n]*?(?P<id>" + ID + r")", re.I)
NAME = re.compile(r"요구\s*사항\s*(?:명\s*칭|명)(?![가-힣])[ \t:|\n]*([^\n|]+)")
DEVICE = re.compile(r"(?:서버|스토리지|스위치)(?:\s*\([^)]{1,20}\))?$")
EXCLUDED = re.compile(r"공통|일반\s*(?:사항|요구)|보증|시험\s*운영|하자|유지\s*보수|소프트웨어|S\s*/?\s*W\b|라이[선센]스|OLAP|DBMS|솔루션|기능\s*요구|보안\s*요구|성능\s*요구", re.I)
NUMERIC = re.compile(r"\d[\d,.]*\s*(?:GB|TB|TiB|GHz|Gbps|GbE|MHz|코어|core|port|포트|소켓|DIMM)(?![A-Za-z])", re.I)
SPEC = re.compile(r"CPU|메모리|SSD|디스크|컨트롤러|Cache|Usable|RAID|NIC|HBA|포트", re.I)
HEADING = re.compile(r"(?m)^[ \t]*(?:(?:\d+|[가-하])[.)][ \t]*)?((?:시스템\s*)?장비\s*(?:구성\s*)?(?:요구사항|규격)|(?:하드웨어|H/W|HW)\s*(?:도입\s*)?(?:요구사항|규격)|도입\s*대상\s*(?:HW|하드웨어)(?:\s*내역)?)[ \t]*$", re.I)
STOP = re.compile(r"(?m)^[ \t]*(?:(?:\d+|[가-하])[.)][ \t]*)?(?:사업\s*(?:개요|배경|목적)|(?:기능|성능|인터페이스|데이터|보안|품질|제약|프로젝트\s*관리)\s*요구사항|도입\s*대상\s*(?:SW|소프트웨어)|소프트웨어\s*(?:요구사항|내역))[ \t]*$", re.I)


def canonical(value):
    return re.sub(r"\s+", "", value).replace("–", "-").upper()


def device_names(text, name=""):
    """Conservative inventory for missing-device warnings, never model input or truth labels."""
    names = []
    if DEVICE.search(name.strip()):
        names.append(name.strip())
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for i, line in enumerate(lines):
        line = re.sub(r"^[○❍◦•·\-]\s*", "", line)
        if re.match(ID, line):
            continue
        if not DEVICE.search(line) or len(line) > 32 or re.search(r"[:：]|요구사항|구분|서버당|이상|제공|지원|구축|설치", line):
            continue
        if line in ("서버", "스토리지", "스위치", "가상 서버"):
            prior = lines[i - 1] if i else ""
            if len(prior) <= 20 and re.fullmatch(r"[A-Za-z가-힣 /()-]+", prior) and not re.search(r"내용|정의|수량|요구|규격", prior):
                line = prior + " " + line
            else:
                continue
        if canonical(line) not in {canonical(n) for n in names}:
            names.append(line)
    return names


def select_sections(page_texts, max_pages=12):
    starts, parts, cursor = [], [], 0
    for text in page_texts:
        starts.append(cursor)
        parts.append(text + "\n\f\n")
        cursor += len(parts[-1])
    source = "".join(parts)
    fields = list(FIELD.finditer(source))
    boundaries = []
    for match in fields:
        start = match.start()
        prefix_start = max(0, start - 160)
        classification = re.search(r"(?m)^[ \t]*요구\s*사항\s*분류[^\n]*(?:\n[^\n\f]*)?\s*\Z", source[prefix_start:start])
        if classification:
            start = prefix_start + classification.start()
        boundaries.append({"start": start, "body": match.end(), "id": canonical(match.group("id"))})
    # Some HWP templates put 장비-003-업무 서버 above the table, without an ID label.
    # A nearby detail header distinguishes these from an inventory/TOC or reference.
    standalone = re.compile(r"(?m)^[ \t|#]*(?P<id>" + ID + r")[^\n]*$")
    for match in standalone.finditer(source):
        # A spec such as '전원 - Dual' or '인터페이스 - FC' is not an ID,
        # even when the next requirement header happens to be within 200 chars.
        if not re.search(r"\d", match.group('id')):
            continue
        if any(field.start() <= match.start() < field.end() for field in fields):
            continue
        following = source[match.end():match.end() + 200]
        if not re.search(r"요구\s*사항\s*(?:분류|명\s*칭|정의)", following):
            continue
        # AI in 장비-028-AI 스토리지 is the title, not a sub-ID.
        raw_id = match.group("id")
        equipment_id = re.match(r"장비[ \t]*[-–][ \t]*\d+", raw_id)
        boundaries.append({"start": match.start(), "body": match.end(),
                           "id": canonical(equipment_id.group() if equipment_id else raw_id)})
    boundaries.sort(key=lambda b: b["start"])
    # Repeated ID-only headers on continuation pages do not begin a new table.
    merged = []
    for index, entry in enumerate(boundaries):
        end = boundaries[index + 1]['start'] if index + 1 < len(boundaries) else len(source)
        if merged and entry['id'] == merged[-1]['id'] and not NAME.search(source[entry['body']:end][:400]):
            continue
        merged.append(entry)
    boundaries = merged
    # Numbered details take priority over ID-less HW overview tables at the front.
    has_equipment_fields = any(re.match(r"^(?:ECR|HWR|장비)-", b["id"]) for b in boundaries)
    if not has_equipment_fields:
        # Only explicit equipment headings; a CPU mention in 사업개요 is not a seed.
        boundaries.extend({"start": m.start(), "body": m.end(), "id": "", "heading": m.group(1)} for m in HEADING.finditer(source))
        boundaries.sort(key=lambda b: b["start"])
    selected, excluded = [], []
    for i, entry in enumerate(boundaries):
        end = boundaries[i + 1]["start"] if i + 1 < len(boundaries) else len(source)
        body = source[entry["start"]:end]
        stop = STOP.search(source, entry["body"], end)
        if stop:
            end, body = stop.start(), source[entry["start"]:stop.start()]
        match = NAME.search(body[:400])
        name = match.group(1).strip() if match else entry.get("heading", "")
        first = bisect.bisect_right(starts, entry["start"])
        # A following table's header must not cause the previous requirement to include that page.
        trimmed_end = entry["start"] + len(body.rstrip("\n\f \t"))
        last = bisect.bisect_right(starts, max(entry["start"], trimmed_end - 1))
        # A continuation with no ID stops at the next requirement, including SFR/INR/etc.
        ids = [entry["id"]] if entry["id"] else []
        record = {"id": entry["id"], "name": name, "pages": list(range(first, last + 1)), "chars": len(body)}
        reason = None
        if ids and not re.match(r"^(?:ECR|HWR|장비)-", entry["id"]):
            reason = "other-requirement"
        elif re.match(r"^ECR-(?:SW|COM)-", entry["id"]):
            reason = "software-or-common"
        elif EXCLUDED.search(name) and not DEVICE.search(name):
            reason = "non-equipment-title"
        elif entry["id"] and not name and not re.search(r"세부\s*내용|상세\s*(?:설명|내용)|정의", body[:500]):
            reason = "no-detail-header"
        elif (len(NUMERIC.findall(body)) < 2 or len(set(m.group().lower() for m in SPEC.finditer(body))) < 2) and not (
                re.search(r'서버.*메모리\s*증설', name) and re.search(r'\d[\d,.]*\s*(?:GB|TB)\s*증설', body, re.I)):
            reason = "no-concrete-equipment-specs"
        elif not entry["id"] and re.search(r"목\s*차", body[:100]):
            reason = "table-of-contents"
        if reason:
            record["reason"] = reason
            excluded.append(record)
        else:
            record.update(expectedDevices=device_names(body, name), reason="numbered-equipment-detail" if ids else "explicit-equipment-heading")
            record['inventory'], record['inventoryWarnings'] = inventory(body, lambda offset: bisect.bisect_right(starts, entry['start'] + offset), name)
            selected.append(record)
    pages = sorted({p for section in selected for p in section["pages"]})
    blank = [i + 1 for i, text in enumerate(page_texts) if not text.strip()]
    warnings = []
    if blank:
        warnings.append("텍스트가 없는 페이지가 있습니다. 이미지 전용 장비 표가 빠질 수 있으므로 수동 확인이 필요합니다.")
    status = "ready" if pages else "needs-review"
    if not pages:
        warnings.append("장비 상세 구간을 확정하지 못했습니다. 전체 문서를 LLM에 보내지 않습니다. 페이지를 직접 지정해 주세요.")
    if len(pages) > max_pages:
        status = "over-budget"
        warnings.append(f"선별한 {len(pages)}쪽이 설정한 {max_pages}쪽을 넘었습니다. 조용히 자르거나 전체 분석하지 않습니다.")
    return {"version": VERSION, "status": status, "totalPages": len(page_texts), "selectedPages": pages,
            "selectedCount": len(pages), "maxPages": max_pages, "sections": selected, "excluded": excluded,
            "blankPages": blank, "warnings": warnings, "remoteCalls": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--deps", type=Path)
    parser.add_argument("--max-pages", type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 100:
        parser.error("--max-pages must be 1..100")
    if args.deps:
        sys.path.insert(0, str(args.deps.resolve()))
    from pypdf import PdfReader, PdfWriter
    sha = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    cache = args.output / f"text-{sha}.json"
    reader = PdfReader(args.pdf)
    saved = json.loads(cache.read_text("utf8")) if cache.exists() else {}
    cached = saved.get("sha256") == sha and saved.get("version") == VERSION and len(saved.get("pages", [])) == len(reader.pages)
    texts = saved["pages"] if cached else [page.extract_text() or "" for page in reader.pages]
    if not cached:
        cache.write_text(json.dumps({"version": VERSION, "sha256": sha, "pages": texts}, ensure_ascii=False), encoding="utf8")
    result = select_sections(texts, args.max_pages)
    result.update(pdf=str(args.pdf.resolve()), sha256=sha, textCached=cached, textCache=str(cache.resolve()))
    if result["status"] == "ready":
        writer = PdfWriter()
        for number in result["selectedPages"]:
            writer.add_page(reader.pages[number - 1])
        subset = args.output / "selected.pdf"
        with subset.open("wb") as stream:
            writer.write(stream)
        result.update(selectedPdf=str(subset.resolve()), selectedPdfBytes=subset.stat().st_size,
                      pageMap=[{"selectedPage": i + 1, "sourcePage": p} for i, p in enumerate(result["selectedPages"])])
    (args.output / "selection.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps({k: result[k] for k in ["status", "totalPages", "selectedPages", "textCached", "warnings"]}, ensure_ascii=False))
    if result["status"] != "ready":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
