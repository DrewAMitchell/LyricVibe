import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native import review_package


class NativeReviewPackageTests(unittest.TestCase):
    def test_peak_reduction_uses_100ms_buckets_and_normalizes_signed_pcm(self):
        samples = [0] * review_package.SAMPLES_PER_BUCKET
        samples[17] = -32768
        samples += [0] * (review_package.SAMPLES_PER_BUCKET - 1) + [16384]
        pcm = struct.pack("<" + "h" * len(samples), *samples)

        self.assertEqual(review_package._peaks_from_pcm(pcm), [1.0, 0.5])

    def test_peak_count_matches_probed_media_duration(self):
        self.assertEqual(review_package._fit_peaks_to_duration([0.2, 0.3], 101), [0.2, 0.3])
        self.assertEqual(review_package._fit_peaks_to_duration([0.2, 0.3, 0.4], 101), [0.2, 0.3])
        self.assertEqual(review_package._fit_peaks_to_duration([0.2], 250), [0.2, 0.0, 0.0])

    def test_launcher_has_local_base_and_escaped_inert_seed_before_deferred_scripts(self):
        package = {"version": review_package.PACKAGE_VERSION, "lyric": "</script>&\u2028"}
        with tempfile.TemporaryDirectory() as temp:
            media = Path(temp) / "song #1.mp4"
            media.write_bytes(b"fixture")
            html = review_package.build_launcher_html(package, media)

        seed_index = html.index('id="local-review-seed"')
        first_deferred_index = html.index('src="score-core.js" defer')
        self.assertLess(html.index("<base href=\"file:///"), seed_index)
        self.assertLess(seed_index, first_deferred_index)
        self.assertIn("\\u003c/script\\u003e\\u0026\\u2028", html)
        self.assertIn('"mediaUrl":"file:///', html)
        self.assertEqual(html.count('id="local-review-seed"'), 1)

    def test_build_binds_exact_media_hash_and_emits_bounded_waveform_without_audio_file(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            score_path = folder / "score.json"
            receipt_path = folder / "receipt.json"
            media_path = folder / "song.mp4"
            score_path.write_text("{}", encoding="utf-8")
            receipt_path.write_text("{}", encoding="utf-8")
            media_path.write_bytes(b"original media fixture")
            pcm = struct.pack("<" + "h" * review_package.SAMPLES_PER_BUCKET, *([32767] * review_package.SAMPLES_PER_BUCKET))
            with patch.object(review_package, "_validate_score_and_receipt"), \
                 patch.object(review_package, "_resolve_tool", side_effect=lambda explicit, name: name), \
                 patch.object(review_package, "_probe_duration_ms", return_value=100), \
                 patch.object(review_package, "_decode_bounded_pcm", return_value=pcm):
                package = review_package.build_review_package(score_path, receipt_path, media_path, ffmpeg_path="ffmpeg", ffprobe_path="ffprobe")

            import hashlib
            self.assertEqual(package["version"], "lyricvibe.review.v1")
            self.assertEqual(package["audio"]["sizeBytes"], len(b"original media fixture"))
            self.assertEqual(package["audio"]["sha256"], hashlib.sha256(b"original media fixture").hexdigest())
            self.assertEqual(package["waveform"], {"sampleRate": 8000, "bucketMs": 100, "peaks": [32767 / 32768]})
            self.assertEqual(sorted(path.name for path in folder.iterdir()), ["receipt.json", "score.json", "song.mp4"])

    def test_writer_rejects_output_that_would_replace_media(self):
        with tempfile.TemporaryDirectory() as temp:
            media = Path(temp) / "song.mp4"
            media.write_bytes(b"fixture")
            package = {"version": review_package.PACKAGE_VERSION}
            with self.assertRaises(review_package.ReviewPackageError) as caught:
                review_package.write_review_package(package, media, media_path=media)
        self.assertEqual(caught.exception.code, "OUTPUT_COLLISION")

    def test_package_size_is_bounded(self):
        with self.assertRaises(review_package.ReviewPackageError) as caught:
            review_package._bounded_package_json({"content": "x" * review_package.MAX_PACKAGE_BYTES})
        self.assertEqual(caught.exception.code, "PACKAGE_TOO_LARGE")


if __name__ == "__main__":
    unittest.main()
