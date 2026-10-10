"""Validate a selected local WAV before native analysis.

Audio stays at the caller-selected path. This module reads container metadata
only; it never copies, converts, uploads, or deletes the selected audio.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import wave


MAX_AUDIO_DURATION_SECONDS = 60.0
MAX_AUDIO_FILE_BYTES = 64 * 1024 * 1024
MAX_AUDIO_CHANNELS = 8
MIN_SAMPLE_RATE = 8_000
MAX_SAMPLE_RATE = 192_000


class AudioInputError(ValueError):
    """A selected local audio file violates the bounded PCM WAV contract."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AudioInput:
    """Metadata for a validated PCM WAV; ``path`` remains caller-owned."""

    path: Path
    duration_seconds: float
    sample_rate: int
    channels: int
    sample_width_bytes: int
    sample_format: str


def _format_for_width(sample_width_bytes: int) -> str:
    return {
        1: "pcm_u8",
        2: "pcm_s16le",
        3: "pcm_s24le",
        4: "pcm_s32le",
    }[sample_width_bytes]


def validate_audio_input(
    path: str | Path,
    *,
    max_duration_seconds: float = MAX_AUDIO_DURATION_SECONDS,
) -> AudioInput:
    """Read bounded WAV metadata without retaining or changing audio samples.

    The aligner owns any in-memory downmix or resampling needed for inference.
    Inputs longer than 60 seconds are rejected even if a caller supplies a
    larger limit; callers may choose a stricter limit for a particular run.
    """
    if (
        isinstance(max_duration_seconds, bool)
        or not isinstance(max_duration_seconds, (int, float))
        or not math.isfinite(max_duration_seconds)
        or max_duration_seconds <= 0
        or max_duration_seconds > MAX_AUDIO_DURATION_SECONDS
    ):
        raise AudioInputError(
            "INVALID_DURATION_LIMIT",
            f"duration limit must be greater than zero and at most {MAX_AUDIO_DURATION_SECONDS:g} seconds",
        )

    audio_path = Path(path).expanduser()
    try:
        if not audio_path.is_file():
            raise AudioInputError("AUDIO_FILE_NOT_FOUND", "selected audio file does not exist")
        file_size = audio_path.stat().st_size
    except OSError as exc:
        raise AudioInputError("AUDIO_FILE_UNAVAILABLE", "selected audio file cannot be read") from exc

    if file_size > MAX_AUDIO_FILE_BYTES:
        raise AudioInputError("AUDIO_FILE_TOO_LARGE", "selected audio file exceeds the 64 MiB input limit")

    try:
        with wave.open(str(audio_path), "rb") as wav:
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
            sample_width_bytes = wav.getsampwidth()
            frame_count = wav.getnframes()
            compression = wav.getcomptype()
    except (OSError, EOFError, wave.Error) as exc:
        raise AudioInputError("INVALID_PCM_WAV", "selected audio must be an uncompressed PCM WAV") from exc

    if compression != "NONE":
        raise AudioInputError("INVALID_PCM_WAV", "selected audio must be an uncompressed PCM WAV")
    if not 1 <= channels <= MAX_AUDIO_CHANNELS:
        raise AudioInputError("UNSUPPORTED_CHANNEL_COUNT", f"WAV must have between 1 and {MAX_AUDIO_CHANNELS} channels")
    if not MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE:
        raise AudioInputError(
            "UNSUPPORTED_SAMPLE_RATE",
            f"WAV sample rate must be between {MIN_SAMPLE_RATE} and {MAX_SAMPLE_RATE} Hz",
        )
    if sample_width_bytes not in (1, 2, 3, 4):
        raise AudioInputError("UNSUPPORTED_SAMPLE_FORMAT", "WAV samples must use 8, 16, 24, or 32-bit PCM")
    if frame_count <= 0:
        raise AudioInputError("EMPTY_AUDIO", "selected WAV contains no audio samples")

    duration_seconds = frame_count / sample_rate
    if duration_seconds > max_duration_seconds:
        raise AudioInputError(
            "AUDIO_TOO_LONG",
            f"selected WAV is {duration_seconds:.3f} seconds; limit is {max_duration_seconds:g} seconds",
        )

    return AudioInput(
        path=audio_path.resolve(),
        duration_seconds=duration_seconds,
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bytes=sample_width_bytes,
        sample_format=_format_for_width(sample_width_bytes),
    )
