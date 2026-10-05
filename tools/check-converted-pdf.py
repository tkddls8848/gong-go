"""Browser conversion output vs original text; ID coverage is not layout equivalence."""
import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("summary", type=Path)
    parser.add_argument("--samples", type=Path, default=Path("samples"))
    parser.add_argument("--deps", type=Path)
    args = parser.parse_args()
    if args.deps:
        sys.path.insert(0, str(args.deps.resolve()))
    from pypdf import PdfReader
    import pypdfium2 as pdfium
    spec = importlib.util.spec_from_file_location("local_extract", Path(__file__).with_name("extract-rfp-local.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checks = []
    for item in json.loads(args.summary.read_text("utf8"))["results"]:
        original, _ = module.extract(args.samples / item["input"])
        reader = PdfReader(item["output"])
        texts = [p.extract_text() or "" for p in reader.pages]
        converted = "\n".join(texts)
        def ids(text):
            return sorted({re.sub(r"[ \t]+", "", value).replace("–", "-")
                           for value in re.findall(r"(?:ECR|HWR|H/W|장비)[ \t]*[-–][ \t]*\d+", text, re.I)})
        check = {"name": item["input"], "pages": len(texts), "originalChars": len(original),
                 "pdfChars": len(converted), "originalIds": ids(original), "pdfIds": ids(converted),
                 "missingIds": sorted(set(ids(original)) - set(ids(converted))),
                 "hangul": len(re.findall("[가-힣]", converted))}
        checks.append(check)
        selected = next((i for i, text in enumerate(texts) if "ECR-001" in text and "요구사항" in text and len(text) > 500), 0)
        document = pdfium.PdfDocument(item["output"])
        document[selected].render(scale=1.3).to_pil().save(item["output"] + ".png")
        Path(item["output"] + ".txt").write_text(converted, encoding="utf8")
        Path(item["output"] + ".pages.json").write_text(json.dumps([
            {"page": i + 1, "ids": ids(text), "text": text} for i, text in enumerate(texts)
        ], ensure_ascii=False), encoding="utf8")
    args.summary.with_name("text-checks.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(checks, ensure_ascii=True, indent=2))
    if any(c["missingIds"] or not c["hangul"] for c in checks):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
