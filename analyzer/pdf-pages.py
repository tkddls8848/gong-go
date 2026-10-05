"""Render selected PDF pages locally for Ollama vision, retaining text for verification."""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pages", required=True, help="1-based page numbers, comma separated")
    parser.add_argument("--deps", type=Path)
    parser.add_argument("--dpi", type=int, default=160)
    parser.add_argument("--columns", type=int, choices=(1, 2), default=1, help="Use 2 only for confirmed side-by-side printed pages")
    parser.add_argument("--table-crops", action="store_true", help="Render bounded UNIX/HCI detail tables when unique headings locate them")
    parser.add_argument("--text-extractor", choices=("auto", "pypdf", "pdfium"), default="auto",
                        help="auto uses pypdf for whole pages, PDFium for spatially cropped panels")
    args = parser.parse_args()
    if args.deps:
        sys.path.insert(0, str(args.deps.resolve()))
    import pypdfium2 as pdfium
    backend = ("pypdf" if args.columns == 1 else "pdfium") if args.text_extractor == "auto" else args.text_extractor
    if backend == "pypdf" and args.columns != 1:
        raise ValueError("pypdf whole-page text cannot verify individual cropped panels; use pdfium")
    text_pdf = None
    if backend == "pypdf":
        # Some SVG-derived PDFs render correctly but PDFium drops Latin letters/digits
        # from text. pypdf reads their Unicode maps; it is never sent to the model.
        from pypdf import PdfReader
        text_pdf = PdfReader(args.pdf)
    requested = sorted(set(int(p) for p in args.pages.split(",")))
    if not 72 <= args.dpi <= 240:
        raise ValueError("DPI must be 72..240")
    args.output.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    pages = []
    with pdfium.PdfDocument(args.pdf) as pdf:
        if not requested or any(p < 1 or p > len(pdf) for p in requested):
            raise ValueError("Page outside PDF")
        for number in requested:
            page = pdf[number - 1]
            textpage = page.get_textpage()
            bitmap = page.render(scale=args.dpi / 72)
            image = bitmap.to_pil()
            width, height = page.get_size()
            for column in range(args.columns):
                left, right = width * column / args.columns, width * (column + 1) / args.columns
                text = (text_pdf.pages[number - 1].extract_text() or "") if text_pdf is not None else textpage.get_text_bounded(left, 0, right, height)
                panel = image.crop((round(image.width * column / args.columns), 0, round(image.width * (column + 1) / args.columns), image.height))
                filename = f"{source_hash}-p{number}-c{column + 1}of{args.columns}-{args.dpi}.png"
                panel.save(args.output / filename)
                record = {"page": number, "panel": column + 1, "columns": args.columns, "image": filename, "text": text, "textExtractor": backend, "width": panel.width, "height": panel.height}
                if args.table_crops and args.columns == 1:
                    crops = {}
                    for kind, start_word, end_word in [('unix-row', '상세', '설치'), ('logical', '논리', '산출정보')]:
                        if kind == 'unix-row' and not ('tpmC' in text and 'UNIX' in text):
                            continue
                        if kind == 'logical' and not ('Core' in text and '논리' in text):
                            continue
                        start_search, end_search = textpage.search(start_word), textpage.search(end_word)
                        start_hit, end_hit = start_search.get_next(), end_search.get_next()
                        unique = start_search.get_next() is None and end_search.get_next() is None
                        start_search.close(); end_search.close()
                        if not start_hit or not end_hit or not unique:
                            continue
                        top = height - textpage.get_charbox(start_hit[0])[3] - 12
                        bottom = height - textpage.get_charbox(end_hit[0])[3] - 4
                        if not 0 <= top < bottom <= height:
                            continue
                        box = (0, round(top * args.dpi / 72), image.width, round(bottom * args.dpi / 72))
                        cropped = image.crop(box)
                        crop_file = f'{source_hash}-p{number}-{kind}-{args.dpi}.png'
                        cropped.save(args.output / crop_file); cropped.close()
                        crops[kind] = {"image": crop_file, "pixelBox": box, "locator": [start_word, end_word]}
                    record['tableCrops'] = crops
                pages.append(record)
                panel.close()
            textpage.close()
            image.close()
            bitmap.close()
            page.close()
    manifest = {"pdf": str(args.pdf.resolve()), "sha256": source_hash, "dpi": args.dpi, "pages": pages}
    (args.output / "pages.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"pages": len(pages), "manifest": str(args.output / "pages.json")}))


if __name__ == "__main__":
    main()
