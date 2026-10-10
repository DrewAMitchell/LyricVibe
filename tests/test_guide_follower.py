import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

from native.guide_follower import CachedCtcRuntime, GuideFollower, GuideFollowerError, _decode_greedy_frames


def decoded(*tokens):
    """Build compact (text, start, end) decode fixtures."""
    return [
        {"text": text, "startMs": index * 300, "endMs": (index + 1) * 300}
        for index, text in enumerate(tokens)
    ]


def supplied(*tokens):
    return [{"id": f"word-{index}", "text": token} for index, token in enumerate(tokens)]


class GuideFollowerTests(unittest.TestCase):
    def test_runtime_enforces_two_second_minimum_before_model_inference(self):
        runtime = object.__new__(CachedCtcRuntime)
        runtime.torch = SimpleNamespace(inference_mode=nullcontext)
        runtime.torchaudio = object()
        runtime.model = lambda waveform: self.fail("short windows must fail before model inference")
        with patch("native.guide_follower.alignment._load_pcm_samples", return_value=(SimpleNamespace(shape=(1, 31_999)), 16_000)):
            with self.assertRaises(GuideFollowerError) as raised:
                runtime.decode(b"\0\0")
        self.assertEqual(raised.exception.code, "WINDOW_TOO_SHORT")

    def test_runtime_reports_invalid_or_oversized_pcm_as_a_typed_error(self):
        runtime = object.__new__(CachedCtcRuntime)
        runtime.torch = SimpleNamespace(inference_mode=nullcontext)
        runtime.torchaudio = object()
        with patch("native.guide_follower.alignment._load_pcm_samples", side_effect=ValueError("over maximum")):
            with self.assertRaises(GuideFollowerError) as raised:
                runtime.decode(b"\0\0")
        self.assertEqual(raised.exception.code, "INVALID_PCM")

        with self.assertRaises(GuideFollowerError) as raised:
            runtime.decode(b"\0\0" * (12 * 16_000 + 1))
        self.assertEqual(raised.exception.code, "WINDOW_TOO_LONG")

    def test_runtime_sanitizes_inference_failure_as_typed_error(self):
        runtime = object.__new__(CachedCtcRuntime)
        runtime.torch = SimpleNamespace(inference_mode=nullcontext)
        runtime.torchaudio = object()
        runtime.model = lambda waveform: (_ for _ in ()).throw(RuntimeError("private model detail"))
        with patch("native.guide_follower.alignment._load_pcm_samples", return_value=(SimpleNamespace(shape=(1, 32_000)), 16_000)):
            with self.assertRaises(GuideFollowerError) as raised:
                runtime.decode(b"\0\0")
        self.assertEqual(raised.exception.code, "MODEL_INFERENCE_FAILED")
        self.assertNotIn("private model detail", str(raised.exception))

    def test_greedy_collapse_merges_repeated_frames_but_keeps_blank_separated_letters(self):
        words = _decode_greedy_frames(
            [2, 2, 0, 2, 1, 3], ("-", "|", "A", "B"), duration_ms=6000
        )
        self.assertEqual([(word.text, word.start_ms, word.end_ms) for word in words], [
            ("AA", 0, 4000), ("B", 5000, 6000),
        ])

    def test_unique_two_word_run_emits_only_provisional_id_and_advances(self):
        follower = GuideFollower(supplied("hello", "there", "friend"))
        event = follower.observe_decoded(decoded("hello", "there"), source_epoch="song-a", window_start_ms=1000)

        self.assertEqual(event["status"], "provisional")
        self.assertEqual(event["wordId"], "word-1")
        self.assertEqual(event["wordIndex"], 1)
        self.assertEqual(event["approximateSourceStartMs"], 1300)
        self.assertEqual(event["approximateSourceEndMs"], 1600)
        self.assertEqual(event["matchedRunStartMs"], 1000)
        self.assertEqual(event["matchedRunEndMs"], 1600)
        self.assertTrue(event["cursorAdvanced"])
        self.assertFalse(event["calibrated"])
        self.assertFalse(event["scoreMutation"])
        self.assertFalse(any("text" in key.lower() or "transcript" in key.lower() for key in event))
        self.assertEqual(follower.cursor, 2)

    def test_single_word_or_nonmatching_audio_never_advances(self):
        follower = GuideFollower(supplied("hello", "there"))
        for observation in (decoded("hello"), decoded("music", "noise"), []):
            event = follower.observe_decoded(observation, source_epoch="song-a", window_start_ms=1000)
            self.assertEqual(event["status"], "unsupported")
            self.assertEqual(follower.cursor, 0)

    def test_repeated_lyric_run_is_ambiguous_and_does_not_advance(self):
        follower = GuideFollower(supplied("go", "now", "go", "now"))
        event = follower.observe_decoded(decoded("go", "now"), source_epoch="song-a", window_start_ms=0)
        self.assertEqual(event["reason"], "ambiguous-repeated-lyrics")
        self.assertEqual(follower.cursor, 0)

    def test_repeated_observation_inside_one_window_is_also_ambiguous(self):
        follower = GuideFollower(supplied("one", "two"))
        event = follower.observe_decoded(decoded("one", "two", "one", "two"), source_epoch="song-a", window_start_ms=0)
        self.assertEqual(event["reason"], "ambiguous-repeated-lyrics")
        self.assertEqual(follower.cursor, 0)

    def test_large_lyric_cursor_jump_is_unsupported(self):
        follower = GuideFollower(supplied("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"))
        event = follower.observe_decoded(decoded("nine", "ten"), source_epoch="song-a", window_start_ms=0)
        self.assertEqual(event["reason"], "lyric-cursor-jump-too-large")
        self.assertEqual(follower.cursor, 0)

    def test_source_epoch_change_resets_and_discards_window_that_detected_it(self):
        follower = GuideFollower(supplied("one", "two", "three"))
        first = follower.observe_decoded(decoded("one", "two"), source_epoch="song-a", window_start_ms=1000)
        self.assertEqual(first["status"], "provisional")

        reset = follower.observe_decoded(decoded("two", "three"), source_epoch="song-b", window_start_ms=0)
        self.assertEqual(reset["status"], "unsupported")
        self.assertEqual(reset["resetReason"], "source-epoch-changed")
        self.assertEqual(follower.cursor, 0)

        fresh = follower.observe_decoded(decoded("one", "two"), source_epoch="song-b", window_start_ms=500)
        self.assertEqual(fresh["status"], "provisional")

    def test_seek_and_backward_source_clock_each_reset_without_reusing_old_decode(self):
        for trigger in ("seek", "backward"):
            follower = GuideFollower(supplied("one", "two", "three"))
            follower.observe_decoded(decoded("one", "two"), source_epoch=1, window_start_ms=1000)
            if trigger == "seek":
                event = follower.observe_decoded(decoded("two", "three"), source_epoch=1, window_start_ms=1200, seeking=True)
            else:
                event = follower.observe_decoded(decoded("two", "three"), source_epoch=1, window_start_ms=500)
            self.assertEqual(event["status"], "unsupported")
            self.assertEqual(event["resetReason"], "seek-or-backward-clock")
            self.assertEqual(follower.cursor, 0)

    def test_duplicate_window_is_rejected(self):
        follower = GuideFollower(supplied("one", "two"))
        self.assertEqual(follower.observe_decoded(decoded("one", "two"), source_epoch=1, window_start_ms=0)["status"], "provisional")
        duplicate = follower.observe_decoded(decoded("one", "two"), source_epoch=1, window_start_ms=0)
        self.assertEqual(duplicate["reason"], "stale-or-duplicate-window")
        self.assertEqual(follower.cursor, 2)

    def test_malformed_lyric_sequence_and_clock_are_rejected(self):
        for lyrics in ([], [{"id": "x", "text": ""}], [{"id": "x", "text": "one"}, {"id": "x", "text": "two"}]):
            with self.assertRaises(GuideFollowerError):
                GuideFollower(lyrics)
        follower = GuideFollower(supplied("one", "two"))
        with self.assertRaises(GuideFollowerError):
            follower.observe_decoded([], source_epoch=True, window_start_ms=0)
        with self.assertRaises(GuideFollowerError):
            follower.observe_decoded([], source_epoch=1, window_start_ms=-1)


if __name__ == "__main__":
    unittest.main()
