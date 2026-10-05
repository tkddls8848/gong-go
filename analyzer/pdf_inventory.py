"""Inventory table blocks/rows locally, without asking an LLM to enumerate itself.

Recognized layouts: bullet + equipment quantity, UNIX detail rows, HCI logical
rows. Unknown layouts remain explicit section fallbacks, never 'complete'.
"""
import re
from pdf_table_inventory import table_inventory


def inventory(body, page_at, section_name=''):
    units, warnings = [], []
    bullets = list(re.finditer(r"(?m)^[ \t]*[○❍◦•][ \t]*(.+)$", body))
    for index, bullet in enumerate(bullets):
        end = bullets[index + 1].start() if index + 1 < len(bullets) else len(body)
        block = body[bullet.start():end]
        title = bullet.group(1).strip()
        if re.search(r"논리\s*서버.*상세", title):
            if not re.search(r'Core\s*Mem\s*\(?GB\)?\s*수량', block, re.I):
                warnings.append(f"논리 서버 열 순서/단위 미인식: {title}")
                continue
            rows = list(re.finditer(r"(?m)^([^\n]+?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", block))
            for row in rows:
                units.append(dict(name=row[1].strip(), type="logical", kind="서버",
                                  pages=[page_at(bullet.start() + row.start())], source=row.group(),
                                  expected={"CPU": row[2], "메모리": row[3], "수량": row[4]},
                                  requiredFields=["CPU", "메모리", "수량"]))
            if not rows:
                warnings.append(f"논리 서버 행 해석 실패: {title}")
        elif re.fullmatch(r"상세\s*내역", title) and re.search(r"tpmC", block, re.I):
            # Labels can occupy several lines (DR / 내부 / WEB). Start after
            # the final network column header; never absorb a preceding row.
            header = re.search(r"TX\s*1G\s*\n", block, re.I)
            if not header:
                warnings.append("UNIX 상세 표 열 머리글 인식 실패")
                continue
            table = block[header.end():]
            row_re = re.compile(r"(?P<label>(?:[^\n]*\S[^\n]*\n)*?[^\n]*?)\s*(?P<core>\d+)\s+(?P<tpm>[\d,]+)\s+이상\s+(?P<mem>\d+)\s+(?P<disk>\d+GB\s*x\s*\d+)\s+(?P<fc2>\d+|-)\s+(?P<fc4>\d+|-)\s+(?P<sr>\d+|-)\s+(?P<tx>\d+|-)\s*", re.I)
            rows = list(row_re.finditer(table))
            common = body[:bullet.start()]
            for row in rows:
                label = " ".join(row['label'].split())
                units.append(dict(name=label, type="unix-row", kind="서버",
                                  pages=[page_at(bullet.start() + header.end() + row.start())],
                                  source=row.group(), common=common,
                                  network='SR' if re.search(r'SR\s*10G', block) else 'SX',
                                  expected={"CPU": row['core'], "메모리": row['mem'], "성능": row['tpm']},
                                  requiredFields=["CPU", "메모리", "성능", "로컬 디스크", "NIC/HBA"]))
            if not rows or table[rows[-1].end():].strip():
                warnings.append("UNIX 상세 표에 미해석 텍스트가 있습니다")
        elif (re.search(r"수량\s*[:：]\s*\d+|\(\s*\d+\s*(?:식|대|Node)\s*\)", block, re.I)
              and re.search(r"CPU|메모리|인터페이스|드라이브|용량|포트", block, re.I)):
            kind = "스위치" if "스위치" in title else "스토리지" if re.search(r"스토리지|PTL|어플라이언스", title, re.I) else "서버"
            # Quantity is evidence, not part of the prompt's equipment identity.
            name = re.sub(r"\s*(?:도입)?\(\s*\d+\s*(?:식|대|Node)\s*\)\s*$", "", title, flags=re.I)
            source = re.split(r"산출정보", block)[0].strip()
            required = ["수량"]
            if re.search(r"CPU", block): required.append("CPU")
            if re.search(r"메모리", block): required.append("메모리")
            if kind == "서버": required += ["로컬 디스크", "NIC/HBA", "이중화"]
            if "Usable" in block: required.append("Usable 용량")
            if kind == "스위치": required += ["포트 수", "포트 속도"]
            expected = {}
            quantity = re.search(r'수량\s*[:：]\s*(\d+)|\(\s*(\d+)\s*(?:식|대|Node)\s*\)', source, re.I)
            if quantity: expected['수량'] = next(v for v in quantity.groups() if v)
            memory = re.search(r'메모리\s*[-:]?\s*(\d[\d,.]*)\s*(?:GB|TB)', source, re.I)
            if memory: expected['메모리'] = memory[1]
            cpu = re.search(r'(\d[\d,.]*)\s*GHz\s+(\d+)\s*core(?:\s*x\s*(\d+)\s*CPU)?', source, re.I)
            if cpu: expected['CPU'] = [v for v in cpu.groups() if v]
            units.append(dict(name=name, type="physical", kind=kind,
                              pages=list(range(page_at(bullet.start()), page_at(bullet.start() + len(source) - 1) + 1)),
                              source=source, expected=expected, requiredFields=required))
    if not units:
        units, table_warnings = table_inventory(body, page_at, section_name)
        warnings.extend(table_warnings)
    if not units:
        warnings.append("하위 장비 표 형식 미인식: 페이지 단위 결과의 완전성을 확인해야 합니다")
    for i, unit in enumerate(units):
        unit['key'] = f"device-{i + 1}"
    return units, warnings
