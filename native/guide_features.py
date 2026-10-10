"""Bounded DSP features for a live guide-vocal timeline.

This module consumes only caller-supplied mono PCM16LE chunks. It retains a
short ring of numeric features, never raw audio. Spectrum, spectral flux and
energy continuity are acoustic cues; none of them identifies a syllable,
phoneme, word, singer or source-media position.
"""

from __future__ import annotations

from collections import deque
import math
from typing import Any

import numpy as np


SAMPLE_RATE_HZ = 16_000
FFT_SIZE = 512                 # 32 ms analysis window at 16 kHz
FRAME_HOP_SAMPLES = 160        # 10 ms feature cadence
MAX_CHUNK_SAMPLES = 3_200      # 200 ms input bound
HISTORY_SECONDS = 8
SPECTRUM_BANDS = 32
MIN_ACTIVE_RMS = 0.025
ONSET_SCORE_THRESHOLD = 0.18
ONSET_REFRACTORY_SAMPLES = SAMPLE_RATE_HZ // 12  # 83 ms
MAX_SAFE_SAMPLE = 2**53 - 1

_BAND_EDGES_HZ = np.geomspace(80.0, 7_600.0, SPECTRUM_BANDS + 1)
_BAND_EDGES_BIN = np.clip(np.floor(_BAND_EDGES_HZ * FFT_SIZE / SAMPLE_RATE_HZ).astype(int), 1, FFT_SIZE // 2 + 1)
_HANN = np.hanning(FFT_SIZE).astype(np.float64)
_WINDOW_POWER = float(np.sum(_HANN * _HANN))
_HISTORY_FRAMES = HISTORY_SECONDS * SAMPLE_RATE_HZ // FRAME_HOP_SAMPLES


class GuideFeatureError(ValueError):
    """Invalid or discontinuous guide-audio feature input with a stable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _safe_sample(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_SAMPLE


class GuideFeatureStream:
    """Convert bounded PCM16LE chunks into timestamped numeric guide features.

    Call ``push_pcm16`` for contiguous capture chunks and pass its new frames
    to a UI. ``snapshot`` returns at most eight seconds of derived feature
    frames. The time origin is the caller's guide-capture sample clock; mapping
    that clock to a playing video is a separate, explicitly uncertain step.
    """

    sample_rate_hz = SAMPLE_RATE_HZ
    frame_hop_samples = FRAME_HOP_SAMPLES
    fft_size = FFT_SIZE
    band_edges_hz = tuple(float(value) for value in _BAND_EDGES_HZ)
    spectrum_bands = SPECTRUM_BANDS
    history_seconds = HISTORY_SECONDS

    def __init__(self) -> None:
        self._frames: deque[dict[str, Any]] = deque(maxlen=_HISTORY_FRAMES)
        self._pending = np.empty(0, dtype=np.float64)
        self._pending_start_sample: int | None = None
        self._next_input_sample: int | None = None
        self._previous_spectrum = np.zeros(SPECTRUM_BANDS, dtype=np.float64)
        self._previous_rms = 0.0
        self._active_samples = 0
        self._last_onset_sample: int | None = None

    def reset(self, next_sample: int = 0) -> None:
        """Clear all feature and overlap state at a capture discontinuity."""
        if not _safe_sample(next_sample):
            raise GuideFeatureError("INVALID_SAMPLE_INDEX", "next_sample must be a nonnegative safe integer.")
        self._frames.clear()
        self._pending = np.empty(0, dtype=np.float64)
        self._pending_start_sample = None
        self._next_input_sample = next_sample
        self._previous_spectrum.fill(0.0)
        self._previous_rms = 0.0
        self._active_samples = 0
        self._last_onset_sample = None

    def push_pcm16(self, chunk: bytes | bytearray | memoryview, start_sample: int | None = None) -> dict[str, Any]:
        """Consume one contiguous little-endian signed mono PCM16 chunk.

        Chunk length is capped at 200 ms. The returned ``frames`` are new
        10 ms feature frames, each timestamped by its center sample and guide
        capture time. No source-media timestamp is inferred here.
        """
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise GuideFeatureError("INVALID_PCM", "PCM input must be bytes-like PCM16LE data.")
        view = memoryview(chunk)
        if not view.contiguous or view.nbytes == 0 or view.nbytes % 2:
            raise GuideFeatureError("INVALID_PCM", "PCM input must be contiguous bytes with a nonempty even length.")
        sample_count = view.nbytes // 2
        if sample_count > MAX_CHUNK_SAMPLES:
            raise GuideFeatureError("CHUNK_TOO_LARGE", "PCM input exceeds the 200 ms chunk limit.")
        if start_sample is not None and not _safe_sample(start_sample):
            raise GuideFeatureError("INVALID_SAMPLE_INDEX", "start_sample must be a nonnegative safe integer.")
        if start_sample is None:
            start_sample = self._next_input_sample if self._next_input_sample is not None else 0
        if self._next_input_sample is not None and start_sample != self._next_input_sample:
            raise GuideFeatureError("NON_CONTIGUOUS_INPUT", "PCM chunks must be contiguous; reset at a capture discontinuity.")
        if start_sample + sample_count > MAX_SAFE_SAMPLE:
            raise GuideFeatureError("INVALID_SAMPLE_INDEX", "PCM sample clock exceeds its safe integer range.")

        samples_i16 = np.frombuffer(view, dtype="<i2")
        samples = samples_i16.astype(np.float64) / 32768.0
        if self._pending_start_sample is None:
            self._pending_start_sample = start_sample
        self._pending = np.concatenate((self._pending, samples))
        self._next_input_sample = start_sample + sample_count

        frames: list[dict[str, Any]] = []
        while self._pending.size >= FFT_SIZE:
            frame = self._make_frame(self._pending[:FFT_SIZE], self._pending_start_sample)
            frames.append(frame)
            self._frames.append(frame)
            self._pending = self._pending[FRAME_HOP_SAMPLES:]
            self._pending_start_sample += FRAME_HOP_SAMPLES

        return {
            "sampleRateHz": SAMPLE_RATE_HZ,
            "frameHopSamples": FRAME_HOP_SAMPLES,
            "spectrumBands": SPECTRUM_BANDS,
            "bandEdgesHz": list(self.band_edges_hz),
            "historySeconds": HISTORY_SECONDS,
            "frames": [self._copy_frame(frame) for frame in frames],
            "bufferedFrameCount": len(self._frames),
        }

    def snapshot(self, after_sample: int | None = None) -> dict[str, Any]:
        """Return a detached, bounded view of derived feature history."""
        if after_sample is not None and not _safe_sample(after_sample):
            raise GuideFeatureError("INVALID_SAMPLE_INDEX", "after_sample must be a nonnegative safe integer.")
        frames = [frame for frame in self._frames if after_sample is None or frame["centerSample"] >= after_sample]
        return {
            "sampleRateHz": SAMPLE_RATE_HZ,
            "fftSize": FFT_SIZE,
            "frameHopSamples": FRAME_HOP_SAMPLES,
            "spectrumBands": SPECTRUM_BANDS,
            "bandEdgesHz": list(self.band_edges_hz),
            "historySeconds": HISTORY_SECONDS,
            "frames": [self._copy_frame(frame) for frame in frames],
        }

    def _make_frame(self, samples: np.ndarray, frame_start_sample: int) -> dict[str, Any]:
        rms = float(np.sqrt(np.mean(samples * samples)))
        magnitudes = np.abs(np.fft.rfft(samples * _HANN))
        powers = magnitudes * magnitudes / _WINDOW_POWER
        band_values = np.empty(SPECTRUM_BANDS, dtype=np.float64)
        for index, (low, high) in enumerate(zip(_BAND_EDGES_BIN[:-1], _BAND_EDGES_BIN[1:], strict=True)):
            band_power = float(np.mean(powers[low:high])) if high > low else 0.0
            decibels = 10.0 * math.log10(max(band_power, 1e-12))
            band_values[index] = min(1.0, max(0.0, (decibels + 80.0) / 80.0))

        positive_flux = float(np.mean(np.maximum(band_values - self._previous_spectrum, 0.0)))
        rms_rise = max(0.0, rms - self._previous_rms)
        onset_score = min(1.0, max(0.0, 4.0 * positive_flux + 1.5 * rms_rise))
        center_sample = frame_start_sample + FFT_SIZE // 2
        refractory = self._last_onset_sample is not None and center_sample - self._last_onset_sample < ONSET_REFRACTORY_SAMPLES
        activity_rising = self._previous_rms < MIN_ACTIVE_RMS <= rms
        onset_detected = activity_rising and onset_score >= ONSET_SCORE_THRESHOLD and not refractory
        if onset_detected:
            self._last_onset_sample = center_sample

        if rms >= MIN_ACTIVE_RMS:
            self._active_samples += FRAME_HOP_SAMPLES
        else:
            self._active_samples = 0
        self._previous_spectrum = band_values
        self._previous_rms = rms

        return {
            "centerSample": center_sample,
            "timeMs": round(center_sample * 1000.0 / SAMPLE_RATE_HZ, 3),
            "spectrum": [round(float(value), 4) for value in band_values],
            "rms": round(rms, 5),
            "onsetScore": round(onset_score, 5),
            "onsetDetected": bool(onset_detected),
            "activeEnergyMs": self._active_samples * 1000 // SAMPLE_RATE_HZ,
        }

    @staticmethod
    def _copy_frame(frame: dict[str, Any]) -> dict[str, Any]:
        return {**frame, "spectrum": list(frame["spectrum"])}


__all__ = [
    "GuideFeatureError",
    "GuideFeatureStream",
    "SAMPLE_RATE_HZ",
    "FFT_SIZE",
    "FRAME_HOP_SAMPLES",
    "MAX_CHUNK_SAMPLES",
    "HISTORY_SECONDS",
    "SPECTRUM_BANDS",
]
