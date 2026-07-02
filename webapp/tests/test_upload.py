import asyncio
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.datastructures import UploadFile

import webapp.server as server


class UploadTests(unittest.TestCase):
    def test_save_upload_file_writes_content(self):
        with tempfile.TemporaryDirectory() as td:
            old_root = server.UPLOAD_ROOT
            try:
                server.UPLOAD_ROOT = Path(td)
                f = UploadFile(filename="a.bin", file=io.BytesIO(b"hello"))
                path = asyncio.run(server._save_upload_file("u", "task_1", "field", f))
                self.assertTrue(path)
                p = Path(path)
                self.assertTrue(p.exists())
                self.assertEqual(p.read_bytes(), b"hello")
            finally:
                server.UPLOAD_ROOT = old_root

    def test_save_upload_file_respects_size_limit(self):
        with tempfile.TemporaryDirectory() as td:
            old_root = server.UPLOAD_ROOT
            old_max = server.MAX_UPLOAD_BYTES
            try:
                server.UPLOAD_ROOT = Path(td)
                server.MAX_UPLOAD_BYTES = 3
                f = UploadFile(filename="a.bin", file=io.BytesIO(b"hello"))
                with self.assertRaises(server.HTTPException) as ctx:
                    asyncio.run(server._save_upload_file("u", "task_1", "field", f))
                self.assertEqual(ctx.exception.status_code, 413)
                task_dir = Path(td) / "u" / "task_1"
                if task_dir.exists():
                    self.assertEqual(list(task_dir.glob("*")), [])
            finally:
                server.UPLOAD_ROOT = old_root
                server.MAX_UPLOAD_BYTES = old_max


class ZipExtractTests(unittest.TestCase):
    def _make_zip(self, base: Path, entries: dict[str, bytes]) -> Path:
        p = base / "a.zip"
        with zipfile.ZipFile(str(p), "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for name, data in entries.items():
                zf.writestr(name, data)
        return p

    def test_extract_zip_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            z = self._make_zip(base, {"../evil.txt": b"x"})
            out = base / "out"
            with self.assertRaises(RuntimeError):
                server._extract_zip_to_dir(z, out)

    def test_extract_zip_rejects_absolute_and_drive(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            z1 = self._make_zip(base, {"/abs.txt": b"x"})
            with self.assertRaises(RuntimeError):
                server._extract_zip_to_dir(z1, base / "o1")
            z2 = self._make_zip(base, {"C:\\evil.txt": b"x"})
            with self.assertRaises(RuntimeError):
                server._extract_zip_to_dir(z2, base / "o2")

    def test_extract_zip_supports_backslash_paths(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            z = self._make_zip(base, {"a\\b\\c.txt": b"ok"})
            out = base / "out"
            server._extract_zip_to_dir(z, out)
            self.assertEqual((out / "a" / "b" / "c.txt").read_bytes(), b"ok")


if __name__ == "__main__":
    unittest.main()

