import unittest
from pdf_selection import select_sections


def section(id="ECR-001", name="업무 서버", body="CPU 3.2GHz 이상\n메모리 256GB 이상\nSSD 1.9TB 이상"):
    return f"요구사항 고유번호 {id}\n요구사항 명칭 {name}\n세부 내용\n{body}"


class SelectionTests(unittest.TestCase):
    def test_overview_toc_common_software_do_not_become_equipment(self):
        pages = ["사업 배경\nCPU 90%\n메모리 16GB\n가. 도입 대상 HW 내역\nCPU 3GHz\nSSD 1TB",
                 "요구사항 목록\nECR-001 업무 서버\nECR-002 소프트웨어",
                 section("ECR-001", "공통 요구사항"), section("ECR-002", "HW 도입 일반사항"),
                 section("ECR- 006", "도입 대상 HW", "업무 서버\nCPU 3.2GHz\n메모리 256GB"),
                 section("ECR-007", "도입 대상 소프트웨어")]
        report = select_sections(pages)
        self.assertEqual(report["selectedPages"], [5])
        self.assertEqual(report["sections"][0]["id"], "ECR-006")

    def test_continuation_stops_at_other_requirement_and_keeps_last_specs(self):
        pages = [section(body="요구사항 정의 서버 장비"), "CPU 3GHz\n메모리 256GB\nNIC 10Gbps\nSSD 2TB",
                 section("기능-001", "기능 요건", "기능 테스트 CPU 3GHz 메모리 256GB")]
        report = select_sections(pages)
        self.assertEqual(report["selectedPages"], [1, 2])

    def test_same_page_headers_keep_hardware_section_only(self):
        report = select_sections([section() + "\n" + section("ECR-002", "SW 라이선스")])
        self.assertEqual(report["selectedPages"], [1])
        self.assertEqual([s["id"] for s in report["sections"]], ["ECR-001"])

    def test_idless_specs_use_explicit_heading_not_incidental_mentions(self):
        report = select_sections(["사업 개요\n업무 서버 CPU 3GHz 메모리 256GB",
                                  "장비 규격\n업무 서버\nCPU 3GHz\n메모리 256GB\nSSD 2TB",
                                  "4. 기능 요구사항\n기능설명"])
        self.assertEqual(report["selectedPages"], [2])
        self.assertEqual(report["sections"][0]["id"], "")

    def test_no_text_or_no_specs_never_falls_back_to_whole_document(self):
        for pages in [["", ""], ["사업 목적\n서버 구매\nCPU 3GHz\n메모리 128GB"], [section(body="도입 조건 별도 협의")]]:
            report = select_sections(pages)
            self.assertEqual(report["status"], "needs-review")
            self.assertEqual(report["selectedPages"], [])

    def test_excess_selection_stops_instead_of_silent_truncation(self):
        report = select_sections([section(), "CPU 3GHz\n메모리 256GB"], max_pages=1)
        self.assertEqual(report["status"], "over-budget")
        self.assertEqual(report["selectedPages"], [1, 2])

    def test_wrapped_device_names_and_software_server_distinction(self):
        report = select_sections([section(name="백신관리서버", body="CPU 3GHz 메모리 256GB"),
                                  section("ECR-002", "도입 대상 HW", "클라우드\n가상 서버\nCPU 3GHz\n메모리 256GB\nSAN\n스토리지\nCache 192GB\nUsable 30TB")])
        self.assertEqual(report["selectedPages"], [1, 2])
        self.assertEqual(report["sections"][1]["expectedDevices"], ["클라우드 가상 서버", "SAN 스토리지"])

    def test_references_in_requirements_do_not_open_a_new_section(self):
        report = select_sections([section(body="관련 요구사항 ECR-005\nCPU 3GHz\n메모리 256GB")])
        self.assertEqual([s["id"] for s in report["sections"]], ["ECR-001"])

    def test_next_pages_classification_header_does_not_extend_previous_table(self):
        report = select_sections(["요구사항 분류 시스템 장비구성 요구사항\n" + section(),
                                  "요구사항 분류\n기능 요구사항\n" + section("SFR-001", "기능 요구사항")])
        self.assertEqual(report["selectedPages"], [1])

    def test_inventory_field_followed_by_specs_is_not_a_detail_header(self):
        report = select_sections(["목차\n요구사항 번호 ECR-001\n서버 구매\nCPU 3GHz 메모리 256GB"])
        self.assertEqual(report["selectedPages"], [])

    def test_standalone_equipment_id_with_title_and_continuation(self):
        pages = ["장비-001-공통\n요구사항 명칭 공통 요구사항\nCPU 3GHz 메모리 256GB",
                 "장비-003-업무 포털 운영 서버\n요구사항 분류 시스템 장비구성 요구사항\n요구사항 명칭 업무 포털 운영 서버\n요구사항 정의 신규 도입\nCPU 3GHz\n메모리 256GB",
                 "SSD 2TB\nNIC 10Gbps",
                 "장비-028-AI 스토리지 및 SAN\n요구사항 명칭 AI 스토리지 및 SAN\n요구사항 정의 신규 도입\nCache 1TB\nUsable 30TB"]
        report = select_sections(pages)
        self.assertEqual([s["id"] for s in report["sections"]], ["장비-003", "장비-028"])
        self.assertEqual(report["sections"][0]["pages"], [2, 3])
        self.assertEqual(report["sections"][0]["expectedDevices"], ["업무 포털 운영 서버"])

    def test_standalone_inventory_without_detail_headers_is_not_selected(self):
        report = select_sections(["장비-001-업무 서버\n장비-002-스토리지\nCPU 3GHz 메모리 256GB"])
        self.assertEqual(report["selectedPages"], [])

    def test_interface_and_power_are_not_requirement_ids_near_next_header(self):
        first = section('장비-024', '스토리지 및 SAN', '○ 스토리지 도입(1식)\n메모리 2TB\nUsable 100TB\n○ SAN 스위치 도입(2식)\n인터페이스 - FC 32Gbps 24port\n전원 - Dual\n산출정보 정의서')
        report = select_sections([first, section('장비-025')])
        self.assertEqual([s['id'] for s in report['sections']], ['장비-024', '장비-025'])
        self.assertEqual([d['kind'] for d in report['sections'][0]['inventory']], ['스토리지', '스위치'])
        self.assertIn('24port', report['sections'][0]['inventory'][1]['source'])

    def test_repeated_id_only_header_keeps_continuation_and_stops_at_new_id(self):
        pages = [section('ECR-003', '외부 서버'),
                 '요구사항 고유번호 ECR-003\n전원 이중화\n' + section('ECR-004', '소프트웨어 라이선스')]
        result = select_sections(pages)
        self.assertEqual(len(result['sections']), 1)
        self.assertEqual(result['sections'][0]['pages'], [1, 2])
        # Explicit new titles using the same ID remain separate.
        separate = select_sections([section('ECR-003', '운영 서버'), section('ECR-003', '개발 서버')])
        self.assertEqual(len(separate['sections']), 2)

    def test_single_memory_upgrade_is_equipment_but_general_purpose_is_not(self):
        result = select_sections([section('ECR-005', 'DB서버 메모리 증설', '메모리 52GB 증설')])
        self.assertEqual(result['selectedPages'], [1])
        result = select_sections([section('ECR-005', '사업 목적', '메모리 52GB 증설')])
        self.assertEqual(result['selectedPages'], [])


if __name__ == "__main__":
    unittest.main()
