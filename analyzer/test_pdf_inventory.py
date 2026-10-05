import unittest
from pdf_inventory import inventory


class InventoryTests(unittest.TestCase):
    def test_unix_wrapped_labels_are_all_distinct_and_never_quantities(self):
        text = '○ UNIX 서버 공통 규격\nCPU 3.0GHz\n○ 상세 내역\nCPU CORE tpmC Mem GB Disk\nTX\n1G\n'
        for name in ['DR\n내부\nWEB', 'DR\n내부\nWAS', 'DR\n내부\nDB']:
            text += name + '\n2 740,000 이상 32 800GB x 4 - 2 2 2\n'
        text += '○ 설치요건\n설치 계획'
        units, warnings = inventory(text, lambda _: 7)
        self.assertEqual([u['name'] for u in units], ['DR 내부 WEB', 'DR 내부 WAS', 'DR 내부 DB'])
        self.assertEqual(warnings, [])
        self.assertTrue(all('수량' not in u['expected'] for u in units))

    def test_logical_table_exceeding_twelve_keeps_every_row_and_physical_separate(self):
        text = '○ 내부 HCI 서버\n- 수량: 4 Node\nCPU 3GHz\n메모리 512GB\n디스크 Usable 30TB\n○ 내부망 업무 논리서버 상세내역\n시스템 업무 Core Mem GB 수량\n'
        text += '\n'.join(f'보안 업무{i} 4 32 2' for i in range(19))
        units, warnings = inventory(text, lambda _: 24)
        self.assertEqual(len(units), 20)
        self.assertEqual(units[-1]['name'], '보안 업무18')
        self.assertEqual(units[-1]['expected'], {'CPU': '4', '메모리': '32', '수량': '2'})
        self.assertNotIn('512GB', units[-1]['source'])

    def test_multiple_x86_blocks_and_page_continuation(self):
        first = '○ APIM\n수량:2식\nCPU 3GHz\n메모리 128GB\n'
        second = '○ 중계 DB\n수량:2식\nCPU 3GHz\n메모리 64GB\n'
        units, _ = inventory(first + second, lambda offset: 12 if offset < len(first) else 13)
        self.assertEqual([u['pages'] for u in units], [[12], [13]])
        self.assertNotIn('128GB', units[1]['source'])
        self.assertEqual(units[0]['expected']['메모리'], '128')
        self.assertEqual(units[1]['expected']['수량'], '2')

    def test_unknown_layout_requires_review(self):
        units, warnings = inventory('서버 CPU 3GHz 메모리 32GB', lambda _: 1)
        self.assertEqual(units, [])
        self.assertTrue(warnings)

    def test_reordered_logical_columns_are_not_silently_misread(self):
        units, warnings = inventory('○ 업무 논리서버 상세내역\n업무 수량 Core Mem(GB)\n보안 OTP 2 8 64', lambda _: 1)
        self.assertEqual(units, [])
        self.assertTrue(warnings)

    def test_name_scope_spec_quantity_table_keeps_hci_rows_and_excludes_rack(self):
        text = '명칭 구분 규격 수량\nHCI 운영 클러스터\nCPU: 1CPU 16core\nMEM: DDR5 128GB\nDISK: 10TB SSD\nNIC: 10G 2식\n3\n테스트 HCI\nCPU: 1CPU 16core\nMEM: DDR5 128GB\nDISK: 5TB SSD\nNIC: 10G 2식\n3\nRACK 기타\nRACK Console Switch PDU\n2\nㅇ구성요구사항\n전원 이중화'
        units, warnings = inventory(text, lambda _: 47, '클라우드 플랫폼(HCI)')
        self.assertEqual([u['name'] for u in units], ['HCI 운영 클러스터', '테스트 HCI'])
        self.assertEqual([u['expected']['수량'] for u in units], ['3', '3'])
        self.assertNotIn('10TB', units[1]['source'])
        self.assertEqual(warnings, [])

    def test_memory_expansion_does_not_invent_full_server_specs(self):
        text = '명칭 구분 규격 수량\nDB 메모리 DB 메모리 IBM Power8 E880C 증설\n- DB 1,2호기 메모리 52GB 증설 2\nㅇ구성요구사항\n기존 서버 메모리 증설'
        units, _ = inventory(text, lambda _: 49, '일자리포털 DB서버 메모리 증설')
        self.assertEqual(units[0]['requiredFields'], ['메모리', '수량', '도입구분'])
        self.assertEqual(units[0]['expected'], {'메모리': '52', '수량': '2'})


if __name__ == '__main__':
    unittest.main()
