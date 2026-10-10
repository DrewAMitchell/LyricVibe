"""Explicit, bounded, in-memory microphone capture for guide-vocal experiments.

Importing this module never enumerates or opens an audio device. Capture starts
only through ``GuideCapture.start(..., consent=True)``. PCM is delivered to the
caller in short callbacks and is not retained or written by this adapter.
"""

from __future__ import annotations

import importlib
import math
import sys
import threading
import time
from typing import Any, Callable


SAMPLE_RATE_HZ = 16_000
CHANNELS = 1
DTYPE = "int16"
BLOCK_SIZE_FRAMES = 320  # 20 ms at 16 kHz
MAX_CALLBACK_FRAMES = 2_048
DEFAULT_MAX_CAPTURE_SECONDS = 300
MAX_CAPTURE_SECONDS = 600
PCM_BYTES_PER_FRAME = CHANNELS * 2


class GuideCaptureError(RuntimeError):
    """Typed, content-free microphone capability error."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _backend_or_error(backend: Any = None) -> Any:
    if backend is not None:
        return backend
    try:
        return importlib.import_module("sounddevice")
    except ImportError:
        raise GuideCaptureError(
            "CAPTURE_BACKEND_UNAVAILABLE",
            "Install the optional LyricVibe guide-capture dependencies to use a microphone.",
        ) from None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _list_devices(backend: Any) -> list[dict[str, Any]]:
    try:
        devices = backend.query_devices()
        default_device = backend.default.device[0]
    except Exception:
        raise GuideCaptureError(
            "CAPTURE_DEVICE_ENUMERATION_FAILED",
            "Audio input devices could not be listed.",
        ) from None
    if isinstance(default_device, bool) or not isinstance(default_device, int):
        default_device = None
    result: list[dict[str, Any]] = []
    try:
        for index, device in enumerate(devices):
            if not isinstance(device, dict):
                continue
            channels = device.get("max_input_channels", 0)
            if isinstance(channels, bool) or not isinstance(channels, int) or channels <= 0:
                continue
            default_rate = _finite_number(device.get("default_samplerate"))
            name = device.get("name")
            result.append({
                "index": index,
                "name": name if isinstance(name, str) else f"Input device {index}",
                "channels": channels,
                "defaultRate": default_rate,
                "default": index == default_device,
            })
    except Exception:
        raise GuideCaptureError(
            "CAPTURE_DEVICE_ENUMERATION_FAILED",
            "Audio input device metadata was unavailable.",
        ) from None
    return result


def list_input_devices(*, _backend: Any = None) -> list[dict[str, Any]]:
    """List input-capable devices without opening an input stream."""
    return _list_devices(_backend_or_error(_backend))


class GuideCapture:
    """Deliver bounded 16 kHz mono PCM chunks from one explicitly started mic.

    ``on_chunk`` runs on PortAudio's callback thread and must return quickly;
    GUI callers should enqueue the chunk and schedule UI work on their own
    event loop. The adapter owns no PCM after that callback returns.
    """

    def __init__(self, *, _backend: Any = None):
        self._backend = _backend
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.Lock()
        self._stream: Any = None
        self._on_chunk: Callable[[dict[str, Any]], None] | None = None
        self._state = "idle"
        self._device_index: int | None = None
        self._max_frames = 0
        self._frames_captured = 0
        self._input_overflow_count = 0
        self._start_monotonic: float | None = None
        self._last_error_code: str | None = None

    def start(
        self,
        device: int | None,
        on_chunk: Callable[[dict[str, Any]], None],
        *,
        consent: bool = False,
        max_capture_seconds: float = DEFAULT_MAX_CAPTURE_SECONDS,
    ) -> dict[str, Any]:
        """Open the mic only after explicit caller consent and strict setup checks."""
        if consent is not True:
            raise GuideCaptureError("CAPTURE_CONSENT_REQUIRED", "Explicit microphone consent is required to start capture.")
        if not callable(on_chunk):
            raise GuideCaptureError("CAPTURE_INVALID_ARGUMENT", "A chunk callback is required.")
        if device is not None and (isinstance(device, bool) or not isinstance(device, int) or device < 0):
            raise GuideCaptureError("CAPTURE_INVALID_DEVICE", "Select a valid input device index.")
        duration = _finite_number(max_capture_seconds)
        if duration is None or duration <= 0 or duration > MAX_CAPTURE_SECONDS:
            raise GuideCaptureError("CAPTURE_INVALID_LIMIT", "Capture duration must be between zero and 600 seconds.")

        backend = _backend_or_error(self._backend)
        devices = _list_devices(backend)
        if not devices:
            raise GuideCaptureError("CAPTURE_DEVICE_UNAVAILABLE", "No microphone input device is available.")
        if device is None:
            selected = next((item for item in devices if item["default"]), None)
            if selected is None:
                raise GuideCaptureError("CAPTURE_DEVICE_UNAVAILABLE", "No default microphone input device is available.")
            device = selected["index"]
        selected = next((item for item in devices if item["index"] == device), None)
        if selected is None:
            raise GuideCaptureError("CAPTURE_INVALID_DEVICE", "The selected input device is unavailable.")

        try:
            backend.check_input_settings(device=device, channels=CHANNELS, dtype=DTYPE, samplerate=SAMPLE_RATE_HZ)
        except Exception:
            raise GuideCaptureError(
                "CAPTURE_FORMAT_UNSUPPORTED",
                "The selected microphone does not support mono 16 kHz PCM16 input.",
            ) from None

        with self._lifecycle_lock:
            with self._lock:
                if self._state in {"starting", "recording", "stopping"}:
                    raise GuideCaptureError("CAPTURE_ALREADY_ACTIVE", "Stop the current microphone session before starting another.")
                self._state = "starting"
                self._device_index = device
                self._max_frames = math.floor(duration * SAMPLE_RATE_HZ)
                self._frames_captured = 0
                self._input_overflow_count = 0
                self._start_monotonic = time.monotonic()
                self._last_error_code = None
                self._on_chunk = on_chunk
                self._backend = backend
            try:
                stream = backend.RawInputStream(
                    device=device,
                    channels=CHANNELS,
                    samplerate=SAMPLE_RATE_HZ,
                    dtype=DTYPE,
                    blocksize=BLOCK_SIZE_FRAMES,
                    callback=self._audio_callback,
                )
                with self._lock:
                    self._stream = stream
                stream.start()
            except Exception:
                with self._lock:
                    self._state = "failed"
                    self._last_error_code = "CAPTURE_START_FAILED"
                    self._on_chunk = None
                    failed_stream = getattr(self, "_stream", None)
                try:
                    candidate = locals().get("stream", failed_stream)
                    if candidate is not None:
                        candidate.close()
                        with self._lock:
                            if self._stream is candidate:
                                self._stream = None
                except Exception:
                    with self._lock:
                        self._stream = candidate
                        self._last_error_code = "CAPTURE_CLEANUP_FAILED"
                raise GuideCaptureError("CAPTURE_START_FAILED", "The selected microphone could not be started.") from None

            with self._lock:
                if self._state == "starting":
                    self._state = "recording"
        return self.status()

    def _audio_callback(self, indata: Any, frames: int, time_info: Any, status: Any) -> None:
        with self._lock:
            if self._state not in {"starting", "recording"}:
                return
            if isinstance(frames, bool) or not isinstance(frames, int) or frames <= 0 or frames > MAX_CALLBACK_FRAMES:
                self._state = "failed"
                self._last_error_code = "CAPTURE_BLOCK_INVALID"
                abort = getattr(self._backend or _backend_or_error(), "CallbackAbort", RuntimeError)
                raise abort
            first_frame = self._frames_captured
            remaining = self._max_frames - first_frame
            if remaining <= 0:
                self._state = "limit_reached"
                stop = getattr(self._backend or _backend_or_error(), "CallbackStop", RuntimeError)
                raise stop
            take_frames = min(frames, remaining)
            self._frames_captured += take_frames
            overflow = bool(getattr(status, "input_overflow", False))
            if overflow:
                self._input_overflow_count += 1
            callback = self._on_chunk
            input_time = _finite_number(getattr(time_info, "inputBufferAdcTime", None))
            current_time = _finite_number(getattr(time_info, "currentTime", None))
            received_monotonic = time.monotonic()
            reached_limit = self._frames_captured >= self._max_frames

        try:
            if hasattr(indata, "tobytes"):
                pcm = indata.tobytes()
            else:
                pcm = bytes(indata)
            expected_bytes = frames * PCM_BYTES_PER_FRAME
            if len(pcm) != expected_bytes:
                raise ValueError("input block size mismatch")
            pcm = pcm[:take_frames * PCM_BYTES_PER_FRAME]
            if sys.byteorder != "little":
                swapped = bytearray(len(pcm))
                swapped[0::2], swapped[1::2] = pcm[1::2], pcm[0::2]
                pcm = bytes(swapped)
            chunk = {
                "pcmS16LE": pcm,
                "firstFrame": first_frame,
                "frameCount": take_frames,
                "sampleRateHz": SAMPLE_RATE_HZ,
                "channels": CHANNELS,
                "inputBufferAdcTime": input_time,
                "currentTime": current_time,
                "receivedMonotonic": received_monotonic,
                "inputOverflow": overflow,
                "discontinuity": overflow,
            }
            if callback is not None:
                callback(chunk)
        except getattr(self._backend or _backend_or_error(), "CallbackAbort", RuntimeError):
            raise
        except Exception:
            with self._lock:
                self._state = "failed"
                self._last_error_code = "CAPTURE_CALLBACK_FAILED"
            abort = getattr(self._backend or _backend_or_error(), "CallbackAbort", RuntimeError)
            raise abort from None

        if reached_limit:
            with self._lock:
                self._state = "limit_reached"
            stop = getattr(self._backend or _backend_or_error(), "CallbackStop", RuntimeError)
            raise stop

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self._state,
                "deviceIndex": self._device_index,
                "sampleRateHz": SAMPLE_RATE_HZ,
                "channels": CHANNELS,
                "framesCaptured": self._frames_captured,
                "durationMs": round(self._frames_captured * 1000 / SAMPLE_RATE_HZ),
                "inputOverflowCount": self._input_overflow_count,
                "startMonotonic": self._start_monotonic,
                "clockDomain": "portaudio-inputBufferAdcTime plus delivered sample-frame index",
                "lastErrorCode": self._last_error_code,
            }

    def stop(self) -> dict[str, Any]:
        """Stop and close the input stream; no buffered audio remains to retrieve."""
        with self._lifecycle_lock:
            with self._lock:
                stream = self._stream
                self._state = "stopping" if stream is not None else "stopped"
            error_code = None
            if stream is not None:
                closed = False
                try:
                    if bool(getattr(stream, "active", True)):
                        stream.stop()
                except Exception:
                    error_code = "CAPTURE_STOP_FAILED"
                finally:
                    try:
                        stream.close()
                        closed = True
                    except Exception:
                        error_code = "CAPTURE_STOP_FAILED"
                    with self._lock:
                        self._on_chunk = None
                        self._state = "stopped" if closed else "failed"
                        if closed:
                            self._stream = None
                        if error_code is not None:
                            self._last_error_code = error_code
                        elif closed and self._last_error_code == "CAPTURE_STOP_FAILED":
                            self._last_error_code = None
        return self.status()
