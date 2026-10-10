"""Bounded Chrome Native Messaging bridge for LyricVibe's live PCM aligner."""

from __future__ import annotations

import base64
import binascii
import hashlib
import importlib.util
import json
import math
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO


HOST_NAME = "com.lyricvibe.native_audio"
PROTOCOL = "lyricvibe.native-live.v1"
HOST_VERSION = "0.1.0"
SAMPLE_RATE_HZ = 16_000
MAX_AUDIO_MS = 12_000
MAX_PCM_BYTES = SAMPLE_RATE_HZ * 2 * MAX_AUDIO_MS // 1000
MAX_FRAME_BYTES = 1_048_576
MAX_EXPECTED_WORDS = 200
MAX_TEXT_CHARS = 8_000
WORKER_TIMEOUT_SECONDS = 60
MODEL_NAME = "torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H"
MODEL_REVISION = "sha256:488fd4f16de84438ffc945334278c1b9fb9b7159a806c1080b16111a958c945d"
WORD_RE = re.compile(r"^[A-Za-z]+(?:['’][A-Za-z]+)?$")
STATIC_WARNINGS = {
    "The model aligned the supplied lyrics directly; no ASR transcript or interpolated word times were used.",
    "No confidence score is returned. CTC forced alignment can place incorrect or inaudible supplied words; review the audio.",
    "The English model is speech-trained; singing, backing vocals, and overlapping voices are unvalidated.",
    "SILENT_AUDIO: every input sample is exactly zero, so no word intervals were emitted.",
    "This exact-zero gate does not classify near-silence or other low-energy audio.",
}
NO_FRAME_WARNING_PREFIX = "No CTC frames were assigned to supplied word"
SHORT_WORD_WARNING_PREFIX = "Supplied word"


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def read_frame(stream: BinaryIO, max_bytes: int = MAX_FRAME_BYTES) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("TRUNCATED_FRAME", "Native message header was incomplete.")
    size = struct.unpack("<I", header)[0]
    if size == 0 or size > max_bytes:
        raise ProtocolError("FRAME_SIZE_INVALID", "Native message exceeded the host frame limit.")
    body = stream.read(size)
    if len(body) != size:
        raise ProtocolError("TRUNCATED_FRAME", "Native message body was incomplete.")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise ProtocolError("INVALID_JSON", "Native message was not valid UTF-8 JSON.") from None
    if not isinstance(value, dict):
        raise ProtocolError("INVALID_MESSAGE", "Native message must be a JSON object.")
    return value


def write_frame(stream: BinaryIO, value: dict[str, Any], max_bytes: int = MAX_FRAME_BYTES) -> None:
    try:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise ProtocolError("RESPONSE_INVALID", "Native response could not be encoded.") from None
    if not body or len(body) > max_bytes:
        raise ProtocolError("RESPONSE_TOO_LARGE", "Native response exceeded the host frame limit.")
    stream.write(struct.pack("<I", len(body)))
    stream.write(body)
    stream.flush()


