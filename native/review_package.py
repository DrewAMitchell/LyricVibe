#!/usr/bin/env python3
"""Build an offline review package and optional local editor launcher."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
EDITOR_TEMPLATE = ROOT / "extension" / "editor.html"
PACKAGE_VERSION = "lyricvibe.review.v1"
MAX_PACKAGE_BYTES = 5 * 1024 * 1024
MAX_INPUT_JSON_BYTES = MAX_PACKAGE_BYTES
MAX_MEDIA_BYTES = 512 * 1024 * 1024
MAX_MEDIA_DURATION_MS = 30 * 60 * 1000
WAVEFORM_SAMPLE_RATE = 8_000
WAVEFORM_BUCKET_MS = 100
SAMPLES_PER_BUCKET = WAVEFORM_SAMPLE_RATE * WAVEFORM_BUCKET_MS // 1000
MAX_WAVEFORM_BUCKETS = MAX_MEDIA_DURATION_MS // WAVEFORM_BUCKET_MS
MAX_PCM_BYTES = MAX_WAVEFORM_BUCKETS * SAMPLES_PER_BUCKET * 2 + 65_536
PROCESS_TIMEOUT_SECONDS = 120


class ReviewPackageError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        if path.stat().st_size > MAX_INPUT_JSON_BYTES:
            raise ReviewPackageError("INPUT_TOO_LARGE", f"{label} exceeds the 5 MiB input limit.")
        value = json.loads(path.read_text(encoding="utf-8"))
    except ReviewPackageError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ReviewPackageError("INPUT_READ_FAILED", f"{label} could not be read as JSON.") from None
    if not isinstance(value, dict):
        raise ReviewPackageError("INVALID_INPUT", f"{label} must contain a JSON object.")
    return value


def _validate_score_and_receipt(score: dict[str, Any], receipt: dict[str, Any]) -> None:
    try:
        from .companion import CompanionError, _validate_receipt, _validate_score
    except ImportError:
        from companion import CompanionError, _validate_receipt, _validate_score
    try:
        _validate_score(score)
        _validate_receipt(score, receipt)
    except CompanionError as exc:
        raise ReviewPackageError(exc.code, str(exc)) from None


def _resolve_tool(explicit: str | os.PathLike[str] | None, name: str) -> str:
    if explicit is not None:
        candidate = Path(explicit).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        raise ReviewPackageError("TOOL_UNAVAILABLE", f"Configured {name} executable could not be found.")
    found = shutil.which(name)
    if not found:
        raise ReviewPackageError("TOOL_UNAVAILABLE", f"{name} is unavailable on PATH.")
    return found


def _probe_duration_ms(media_path: Path, ffprobe: str) -> int:
    args = [
        ffprobe, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(media_path),
    ]
    try:
        result = subprocess.run(args, capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReviewPackageError("MEDIA_PROBE_FAILED", "ffprobe could not read the selected media duration.") from None
    if result.returncode != 0:
        raise ReviewPackageError("MEDIA_PROBE_FAILED", "ffprobe could not read the selected media duration.")
    try:
        seconds = float(result.stdout.decode("ascii", errors="strict").strip())
    except (UnicodeError, ValueError):
        raise ReviewPackageError("MEDIA_DURATION_INVALID", "ffprobe returned an invalid media duration.") from None
    duration_ms = round(seconds * 1000)
    if not math.isfinite(seconds) or duration_ms <= 0:
        raise ReviewPackageError("MEDIA_DURATION_INVALID", "selected media duration must be finite and positive.")
    if duration_ms > MAX_MEDIA_DURATION_MS:
        raise ReviewPackageError("MEDIA_TOO_LONG", "selected media exceeds the 30 minute waveform limit.")
    return duration_ms


def _media_sha256(media_path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with media_path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError:
        raise ReviewPackageError("MEDIA_READ_FAILED", "selected media could not be hashed.") from None
    return digest.hexdigest()


def _decode_bounded_pcm(media_path: Path, ffmpeg: str) -> bytes:
    args = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(media_path),
        "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
        "-t", f"{MAX_MEDIA_DURATION_MS / 1000:g}", "-ac", "1", "-ar", str(WAVEFORM_SAMPLE_RATE),
        "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ]
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ReviewPackageError("WAVEFORM_TIMEOUT", "bounded ffmpeg waveform decode exceeded its time limit.") from None
    except OSError:
        raise ReviewPackageError("FFMPEG_UNAVAILABLE", "ffmpeg could not decode the selected media.") from None
    if result.returncode != 0:
        raise ReviewPackageError("WAVEFORM_DECODE_FAILED", "ffmpeg could not decode the selected audio stream.")
    pcm = result.stdout
    if len(pcm) > MAX_PCM_BYTES:
        raise ReviewPackageError("WAVEFORM_OUTPUT_TOO_LARGE", "decoded waveform exceeded the bounded PCM output limit.")
    if not pcm or len(pcm) % 2:
        raise ReviewPackageError("WAVEFORM_OUTPUT_INVALID", "ffmpeg returned an empty or malformed PCM stream.")
    return pcm


def _peaks_from_pcm(pcm: bytes) -> list[float]:
    if len(pcm) % 2:
        raise ReviewPackageError("WAVEFORM_OUTPUT_INVALID", "PCM output must contain complete 16-bit samples.")
    peaks: list[float] = []
    bucket_peak = 0
    bucket_samples = 0
    for (sample,) in struct.iter_unpack("<h", pcm):
        magnitude = abs(sample)
        if magnitude > bucket_peak:
            bucket_peak = magnitude
        bucket_samples += 1
        if bucket_samples == SAMPLES_PER_BUCKET:
            peaks.append(bucket_peak / 32768.0)
            bucket_peak = 0
            bucket_samples = 0
    if bucket_samples:
        peaks.append(bucket_peak / 32768.0)
    if len(peaks) > MAX_WAVEFORM_BUCKETS:
        raise ReviewPackageError("WAVEFORM_OUTPUT_TOO_LARGE", "waveform has more than 18,000 buckets.")
    return peaks


def _fit_peaks_to_duration(peaks: list[float], duration_ms: int) -> list[float]:
    """Make waveform coverage match the probed media timeline exactly."""
    expected = (duration_ms + WAVEFORM_BUCKET_MS - 1) // WAVEFORM_BUCKET_MS
    if expected > MAX_WAVEFORM_BUCKETS:
        raise ReviewPackageError("WAVEFORM_OUTPUT_TOO_LARGE", "media duration exceeds the 18,000 bucket limit.")
    if len(peaks) >= expected:
        return peaks[:expected]
    return peaks + [0.0] * (expected - len(peaks))


def _bounded_package_json(package: dict[str, Any]) -> bytes:
    payload = json.dumps(package, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_PACKAGE_BYTES:
        raise ReviewPackageError("PACKAGE_TOO_LARGE", "review package exceeds the 5 MiB limit.")
    return payload


def build_review_package(
    score_path: str | os.PathLike[str],
    receipt_path: str | os.PathLike[str],
    media_path: str | os.PathLike[str],
    *,
    ffmpeg_path: str | os.PathLike[str] | None = None,
    ffprobe_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Bind score, review receipt, exact media identity, and waveform peaks."""
    score_file = Path(score_path).expanduser().resolve()
    receipt_file = Path(receipt_path).expanduser().resolve()
    source = Path(media_path).expanduser().resolve()
    try:
        if not source.is_file():
            raise ReviewPackageError("MEDIA_NOT_FOUND", "selected media file does not exist.")
        before = source.stat()
    except OSError:
        raise ReviewPackageError("MEDIA_NOT_FOUND", "selected media file does not exist.") from None
    if before.st_size <= 0 or before.st_size > MAX_MEDIA_BYTES:
        raise ReviewPackageError("MEDIA_SIZE_INVALID", "selected media must be between 1 byte and 512 MiB.")
    if source in {score_file, receipt_file}:
        raise ReviewPackageError("OUTPUT_COLLISION", "media, score, and receipt inputs must be separate files.")

    score = _load_json(score_file, "score")
    receipt = _load_json(receipt_file, "alignment receipt")
    _validate_score_and_receipt(score, receipt)

    ffprobe = _resolve_tool(ffprobe_path, "ffprobe")
    ffmpeg = _resolve_tool(ffmpeg_path, "ffmpeg")
    duration_ms = _probe_duration_ms(source, ffprobe)
    media_hash = _media_sha256(source)
    pcm = _decode_bounded_pcm(source, ffmpeg)
    peaks = _fit_peaks_to_duration(_peaks_from_pcm(pcm), duration_ms)
    del pcm

    try:
        after = source.stat()
    except OSError:
        raise ReviewPackageError("MEDIA_CHANGED", "selected media disappeared during package generation.") from None
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ReviewPackageError("MEDIA_CHANGED", "selected media changed during package generation.")
    if _media_sha256(source) != media_hash:
        raise ReviewPackageError("MEDIA_CHANGED", "selected media content changed during package generation.")
    if len(peaks) > MAX_WAVEFORM_BUCKETS:
        raise ReviewPackageError("WAVEFORM_OUTPUT_TOO_LARGE", "waveform exceeds the 30 minute limit.")

    package = {
        "version": PACKAGE_VERSION,
        "score": score,
        "receipt": receipt,
        "audio": {
            "name": source.name,
            "durationMs": duration_ms,
            "sizeBytes": before.st_size,
            "sha256": media_hash,
        },
        "waveform": {
            "sampleRate": WAVEFORM_SAMPLE_RATE,
            "bucketMs": WAVEFORM_BUCKET_MS,
            "peaks": peaks,
        },
    }
    _bounded_package_json(package)
    return package


