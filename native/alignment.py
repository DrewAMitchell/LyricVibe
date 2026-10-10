"""Native, supplied-text CTC forced alignment for LyricVibe.

This adapter uses a language-specific acoustic model to align the caller's
lyrics. It does not transcribe audio or substitute ASR word timestamps.
"""

from __future__ import annotations

import re
import hashlib
import math
import time
from pathlib import Path
from typing import Any


MODEL_NAME = "torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H"
MODEL_CHECKPOINT = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
MODEL_SHA256 = "488fd4f16de84438ffc945334278c1b9fb9b7159a806c1080b16111a958c945d"
MAX_AUDIO_SECONDS = 60
MAX_PCM_ALIGNMENT_SECONDS = 12
_WORD_RE = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")


def _load_audio(path: str, torchaudio: Any, torch: Any) -> tuple[Any, int]:
    waveform, sample_rate = torchaudio.load(path)
    if waveform.ndim != 2 or waveform.shape[0] == 0 or waveform.shape[1] == 0:
        raise ValueError("audio contains no samples")
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != 16_000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16_000)
        sample_rate = 16_000
    return waveform.to(dtype=torch.float32), sample_rate


def _normalize_waveform(waveform: Any, sample_rate: int, torchaudio: Any, torch: Any) -> tuple[Any, int]:
    """Normalize an in-memory channel-first waveform to the model's mono 16 kHz input."""
    if waveform.ndim != 2 or waveform.shape[0] == 0 or waveform.shape[1] == 0:
        raise ValueError("audio contains no samples")
    if sample_rate <= 0:
        raise ValueError("sample rate must be a positive integer")
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != 16_000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16_000)
        sample_rate = 16_000
    return waveform.to(dtype=torch.float32), sample_rate


def _load_pcm_samples(pcm: bytes, sample_rate_hz: int, torch: Any, torchaudio: Any) -> tuple[Any, int]:
    """Decode mono signed 16-bit little-endian PCM directly into memory."""
    if not isinstance(pcm, bytes) or not pcm:
        raise ValueError("PCM input must be non-empty bytes")
    if len(pcm) % 2:
        raise ValueError("16-bit PCM input must contain a whole number of samples")
    if not isinstance(sample_rate_hz, int) or isinstance(sample_rate_hz, bool) or sample_rate_hz <= 0:
        raise ValueError("sample rate must be a positive integer")
    duration_seconds = len(pcm) / (2 * sample_rate_hz)
    if duration_seconds > MAX_PCM_ALIGNMENT_SECONDS:
        raise ValueError(f"PCM input exceeds the {MAX_PCM_ALIGNMENT_SECONDS}-second native alignment limit")
    # Copy once into owned writable memory so torch never retains the caller's
    # buffer and no temporary audio path is needed.
    waveform = torch.frombuffer(bytearray(pcm), dtype=torch.int16)
    waveform = waveform.to(dtype=torch.float32).div_(32768.0).unsqueeze(0)
    return _normalize_waveform(waveform, sample_rate_hz, torchaudio, torch)


def _make_target(text: str, labels: tuple[str, ...], torch: Any) -> tuple[Any, list[tuple[int, int, str]]]:
    """Build a CTC character sequence and retain source-word ownership."""
    if any(character.isdigit() or (not character.isascii() and character.isalpha()) for character in text):
        raise ValueError("unsupported non-English or numeric lyric characters; no partial alignment was attempted")
    label_to_id = {label: index for index, label in enumerate(labels)}
    words: list[tuple[int, int, str]] = []
    token_ids: list[int] = []
    matches = list(_WORD_RE.finditer(text))
    delimiter_id = label_to_id.get("|")
    for match_index, match in enumerate(matches):
        word = match.group(0)
        if match_index:
            if delimiter_id is None:
                raise ValueError("the selected CTC model has no word delimiter token")
            token_ids.append(delimiter_id)
        start = len(token_ids)
        normalized = word.replace("’", "'").upper()
        for character in normalized:
            token_id = label_to_id.get(character)
            if token_id is None:
                raise ValueError(f"unsupported character {character!r} in supplied lyric word {word!r}")
            token_ids.append(token_id)
        words.append((start, len(token_ids), word))
    if not words:
        raise ValueError("supplied lyrics contain no alignable English words")
    return torch.tensor([token_ids], dtype=torch.int32), words


