"""Experimental, review-only known-lyrics follower using cached greedy CTC.

Unlike forced alignment, this module decodes the unconstrained CTC top-1 path
from a bounded rolling PCM window and then matches exact word runs against a
caller-supplied sequence. It never returns the decoded transcript or mutates a
score. Word times remain approximate and uncalibrated for singing.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import time
import unicodedata
from typing import Any, Iterable

from . import alignment


MAX_WINDOW_SECONDS = 12
MIN_WINDOW_SECONDS = 2
MAX_LYRIC_WORDS = 5_000
MIN_EXACT_RUN = 2
MAX_LOOKAHEAD_WORDS = 40
MAX_CURSOR_JUMP = 8


class GuideFollowerError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class _DecodedWord:
    text: str
    start_ms: int
    end_ms: int


def _normalize_token(text: str) -> str:
    return "".join(
        char.casefold()
        for char in unicodedata.normalize("NFKC", text)
        if unicodedata.category(char)[0] in {"L", "N"}
    )


def _decode_greedy_frames(
    token_ids: Iterable[int], labels: tuple[str, ...], *, duration_ms: float, blank_id: int = 0,
) -> list[_DecodedWord]:
    """Collapse a framewise CTC argmax path without exposing text to callers."""
    frames = list(token_ids)
    if not frames or not math.isfinite(duration_ms) or duration_ms <= 0:
        return []
    emitted: list[tuple[str, int]] = []
    previous: int | None = None
    for frame_index, token_id in enumerate(frames):
        if token_id == blank_id:
            previous = blank_id
        else:
            if token_id != previous and 0 <= token_id < len(labels):
                emitted.append((labels[token_id], frame_index))
            previous = token_id

    words: list[_DecodedWord] = []
    characters: list[str] = []
    word_start: int | None = None
    last_character_frame: int | None = None

    def flush(end_frame: int) -> None:
        nonlocal characters, word_start, last_character_frame
        if characters and word_start is not None and last_character_frame is not None:
            frame_ms = duration_ms / len(frames)
            text = "".join(characters).upper()
            if _normalize_token(text):
                start_ms = max(0, min(round(duration_ms), round(word_start * frame_ms)))
                end_ms = max(start_ms, min(round(duration_ms), round((last_character_frame + 1) * frame_ms)))
                if end_ms > start_ms:
                    words.append(_DecodedWord(text, start_ms, end_ms))
        characters = []
        word_start = None
        last_character_frame = None

    for label, frame_index in emitted:
        if label == "|":
            flush(frame_index)
        else:
            if word_start is None:
                word_start = frame_index
            characters.append(label)
            last_character_frame = frame_index
    flush(len(frames) - 1)
    return words


class CachedCtcRuntime:
    """One cached local model instance, reused across rolling windows."""

    def __init__(self, *, model: Any = None, labels: tuple[str, ...] | None = None):
        try:
            import torch
            import torchaudio
        except Exception as error:
            raise GuideFollowerError("RUNTIME_NOT_READY", "Local Torch/Torchaudio runtime is unavailable.") from error

        self.torch = torch
        self.torchaudio = torchaudio
        self.bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        # Refuse before bundle.get_model() can fetch weights from the network.
        try:
            self.model_revision = alignment._checkpoint_revision(torch)
            self.model = model if model is not None else self.bundle.get_model().eval()
            self.labels = labels if labels is not None else self.bundle.get_labels()
        except Exception as error:
            raise GuideFollowerError("RUNTIME_NOT_READY", "The pinned local CTC checkpoint is unavailable or failed to load.") from error

    @classmethod
    def cache_ready(cls) -> bool:
        """Check the pinned local cache without constructing or fetching the model."""
        try:
            import torch

            alignment._checkpoint_revision(torch)
            return True
        except Exception:
            return False

    def decode(self, pcm: bytes, sample_rate_hz: int = 16_000) -> tuple[list[_DecodedWord], int]:
        started = time.perf_counter()
        if (
            isinstance(pcm, bytes) and len(pcm) % 2 == 0
            and isinstance(sample_rate_hz, int) and not isinstance(sample_rate_hz, bool)
            and sample_rate_hz > 0
            and len(pcm) / (2 * sample_rate_hz) > MAX_WINDOW_SECONDS
        ):
            raise GuideFollowerError("WINDOW_TOO_LONG", "Follower windows are limited to 12 seconds.")
        try:
            waveform, sample_rate = alignment._load_pcm_samples(
                pcm, sample_rate_hz, self.torch, self.torchaudio
            )
        except ValueError as error:
            raise GuideFollowerError("INVALID_PCM", "PCM must be valid mono s16le within the 12-second window limit.") from error
        duration_ms = waveform.shape[1] * 1000.0 / sample_rate
        if duration_ms < MIN_WINDOW_SECONDS * 1000:
            raise GuideFollowerError("WINDOW_TOO_SHORT", "Follower windows must contain at least 2 seconds.")
        if duration_ms > MAX_WINDOW_SECONDS * 1000:
            raise GuideFollowerError("WINDOW_TOO_LONG", "Follower windows are limited to 12 seconds.")
        try:
            with self.torch.inference_mode():
                emissions, _ = self.model(waveform)
            tokens = emissions[0].argmax(dim=-1).tolist()
            decoded = _decode_greedy_frames(tokens, tuple(self.labels), duration_ms=duration_ms)
        except Exception as error:
            raise GuideFollowerError("MODEL_INFERENCE_FAILED", "The local CTC runtime could not process this window.") from error
        return decoded, round((time.perf_counter() - started) * 1000)


class GuideFollower:
    """Match exact consecutive greedy words to a supplied lyric sequence.

    ``observe_pcm`` is the normal API. ``observe_decoded`` is provided for
    deterministic tests and for callers that already own the same decoder.
    Returned events deliberately carry no transcript text or confidence.
    """

    def __init__(self, words: list[dict[str, str]], *, runtime: CachedCtcRuntime | None = None):
        if not isinstance(words, list) or not 0 < len(words) <= MAX_LYRIC_WORDS:
            raise GuideFollowerError("INVALID_LYRICS", "Follower requires a bounded nonempty supplied word list.")
        self.words: list[tuple[str, str]] = []
        seen: set[str] = set()
        for word in words:
            if not isinstance(word, dict) or not isinstance(word.get("id"), str) or not isinstance(word.get("text"), str):
                raise GuideFollowerError("INVALID_LYRICS", "Each supplied word needs a stable ID and text.")
            normalized = _normalize_token(word["text"])
            if not normalized or word["id"] in seen:
                raise GuideFollowerError("INVALID_LYRICS", "Supplied words need nonempty normalized text and unique IDs.")
            seen.add(word["id"])
            self.words.append((word["id"], normalized))
        self.runtime = runtime
        self.cursor = 0
        self.source_epoch: str | int | None = None
        self.last_window_start_ms: int | None = None

    def reset(self, source_epoch: str | int | None = None) -> None:
        self.cursor = 0
        self.source_epoch = source_epoch
        self.last_window_start_ms = None

    def observe_pcm(
        self,
        pcm: bytes,
        *,
        source_epoch: str | int,
        window_start_ms: int,
        seeking: bool = False,
        sample_rate_hz: int = 16_000,
    ) -> dict[str, Any]:
        if self.runtime is None:
            raise GuideFollowerError("RUNTIME_NOT_READY", "No cached local CTC runtime was provided.")
        decoded, processing_ms = self.runtime.decode(pcm, sample_rate_hz)
        event = self.observe_decoded(
            decoded, source_epoch=source_epoch, window_start_ms=window_start_ms, seeking=seeking
        )
        event["processingMs"] = processing_ms
        event["modelRevision"] = self.runtime.model_revision
        return event

    def observe_decoded(
        self,
        decoded_words: list[_DecodedWord] | list[dict[str, Any]],
        *,
        source_epoch: str | int,
        window_start_ms: int,
        seeking: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(source_epoch, (str, int)) or isinstance(source_epoch, bool):
            raise GuideFollowerError("INVALID_SOURCE_EPOCH", "Source epoch must be a string or integer identity.")
        if not isinstance(window_start_ms, int) or isinstance(window_start_ms, bool) or window_start_ms < 0:
            raise GuideFollowerError("INVALID_MEDIA_TIME", "Window start must be nonnegative source-media milliseconds.")
        reset_reason = None
        if self.source_epoch is not None and source_epoch != self.source_epoch:
            reset_reason = "source-epoch-changed"
        elif seeking or (self.last_window_start_ms is not None and window_start_ms < self.last_window_start_ms):
            reset_reason = "seek-or-backward-clock"
        if reset_reason:
            self.reset(source_epoch)
            # Decoded words from the window that exposed a seek/epoch change
            # belong to the old presentation context. Require a fresh decode.
            self._remember_window(window_start_ms)
            return self._event("unsupported", "source-context-reset", reset_reason=reset_reason)
        elif self.source_epoch is None:
            self.source_epoch = source_epoch

        if self.last_window_start_ms is not None and window_start_ms <= self.last_window_start_ms:
            return self._event("unsupported", "stale-or-duplicate-window")

        decoded: list[tuple[str, int, int]] = []
        for item in decoded_words:
            if isinstance(item, _DecodedWord):
                token, start, end = item.text, item.start_ms, item.end_ms
            elif isinstance(item, dict):
                token, start, end = item.get("text"), item.get("startMs"), item.get("endMs")
            else:
                continue
            if (
                isinstance(token, str) and isinstance(start, int) and not isinstance(start, bool)
                and isinstance(end, int) and not isinstance(end, bool) and 0 <= start < end <= MAX_WINDOW_SECONDS * 1000
            ):
                normalized = _normalize_token(token)
                if normalized:
                    decoded.append((normalized, start, end))

        prior_cursor = self.cursor
        search_start = max(0, self.cursor - 1)
        search_end = min(len(self.words), search_start + MAX_LOOKAHEAD_WORDS)
        candidates: list[tuple[int, int, int, int]] = []
        for target_start in range(search_start, search_end):
            for decoded_start in range(len(decoded)):
                run = 0
                while (
                    target_start + run < search_end and decoded_start + run < len(decoded)
                    and self.words[target_start + run][1] == decoded[decoded_start + run][0]
                ):
                    run += 1
                if run >= MIN_EXACT_RUN:
                    last_decoded = decoded_start + run - 1
                    candidates.append((run, target_start, last_decoded, target_start + run - 1))
        if not candidates:
            self._remember_window(window_start_ms)
            return self._event("unsupported", "insufficient-consecutive-lexical-evidence", reset_reason=reset_reason)

        best_run = max(row[0] for row in candidates)
        best = [row for row in candidates if row[0] == best_run]
        # A duplicate phrase in the lyric sequence or in the current decoded
        # window leaves its source location ambiguous. Never choose the latest
        # occurrence as a hidden tie-breaker.
        best_matches = {(row[1], row[2], row[3]) for row in best}
        if len(best_matches) != 1:
            self._remember_window(window_start_ms)
            return self._event("unsupported", "ambiguous-repeated-lyrics", reset_reason=reset_reason)
        run, target_start, decoded_end, target_end = best[0]
        if target_end < prior_cursor:
            self._remember_window(window_start_ms)
            return self._event("unsupported", "no-new-lexical-progress", reset_reason=reset_reason)
        if target_end - prior_cursor > MAX_CURSOR_JUMP:
            self._remember_window(window_start_ms)
            return self._event("unsupported", "lyric-cursor-jump-too-large", reset_reason=reset_reason)

        decoded_start_index = decoded_end - run + 1
        run_start_ms = decoded[decoded_start_index][1]
        word_start_ms = decoded[decoded_end][1]
        decoded_end_ms = decoded[decoded_end][2]
        self.cursor = target_end + 1
        self._remember_window(window_start_ms)
        word_id = self.words[target_end][0]
        return {
            "status": "provisional",
            "reason": "unique-consecutive-greedy-word-match",
            "wordId": word_id,
            "wordIndex": target_end,
            "approximateSourceStartMs": window_start_ms + word_start_ms,
            "approximateSourceEndMs": window_start_ms + decoded_end_ms,
            "matchedRunStartMs": window_start_ms + run_start_ms,
            "matchedRunEndMs": window_start_ms + decoded_end_ms,
            "matchedRunLength": run,
            "cursorAdvanced": self.cursor > prior_cursor,
            "resetReason": reset_reason,
            "calibrated": False,
            "scoreMutation": False,
        }

    def _remember_window(self, window_start_ms: int) -> None:
        self.last_window_start_ms = window_start_ms

    def _event(self, status: str, reason: str, *, reset_reason: str | None = None) -> dict[str, Any]:
        return {
            "status": status,
            "reason": reason,
            "cursorWordIndex": self.cursor,
            "resetReason": reset_reason,
            "calibrated": False,
            "scoreMutation": False,
        }

