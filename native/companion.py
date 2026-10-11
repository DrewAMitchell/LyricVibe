#!/usr/bin/env python3
"""Create review-only word timing proposals from a validated LyricVibe score."""

from __future__ import annotations

import argparse
from collections import Counter
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
MAX_SCORE_BYTES = 10_000_000
MAX_WORDS = 5_000
MAX_WARNINGS = 100
MAX_WARNING_LENGTH = 500


class CompanionError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CompanionError("INVALID_ARGUMENT", "Command arguments are incomplete or invalid.")


def _json_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _validate_score(score: Any) -> dict[str, Any]:
    """Use the shared JS score validator without a shell or interpolated data."""
    script = (
        "const fs=require('node:fs'); const LvScore=require('./extension/score-core.js'); "
        "try { const score=JSON.parse(fs.readFileSync(0,'utf8')); "
        "LvScore.validateScore(score); const mediaKey=LvScore.mediaKey(score.source); "
        "if (!mediaKey) throw Object.assign(new Error('score has no exact media identity'),{code:'INVALID_SOURCE'}); "
        "process.stdout.write(JSON.stringify({ok:true,mediaKey})); } "
        "catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code||'INVALID_SCORE',message:'score validation failed'})); process.exitCode=1; }"
    )
    try:
        result = subprocess.run(
            ["node", "-e", script], input=json.dumps(score, ensure_ascii=False),
            text=True, capture_output=True, cwd=ROOT, timeout=15, check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CompanionError("SCORE_VALIDATOR_UNAVAILABLE", "Node.js score validation could not run.") from None
    try:
        body = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        raise CompanionError("SCORE_VALIDATOR_FAILED", "Shared score validation returned no result.") from None
    if result.returncode or not body.get("ok"):
        raise CompanionError(body.get("code", "INVALID_SCORE"), "The score is invalid under the shared LyricVibe schema.")
    return body


def _validate_receipt(score: dict[str, Any], receipt: dict[str, Any]) -> None:
    """Apply the shared source/revision/proposal receipt contract before writing."""
    script = (
        "const fs=require('node:fs'); const LvScore=require('./extension/score-core.js'); "
        "try { const input=JSON.parse(fs.readFileSync(0,'utf8')); "
        "LvScore.validateAlignmentReceipt(input.score,input.receipt); process.stdout.write('{\"ok\":true}'); } "
        "catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code||'INVALID_ALIGNMENT_RECEIPT'})); process.exitCode=1; }"
    )
    try:
        result = subprocess.run(
            ["node", "-e", script], input=json.dumps({"score": score, "receipt": receipt}, ensure_ascii=False),
            text=True, capture_output=True, cwd=ROOT, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CompanionError("RECEIPT_VALIDATOR_UNAVAILABLE", "Shared alignment receipt validation could not run.") from None
    try:
        body = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        raise CompanionError("RECEIPT_VALIDATOR_FAILED", "Shared receipt validation returned no result.") from None
    if result.returncode or not body.get("ok"):
        raise CompanionError(body.get("code", "INVALID_ALIGNMENT_RECEIPT"), "Generated receipt failed the shared LyricVibe alignment contract.")


def _load_aligner() -> Callable[..., dict[str, Any]]:
    try:
        from .alignment import align
    except ImportError:
        try:
            from alignment import align  # direct `python native/companion.py` execution
        except ImportError:
            raise CompanionError("ALIGNER_UNAVAILABLE", "The native alignment adapter is unavailable.") from None
    return align


def _validated_audio_path(path: Path) -> Path:
    try:
        from .audio_input import AudioInputError, validate_audio_input
    except ImportError:
        try:
            from audio_input import AudioInputError, validate_audio_input
        except ImportError:
            raise CompanionError("AUDIO_VALIDATOR_UNAVAILABLE", "The bounded WAV input validator is unavailable.") from None
    try:
        return validate_audio_input(path, max_duration_seconds=60).path
    except AudioInputError as error:
        raise CompanionError(error.code, str(error)) from None


def _normalize_word(text: Any) -> str:
    import unicodedata

    if not isinstance(text, str):
        return ""
    return "".join(ch.casefold() for ch in text if unicodedata.category(ch)[0] in {"L", "N"})


def _repeated_phrase_ids(phrases: list[dict[str, Any]]) -> set[str]:
    seen: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for phrase in phrases:
        words = phrase.get("words", [])
        key = tuple(_normalize_word(word.get("text")) for word in words)
        if key and all(key):
            seen.setdefault(key, []).append(phrase)
    repeated: set[str] = set()
    for copies in seen.values():
        if len(copies) > 1:
            repeated.update(word["id"] for phrase in copies for word in phrase.get("words", []))
    return repeated


def _sequence_matches(expected: list[str], actual: list[str]) -> dict[int, int]:
    """Map only exact tokens in ordered matching blocks; never synthesize anchors."""
    matcher = difflib.SequenceMatcher(a=expected, b=actual, autojunk=False)
    matches: dict[int, int] = {}
    for left, right, size in matcher.get_matching_blocks():
        for offset in range(size):
            if expected[left + offset]:
                matches[left + offset] = right + offset
    return matches


def _token_contexts(tokens: list[str]) -> list[tuple[str | None, str, str | None]]:
    return [(tokens[index - 1] if index else None, token,
             tokens[index + 1] if index + 1 < len(tokens) else None)
            for index, token in enumerate(tokens)]


def _bounded_warnings(value: Any, reason_code: Any = None) -> list[str]:
    warnings = ([item[:MAX_WARNING_LENGTH] for item in value[:MAX_WARNINGS] if isinstance(item, str)]
                if isinstance(value, list) else [])
    if (isinstance(reason_code, str) and reason_code and len(reason_code) <= 64 and
            all(character.isupper() or character.isdigit() or character == "_" for character in reason_code) and
            not any(reason_code in warning for warning in warnings)):
        warnings.insert(0, f"{reason_code}: alignment adapter reported a bounded result.")
    return warnings[:MAX_WARNINGS]


def analyze(
    score_path: str | os.PathLike[str],
    audio_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    language: str = "en",
    audio_start_ms: int = 0,
    phrase_ids: list[str] | None = None,
    align_fn: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run alignment and write a bounded, source-bound review receipt."""
    if not isinstance(audio_start_ms, int) or isinstance(audio_start_ms, bool) or audio_start_ms < 0:
        raise CompanionError("INVALID_AUDIO_START", "--audio-start-ms must be a nonnegative integer.")
    if not isinstance(language, str) or not language or len(language) > 35:
        raise CompanionError("INVALID_LANGUAGE", "Language must be a nonempty short language code.")
    score_file, audio_file = Path(score_path), Path(audio_path)
    try:
        if score_file.stat().st_size > MAX_SCORE_BYTES:
            raise CompanionError("SCORE_TOO_LARGE", "Score JSON exceeds the 10 MB input limit.")
        score = json.loads(score_file.read_text(encoding="utf-8"))
    except CompanionError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise CompanionError("SCORE_READ_FAILED", "Score JSON could not be read.") from None
    identity = _validate_score(score)
    audio_file = _validated_audio_path(audio_file)

    all_phrases = score.get("phrases", [])
    all_words = [word for phrase in all_phrases for word in phrase.get("words", [])]
    if len(all_words) > MAX_WORDS:
        raise CompanionError("SCORE_TOO_LARGE", f"Score exceeds the {MAX_WORDS}-word analysis limit.")
    lane_roles = {lane.get("id"): lane.get("role") for lane in score.get("lanes", [])}
    all_lead_phrases = [phrase for phrase in all_phrases if lane_roles.get(phrase.get("laneId")) == "lead"]
    repeated_ids = _repeated_phrase_ids(all_lead_phrases)

    requested_ids = [item.strip() for value in (phrase_ids or []) for item in value.split(",") if item.strip()]
    if len(requested_ids) != len(set(requested_ids)):
        raise CompanionError("INVALID_PHRASE_SELECTION", "Each phrase ID may be selected only once.")
    known_ids = {phrase.get("id") for phrase in all_lead_phrases}
    if requested_ids and any(phrase_id not in known_ids for phrase_id in requested_ids):
        raise CompanionError("INVALID_PHRASE_SELECTION", "Selected phrase IDs must identify lead-lane phrases in this score.")
    if requested_ids:
        by_id = {phrase.get("id"): phrase for phrase in all_lead_phrases}
        selected_order = [phrase for phrase in all_lead_phrases if phrase.get("id") in set(requested_ids)]
        selected_indices = [all_lead_phrases.index(by_id[phrase_id]) for phrase_id in requested_ids]
        if selected_indices != sorted(selected_indices) or (len(selected_indices) > 1 and selected_indices[-1] - selected_indices[0] + 1 != len(selected_indices)):
            raise CompanionError("INVALID_PHRASE_SELECTION", "Selected phrases must be a contiguous score-order range.")
        lead_phrases = selected_order
    else:
        lead_phrases = all_lead_phrases
    lead_phrases.sort(key=lambda phrase: (phrase.get("startMs", 0), phrase.get("id", "")))
    # Simultaneous lead phrases cannot be represented by a single transcript stream.
    overlapping_lead_ids: set[str] = set()
    for index, phrase in enumerate(lead_phrases):
        for other in lead_phrases[index + 1:]:
            if not phrase.get("endEstimated", True) and other.get("startMs", 0) >= phrase.get("endMs", 0):
                break
            if (not phrase.get("endEstimated", True) and not other.get("endEstimated", True) and
                    other.get("startMs", 0) < phrase.get("endMs", 0) and phrase.get("startMs", 0) < other.get("endMs", 0)):
                overlapping_lead_ids.update(word["id"] for item in (phrase, other) for word in item.get("words", []))

    transcript_words = [word for phrase in lead_phrases for word in phrase.get("words", [])]
    unsupported: list[dict[str, str]] = []
    selected_ids = {phrase.get("id") for phrase in lead_phrases}
    unsupported.extend({"phraseId": phrase.get("id", ""), "wordId": word["id"], "reason": "phrase-not-selected"}
                       for phrase in all_lead_phrases if phrase.get("id") not in selected_ids
                       for word in phrase.get("words", []))
    for phrase in all_phrases:
        if lane_roles.get(phrase.get("laneId")) != "lead":
            unsupported.extend({"phraseId": phrase.get("id", ""), "wordId": word["id"], "reason": "backing-lane-overlap-unsupported"} for word in phrase.get("words", []))
    if overlapping_lead_ids:
        unsupported.extend({"wordId": word["id"], "reason": "overlapping-lead-phrases-unsupported"} for word in transcript_words if word["id"] in overlapping_lead_ids)

    transcript = " ".join(word["text"] for word in transcript_words)
    if not transcript_words:
        raise CompanionError("NO_SUPPORTED_WORDS", "The score has no lead-lane words to align.")
    aligner = align_fn or _load_aligner()
    try:
        aligned = aligner(str(audio_file), transcript, language=language)
    except CompanionError:
        raise
    except Exception:
        raise CompanionError("ALIGNMENT_FAILED", "Native alignment failed; no audio or lyric text was logged.") from None
    if not isinstance(aligned, dict) or not isinstance(aligned.get("words"), list):
        raise CompanionError("ALIGNMENT_INVALID", "Alignment adapter returned an invalid word-anchor result.")
    anchors = aligned["words"][:MAX_WORDS]
    expected_tokens = [_normalize_word(word.get("text")) for word in transcript_words]
    actual_tokens = [_normalize_word(anchor.get("text")) if isinstance(anchor, dict) else "" for anchor in anchors]
    # A complete supplied-text CTC path already owns each target position.
    # Repeated words are distinct positions, not competing ASR candidates.
    # Partial or split token paths retain the conservative context matcher.
    ordinal_path = (aligned.get("alignmentKind") == "supplied-text-ctc" and
                    len(anchors) == len(transcript_words) and expected_tokens == actual_tokens and
                    all(anchor.get("wordIndex") == index and not isinstance(anchor.get("wordIndex"), bool)
                        for index, anchor in enumerate(anchors)))
    matches = {index: index for index in range(len(transcript_words))} if ordinal_path else _sequence_matches(expected_tokens, actual_tokens)
    reverse_counts: dict[int, int] = {}
    for actual_index in matches.values():
        reverse_counts[actual_index] = reverse_counts.get(actual_index, 0) + 1
    expected_contexts, actual_contexts = _token_contexts(expected_tokens), _token_contexts(actual_tokens)
    expected_context_counts, actual_context_counts = Counter(expected_contexts), Counter(actual_contexts)
    expected_token_counts, actual_token_counts = Counter(expected_tokens), Counter(actual_tokens)

    audio_hash = hashlib.sha256()
    try:
        with audio_file.open("rb") as audio_stream:
            for block in iter(lambda: audio_stream.read(1024 * 1024), b""):
                audio_hash.update(block)
    except OSError:
        raise CompanionError("AUDIO_READ_FAILED", "Audio input file could not be read.") from None

    proposals: list[dict[str, Any]] = []
    matched_expected = set(matches)
    for index, word in enumerate(transcript_words):
        if index not in matched_expected:
            unsupported.append({"wordId": word["id"], "reason": "unmatched-alignment-token"})
            continue
        anchor_index = matches[index]
        anchor = anchors[anchor_index]
        token_repeats = expected_token_counts[expected_tokens[index]] > 1 or actual_token_counts[actual_tokens[anchor_index]] > 1
        if not ordinal_path and (reverse_counts.get(anchor_index) != 1 or
                (token_repeats and (expected_context_counts[expected_contexts[index]] != 1 or
                                    actual_context_counts[actual_contexts[anchor_index]] != 1 or
                                    expected_contexts[index] != actual_contexts[anchor_index]))):
            unsupported.append({"wordId": word["id"], "reason": "ambiguous-alignment-token"})
            continue
        if word["id"] in overlapping_lead_ids:
            continue
        if word["id"] in repeated_ids and not ordinal_path:
            unsupported.append({"wordId": word["id"], "reason": "repeated-phrase-ambiguous"})
            continue
        if word.get("locked"):
            unsupported.append({"wordId": word["id"], "reason": "manual-word-lock"})
            continue
        if any(child.get("locked") for child in word.get("syllables", [])):
            unsupported.append({"wordId": word["id"], "reason": "manual-syllable-lock"})
            continue
        start_local, end_local = anchor.get("startMs"), anchor.get("endMs")
        if (not isinstance(start_local, (int, float)) or isinstance(start_local, bool) or
                not isinstance(end_local, (int, float)) or isinstance(end_local, bool) or
                not math.isfinite(start_local) or not math.isfinite(end_local) or end_local <= start_local):
            unsupported.append({"wordId": word["id"], "reason": "invalid-anchor-interval"})
            continue
        # The renderer evaluates mediaMs - score.offsetMs. Store model anchors back
        # in that score-time domain by subtracting the existing offset exactly once.
        start_ms = round(audio_start_ms + start_local - score.get("offsetMs", 0))
        end_ms = round(audio_start_ms + end_local - score.get("offsetMs", 0))
        if start_ms < 0 or end_ms <= start_ms:
            unsupported.append({"wordId": word["id"], "reason": "offset-adjusted-anchor-out-of-range"})
            continue
        evidence = f"{identity['mediaKey']}|{score['lyrics']['contentHash']}|{score['revision']}|{audio_hash.hexdigest()}|{word['id']}|{start_ms}|{end_ms}|{aligned.get('adapter','')}|{aligned.get('model','')}"
        proposals.append({
            "wordId": word["id"], "startMs": start_ms, "endMs": end_ms,
            "accepted": False, "evidenceId": hashlib.sha256(evidence.encode("utf-8")).hexdigest(),
        })

    adapter = aligned.get("adapter") if isinstance(aligned.get("adapter"), str) else "unknown"
    model = aligned.get("model") if isinstance(aligned.get("model"), str) else "unknown"
    if not adapter.strip() or not model.strip():
        raise CompanionError("ALIGNMENT_INVALID", "Adapter and model identity are required in alignment results.")
    receipt: dict[str, Any] = {
        "version": "lyricvibe.alignment.v1",
        "mediaKey": identity["mediaKey"],
        "lyricsHash": score["lyrics"]["contentHash"],
        "expectedRevision": score["revision"],
        "timeDomain": "score-time-before-offset",
        "audioStartMs": audio_start_ms,
        "adapter": adapter[:200], "model": model[:200],
        "proposals": proposals[:MAX_WORDS],
        "unsupported": unsupported[:MAX_WORDS],
        "warnings": _bounded_warnings(aligned.get("warnings"), aligned.get("reasonCode")),
        "automaticAdmissionEnabled": False,
        "wordMapping": "supplied-path-ordinal" if ordinal_path else "exact-neighbor-context",
    }
    if isinstance(aligned.get("modelRevision"), str):
        receipt["modelRevision"] = aligned["modelRevision"][:200]
    _validate_receipt(score, receipt)
    try:
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        raise CompanionError("OUTPUT_WRITE_FAILED", "Receipt could not be written to the requested output path.") from None
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description="Create review-only LyricVibe word timing proposals.")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=JsonArgumentParser)
    analyze_parser = commands.add_parser("analyze", help="align supplied score words to a local WAV")
    analyze_parser.add_argument("--score", required=True, help="validated LyricVibe score JSON")
    analyze_parser.add_argument("--audio", required=True, help="local WAV audio file")
    analyze_parser.add_argument("--output", required=True, help="explicit receipt JSON output path")
    analyze_parser.add_argument("--language", default="en", help="language code (default: en)")
    analyze_parser.add_argument("--audio-start-ms", type=int, default=0, help="source-media start time for this clip (default: 0)")
    analyze_parser.add_argument("--phrase-id", action="append", default=[], help="lead phrase ID to include (repeatable; comma-separated IDs also accepted; default: all lead phrases)")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "analyze":
            receipt = analyze(args.score, args.audio, args.output, args.language, args.audio_start_ms, args.phrase_id)
            print(json.dumps({"ok": True, "output": str(Path(args.output).resolve()), "proposalCount": len(receipt["proposals"]), "unsupportedCount": len(receipt["unsupported"])}))
            return 0
        raise CompanionError("COMMAND_UNKNOWN", "Unknown command.")
    except CompanionError as error:
        print(json.dumps(_json_error(error.code, str(error))))
        return 2
    except SystemExit as error:
        return int(error.code or 0)


if __name__ == "__main__":
    sys.exit(main())
