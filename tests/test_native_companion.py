import json
import subprocess
import sys
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native import companion


class NativeCompanionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
const LvScore=require('./extension/score-core.js');
const score=LvScore.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Song',artist:'Artist',durationMs:10000},process.argv[1],{provider:'test',entryId:'one',contentHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});
process.stdout.write(JSON.stringify(score));
"""
        cls.lrc = "[00:05.00]hello, world\n[00:07.00]"
        result = subprocess.run(["node", "-e", script, cls.lrc], cwd=ROOT, text=True, capture_output=True, check=True)
        cls.base_score = json.loads(result.stdout)

    def run_analysis(self, score, aligned, *, audio_start_ms=0, phrase_ids=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        folder = Path(directory.name)
        score_path, audio_path, receipt_path = folder / "score.json", folder / "input.wav", folder / "receipt.json"
        score_path.write_text(json.dumps(score), encoding="utf-8")
        with wave.open(str(audio_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16_000)
            wav.writeframes(b"\0" * 32000)
        calls = []

        def fake_align(path, text, language="en"):
            calls.append((path, text, language))
            return aligned

        receipt = companion.analyze(score_path, audio_path, receipt_path, language="en", audio_start_ms=audio_start_ms, phrase_ids=phrase_ids, align_fn=fake_align)
        return receipt, json.loads(receipt_path.read_text(encoding="utf-8")), calls

    def test_receipt_binds_exact_source_and_subtracts_existing_offset_once(self):
        score = json.loads(json.dumps(self.base_score))
        score["offsetMs"] = 100
        words = score["phrases"][0]["words"]
        aligned = {"adapter": "fake-test", "model": "invented-anchor-fixture", "modelRevision": "test-1", "warnings": [], "words": [
            {"text": "hello", "startMs": 200, "endMs": 500, "score": 1.0},
            {"text": "world", "startMs": 700, "endMs": 1000, "score": 1.0},
        ]}
        receipt, saved, calls = self.run_analysis(score, aligned, audio_start_ms=5000)
        self.assertEqual(receipt, saved)
        self.assertEqual(receipt["version"], "lyricvibe.alignment.v1")
        self.assertEqual(receipt["mediaKey"], "youtube:FIXTURE0001")
        self.assertEqual(receipt["lyricsHash"], score["lyrics"]["contentHash"])
        self.assertEqual(receipt["expectedRevision"], score["revision"])
        self.assertEqual(receipt["timeDomain"], "score-time-before-offset")
        self.assertFalse(receipt["automaticAdmissionEnabled"])
        self.assertEqual([item["wordId"] for item in receipt["proposals"]], [word["id"] for word in words])
        self.assertEqual([[item["startMs"], item["endMs"], item["accepted"]] for item in receipt["proposals"]], [[5100, 5400, False], [5600, 5900, False]])
        self.assertEqual(calls[0][1], "hello, world")
        self.assertEqual(calls[0][2], "en")

    def test_locked_words_and_locked_syllables_are_never_proposed(self):
        score = json.loads(json.dumps(self.base_score))
        first, second = score["phrases"][0]["words"]
        first["locked"] = True
        first["provenance"] = "manual"
        second["syllables"] = [{
            "id": "locked-child", "text": second["text"], "startMs": second["startMs"], "endMs": second["endMs"],
            "provenance": "manual", "locked": True, "effects": [],
        }]
        aligned = {"adapter": "fake", "model": "fake", "words": [
            {"text": "hello", "startMs": 200, "endMs": 500}, {"text": "world", "startMs": 700, "endMs": 1000},
        ]}
        receipt, _, _ = self.run_analysis(score, aligned)
        self.assertEqual(receipt["proposals"], [])
        self.assertEqual({item["reason"] for item in receipt["unsupported"]}, {"manual-word-lock", "manual-syllable-lock"})

    def test_unmatched_word_is_reported_without_invented_timing(self):
        aligned = {"adapter": "fake", "model": "fake", "words": [{"text": "hello", "startMs": 200, "endMs": 500}]}
        receipt, _, _ = self.run_analysis(self.base_score, aligned)
        self.assertEqual(len(receipt["proposals"]), 1)
        self.assertEqual(receipt["proposals"][0]["wordId"], self.base_score["phrases"][0]["words"][0]["id"])
        self.assertIn({"wordId": self.base_score["phrases"][0]["words"][1]["id"], "reason": "unmatched-alignment-token"}, receipt["unsupported"])

    def test_neighbor_context_must_disambiguate_repeated_word_anchors(self):
        script = """