def _checkpoint_revision(torch: Any) -> str:
    checkpoint = Path(torch.hub.get_dir()) / "checkpoints" / MODEL_CHECKPOINT
    if not checkpoint.is_file():
        raise RuntimeError("the expected Torchaudio alignment checkpoint is missing from the local model cache")
    digest = hashlib.sha256()
    with checkpoint.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    revision = digest.hexdigest()
    if revision != MODEL_SHA256:
        raise RuntimeError("the local Torchaudio alignment checkpoint does not match the pinned SHA-256")
    return f"sha256:{revision}"


def _is_exact_zero_energy(waveform: Any, torch: Any) -> bool:
    """Detect exact digital silence without a near-silence threshold."""
    return torch.count_nonzero(waveform).item() == 0


def _target_frame_groups(aligned_tokens: Any, token_ids: Any, blank_id: int = 0) -> tuple[list[list[int]] | None, str | None]:
    """Map CTC frames to target-token ordinals, rejecting malformed paths."""
    frame_tokens = aligned_tokens[0].tolist()
    targets = token_ids[0].tolist()
    target_frames: list[list[int]] = []
    target_index = -1
    active_token: int | None = None
    for frame, token in enumerate(frame_tokens):
        if token == blank_id:
            active_token = None
            continue
        if active_token != token:
            target_index += 1
            if target_index >= len(targets) or targets[target_index] != token:
                return None, "The CTC output did not reproduce the supplied token path; no word intervals emitted."
            target_frames.append([])
            active_token = token
        target_frames[target_index].append(frame)

    if len(target_frames) != len(targets):
        return None, "The CTC output omitted supplied transcript tokens; no complete word intervals emitted."
    return target_frames, None


