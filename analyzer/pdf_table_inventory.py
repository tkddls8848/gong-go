"""Recognize the explicit name/scope/spec/quantity equipment table layout."""
import re


def table_inventory(body, page_at, section_name):
    header = re.search(r'명칭\s+구분\s+규격\s+수량\s*\n', body)
    if not header:
        return [], []
    stop = re.search(r'(?m)^\s*(?:[ㅇ○❍]|\*)', body[header.end():])
    end = header.end() + stop.start() if stop else len(body)
    table = body[header.end():end]
    tail = re.split(r'산출\s*정보', body[end:])[0]
    tail = re.sub(r'(?:\s|-[0-9]+-|요구사항\s*고유번호\s*[A-Z]+-[0-9]+)+\Z', '', tail)
    # Continuation conditions remain image input, including power/warranty clauses.
    pages = list(range(page_at(header.start()), page_at(end + len(tail) - 1) + 1))
    cpus = list(re.finditer(r'(?m)^\s*CPU\s*[:：]', table, re.I))
    units, warnings, cursor = [], [], 0
    for index, cpu in enumerate(cpus):
        limit = cpus[index + 1].start() if index + 1 < len(cpus) else len(table)
        quantity = re.search(r'(?m)^[ \t]*(\d+)[ \t]*$', table[cpu.end():limit])
        if not quantity:
            warnings.append('규격 표의 장비 수량 셀을 확정할 수 없습니다')
            continue
        row_end = cpu.end() + quantity.end()
        label = ' '.join(table[cursor:cpu.start()].split())
        source = table[cursor:row_end].strip()
        if not label or len(label) > 100:
            warnings.append('규격 표의 장비 행 명칭을 확정할 수 없습니다')
            continue
        expected = {'수량': quantity[1]}
        cpu_values = re.findall(r'(\d[\d,.]*)\s*(?:CPU|core|GHz)', source, re.I)
        if cpu_values: expected['CPU'] = cpu_values
        mem = re.search(r'MEM\s*:\s*(?:DDR\d+\s*)?(\d[\d,.]*)\s*GB', source, re.I)
        if mem: expected['메모리'] = mem[1]
        required = ['CPU', '메모리', '로컬 디스크', 'NIC/HBA', '수량']
        if re.search(r'전원\s*이중화', tail): required.append('이중화')
        units.append(dict(name=label, type='physical', kind='서버', pages=pages, source=source + '\n' + tail,
                          expected=expected, requiredFields=required))
        cursor = row_end
    if cpus:
        leftover = re.sub(r'(?m)^\s*요구사항\s*고유번호[^\n]*$|^\s*-\d+-\s*$', '', table[cursor:]).strip()
        if leftover and not re.match(r'RACK\b', leftover, re.I):
            warnings.append('규격 표에 미해석 행이 있습니다')
    elif re.search(r'서버.*메모리\s*증설', section_name):
        # Only a single explicit upgrade row with a capacity and trailing quantity.
        upgrade = re.search(r'(\d[\d,.]*)\s*(GB|TB)\s*증설\s+(\d+)\s*$', table.strip(), re.I)
        if upgrade:
            units.append(dict(name=section_name, type='physical', kind='서버', pages=pages, source=table.strip() + '\n' + tail,
                              expected={'메모리': upgrade[1], '수량': upgrade[3]}, requiredFields=['메모리', '수량', '도입구분']))
    return units, warnings