const LvScore=require('./extension/score-core.js');
process.stdout.write(JSON.stringify(LvScore.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Song',artist:'Artist',durationMs:10000},'[00:00.00]go go home\\n[00:02.00]',{provider:'test',contentHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})));
"""
        score = json.loads(subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True).stdout)
        aligned = {"adapter": "fake", "model": "fake", "words": [
            {"text": "go", "startMs": 100, "endMs": 200}, {"text": "home", "startMs": 300, "endMs": 400},
        ]}
        receipt, _, _ = self.run_analysis(score, aligned)
        self.assertEqual([item["wordId"] for item in receipt["proposals"]], [score["phrases"][0]["words"][2]["id"]])
        self.assertIn("ambiguous-alignment-token", {item["reason"] for item in receipt["unsupported"]})

    def test_backing_lane_words_are_reported_unsupported_and_omitted_from_transcript(self):
        script = """
const LvScore=require('./extension/score-core.js');
process.stdout.write(JSON.stringify(LvScore.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Song',artist:'Artist',durationMs:10000},'[00:00.00]lead (echo voice)\\n[00:02.00]',{provider:'test',contentHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})));
"""
        score = json.loads(subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True).stdout)
        aligned = {"adapter": "fake", "model": "fake", "words": [{"text": "lead", "startMs": 100, "endMs": 400}]}
        receipt, _, calls = self.run_analysis(score, aligned)
        self.assertEqual(calls[0][1], "lead")
        self.assertEqual(len(receipt["proposals"]), 1)
        self.assertEqual({item["reason"] for item in receipt["unsupported"]}, {"backing-lane-overlap-unsupported"})

    def test_adapter_reason_code_survives_as_bounded_receipt_warning(self):
        aligned = {"adapter": "fake-test", "model": "silent-fixture", "reasonCode": "SILENT_AUDIO", "warnings": [], "words": []}
        receipt, _, _ = self.run_analysis(self.base_score, aligned)
        self.assertTrue(any(item.startswith("SILENT_AUDIO:") for item in receipt["warnings"]))

    def test_phrase_selection_uses_lane_role_and_keeps_full_score_binding(self):
        script = """
const LvScore=require('./extension/score-core.js');
const score=LvScore.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Song',artist:'Artist',durationMs:10000},'[00:00.00]first phrase\\n[00:02.00]second phrase\\n[00:04.00]third phrase\\n[00:06.00]',{provider:'test',contentHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});
score.lanes.find(lane=>lane.role==='lead').id='main-vocal';
for (const phrase of score.phrases) if (phrase.laneId==='lead') phrase.laneId='main-vocal';
LvScore.validateScore(score);
process.stdout.write(JSON.stringify(score));
"""
        score = json.loads(subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True).stdout)
        selected = score["phrases"][1]
        aligned = {"adapter": "fake", "model": "fake", "words": [
            {"text": "second", "startMs": 100, "endMs": 200}, {"text": "phrase", "startMs": 250, "endMs": 400},
        ]}
        receipt, _, calls = self.run_analysis(score, aligned, phrase_ids=[selected["id"]])
        self.assertEqual(calls[0][1], "second phrase")
        self.assertEqual({item["wordId"] for item in receipt["proposals"]}, {word["id"] for word in selected["words"]})
        self.assertEqual(receipt["mediaKey"], "youtube:FIXTURE0001")
        self.assertEqual(receipt["expectedRevision"], score["revision"])
        self.assertEqual({item["reason"] for item in receipt["unsupported"]}, {"phrase-not-selected"})

    def test_repeated_phrase_text_is_explicitly_unsupported(self):
        script = """
const LvScore=require('./extension/score-core.js');
process.stdout.write(JSON.stringify(LvScore.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Song',artist:'Artist',durationMs:10000},'[00:00.00]hello world\\n[00:02.00]hello world',{provider:'test',contentHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})));
"""
        score = json.loads(subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True).stdout)
        aligned = {"adapter": "fake", "model": "fake", "words": [
            {"text": "hello", "startMs": 100, "endMs": 200}, {"text": "world", "startMs": 300, "endMs": 400},
            {"text": "hello", "startMs": 2100, "endMs": 2200}, {"text": "world", "startMs": 2300, "endMs": 2400},
        ]}
        receipt, _, _ = self.run_analysis(score, aligned)
        self.assertEqual(receipt["proposals"], [])
        self.assertEqual(len(receipt["unsupported"]), 4)
        self.assertEqual({item["reason"] for item in receipt["unsupported"]}, {"repeated-phrase-ambiguous"})

        aligned["alignmentKind"] = "supplied-text-ctc"
        for index, anchor in enumerate(aligned["words"]):
            anchor["wordIndex"] = index
        receipt, _, _ = self.run_analysis(score, aligned)
        self.assertEqual(len(receipt["proposals"]), 4)
        self.assertEqual(receipt["wordMapping"], "supplied-path-ordinal")
        self.assertFalse(receipt["automaticAdmissionEnabled"])
        self.assertTrue(all(not proposal["accepted"] for proposal in receipt["proposals"]))

        aligned["words"][2]["wordIndex"] = 0
        receipt, _, _ = self.run_analysis(score, aligned)
        self.assertEqual(receipt["proposals"], [])
        self.assertEqual(receipt["wordMapping"], "exact-neighbor-context")

    def test_cli_argument_errors_are_bounded_json(self):
        output = StringIO()
        with redirect_stdout(output):
            status = companion.main(["analyze"])
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(output.getvalue()), {
            "ok": False,
            "error": {"code": "INVALID_ARGUMENT", "message": "Command arguments are incomplete or invalid."},
        })


if __name__ == "__main__":
    unittest.main()
