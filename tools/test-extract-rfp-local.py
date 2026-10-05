"""Standard-library tests for the offline diagnostic reader (no sample documents)."""
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("reader", Path(__file__).with_name("extract-rfp-local.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReaderTest(unittest.TestCase):
    def test_control_payload_is_not_text(self):
        data = "서버 ".encode("utf-16le") + b"\x02\x00" + b"x" * 14 + "CPU 32Core\r".encode("utf-16le")
        self.assertEqual(reader.paragraph_text(data), "서버  CPU 32Core")

    def test_nested_hwpx_table_is_not_duplicated(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "fixture.hwpx"
            with zipfile.ZipFile(file, "w") as archive:
                archive.writestr("Contents/section0.xml", '<sec><p><run><t>표 제목</t><tbl><tc><p><run><t>CPU 32Core</t></run></p></tc></tbl></run></p></sec>')
            text, _ = reader.hwpx_text(file)
            self.assertEqual(text.count("CPU 32Core"), 1)
            self.assertLess(text.index("표 제목"), text.index("CPU"))

    def test_container_signature_overrides_extension(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "mislabeled.hwpx"
            file.write_bytes(bytes.fromhex("d0cf11e0a1b11ae1"))
            with patch.object(reader, "hwp_text", return_value=("HWP body", {})) as convert:
                self.assertEqual(reader.extract(file)[0], "HWP body")
                convert.assert_called_once_with(file)


if __name__ == "__main__":
    unittest.main()
