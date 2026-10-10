"""Bounded, local-only output transport for the native timeline."""
from __future__ import annotations

import math
from copy import deepcopy
from pathlib import Path
import threading
import time
from typing import Any, Callable

RATE = 16_000
MAX_CLIP_SECONDS = 12


def _load_bound_package(package_path: Path, media_path: Path) -> dict[str, Any]:
    from .guide_viewer import load_bound_package
    return load_bound_package(package_path, media_path)


def _decode_audition(media_path: Path, start_ms: float, stop: threading.Event,
                     duration_seconds: int) -> bytes:
    from .guide_review import decode_audition
    return decode_audition(media_path, start_ms, stop, duration_seconds)


class TimelineAudio:
    """Nonblocking playback bound to one review package and its exact media.

    Poll this object from the UI thread. It never imports Tk or captures input.
    FFmpeg decoding is delegated to ``decode_audition`` which owns and reaps its
    bounded child process; output is sent directly to the selected audio device.
    """

    def __init__(self, package_path: str | Path, media_path: str | Path, *,
                 expected_package: dict[str, Any] | None = None,
                 package_loader: Callable | None = None,
                 decoder: Callable | None = None,
                 output_stream_factory: Callable | None = None,
                 callback_stop: type[BaseException] | None = None,
                 callback_abort: type[BaseException] | None = None,
                 monotonic: Callable[[], float] = time.monotonic):
        self.package_path = Path(package_path).expanduser().resolve()
        self.media_path = Path(media_path).expanduser().resolve()
        self._expected_package = deepcopy(expected_package) if expected_package is not None else None
        self._package_loader = package_loader or _load_bound_package
        self._decoder = decoder or _decode_audition
        self._output_stream_factory = output_stream_factory
        self._callback_stop = callback_stop
        self._callback_abort = callback_abort
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._epoch = 0
        self._stop_event: threading.Event | None = None
        self._worker: threading.Thread | None = None
        self._closed = False
        self._state = 'stopped'
        self._position_ms: float | None = None
        self._error: str | None = None
        self._start_ms = 0.0
        self._end_ms = 0.0
        self._clock_anchor_frame: int | None = None
        self._clock_anchor_monotonic: float | None = None
        self._queued_frame = 0

    @property
    def busy(self) -> bool:
        worker = self._worker
        return worker is not None and worker.is_alive()

    def play(self, start_ms: float, duration_seconds: int = 12) -> bool:
        if (isinstance(start_ms, bool) or not isinstance(start_ms, (int, float))
                or not math.isfinite(start_ms) or start_ms < 0):
            raise ValueError('Playback start must be a finite, nonnegative source time.')
        if duration_seconds not in (3, 12):
            raise ValueError('Timeline playback must be 3 or 12 seconds.')
        with self._lock:
            if self._closed or (self._worker is not None and self._worker.is_alive()):
                return False
            self._epoch += 1
            epoch = self._epoch
            stop_event = threading.Event()
            self._stop_event = stop_event
            self._state = 'preparing'
            self._position_ms = float(start_ms)
            self._start_ms = float(start_ms)
            self._end_ms = float(start_ms)
            self._error = None
            self._clock_anchor_frame = None
            self._clock_anchor_monotonic = None
            self._queued_frame = 0
            worker = threading.Thread(
                target=self._run, args=(epoch, stop_event, float(start_ms), duration_seconds),
                name='lyricvibe-timeline-audio', daemon=False,
            )
            self._worker = worker
            worker.start()
            return True

    def stop(self) -> None:
        with self._lock:
            current = self._current_position_locked(self._monotonic())
            if current is not None:
                self._position_ms = current
            self._epoch += 1
            if self._stop_event is not None:
                self._stop_event.set()
            self._clock_anchor_frame = None
            self._clock_anchor_monotonic = None
            self._state = 'stopped'
            self._error = None

    def poll(self) -> dict[str, Any]:
        with self._lock:
            position = self._current_position_locked(self._monotonic())
            if position is not None:
                self._position_ms = position
            return {'state': self._state, 'positionMs': self._position_ms, 'error': self._error}

    def close(self) -> bool:
        with self._lock:
            self._closed = True
        self.stop()
        worker = self._worker
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=0)
        return not self.busy

    def _current_position_locked(self, now: float) -> float | None:
        if self._state != 'playing' or self._clock_anchor_frame is None or self._clock_anchor_monotonic is None:
            return self._position_ms
        frame = self._clock_anchor_frame + round((now - self._clock_anchor_monotonic) * RATE)
        frame = max(0, min(frame, self._queued_frame))
        return min(self._end_ms, self._start_ms + frame * 1000 / RATE)

    def _stream_factory(self):
        if self._output_stream_factory is not None:
            return self._output_stream_factory, self._callback_stop, self._callback_abort
        import sounddevice as sd
        return sd.RawOutputStream, sd.CallbackStop, sd.CallbackAbort

    def _set_failed(self, epoch: int, message: str) -> None:
        with self._lock:
            if epoch != self._epoch:
                return
            self._state = 'failed'
            self._error = message

    def _run(self, epoch: int, stop_event: threading.Event, start_ms: float,
             duration_seconds: int) -> None:
        stream = None
        started = False
        try:
            package = self._package_loader(self.package_path, self.media_path)
            if self._expected_package is not None and package != self._expected_package:
                raise ValueError('Review package no longer matches the open editor document.')
            audio = package.get('audio')
            media_duration_ms = audio.get('durationMs') if isinstance(audio, dict) else None
            if (isinstance(media_duration_ms, bool) or not isinstance(media_duration_ms, (int, float))
                    or not math.isfinite(media_duration_ms) or media_duration_ms <= 0
                    or start_ms >= media_duration_ms):
                raise ValueError('Playback start is outside the bound recording.')
            end_ms = min(float(media_duration_ms), start_ms + duration_seconds * 1000)
            with self._lock:
                if epoch != self._epoch or stop_event.is_set():
                    return
                self._end_ms = end_ms

            pcm = self._decoder(self.media_path, start_ms, stop_event, duration_seconds)
            if stop_event.is_set() or not self._is_current(epoch):
                return
            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > duration_seconds * RATE * 2:
                raise ValueError('Bounded decoder returned invalid PCM.')
            max_frames = max(0, math.floor((end_ms - start_ms) * RATE / 1000))
            pcm = pcm[:max_frames * 2]
            if not pcm:
                raise ValueError('Playback has no audio at the selected source time.')
            effective_end_ms = min(end_ms, start_ms + len(pcm) * 1000 / (RATE * 2))
            with self._lock:
                if epoch != self._epoch or stop_event.is_set():
                    return
                self._end_ms = effective_end_ms
            # Recheck the exact package/media binding after decode. If either file
            # changed while FFmpeg read it, discard the decoded audio.
            if self._package_loader(self.package_path, self.media_path) != package:
                raise ValueError('Review package or source recording changed during playback setup.')
            if stop_event.is_set() or not self._is_current(epoch):
                return

            factory, callback_stop, callback_abort = self._stream_factory()
            if callback_stop is None or callback_abort is None:
                raise RuntimeError('Audio output callbacks are unavailable.')
            frame_count = len(pcm) // 2
            finished = threading.Event()
            callback_error: list[str] = []

            def output(outdata, frames, clock, _status):
                nonlocal started
                outdata[:] = bytes(len(outdata))
                with self._lock:
                    if epoch != self._epoch or stop_event.is_set():
                        raise callback_abort
                    first_frame = self._queued_frame
                    chunk = pcm[first_frame * 2:min((first_frame + frames) * 2, len(pcm))]
                    outdata[:len(chunk)] = chunk
                    self._queued_frame = first_frame + len(chunk) // 2
                    dac_time = getattr(clock, 'outputBufferDacTime', None)
                    current_time = getattr(clock, 'currentTime', None)
                    if (isinstance(dac_time, (int, float)) and math.isfinite(dac_time)
                            and isinstance(current_time, (int, float)) and math.isfinite(current_time)):
                        self._clock_anchor_frame = first_frame
                        self._clock_anchor_monotonic = self._monotonic() + max(0.0, dac_time - current_time)
                    else:
                        callback_error.append('Output DAC clock is unavailable.')
                        stop_event.set()
                        finished.set()
                        raise callback_abort
                    if not started:
                        started = True
                        self._state = 'playing'
                    self._position_ms = min(end_ms, start_ms + first_frame * 1000 / RATE)
                if self._queued_frame >= frame_count:
                    raise callback_stop

            stream = factory(samplerate=RATE, channels=1, dtype='int16', blocksize=320,
                             callback=output, finished_callback=finished.set)
            stream.start()
            deadline = self._monotonic() + duration_seconds + 3
            while not finished.wait(.05):
                if stop_event.is_set() or not self._is_current(epoch):
                    stream.abort()
                    break
                if self._monotonic() >= deadline:
                    stop_event.set()
                    stream.abort()
                    raise TimeoutError('Audio output exceeded its playback bound.')
            if callback_error:
                raise RuntimeError(callback_error[0])
            if stop_event.is_set() or not self._is_current(epoch):
                return
            with self._lock:
                if epoch == self._epoch:
                    self._position_ms = effective_end_ms
                    self._state = 'stopped'
                    self._error = None
        except Exception as exc:
            message = ('Audio output is unavailable.' if 'clock' in str(exc).lower()
                       else 'Local playback failed. Check the review package, recording, FFmpeg, and output device.')
            self._set_failed(epoch, message)
        finally:
            if stream is not None:
                try:
                    if stop_event.is_set():
                        stream.abort()
                    elif started:
                        stream.stop()
                except Exception:
                    pass
                try:
                    stream.close()
                except Exception:
                    pass

    def _is_current(self, epoch: int) -> bool:
        with self._lock:
            return epoch == self._epoch