def _script_json(value: Any) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def build_launcher_html(package: dict[str, Any], media_path: str | os.PathLike[str]) -> str:
    """Create local editor HTML with inert JSON seed before deferred scripts."""
    try:
        template = EDITOR_TEMPLATE.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise ReviewPackageError("EDITOR_TEMPLATE_UNAVAILABLE", "local editor template could not be read.") from None
    if template.count("<head>") != 1 or "local-review-seed" in template:
        raise ReviewPackageError("EDITOR_TEMPLATE_INVALID", "local editor template has an unexpected head or review seed.")
    source = Path(media_path).expanduser().resolve()
    seed = _script_json({"package": package, "mediaUrl": source.as_uri()})
    extension_url = (ROOT / "extension").resolve().as_uri()
    if not extension_url.endswith("/"):
        extension_url += "/"
    injected = (
        "<head>\n"
        f'  <base href="{extension_url}">\n'
        f'  <script id="local-review-seed" type="application/json">{seed}</script>\n'
    )
    return template.replace("<head>\n", injected, 1)


def write_review_package(
    package: dict[str, Any],
    output_path: str | os.PathLike[str],
    *,
    launcher_path: str | os.PathLike[str] | None = None,
    media_path: str | os.PathLike[str] | None = None,
    input_paths: tuple[str | os.PathLike[str], ...] = (),
) -> None:
    output = Path(output_path).expanduser().resolve()
    payload = _bounded_package_json(package)
    if media_path is None:
        raise ReviewPackageError("INVALID_ARGUMENT", "the original media path is required for source binding.")
    source = Path(media_path).expanduser().resolve()
    launcher = Path(launcher_path).expanduser().resolve() if launcher_path is not None else None
    protected = {source, *(Path(path).expanduser().resolve() for path in input_paths)}
    if output in protected or (launcher is not None and launcher in {*protected, output}):
        raise ReviewPackageError("OUTPUT_COLLISION", "package and launcher outputs must not replace an input or each other.")
    launcher_html = build_launcher_html(package, source) if launcher is not None else None
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
    except OSError:
        raise ReviewPackageError("PACKAGE_WRITE_FAILED", "review package could not be written to the requested path.") from None

    if launcher is not None:
        try:
            launcher.parent.mkdir(parents=True, exist_ok=True)
            launcher.write_text(launcher_html, encoding="utf-8", newline="\n")
        except OSError:
            raise ReviewPackageError("LAUNCHER_WRITE_FAILED", "local editor launcher could not be written.") from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a local LyricVibe review package with bounded waveform peaks.")
    parser.add_argument("--score", required=True, help="validated LyricVibe score JSON")
    parser.add_argument("--receipt", required=True, help="native alignment review receipt JSON")
    parser.add_argument("--media", required=True, help="original local media file")
    parser.add_argument("--output", required=True, help="ignored/local output review-package JSON path")
    parser.add_argument("--ffmpeg", help="ffmpeg executable path (defaults to PATH)")
    parser.add_argument("--ffprobe", help="ffprobe executable path (defaults to PATH)")
    parser.add_argument("--launcher", help="optional local editor HTML launcher output path")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        package = build_review_package(
            args.score, args.receipt, args.media,
            ffmpeg_path=args.ffmpeg, ffprobe_path=args.ffprobe,
        )
        write_review_package(
            package, args.output, launcher_path=args.launcher, media_path=args.media,
            input_paths=(args.score, args.receipt),
        )
        print(json.dumps({
            "ok": True,
            "version": package["version"],
            "output": str(Path(args.output).expanduser().resolve()),
            "launcher": str(Path(args.launcher).expanduser().resolve()) if args.launcher else None,
            "durationMs": package["audio"]["durationMs"],
            "waveformBuckets": len(package["waveform"]["peaks"]),
            "audioSha256": package["audio"]["sha256"],
        }, separators=(",", ":")))
        return 0
    except ReviewPackageError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": str(exc)}}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
