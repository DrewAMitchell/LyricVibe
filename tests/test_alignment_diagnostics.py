import unittest
from types import SimpleNamespace

from native.alignment import _greedy_consistency, _make_target, _target_frame_groups


class _TensorRow:
    def __init__(self, values):
        self.values = list(values)

    def tolist(self):
        return list(self.values)


class _Tensor:
    def __init__(self, rows):
        self.rows = rows

    def __getitem__(self, index):
        return _TensorRow(self.rows[index])


class AlignmentDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.labels = ("-", "|", "A", "B", "C")
        torch = SimpleNamespace(int32=object(), tensor=lambda values, dtype: values)
        self.target, self.spans = _make_target("ab bc", self.labels, torch)
        self.aligned = _Tensor([[0, 2, 2, 3, 1, 3, 4, 0]])

    def test_diagnostics_are_numeric_same_model_comparison_without_transcript(self):
        frames, error = _target_frame_groups(self.aligned, _Tensor(self.target))
        self.assertIsNone(error)
        metrics = _greedy_consistency(
            [0, 2, 3, 3, 1, 2, 4, 0],
            self.aligned[0].tolist(),
            [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8],
            frames,
            self.spans,
            self.labels,
        )

        self.assertEqual(metrics["method"], "same-model-greedy-vs-forced-ctc")
        self.assertFalse(metrics["calibrated"])
        self.assertEqual(metrics["wordCount"], 2)
        self.assertEqual(metrics["greedyWordCount"], 2)
        self.assertEqual(metrics["matchedWordFraction"], 0.5)
        self.assertEqual(metrics["words"][0], {
            "wordIndex": 0,
            "forcedFrameCount": 3,
            "greedyTop1FrameFraction": 2 / 3,
            "meanForcedLogProb": -0.3,
        })
        self.assertEqual(metrics["words"][1]["wordIndex"], 1)
        self.assertEqual(metrics["words"][1]["forcedFrameCount"], 2)
        self.assertEqual(metrics["words"][1]["greedyTop1FrameFraction"], 0.5)
        self.assertAlmostEqual(metrics["words"][1]["meanForcedLogProb"], -0.65)
        self.assertNotIn("transcript", str(metrics).lower())
        self.assertNotIn("text", metrics)

    def test_sequence_similarity_uses_word_edit_distance_and_no_audio_time(self):
        frames, _ = _target_frame_groups(self.aligned, _Tensor(self.target))
        metrics = _greedy_consistency(
            [0, 2, 3, 1, 4, 0],
            self.aligned[0].tolist(),
            [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8],
            frames,
            self.spans,
            self.labels,
        )
        self.assertEqual(metrics["matchedWordFraction"], 0.5)
        self.assertNotIn("startMs", metrics)
        self.assertNotIn("endMs", metrics)

    def test_malformed_forced_path_has_no_per_word_frame_support(self):
        frames, error = _target_frame_groups(_Tensor([[0, 3, 0]]), _Tensor(self.target))
        self.assertIsNone(frames)
        self.assertIn("did not reproduce", error)


if __name__ == "__main__":
    unittest.main()
