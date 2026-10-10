import unittest
from types import SimpleNamespace

from native.alignment import _frame_words, _is_exact_zero_energy, _make_target


class _FrameRow:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return list(self.values)


class _FrameTensor:
    def __init__(self, rows):
        self.rows = rows

    def __getitem__(self, index):
        return _FrameRow(self.rows[index])


class _CountTensor:
    def __init__(self, count):
        self.count = count

    def item(self):
        return self.count


class _CountTorch:
    @staticmethod
    def count_nonzero(tensor):
        return _CountTensor(tensor)


class NativeAlignmentMappingTests(unittest.TestCase):
    def test_target_preserves_supplied_word_text_and_delimiters(self):
        torch = SimpleNamespace(int32=object(), tensor=lambda values, dtype: values)
        labels = ("-", "|", "A", "L", "I", "V", "E")
        token_ids, words = _make_target("Alive, alive!", labels, torch)

        self.assertEqual(token_ids, [[2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]])
        self.assertEqual(words, [(0, 5, "Alive"), (6, 11, "alive")])

    def test_word_boundaries_follow_separate_repeated_character_frames(self):
        # Transcript: "all all". The blank frames separating each repeated L
        # and the two lexical words must not merge their source intervals.
        aligned = _FrameTensor([[0, 2, 3, 0, 3, 1, 2, 3, 0, 3, 0]])
        targets = _FrameTensor([[2, 3, 3, 1, 2, 3, 3]])
        words, warnings = _frame_words(
            aligned,
            targets,
            [(0, 3, "all"), (4, 7, "all")],
            blank_id=0,
            duration_ms=1100,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(words, [
            {"text": "all", "startMs": 100, "endMs": 500, "wordIndex": 0},
            {"text": "all", "startMs": 600, "endMs": 1000, "wordIndex": 1},
        ])

    def test_malformed_forced_path_returns_no_partial_intervals(self):
        aligned = _FrameTensor([[0, 2, 0, 2]])
        targets = _FrameTensor([[2, 3]])
        words, warnings = _frame_words(
            aligned,
            targets,
            [(0, 2, "ab")],
            blank_id=0,
            duration_ms=400,
        )

        self.assertEqual(words, [])
        self.assertIn("did not reproduce", warnings[0])

    def test_unsupported_character_fails_explicitly(self):
        torch = SimpleNamespace(int32=object(), tensor=lambda values, dtype: values)
        labels = ("-", "|") + tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ("'",)
        with self.assertRaisesRegex(ValueError, "unsupported non-English"):
            _make_target("café", labels, torch)

    def test_numeric_content_fails_instead_of_silently_dropping(self):
        torch = SimpleNamespace(int32=object(), tensor=lambda values, dtype: values)
        labels = ("-", "|") + tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ("'",)
        with self.assertRaisesRegex(ValueError, "numeric lyric characters"):
            _make_target("we rise in 2026", labels, torch)

    def test_curly_apostrophe_remains_one_supplied_word(self):
        torch = SimpleNamespace(int32=object(), tensor=lambda values, dtype: values)
        labels = ("-", "|") + tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ("'",)
        token_ids, words = _make_target("Can’t", labels, torch)
        self.assertEqual(words, [(0, 5, "Can’t")])
        self.assertEqual(token_ids[0], [4, 2, 15, 28, 21])

    def test_silence_gate_matches_only_exact_zero_energy(self):
        self.assertTrue(_is_exact_zero_energy(0, _CountTorch))
        self.assertFalse(_is_exact_zero_energy(1, _CountTorch))


if __name__ == "__main__":
    unittest.main()