def _frame_words(
    aligned_tokens: Any,
    token_ids: Any,
    word_spans: list[tuple[int, int, str]],
    blank_id: int,
    duration_ms: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Convert native CTC frame assignments into word intervals."""
    frame_tokens = aligned_tokens[0].tolist()
    target_frames, error = _target_frame_groups(aligned_tokens, token_ids, blank_id)
    if error or target_frames is None:
        return [], [error or "The CTC output path is unavailable; no word intervals emitted."]
    warnings: list[str] = []
    frame_ms = duration_ms / max(1, len(frame_tokens))

    output: list[dict[str, Any]] = []
    for word_index, (start_token, end_token, word) in enumerate(word_spans):
        assigned = [frame for token_frames in target_frames[start_token:end_token] for frame in token_frames]
        first_frame = min(assigned) if assigned else -1
        last_frame = max(assigned) + 1 if assigned else -1

        if first_frame < 0 or last_frame <= first_frame:
            warnings.append(f"No CTC frames were assigned to supplied word {word!r}; that region is unsupported.")
            continue

        start_ms = max(0, min(duration_ms, round(first_frame * frame_ms)))
        end_ms = max(start_ms, min(duration_ms, round(last_frame * frame_ms)))
        if end_ms <= start_ms:
            warnings.append(f"Supplied word {word!r} is shorter than the model's frame resolution; omitted.")
            continue
        output.append({
            "text": word,
            "startMs": int(start_ms),
            "endMs": int(end_ms),
            "wordIndex": word_index,
        })
    return output, warnings


def _collapse_greedy_path(token_ids: list[int], labels: tuple[str, ...], blank_id: int = 0) -> list[str]:
    """Greedy CTC decode to normalized word tokens; callers must not expose it."""
    emitted: list[str] = []
    active_token: int | None = None
    for token in token_ids:
        if token == blank_id:
            active_token = blank_id
            continue
        if token != active_token and 0 <= token < len(labels):
            emitted.append(labels[token])
        active_token = token

    words: list[str] = []
    current: list[str] = []
    for label in emitted:
        if label == "|":
            if current:
                words.append("".join(current).upper().replace("’", "'"))
                current = []
        else:
            current.append(label)
    if current:
        words.append("".join(current).upper().replace("’", "'"))
    return words


def _word_edit_distance(supplied: list[str], greedy: list[str]) -> int:
    """Compute bounded-row Levenshtein distance without retaining transcript text."""
    previous = list(range(len(greedy) + 1))
    for row_index, supplied_word in enumerate(supplied, start=1):
        current = [row_index]
        for column_index, greedy_word in enumerate(greedy, start=1):
            current.append(min(
                current[column_index - 1] + 1,
                previous[column_index] + 1,
                previous[column_index - 1] + (supplied_word != greedy_word),
            ))
        previous = current
    return previous[-1]


def _greedy_consistency(
    greedy_token_ids: list[int],
    aligned_token_ids: list[int],
    aligned_frame_scores: list[float],
    target_frames: list[list[int]] | None,
    word_spans: list[tuple[int, int, str]],
    labels: tuple[str, ...],
    blank_id: int = 0,
) -> dict[str, Any]:
    """Return numeric same-model consistency only; never return greedy words."""
    supplied_words = [word.replace("’", "'").upper() for _start, _end, word in word_spans]
    greedy_words = _collapse_greedy_path(greedy_token_ids, labels, blank_id)
    longest = max(len(supplied_words), len(greedy_words))
    matched_fraction = 0.0 if longest == 0 else 1 - _word_edit_distance(supplied_words, greedy_words) / longest
    per_word: list[dict[str, Any]] = []
    # `target_frames` contains one list per character, while each word span
    # addresses a contiguous subrange of that list.
    if target_frames is not None:
        for word_index, (token_start, token_end, _word) in enumerate(word_spans):
            frames = [frame for token_group in target_frames[token_start:token_end] for frame in token_group]
            if not frames or any(frame >= len(greedy_token_ids) or frame >= len(aligned_frame_scores) for frame in frames):
                per_word.append({
                    "wordIndex": word_index,
                    "forcedFrameCount": 0,
                    "greedyTop1FrameFraction": None,
                    "meanForcedLogProb": None,
                })
                continue
            forced_frames = sum(greedy_token_ids[frame] == aligned_token_ids[frame] for frame in frames)
            scores = [float(aligned_frame_scores[frame]) for frame in frames]
            per_word.append({
                "wordIndex": word_index,
                "forcedFrameCount": len(frames),
                "greedyTop1FrameFraction": forced_frames / len(frames),
                "meanForcedLogProb": sum(scores) / len(scores) if all(math.isfinite(score) and score <= 0 for score in scores) else None,
            })
    return {
        "method": "same-model-greedy-vs-forced-ctc",
        "calibrated": False,
        "wordCount": len(supplied_words),
        "greedyWordCount": len(greedy_words),
        "matchedWordFraction": max(0.0, min(1.0, matched_fraction)),
        "words": per_word,
    }


def _align_waveform(waveform: Any, sample_rate: int, text: str, language: str, started: float,
                    max_audio_seconds: int = MAX_AUDIO_SECONDS) -> dict[str, Any]:
    """Run the shared supplied-text CTC path on a normalized in-memory waveform."""
    import torch
    import torchaudio

    if language.lower() not in {"en", "eng", "english"}:
        raise ValueError(f"unsupported language {language!r}; this adapter supports English only")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("supplied lyrics must be a non-empty string")
    duration_ms = waveform.shape[1] * 1000.0 / sample_rate
    if duration_ms > max_audio_seconds * 1000:
        raise ValueError(f"audio exceeds the {max_audio_seconds}-second native alignment limit")
    if _is_exact_zero_energy(waveform, torch):
        return {
            "words": [],
            "alignmentKind": "supplied-text-ctc",
            "adapter": "torchaudio-ctc-forced-alignment",
            "model": MODEL_NAME,
            "modelRevision": _checkpoint_revision(torch),
            "reasonCode": "SILENT_AUDIO",
            "warnings": [
                "SILENT_AUDIO: every input sample is exactly zero, so no word intervals were emitted.",
                "This exact-zero gate does not classify near-silence or other low-energy audio.",
            ],
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "modelLoadMs": 0,
            "inferenceMs": 0,
            "audioDurationMs": round(duration_ms),
            "sampleRateHz": sample_rate,
        }
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model_started = time.perf_counter()
    model = bundle.get_model().eval()
    model_load_ms = round((time.perf_counter() - model_started) * 1000)
    labels = bundle.get_labels()
    token_ids, word_spans = _make_target(text, labels, torch)

    # A CTC path needs one frame per target token and an intervening blank for
    # every repeated adjacent token. Fail rather than return fabricated spans.
    targets = token_ids[0].tolist()
    minimum_frames = len(targets) + sum(a == b for a, b in zip(targets, targets[1:]))
    inference_started = time.perf_counter()
    with torch.inference_mode():
        emissions, _ = model(waveform)
        log_probs = torch.log_softmax(emissions, dim=-1)
    inference_ms = round((time.perf_counter() - inference_started) * 1000)
    frame_count = int(log_probs.shape[1])
    if frame_count < minimum_frames:
        return {
            "words": [],
            "alignmentKind": "supplied-text-ctc",
            "adapter": "torchaudio-ctc-forced-alignment",
            "model": MODEL_NAME,
            "modelRevision": _checkpoint_revision(torch),
            "warnings": [
                f"Supplied text needs at least {minimum_frames} CTC frames but audio produced {frame_count}; no words aligned.",
                "The adapter aligns only supplied English text; no speech recognition or singing accuracy is claimed.",
            ],
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "modelLoadMs": model_load_ms,
            "inferenceMs": inference_ms,
            "audioDurationMs": round(duration_ms),
            "sampleRateHz": sample_rate,
        }

    input_lengths = torch.tensor([frame_count], dtype=torch.int32)
    target_lengths = torch.tensor([len(targets)], dtype=torch.int32)
    align_started = time.perf_counter()
    aligned_tokens, aligned_scores = torchaudio.functional.forced_align(
        log_probs,
        token_ids,
        input_lengths=input_lengths,
        target_lengths=target_lengths,
        blank=0,
    )
    forced_alignment_ms = round((time.perf_counter() - align_started) * 1000)
    words, warnings = _frame_words(aligned_tokens, token_ids, word_spans, 0, duration_ms)
    target_frames, _path_error = _target_frame_groups(aligned_tokens, token_ids, 0)
    greedy_consistency = _greedy_consistency(
        log_probs[0].argmax(dim=-1).tolist(),
        aligned_tokens[0].tolist(),
        aligned_scores[0].tolist(),
        target_frames,
        word_spans,
        labels,
        0,
    )
    warnings.extend(
        [
            "The model aligned the supplied lyrics directly; no ASR transcript or interpolated word times were used.",
            "No confidence score is returned. CTC forced alignment can place incorrect or inaudible supplied words; review the audio.",
            "The English model is speech-trained; singing, backing vocals, and overlapping voices are unvalidated.",
        ]
    )
    return {
        "words": words,
        "alignmentKind": "supplied-text-ctc",
        "adapter": "torchaudio-ctc-forced-alignment",
        "model": MODEL_NAME,
        "modelRevision": _checkpoint_revision(torch),
        "diagnostics": {"greedyConsistency": greedy_consistency},
        "warnings": warnings,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "modelLoadMs": model_load_ms,
        "inferenceMs": inference_ms,
        "forcedAlignmentMs": forced_alignment_ms,
        "audioDurationMs": round(duration_ms),
        "sampleRateHz": sample_rate,
    }


def align_samples(pcm: bytes, text: str, sample_rate_hz: int = 16_000, language: str = "en") -> dict[str, Any]:
    """Align supplied English lyrics to in-memory mono s16le PCM.

    This entry point is bounded to 12 seconds and never materializes an audio
    file. The returned metadata and word anchors match :func:`align`.
    """
    try:
        import torch
        import torchaudio
    except ImportError as exc:
        raise RuntimeError(
            "native CTC alignment requires the isolated runtime dependencies torch and torchaudio"
        ) from exc
    started = time.perf_counter()
    waveform, sample_rate = _load_pcm_samples(pcm, sample_rate_hz, torch, torchaudio)
    return _align_waveform(waveform, sample_rate, text, language, started, MAX_PCM_ALIGNMENT_SECONDS)


def align(audio_path: str, text: str, language: str = "en") -> dict[str, Any]:
    """Align supplied English lyrics to local audio with TorchAudio CTC.

    Returned times are derived from actual model-assigned CTC acoustic frames.
    They are not generated from lyric order, ASR timestamps, duration scaling,
    or interpolation. CTC forced alignment will still attempt to place text
    that is absent from audio, so outputs must be reviewed.
    """
    if language.lower() not in {"en", "eng", "english"}:
        raise ValueError(f"unsupported language {language!r}; this adapter supports English only")
    audio_file = Path(audio_path)
    if not audio_file.is_file():
        raise FileNotFoundError(f"audio file does not exist: {audio_file}")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("supplied lyrics must be a non-empty string")
    try:
        import torch
        import torchaudio
    except ImportError as exc:
        raise RuntimeError(
            "native CTC alignment requires the isolated runtime dependencies torch and torchaudio"
        ) from exc

    started = time.perf_counter()
    waveform, sample_rate = _load_audio(str(audio_file), torchaudio, torch)
    return _align_waveform(waveform, sample_rate, text, language, started)
