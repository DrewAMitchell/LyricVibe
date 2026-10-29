import copy
import unittest
from unittest.mock import patch

from native.phrase_alignment import phrase_plan, proposals


def fixture():
    return {"revision": 7, "offsetMs": -170, "lyrics": {"contentHash": "a" * 64},
            "phrases": [{"id": "p", "startMs": 1000, "endMs": 4000,
                         "words": [{"id": "a", "text": "hello", "locked": False},
                                   {"id": "b", "text": "hello", "locked": False}]}]}


def aligned():
    return {"model": "fixture", "modelRevision": "fixture-only", "words": [
        {"wordIndex": i, "text": "hello", "startMs": 100 + i * 1000, "endMs": 600 + i * 1000,
         "characters": [{"characterIndex": j, "startMs": 100 + i * 1000 + j * 100,
                         "endMs": 200 + i * 1000 + j * 100} for j in range(5)]}
        for i in range(2)]}


@patch("native.phrase_alignment._validate_score", return_value={"mediaKey": "youtube:TESTVIDEO01"})
class PhraseAlignmentTests(unittest.TestCase):
    def test_phrase_bounds_and_repeated_word_ordinals_are_preserved(self, _validate):
        score = fixture()
        before = copy.deepcopy(score)
        hint = {"parts": ["hel", "lo"], "basis": "human-test-cuts"}
        result = proposals(score, "p", aligned(), {"a": hint, "b": hint})
        self.assertEqual(result["window"], {"sourceStartMs": 830, "durationMs": 3000, "playbackRate": 1})
        self.assertEqual([p["wordId"] for p in result["proposals"]], ["a", "b"])
        self.assertEqual([p["startMs"] for p in result["proposals"]], [1100, 2100])
        self.assertEqual([(s["startMs"], s["endMs"]) for s in result["syllableOperations"][0]["syllables"]], [(1100, 1400), (1400, 1600)])
        self.assertTrue(all(not p["accepted"] for p in result["proposals"]))
        self.assertTrue(all(s["provenance"] == "aligned" and not s["locked"] for op in result["syllableOperations"] for s in op["syllables"]))
        self.assertFalse(result["automaticAdmissionEnabled"])
        self.assertEqual(score, before)

    def test_unknown_spelling_keeps_word_proposal_without_fabricating_syllables(self, _validate):
        result = proposals(fixture(), "p", aligned(), {})
        self.assertEqual(len(result["proposals"]), 2)
        self.assertEqual(result["syllableOperations"], [])
        self.assertTrue(all(w["syllableCount"] is None for w in result["words"]))

    def test_protected_human_timings_are_not_replaced(self, _validate):
        score = fixture()
        score["phrases"][0]["words"][0]["syllables"] = [{"locked": True}]
        result = proposals(score, "p", aligned(), {})
        self.assertEqual(result["protectedWordIds"], ["a"])
        self.assertEqual([p["wordId"] for p in result["proposals"]], ["b"])

    def test_partial_misordered_out_of_bounds_or_invalid_character_results_reject(self, _validate):
        for mutation in [lambda a: a["words"].pop(),
                         lambda a: a["words"][0].update(wordIndex=1),
                         lambda a: a["words"][0].update(endMs=4000),
                         lambda a: a["words"][0]["characters"][0].update(endMs=9000)]:
            candidate = aligned()
            mutation(candidate)
            with self.assertRaises(ValueError):
                proposals(fixture(), "p", candidate, {"a": {"parts": ["hello"], "basis": "fixture"}})

    def test_overlap_and_long_phrase_need_explicit_review(self, _validate):
        score = fixture()
        score["phrases"].append({"id": "backing", "startMs": 2000, "endMs": 3000, "words": []})
        with self.assertRaisesRegex(ValueError, "Overlapping"):
            phrase_plan(score, "p")
        score = fixture()
        score["phrases"][0]["endMs"] = 20_000
        with self.assertRaisesRegex(ValueError, "12 seconds"):
            phrase_plan(score, "p")


if __name__ == "__main__":
    unittest.main()
