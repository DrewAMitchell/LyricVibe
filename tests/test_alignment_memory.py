import struct
import unittest
from types import SimpleNamespace

from native.alignment import MAX_PCM_ALIGNMENT_SECONDS, _load_pcm_samples


class _Waveform:
    def __init__(self, values, dimensions=1):
        self.values = values
        self.ndim = dimensions
        self.shape = (len(values),) if dimensions == 1 else (1, len(values))

    def to(self, dtype):
        return self

    def div_(self, divisor):
        self.values = [value / divisor for value in self.values]
        return self

    def unsqueeze(self, dimension):
        assert dimension == 0
        return _Waveform(self.values, dimensions=2)


class _Torch:
    int16 = object()
    float32 = object()

    def __init__(self):
        self.frombuffer_calls = 0

    def frombuffer(self, buffer, dtype):
        self.frombuffer_calls += 1
        values = struct.unpack(f"<{len(buffer) // 2}h", buffer)
        return _Waveform(list(values))


class NativeMemoryAlignmentInputTests(unittest.TestCase):
    def setUp(self):
        self.torch = _Torch()
        self.torchaudio = SimpleNamespace(functional=SimpleNamespace())

    def test_s16le_samples_are_normalized_to_mono_float_waveform(self):
        pcm = struct.pack("<3h", -32768, 0, 32767)

        waveform, sample_rate = _load_pcm_samples(pcm, 16000, self.torch, self.torchaudio)

        self.assertEqual(sample_rate, 16000)
        self.assertEqual(waveform.shape, (1, 3))
        self.assertEqual(waveform.values, [-1.0, 0.0, 32767 / 32768])

    def test_invalid_or_oversized_pcm_fails_before_buffer_decode(self):
        with self.assertRaisesRegex(ValueError, "non-empty bytes"):
            _load_pcm_samples(b"", 16000, self.torch, self.torchaudio)
        with self.assertRaisesRegex(ValueError, "whole number of samples"):
            _load_pcm_samples(b"\x00", 16000, self.torch, self.torchaudio)
        with self.assertRaisesRegex(ValueError, "positive integer"):
            _load_pcm_samples(b"\x00\x00", 0, self.torch, self.torchaudio)
        too_long = b"\x00\x00" * (MAX_PCM_ALIGNMENT_SECONDS * 16000 + 1)
        with self.assertRaisesRegex(ValueError, "12-second"):
            _load_pcm_samples(too_long, 16000, self.torch, self.torchaudio)
        self.assertEqual(self.torch.frombuffer_calls, 0)


if __name__ == "__main__":
    unittest.main()
