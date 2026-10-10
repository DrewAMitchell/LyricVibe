import math
import unittest

import numpy as np

from native.guide_features import (
    FFT_SIZE,
    FRAME_HOP_SAMPLES,
    HISTORY_SECONDS,
    MAX_CHUNK_SAMPLES,
    SAMPLE_RATE_HZ,
    SPECTRUM_BANDS,
    GuideFeatureError,
    GuideFeatureStream,
)


def pcm16(samples: np.ndarray) -> bytes:
    bounded = np.clip(samples, -1.0, 32767 / 32768)
    return np.round(bounded * 32768).astype("<i2").tobytes()


def tone(start: int, count: int, frequency: float = 220.0, amplitude: float = 0.35) -> np.ndarray:
    indexes = np.arange(start, start + count, dtype=np.float64)
    return amplitude * np.sin(2 * math.pi * frequency * indexes / SAMPLE_RATE_HZ)


def feed(stream: GuideFeatureStream, samples: np.ndarray, chunk_samples: int = 1_600, start_sample: int = 0):
    frames = []
    for offset in range(0, len(samples), chunk_samples):
        chunk = samples[offset : offset + chunk_samples]
        frames.extend(stream.push_pcm16(pcm16(chunk), start_sample + offset)["frames"])
    return frames


class GuideFeatureTests(unittest.TestCase):
    def test_stream_emits_timestamped_numeric_spectra_and_keeps_capture_clock(self):
        stream = GuideFeatureStream()
        first = feed(stream, tone(0, 3_200), chunk_samples=1_600, start_sample=4_000)

        self.assertTrue(first)
        self.assertEqual(stream.sample_rate_hz, SAMPLE_RATE_HZ)
        self.assertEqual(stream.frame_hop_samples, FRAME_HOP_SAMPLES)
        self.assertEqual(stream.fft_size, FFT_SIZE)
        self.assertEqual(len(stream.snapshot()["bandEdgesHz"]), SPECTRUM_BANDS + 1)
        self.assertEqual(len(first[0]["spectrum"]), SPECTRUM_BANDS)
        self.assertEqual(first[0]["centerSample"], FFT_SIZE // 2 + 4_000)
        self.assertAlmostEqual(first[0]["timeMs"], first[0]["centerSample"] * 1000 / SAMPLE_RATE_HZ, places=3)
        self.assertTrue(all(math.isfinite(value) and 0.0 <= value <= 1.0 for value in first[0]["spectrum"]))
        self.assertNotIn("syllable", first[0])
        self.assertNotIn("word", first[0])

    def test_silence_has_no_onsets_or_active_energy(self):
        frames = feed(GuideFeatureStream(), np.zeros(SAMPLE_RATE_HZ, dtype=np.float64))

        self.assertGreater(len(frames), 80)
        self.assertTrue(all(frame["rms"] == 0 for frame in frames))
        self.assertFalse(any(frame["onsetDetected"] for frame in frames))
        self.assertTrue(all(frame["activeEnergyMs"] == 0 for frame in frames))
        self.assertTrue(all(all(value == 0 for value in frame["spectrum"]) for frame in frames))

    def test_held_vowel_does_not_create_repeated_onsets_and_energy_continues(self):
        frames = feed(GuideFeatureStream(), tone(0, int(0.9 * SAMPLE_RATE_HZ)))
        onset_frames = [frame for frame in frames if frame["onsetDetected"]]

        self.assertLessEqual(len(onset_frames), 1)
        self.assertGreater(max(frame["activeEnergyMs"] for frame in frames), 700)

    def test_separated_bursts_create_distinct_onsets(self):
        burst = int(0.20 * SAMPLE_RATE_HZ)
        gap = int(0.25 * SAMPLE_RATE_HZ)
        samples = np.concatenate((tone(0, burst, 440.0), np.zeros(gap), tone(burst + gap, burst, 440.0)))
        frames = feed(GuideFeatureStream(), samples, chunk_samples=800)
        onsets = [frame for frame in frames if frame["onsetDetected"]]

        self.assertEqual(len(onsets), 2)
        self.assertGreater(onsets[1]["centerSample"] - onsets[0]["centerSample"], int(0.35 * SAMPLE_RATE_HZ))

    def test_chunk_cap_continuity_validation_and_reset(self):
        stream = GuideFeatureStream()
        valid = pcm16(np.zeros(1_600))
        stream.push_pcm16(valid, start_sample=100)

        with self.assertRaises(GuideFeatureError) as too_large:
            stream.push_pcm16(pcm16(np.zeros(MAX_CHUNK_SAMPLES + 1)), start_sample=1_700)
        self.assertEqual(too_large.exception.code, "CHUNK_TOO_LARGE")

        with self.assertRaises(GuideFeatureError) as discontinuity:
            stream.push_pcm16(valid, start_sample=2_000)
        self.assertEqual(discontinuity.exception.code, "NON_CONTIGUOUS_INPUT")

        with self.assertRaises(GuideFeatureError) as malformed:
            stream.push_pcm16(b"\x00")
        self.assertEqual(malformed.exception.code, "INVALID_PCM")

        stream.reset(next_sample=9_000)
        self.assertEqual(stream.snapshot()["frames"], [])
        restarted = stream.push_pcm16(pcm16(tone(9_000, 1_600)), start_sample=9_000)["frames"]
        self.assertTrue(restarted)
        self.assertEqual(restarted[0]["centerSample"], 9_000 + FFT_SIZE // 2)
        self.assertTrue(any(frame["onsetDetected"] for frame in restarted))

    def test_feature_ring_is_bounded_and_snapshot_is_detached(self):
        stream = GuideFeatureStream()
        frames = feed(stream, np.zeros((HISTORY_SECONDS + 2) * SAMPLE_RATE_HZ, dtype=np.float64))
        snapshot = stream.snapshot()

        self.assertGreater(len(frames), 800)
        self.assertEqual(len(snapshot["frames"]), HISTORY_SECONDS * SAMPLE_RATE_HZ // FRAME_HOP_SAMPLES)
        self.assertEqual(snapshot["frames"][0]["centerSample"], frames[-len(snapshot["frames"])]["centerSample"])
        snapshot["frames"][0]["spectrum"][0] = 1.0
        self.assertEqual(stream.snapshot()["frames"][0]["spectrum"][0], 0.0)


if __name__ == "__main__":
    unittest.main()
