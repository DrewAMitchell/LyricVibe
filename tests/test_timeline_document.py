"""Meaningful integration coverage for the score-backed timeline document."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from native.timeline_document import TimelineDocument, TimelineError, ROOT


@unittest.skipUnless(shutil.which("node"), "Timeline score operations require Node.js")
class TimelineDocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = (
            "const core=require('./extension/score-core.js');"
            "const score=core.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Fixture',artist:'Fixture',durationMs:10000},"
            "'[00:01.00]hello world\\n[00:05.00]',{provider:'test',entryId:'fixture',contentHash:'a'.repeat(64)});"
            "process.stdout.write(JSON.stringify(score));"
        )
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, check=True, timeout=10)
        cls.score = json.loads(result.stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package_path = self.root / "package.json"
        self.original_score = copy.deepcopy(self.score)
        self.package = {
            "version": "lyricvibe.review.v1", "score": copy.deepcopy(self.score),
            "receipt": {"expectedRevision": self.score["revision"]},
            "audio": {"name": "fixture.wav", "durationMs": 10000, "sizeBytes": 1, "sha256": "b" * 64},
            "waveform": {"sampleRate": 8000, "bucketMs": 100, "peaks": [0.0]},
        }
        self.package_path.write_text(json.dumps(self.package), encoding="utf-8")
        self.doc = TimelineDocument(self.package_path)
        self.word = self.score["phrases"][0]["words"][0]

    def test_shared_word_timing_edit_tracks_both_revisions_and_keeps_original_immutable(self):
        package_before = self.package_path.read_bytes()
        original = self.doc.package
        returned = self.doc.act({"type": "setWordTiming", "wordId": self.word["id"],
                                 "startMs": self.word["startMs"] + 20, "endMs": self.word["endMs"] - 20}, 0)
        self.assertEqual(self.doc.revision, 1)
        self.assertEqual(returned["revision"], self.original_score["revision"] + 1)
        self.assertEqual(returned["phrases"][0]["words"][0]["provenance"], "manual")
        self.assertTrue(returned["phrases"][0]["words"][0]["locked"])
        original["score"]["phrases"][0]["words"][0]["startMs"] = -1
        self.assertEqual(self.doc.package["score"]["phrases"][0]["words"][0]["startMs"], self.word["startMs"])
        self.assertEqual(self.package_path.read_bytes(), package_before)

    def test_manual_timing_can_be_refined_without_removing_automatic_protection(self):
        self.doc.act({"type": "setWordLock", "wordId": self.word["id"], "locked": True}, 0)
        locked_score = self.doc.score
        changed = self.doc.act({"type": "setWordTiming", "wordId": self.word["id"],
                                "startMs": self.word["startMs"] + 1, "endMs": self.word["endMs"]}, 1)
        changed = self.doc.act({"type": "setWordTiming", "wordId": self.word["id"],
                                "startMs": self.word["startMs"] + 2, "endMs": self.word["endMs"] - 1}, 2)
        self.assertEqual(self.doc.revision, 3)
        self.assertEqual(changed["revision"], locked_score["revision"] + 2)
        self.assertTrue(changed['phrases'][0]['words'][0]['locked'])
        restored = self.doc.undo(3)
        self.assertEqual(restored['phrases'][0]['words'][0]['startMs'], self.word['startMs'] + 1)
        self.assertTrue(restored['phrases'][0]['words'][0]['locked'])

    def test_locked_child_timing_remains_manually_editable_inside_protected_word(self):
        word_id = self.word["id"]
        start, end = self.word["startMs"], self.word["endMs"]
        self.doc.act({"type": "setWordSyllables", "wordId": word_id, "syllables": [
            {"id": "manual-a", "text": "hel", "startMs": start, "endMs": start + 300},
            {"id": "manual-b", "text": "lo", "startMs": start + 300, "endMs": end},
        ]}, 0)
        syllable = self.doc.score["phrases"][0]["words"][0]["syllables"][0]
        self.assertTrue(syllable["locked"])
        self.doc.act({'type': 'setWordLock', 'wordId': word_id, 'locked': True}, 1)
        result = self.doc.act({"type": "setSyllableTiming", "syllableId": syllable["id"],
                               "startMs": start + 5, "endMs": start + 250}, 2)
        self.assertEqual(result["phrases"][0]["words"][0]["syllables"][0]["startMs"], start + 5)
        self.assertTrue(result['phrases'][0]['words'][0]['locked'])
        self.assertTrue(result['phrases'][0]['words'][0]['syllables'][0]['locked'])

    def test_typed_split_uses_core_and_bad_split_is_atomic(self):
        start, end = self.word["startMs"], self.word["endMs"]
        before = self.doc.score
        with self.assertRaises(TimelineError) as invalid:
            self.doc.act({"type": "setWordSyllables", "wordId": self.word["id"], "syllables": [
                {"id": "bad-a", "text": "he", "startMs": start, "endMs": start + 200},
                {"id": "bad-b", "text": "lo", "startMs": start + 200, "endMs": end},
            ]}, 0)
        self.assertEqual(invalid.exception.code, "INVALID_SYLLABLES")
        self.assertEqual(self.doc.revision, 0)
        self.assertEqual(self.doc.score, before)

    def test_undo_restores_content_with_monotonic_document_and_score_revisions(self):
        self.doc.act({"type": "setOffset", "offsetMs": 80}, 0)
        self.doc.act({"type": "setOffset", "offsetMs": 120}, 1)
        restored = self.doc.undo(2)
        self.assertEqual(restored["offsetMs"], 80)
        self.assertEqual(self.doc.revision, 3)
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(self.doc.undo(3)["offsetMs"], 0)
        self.assertEqual(self.doc.revision, 4)
        self.assertEqual(self.doc.score["revision"], 4)
        with self.assertRaises(TimelineError) as stale:
            self.doc.act({"type": "setOffset", "offsetMs": 10}, 2)
        self.assertEqual(stale.exception.code, "REVISION_CONFLICT")

    def test_import_is_bound_atomic_and_preserves_existing_manual_locks(self):
        self.doc.act({"type": "setWordLock", "wordId": self.word["id"], "locked": True}, 0)
        imported = self.doc.score
        imported["revision"] += 10
        imported["offsetMs"] = 25
        import_path = self.root / "incoming.json"
        import_path.write_text(json.dumps(imported), encoding="utf-8")
        result = self.doc.import_score(import_path, 1)
        self.assertEqual(result["offsetMs"], 25)
        self.assertEqual(self.doc.revision, 2)
        self.assertEqual(result["revision"], imported["revision"])

        before = self.doc.score
        wrong_source = copy.deepcopy(before)
        wrong_source["lyrics"]["contentHash"] = "c" * 64
        wrong_path = self.root / "wrong.json"
        wrong_path.write_text(json.dumps(wrong_source), encoding="utf-8")
        with self.assertRaises(TimelineError) as mismatch:
            self.doc.import_score(wrong_path, 2)
        self.assertEqual(mismatch.exception.code, "SOURCE_MISMATCH")
        self.assertEqual(self.doc.score, before)
        self.assertEqual(self.doc.revision, 2)

        changed_lock = copy.deepcopy(before)
        changed_lock["phrases"][0]["words"][0]["startMs"] += 1
        locked_path = self.root / "locked.json"
        locked_path.write_text(json.dumps(changed_lock), encoding="utf-8")
        with self.assertRaises(TimelineError) as lock_failure:
            self.doc.import_score(locked_path, 2)
        self.assertEqual(lock_failure.exception.code, "IMPORT_LOCKED_CHANGE")
        self.assertEqual(self.doc.score, before)

    def test_import_preserves_unlocked_estimated_children_of_locked_word(self):
        word_id = self.word["id"]
        start, end = self.word["startMs"], self.word["endMs"]
        self.doc.act({"type": "setWordSyllables", "wordId": word_id, "syllables": [
            {"id": "estimate-a", "text": "hel", "startMs": start, "endMs": start + 300,
             "provenance": "estimated", "locked": False},
            {"id": "estimate-b", "text": "lo", "startMs": start + 300, "endMs": end,
             "provenance": "estimated", "locked": False},
        ]}, 0)
        self.doc.act({"type": "setWordTiming", "wordId": word_id,
                      "startMs": start + 10, "endMs": end - 10}, 1)
        current = self.doc.score
        children = current["phrases"][0]["words"][0]["syllables"]
        self.assertTrue(current["phrases"][0]["words"][0]["locked"])
        self.assertEqual([child["locked"] for child in children], [False, False])

        export_path = self.root / "locked-with-estimates.json"
        self.doc.export(export_path)
        reopened = self.doc.import_score(export_path, 2)
        self.assertEqual(reopened["phrases"][0]["words"][0]["syllables"], children)
        self.assertEqual(self.doc.revision, 3)

        changed = copy.deepcopy(reopened)
        word = changed["phrases"][0]["words"][0]
        child_start, child_end = word["startMs"], word["endMs"]
        word["syllables"] = [
            {"id": "new-a", "text": "he", "startMs": child_start, "endMs": child_start + 250,
             "provenance": "estimated", "locked": False, "effects": []},
            {"id": "new-b", "text": "llo", "startMs": child_start + 250, "endMs": child_end,
             "provenance": "estimated", "locked": False, "effects": []},
        ]
        changed_path = self.root / "changed-segmentation.json"
        changed_path.write_text(json.dumps(changed), encoding="utf-8")
        before_score = self.doc.score
        with self.assertRaises(TimelineError) as blocked:
            self.doc.import_score(changed_path, 3)
        self.assertEqual(blocked.exception.code, "IMPORT_LOCKED_CHANGE")
        self.assertEqual(self.doc.score, before_score)
        self.assertEqual(self.doc.revision, 3)

    def test_export_is_score_v1_exclusive_and_leaves_package_bytes_unchanged(self):
        before = self.package_path.read_bytes()
        export_path = self.root / "timeline.json"
        self.doc.export(export_path)
        exported = json.loads(export_path.read_text(encoding="utf-8"))
        self.assertEqual(exported["version"], "lyricvibe.score.v1")
        reopened = self.root / "reopened-package.json"
        package = copy.deepcopy(self.package)
        package["score"] = exported
        reopened.write_text(json.dumps(package), encoding="utf-8")
        loaded = TimelineDocument(reopened)
        self.assertEqual(loaded.score, exported)
        with self.assertRaises(TimelineError) as exists:
            self.doc.export(export_path)
        self.assertEqual(exists.exception.code, "EXPORT_EXISTS")
        self.assertEqual(self.package_path.read_bytes(), before)

    def test_undo_history_is_bounded(self):
        for index in range(101):
            self.doc.act({"type": "setOffset", "offsetMs": index + 1}, index)
        self.assertEqual(self.doc.revision, 101)
        self.assertEqual(len(self.doc._history), 100)
        with self.assertRaises(TimelineError) as conflict:
            self.doc.undo(100)
        self.assertEqual(conflict.exception.code, "REVISION_CONFLICT")
        current_revision = self.doc.revision
        for _ in range(100):
            self.doc.undo(self.doc.revision)
        self.assertEqual(self.doc.revision, current_revision + 100)
        with self.assertRaises(TimelineError) as empty:
            self.doc.undo(self.doc.revision)
        self.assertEqual(empty.exception.code, "NOTHING_TO_UNDO")


if __name__ == "__main__":
    unittest.main()