def _safe_int(value: Any, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _safe_string(value: Any, max_chars: int, *, nonempty: bool = True) -> bool:
    return isinstance(value, str) and (not nonempty or bool(value)) and len(value) <= max_chars


def validate_analysis(message: dict[str, Any]) -> tuple[dict[str, Any], bytes, str]:
    if message.get("version") != PROTOCOL or message.get("type") != "analyze":
        raise ProtocolError("PROTOCOL_MISMATCH", "Native analysis request used an unsupported protocol.")
    request_id, session_id = message.get("requestId"), message.get("sessionId")
    source, audio, words = message.get("source"), message.get("audio"), message.get("expectedWords")
    if not _safe_string(request_id, 100) or not _safe_string(session_id, 100):
        raise ProtocolError("INVALID_REQUEST", "Native request identity was invalid.")
    if not isinstance(source, dict) or not _safe_int(source.get("tabId"), 1) or not _safe_string(source.get("mediaKey"), 200) or \
            not _safe_string(source.get("lyricsHash"), 64) or len(source["lyricsHash"]) != 64 or \
            any(char not in "0123456789abcdef" for char in source["lyricsHash"]) or \
            not _safe_int(source.get("expectedRevision")) or not _safe_int(source.get("captureEpoch")):
        raise ProtocolError("INVALID_SOURCE_BINDING", "Native request source binding was invalid.")
    if not isinstance(audio, dict) or audio.get("encoding") != "pcm_s16le" or audio.get("sampleRateHz") != SAMPLE_RATE_HZ or \
            audio.get("channels") != 1 or not _safe_int(audio.get("durationMs"), 1) or audio["durationMs"] > MAX_AUDIO_MS or \
            not _safe_int(audio.get("audioStartMs")) or not isinstance(audio.get("playbackRate"), (int, float)) or \
            isinstance(audio.get("playbackRate"), bool) or not math.isfinite(audio["playbackRate"]) or not 0.25 <= audio["playbackRate"] <= 4:
        raise ProtocolError("INVALID_AUDIO_WINDOW", "Native audio window exceeded the PCM protocol limits.")
    encoded, checksum = audio.get("pcmBase64"), audio.get("sha256")
    if not _safe_string(encoded, (MAX_PCM_BYTES * 4 + 2) // 3) or not _safe_string(checksum, 64) or len(checksum) != 64 or \
            any(char not in "0123456789abcdef" for char in checksum):
        raise ProtocolError("INVALID_AUDIO_WINDOW", "Native PCM encoding or checksum was invalid.")
    try:
        pcm = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ProtocolError("INVALID_AUDIO_WINDOW", "Native PCM was not valid base64.") from None
    if not pcm or len(pcm) > MAX_PCM_BYTES or len(pcm) % 2:
        raise ProtocolError("INVALID_AUDIO_WINDOW", "Native PCM length exceeded the bounded mono s16le window.")
    actual_ms = len(pcm) * 1000 / (SAMPLE_RATE_HZ * 2)
    if abs(actual_ms - audio["durationMs"]) > 1.1:
        raise ProtocolError("INVALID_AUDIO_WINDOW", "Native PCM sample count did not match its declared duration.")
    digest = hashlib.sha256(pcm).hexdigest()
    if digest != checksum:
        raise ProtocolError("AUDIO_CHECKSUM_MISMATCH", "Native PCM checksum did not match its bytes.")
    if not isinstance(words, list) or not 1 <= len(words) <= MAX_EXPECTED_WORDS:
        raise ProtocolError("INVALID_LYRICS_WINDOW", "Native request must include a bounded set of expected words.")
    seen: set[str] = set()
    text_words: list[str] = []
    clean_words: list[dict[str, str]] = []
    for word in words:
        if not isinstance(word, dict) or not _safe_string(word.get("wordId"), 128) or not _safe_string(word.get("phraseId"), 128) or \
                not _safe_string(word.get("laneId"), 128) or not _safe_string(word.get("text"), 100):
            raise ProtocolError("INVALID_LYRICS_WINDOW", "Expected word identity or text was invalid.")
        normalized_text = word["text"].replace("’", "'")
        if not WORD_RE.fullmatch(normalized_text):
            raise ProtocolError("INVALID_LYRICS_WINDOW", "Expected words must use bounded English letters with at most one interior apostrophe.")
        if word["wordId"] in seen:
            raise ProtocolError("INVALID_LYRICS_WINDOW", "Expected words must have unique IDs and bounded English text.")
        seen.add(word["wordId"])
        clean_words.append({key: word[key] for key in ("wordId", "phraseId", "laneId", "text")})
        text_words.append(normalized_text)
    transcript = " ".join(text_words)
    if len(transcript) > MAX_TEXT_CHARS:
        raise ProtocolError("INVALID_LYRICS_WINDOW", "Expected lyric text exceeded its character limit.")
    source_copy = {key: source[key] for key in ("tabId", "mediaKey", "lyricsHash", "expectedRevision", "captureEpoch")}
    context = {
        "version": PROTOCOL, "type": "analyze", "requestId": request_id, "sessionId": session_id,
        "source": source_copy, "audio": {"audioStartMs": audio["audioStartMs"], "playbackRate": float(audio["playbackRate"]), "sha256": digest, "durationMs": audio["durationMs"]},
        "expectedWords": clean_words,
    }
    return context, pcm, transcript


def envelope(context: dict[str, Any]) -> dict[str, Any]:
    return {"version": PROTOCOL, "requestId": context["requestId"], "sessionId": context["sessionId"], "source": context["source"]}


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _map_greedy_consistency(context: dict[str, Any], diagnostics: Any) -> dict[str, Any] | None:
    """Copy bounded numeric consistency metrics while replacing ordinals with submitted IDs."""
    if not isinstance(diagnostics, dict):
        return None
    metrics = diagnostics.get("greedyConsistency")
    if not isinstance(metrics, dict):
        return None
    expected = context["expectedWords"]
    word_count = metrics.get("wordCount")
    greedy_word_count = metrics.get("greedyWordCount")
    fraction = metrics.get("matchedWordFraction")
    method = metrics.get("method")
    calibrated = metrics.get("calibrated")
    words = metrics.get("words")
    if not (_safe_int(word_count) and word_count <= len(expected) and
            _safe_int(greedy_word_count) and greedy_word_count <= 600 and
            _finite_number(fraction) and 0 <= fraction <= 1 and
            method == "same-model-greedy-vs-forced-ctc" and calibrated is False and
            isinstance(words, list) and len(words) <= word_count):
        return None
    mapped_words: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for metric in words:
        if not isinstance(metric, dict):
            return None
        index = metric.get("wordIndex")
        frame_count = metric.get("forcedFrameCount")
        same_top1 = metric.get("greedyTop1FrameFraction")
        mean_log_prob = metric.get("meanForcedLogProb")
        if not (_safe_int(index) and index < word_count and index < len(expected) and index not in seen_indices and
                _safe_int(frame_count) and frame_count <= 600):
            return None
        if frame_count == 0:
            if same_top1 is not None or mean_log_prob is not None:
                return None
        elif not (_finite_number(same_top1) and 0 <= same_top1 <= 1 and
                  _finite_number(mean_log_prob) and -1000 <= mean_log_prob <= 0):
            return None
        seen_indices.add(index)
        mapped_words.append({
            "wordId": expected[index]["wordId"],
            "forcedFrameCount": frame_count,
            "greedyTop1FrameFraction": same_top1,
            "meanForcedLogProb": mean_log_prob,
        })
    return {
        "method": method,
        "calibrated": False,
        "wordCount": word_count,
        "greedyWordCount": greedy_word_count,
        "matchedWordFraction": float(fraction),
        "words": mapped_words,
    }


def format_result(context: dict[str, Any], aligned: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(aligned, dict):
        raise ProtocolError("ALIGNMENT_FAILED", "Native aligner returned an invalid result.")
    expected = context["expectedWords"]
    mapped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in aligned.get("words", []) if isinstance(aligned, dict) else []:
        if not isinstance(item, dict):
            continue
        index = item.get("wordIndex")
        start, end = item.get("startMs"), item.get("endMs")
        if not _safe_int(index) or index >= len(expected) or not _safe_int(start) or not _safe_int(end, 1) or end <= start or end > context["audio"]["durationMs"]:
            continue
        word_id = expected[index]["wordId"]
        if word_id in seen_ids:
            continue
        seen_ids.add(word_id)
        mapped.append({"wordId": word_id, "startMs": start, "endMs": end})
    if aligned.get("alignmentKind") != "supplied-text-ctc":
        raise ProtocolError("ALIGNMENT_FAILED", "Native aligner returned an unsupported alignment kind.")
    if not all(_safe_string(aligned.get(key), 200) for key in ("adapter", "model", "modelRevision")):
        raise ProtocolError("ALIGNMENT_FAILED", "Native aligner omitted its model identity.")
    warnings = aligned.get("warnings", [])
    if not isinstance(warnings, list):
        warnings = []
    safe_warnings: list[str] = []
    for warning in warnings[:100]:
        if not isinstance(warning, str):
            continue
        if warning in STATIC_WARNINGS:
            safe_warnings.append(warning)
        elif warning.startswith(NO_FRAME_WARNING_PREFIX):
            generic = "One or more supplied words had no assigned CTC frames; those regions are unsupported."
            if generic not in safe_warnings:
                safe_warnings.append(generic)
        elif warning.startswith(SHORT_WORD_WARNING_PREFIX) and "is shorter than the model's frame resolution" in warning:
            generic = "One or more supplied words were shorter than the model's frame resolution and were omitted."
            if generic not in safe_warnings:
                safe_warnings.append(generic)
    result = {
        **envelope(context), "type": "result", "accepted": False, "automaticAdmissionEnabled": False,
        "alignmentKind": "supplied-text-ctc", "adapter": str(aligned.get("adapter", ""))[:200],
        "model": str(aligned.get("model", ""))[:200], "modelRevision": str(aligned.get("modelRevision", ""))[:200],
        "audio": {"audioStartMs": context["audio"]["audioStartMs"], "sha256": context["audio"]["sha256"]},
        "words": mapped, "warnings": safe_warnings,
    }
    if aligned.get("reasonCode") == "SILENT_AUDIO":
        result["reasonCode"] = "SILENT_AUDIO"
    consistency = _map_greedy_consistency(context, aligned.get("diagnostics"))
    if consistency is not None:
        # A diagnostic sidecar carries no timing or admission authority.
        result["diagnostics"] = {"greedyConsistency": consistency}
    return result


def _checkpoint_path() -> Path:
    torch_home = os.environ.get("TORCH_HOME")
    if not torch_home:
        cache_home = os.environ.get("XDG_CACHE_HOME")
        torch_home = str(Path(cache_home) / "torch") if cache_home else str(Path.home() / ".cache" / "torch")
    return Path(torch_home) / "hub" / "checkpoints" / "wav2vec2_fairseq_base_ls960_asr_ls960.pth"


def _readiness() -> tuple[bool, str]:
    try:
        deps_ready = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("torchaudio") is not None
    except (ImportError, ValueError):
        deps_ready = False
    ready = deps_ready and _checkpoint_path().is_file()
    return ready, "ready" if ready else "unavailable"


def _send_error(write: BinaryIO, context: dict[str, Any] | None, code: str, message: str) -> None:
    value = {**envelope(context), "type": "error", "error": {"code": code, "message": message}} if context else {
        "version": PROTOCOL, "type": "error", "error": {"code": code, "message": message},
    }
    write_frame(write, value)


def _rejection_context(message: dict[str, Any]) -> dict[str, Any] | None:
    source = message.get("source")
    if not (_safe_string(message.get("requestId"), 100) and _safe_string(message.get("sessionId"), 100) and isinstance(source, dict)):
        return None
    if not (_safe_int(source.get("tabId"), 1) and _safe_string(source.get("mediaKey"), 200) and
            _safe_string(source.get("lyricsHash"), 64) and len(source["lyricsHash"]) == 64 and
            all(char in "0123456789abcdef" for char in source["lyricsHash"]) and
            _safe_int(source.get("expectedRevision")) and _safe_int(source.get("captureEpoch"))):
        return None
    return {"requestId": message["requestId"], "sessionId": message["sessionId"],
            "source": {key: source[key] for key in ("tabId", "mediaKey", "lyricsHash", "expectedRevision", "captureEpoch")}}


def _stop_worker(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _drain_worker_output(process: subprocess.Popen[bytes], done: queue.Queue[tuple[subprocess.Popen[bytes], bytes, int]]) -> None:
    output = process.stdout.read(MAX_FRAME_BYTES + 1) if process.stdout else b""
    if len(output) > MAX_FRAME_BYTES:
        _stop_worker(process)
    try:
        return_code = process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        return_code = process.wait(timeout=5)
    done.put((process, output, return_code))


def _worker_main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1).decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("pcmBase64"), str) or \
                len(payload["pcmBase64"]) > (MAX_PCM_BYTES * 4 + 2) // 3 or not _safe_string(payload.get("text"), MAX_TEXT_CHARS):
            return 2
        pcm = base64.b64decode(payload["pcmBase64"], validate=True)
        if not pcm or len(pcm) > MAX_PCM_BYTES:
            return 2
        text = payload["text"]
        del payload
        from alignment import align_samples
        aligned = align_samples(pcm, text, sample_rate_hz=SAMPLE_RATE_HZ, language="en")
        del pcm, text
        sys.stdout.write(json.dumps(aligned, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        sys.stdout.flush()
        return 0
    except BaseException:
        # Keep stdout machine-readable and avoid logging lyrics, audio, paths, or exceptions.
        return 3


def _registered_origin() -> str | None:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return None
    manifest = Path(local_app_data) / "LyricVibe" / "NativeMessaging" / f"{HOST_NAME}.json"
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8-sig"))
        if not isinstance(payload, dict):
            return None
        origins = payload.get("allowed_origins")
        if payload.get("name") != HOST_NAME or payload.get("type") != "stdio" or not isinstance(origins, list) or len(origins) != 1:
            return None
        origin = origins[0]
        if not isinstance(origin, str) or not re.fullmatch(r"chrome-extension://[a-p]{32}/", origin):
            return None
        return origin
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def _caller_is_allowed(argv: list[str], allowed_origin: str | None) -> bool:
    return allowed_origin is not None and len(argv) >= 2 and argv[1] == allowed_origin


def run_host(read: BinaryIO | None = None, write: BinaryIO | None = None, argv: list[str] | None = None) -> int:
    read = read or sys.stdin.buffer
    write = write or sys.stdout.buffer
    argv = sys.argv if argv is None else argv
    if hasattr(os, "name") and os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    allowed_origin = _registered_origin()
    if not _caller_is_allowed(argv, allowed_origin):
        return 1
    ready, _ = _readiness()
    hello = {
        "version": PROTOCOL, "type": "hello", "hostName": HOST_NAME, "hostVersion": HOST_VERSION,
        "state": "ready" if ready else "unavailable", "modelReady": ready, "alignmentReady": ready,
        "adapter": "torchaudio-ctc-forced-alignment", "model": MODEL_NAME, "modelRevision": MODEL_REVISION,
        "limits": {"maxAudioMs": MAX_AUDIO_MS, "sampleRateHz": SAMPLE_RATE_HZ, "channels": 1, "encoding": "pcm_s16le", "maxPcmBytes": MAX_PCM_BYTES},
    }
    write_frame(write, hello)
    if not ready:
        return 0

    messages: queue.Queue[dict[str, Any] | BaseException | None] = queue.Queue(maxsize=4)

    def reader() -> None:
        try:
            while True:
                item = read_frame(read)
                try:
                    messages.put(item, timeout=0.5)
                except queue.Full:
                    messages.put(ProtocolError("BACKPRESSURE", "Native host input queue is full."))
                    return
                if item is None:
                    return
        except BaseException as exc:
            messages.put(exc)

    threading.Thread(target=reader, name="lyricvibe-native-reader", daemon=True).start()
    active: dict[str, Any] | None = None
    while True:
        try:
            event = messages.get(timeout=0.05)
        except queue.Empty:
            event = ...
        if event is None:
            if active:
                _stop_worker(active["process"])
            return 0
        if isinstance(event, BaseException):
            if active:
                _stop_worker(active["process"])
            if isinstance(event, ProtocolError):
                _send_error(write, None, event.code, str(event))
            return 1
        if event is not ...:
            message = event
            if message.get("version") != PROTOCOL:
                _send_error(write, None, "PROTOCOL_MISMATCH", "Native message used an unsupported protocol.")
                continue
            if message.get("type") == "hello":
                write_frame(write, hello)
                continue
            if message.get("type") == "cancel":
                source, context = message.get("source"), active.get("context") if active else None
                if context and message.get("requestId") == context["requestId"] and message.get("sessionId") == context["sessionId"] and \
                        isinstance(source, dict) and source.get("captureEpoch") == context["source"]["captureEpoch"]:
                    proc = active["process"]
                    _stop_worker(proc)
                    write_frame(write, {**envelope(context), "type": "status", "state": "cancelled"})
                    active = None
                continue
            if message.get("type") != "analyze":
                _send_error(write, None, "UNKNOWN_MESSAGE", "Native host received an unsupported message.")
                continue
            if active is not None:
                source = message.get("source")
                if message.get("version") == PROTOCOL and _safe_string(message.get("requestId"), 100) and \
                        _safe_string(message.get("sessionId"), 100) and isinstance(source, dict) and \
                        _safe_int(source.get("tabId"), 1) and _safe_string(source.get("mediaKey"), 200) and \
                        _safe_string(source.get("lyricsHash"), 64) and len(source["lyricsHash"]) == 64 and \
                        all(char in "0123456789abcdef" for char in source["lyricsHash"]) and \
                        _safe_int(source.get("expectedRevision")) and _safe_int(source.get("captureEpoch")):
                    busy_context = {"requestId": message["requestId"], "sessionId": message["sessionId"],
                                    "source": {key: source[key] for key in ("tabId", "mediaKey", "lyricsHash", "expectedRevision", "captureEpoch")}}
                    write_frame(write, {**envelope(busy_context), "type": "status", "state": "busy"})
                continue
            try:
                context, pcm, transcript = validate_analysis(message)
            except ProtocolError as exc:
                _send_error(write, _rejection_context(message), exc.code, str(exc))
                continue
            message.get("audio", {}).pop("pcmBase64", None)
            worker_payload = json.dumps({"pcmBase64": base64.b64encode(pcm).decode("ascii"), "text": transcript}, separators=(",", ":")).encode("utf-8") + b"\n"
            del pcm, transcript, message, event
            try:
                proc = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "--worker"], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(Path(__file__).resolve().parent),
                )
                assert proc.stdin is not None
                proc.stdin.write(worker_payload)
                proc.stdin.close()
            except (OSError, BrokenPipeError):
                if "proc" in locals() and proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=3)
                _send_error(write, context, "WORKER_START_FAILED", "Native alignment worker could not start.")
                continue
            del worker_payload
            worker_done: queue.Queue[tuple[subprocess.Popen[bytes], bytes, int]] = queue.Queue(maxsize=1)
            threading.Thread(target=_drain_worker_output, args=(proc, worker_done), name="lyricvibe-native-worker-output", daemon=True).start()
            active = {"process": proc, "context": context, "started": time.monotonic(), "done": worker_done}
            write_frame(write, {**envelope(context), "type": "status", "state": "accepted", "audio": {"audioStartMs": context["audio"]["audioStartMs"], "sha256": context["audio"]["sha256"]}})

        if active:
            proc = active["process"]
            if time.monotonic() - active["started"] > WORKER_TIMEOUT_SECONDS:
                _stop_worker(proc)
                _send_error(write, active["context"], "ALIGNMENT_TIMEOUT", "Native alignment exceeded its time limit.")
                active = None
            else:
                try:
                    finished, stdout, return_code = active["done"].get_nowait()
                except queue.Empty:
                    finished = None
                if finished is proc:
                    context = active["context"]
                    if return_code != 0 or len(stdout) > MAX_FRAME_BYTES:
                        _send_error(write, context, "ALIGNMENT_FAILED", "Native supplied-text alignment could not be completed.")
                    else:
                        try:
                            aligned = json.loads(stdout.decode("utf-8"))
                            result = format_result(context, aligned)
                            write_frame(write, result)
                        except (UnicodeError, json.JSONDecodeError, ProtocolError):
                            _send_error(write, context, "ALIGNMENT_FAILED", "Native supplied-text alignment returned an invalid result.")
                    active = None


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--worker":
        return _worker_main()
    try:
        return run_host()
    except (BrokenPipeError, OSError, ProtocolError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
