"""Small additive click cues for local guide playback, with no audio retention."""
from __future__ import annotations

from array import array
import math
import queue
import sys
from typing import Iterable

SAMPLE_RATE_HZ = 16_000
CLICK_FREQUENCY_HZ = 1_200
CLICK_AMPLITUDE = 5_000
CLICK_FRAMES = 480  # 30 ms at 16 kHz
MAX_QUEUED_CLICKS = 512
_CLICK = tuple(
    round(CLICK_AMPLITUDE * math.sin(2 * math.pi * CLICK_FREQUENCY_HZ * step / SAMPLE_RATE_HZ)
          * (1 - step / CLICK_FRAMES))
    for step in range(CLICK_FRAMES)
)


def _to_samples(pcm_s16le: bytes) -> array:
    if not isinstance(pcm_s16le, bytes) or len(pcm_s16le) % 2:
        raise ValueError("PCM must contain whole signed 16-bit little-endian samples.")
    samples = array("h")
    samples.frombytes(pcm_s16le)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _from_samples(samples: array) -> bytes:
    if sys.byteorder == "little":
        return samples.tobytes()
    copy = array("h", samples)
    copy.byteswap()
    return copy.tobytes()


def _mix_clicks(pcm_s16le: bytes, first_frame: int, tap_frames: Iterable[int]) -> bytes:
    samples = _to_samples(pcm_s16le)
    block_end = first_frame + len(samples)
    for tap_frame in tap_frames:
        if tap_frame >= block_end or tap_frame + CLICK_FRAMES <= first_frame:
            continue
        first_step = max(0, first_frame - tap_frame)
        last_step = min(CLICK_FRAMES, block_end - tap_frame)
        for step in range(first_step, last_step):
            index = tap_frame + step - first_frame
            samples[index] = max(-32768, min(32767, samples[index] + _CLICK[step]))
    return _from_samples(samples)


def add_tap_clicks(
    pcm: bytes,
    start_ms: int | float,
    tap_times: Iterable[int | float],
    *,
    sample_rate_hz: int = SAMPLE_RATE_HZ,
) -> bytes:
    """Return a copy of PCM with short clicks at source-relative tap times."""
    if isinstance(start_ms, bool) or not isinstance(start_ms, (int, float)) or not math.isfinite(start_ms):
        raise ValueError("start_ms must be finite.")
    if isinstance(sample_rate_hz, bool) or not isinstance(sample_rate_hz, int) or sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be a positive integer.")
    frames_per_ms = sample_rate_hz / 1000
    tap_frames = []
    sample_count = len(_to_samples(pcm))
    for tap_time in tap_times:
        if isinstance(tap_time, bool) or not isinstance(tap_time, (int, float)) or not math.isfinite(tap_time):
            raise ValueError("tap times must be finite numbers.")
        frame = round((tap_time - start_ms) * frames_per_ms)
        if 0 <= frame < sample_count:
            tap_frames.append(frame)
    return _mix_clicks(pcm, 0, tap_frames)


class LiveTapClickMixer:
    """Bounded, callback-driven click queue mixed into an existing output stream."""

    def __init__(self, *, max_queued: int = MAX_QUEUED_CLICKS):
        if isinstance(max_queued, bool) or not isinstance(max_queued, int) or max_queued <= 0:
            raise ValueError("max_queued must be a positive integer.")
        self._queue: queue.Queue[tuple[int, int]] = queue.Queue(maxsize=max_queued)
        self._generation = 0
        self._active: list[tuple[int, int]] = []  # callback-thread-owned (generation, frame)

    def schedule(self, output_frame: int) -> bool:
        """Queue one click at an absolute output PCM frame without blocking."""
        if isinstance(output_frame, bool) or not isinstance(output_frame, int) or output_frame < 0:
            return False
        try:
            self._queue.put_nowait((self._generation, output_frame))
            return True
        except queue.Full:
            return False

    def clear(self) -> None:
        """Invalidate pending and in-progress clicks at a trial boundary."""
        self._generation += 1
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

    def mix(self, pcm_s16le: bytes, first_frame: int) -> bytes:
        """Mix clicks intersecting this callback block; input PCM is never mutated."""
        if isinstance(first_frame, bool) or not isinstance(first_frame, int) or first_frame < 0:
            raise ValueError("first_frame must be a nonnegative integer.")
        if not isinstance(pcm_s16le, bytes) or len(pcm_s16le) % 2:
            raise ValueError("PCM must contain whole signed 16-bit little-endian samples.")
        block_end = first_frame + len(pcm_s16le) // 2
        generation = self._generation
        active = [event for event in self._active if event[0] == generation]
        self._active = active
        while True:
            try:
                event_generation, tap_frame = self._queue.get_nowait()
            except queue.Empty:
                break
            if event_generation == generation:
                active.append((event_generation, tap_frame))

        audible = []
        pending = []
        for event_generation, tap_frame in active:
            if tap_frame + CLICK_FRAMES <= first_frame:
                continue
            if tap_frame >= block_end:
                pending.append((event_generation, tap_frame))
                continue
            audible.append(tap_frame)
            if tap_frame + CLICK_FRAMES > block_end:
                pending.append((event_generation, tap_frame))
        self._active = pending
        return _mix_clicks(pcm_s16le, first_frame, audible) if audible else pcm_s16le
