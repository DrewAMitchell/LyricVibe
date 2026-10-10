import hashlib
import tempfile
import unittest
import wave
from pathlib import Path

from native.audio_input import (
    MAX_AUDIO_FILE_BYTES,
    AudioInputError,
    validate_audio_input,
)


def _write_wav(path: Path, *, channels=1, sample_rate=16_000, sample_width=2, seconds=1):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\0" * channels * sample_width * sample_rate * seconds)


class AudioInputValidationTests(unittest.TestCase):
    def test_accepts_pcm_wav_and_returns_metadata_without_modifying_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "selected.wav"
            _write_wav(source, channels=2, sample_rate=48_000, sample_width=2, seconds=2)
            before = hashlib.sha256(source.read_bytes()).digest()

            audio = validate_audio_input(source)

            self.assertEqual(audio.path, source.resolve())
            self.assertEqual(audio.duration_seconds, 2)
            self.assertEqual(audio.sample_rate, 48_000)
            self.assertEqual(audio.channels, 2)
            self.assertEqual(audio.sample_width_bytes, 2)
            self.assertEqual(audio.sample_format, "pcm_s16le")
            self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
            self.assertEqual(list(Path(temporary).iterdir()), [source])

    def test_rejects_audio_longer_than_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "long.wav"
            _write_wav(source, sample_rate=8_000, seconds=61)

            with self.assertRaises(AudioInputError) as caught:
                validate_audio_input(source)

            self.assertEqual(caught.exception.code, "AUDIO_TOO_LONG")

    def test_allows_a_stricter_per_run_duration_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.wav"
            _write_wav(source, seconds=3)

            with self.assertRaises(AudioInputError) as caught:
                validate_audio_input(source, max_duration_seconds=2)

            self.assertEqual(caught.exception.code, "AUDIO_TOO_LONG")

    def test_rejects_non_pcm_wav(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "compressed.wav"
            _write_wav(source)
            contents = bytearray(source.read_bytes())
            # WAVE fmt's format tag: 1 is integer PCM; 3 is IEEE float.
            contents[20:22] = (3).to_bytes(2, "little")
            source.write_bytes(contents)

            with self.assertRaises(AudioInputError) as caught:
                validate_audio_input(source)

            self.assertEqual(caught.exception.code, "INVALID_PCM_WAV")

    def test_rejects_empty_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            empty = Path(temporary) / "empty.wav"
            _write_wav(empty, seconds=0)
            with self.assertRaises(AudioInputError) as empty_error:
                validate_audio_input(empty)
            self.assertEqual(empty_error.exception.code, "EMPTY_AUDIO")

            oversized = Path(temporary) / "oversized.wav"
            with oversized.open("wb") as stream:
                stream.truncate(MAX_AUDIO_FILE_BYTES + 1)
            with self.assertRaises(AudioInputError) as size_error:
                validate_audio_input(oversized)
            self.assertEqual(size_error.exception.code, "AUDIO_FILE_TOO_LARGE")

    def test_rejects_nonexistent_and_invalid_duration_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(AudioInputError) as missing:
                validate_audio_input(Path(temporary) / "missing.wav")
            self.assertEqual(missing.exception.code, "AUDIO_FILE_NOT_FOUND")

            source = Path(temporary) / "valid.wav"
            _write_wav(source)
            with self.assertRaises(AudioInputError) as limit_error:
                validate_audio_input(source, max_duration_seconds=61)
            self.assertEqual(limit_error.exception.code, "INVALID_DURATION_LIMIT")


if __name__ == "__main__":
    unittest.main()
