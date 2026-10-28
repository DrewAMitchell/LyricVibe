import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).resolve().parents[1] / "scripts/package-release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleasePackageTests(unittest.TestCase):
    def test_exact_inventory_reproducible_zip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "dist/lyricvibe"
            build.mkdir(parents=True)
            (build / "manifest.json").write_text(json.dumps({"version": "2026.4.2.0", "version_name": "2026.4.2.0"}))
            (root / "package-lock.json").write_text("{}")
            (root / "release-files.json").write_text('["manifest.json"]')
            extra = build / "private-score.json"
            extra.write_text("{}")
            with self.assertRaisesRegex(ValueError, "inventory differs"):
                module.package(root, root / "out1", "a" * 40)
            self.assertFalse((root / "out1").exists())
            extra.unlink()
            a = module.package(root, root / "out1", "a" * 40)
            b = module.package(root, root / "out2", "a" * 40)
            self.assertEqual(a["sha256"], b["sha256"])
            self.assertEqual(a["sourceCommit"], "a" * 40)
            with self.assertRaisesRegex(ValueError, "never overwritten"):
                module.package(root, root / "out1", "a" * 40)

    def test_version_disagreement_stops_before_artifact_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "dist/lyricvibe"
            build.mkdir(parents=True)
            (build / "manifest.json").write_text(json.dumps({"version": "2026.4.2.0", "version_name": "2026.4.2.1"}))
            (root / "release-files.json").write_text('["manifest.json"]')
            with self.assertRaisesRegex(ValueError, "mismatch"):
                module.package(root, root / "out", "a" * 40)
            self.assertFalse((root / "out").exists())


if __name__ == "__main__":
    unittest.main()
