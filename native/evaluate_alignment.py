#!/usr/bin/env python3
"""Compare review proposals with explicitly selected, human-marked score words."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native.companion import CompanionError, _validate_score, _validate_receipt

MAX_BYTES = 5 * 1024 * 1024


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _summary(values):
    if not values:
        return None
    absolute = sorted(abs(value) for value in values)
    return {"count": len(values), "meanSignedMs": statistics.mean(values),
            "medianAbsoluteMs": statistics.median(absolute),
            "p90AbsoluteMs": absolute[math.ceil(0.9 * len(absolute)) - 1],
            "maxAbsoluteMs": absolute[-1]}


def evaluate(package, reference, word_ids, *, human_reviewed=False):
    """Human-review assertion is caller provenance, never inferred from a lock."""
    if human_reviewed is not True:
        raise CompanionError("HUMAN_REFERENCE_REQUIRED", "Confirm that selected boundaries were marked by listening, not copied from proposals.")
    if not isinstance(package, dict) or package.get("version") != "lyricvibe.review.v1":
        raise CompanionError("INVALID_PACKAGE", "A local review package is required.")
    baseline, receipt = package.get("score"), package.get("receipt")
    base_identity = _validate_score(baseline)
    ref_identity = _validate_score(reference)
    _validate_receipt(baseline, receipt)
    if base_identity["mediaKey"] != ref_identity["mediaKey"]:
        raise CompanionError("SOURCE_MISMATCH", "Reference belongs to another video.")
    if baseline["lyrics"]["contentHash"] != reference["lyrics"]["contentHash"]:
        raise CompanionError("LYRICS_MISMATCH", "Reference belongs to another lyric revision.")
    audio = package.get("audio")
    audio_hash = audio.get("sha256") if isinstance(audio, dict) else None
    if not isinstance(audio_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", audio_hash):
        raise CompanionError("INVALID_RECORDING_IDENTITY", "Review package needs an exact recording SHA-256.")
    def words(score):
        return {word["id"]: word for phrase in score["phrases"] for word in phrase["words"]}
    base_words, ref_words = words(baseline), words(reference)
    if {key: value["text"] for key, value in base_words.items()} != {key: value["text"] for key, value in ref_words.items()}:
        raise CompanionError("LEXICAL_MISMATCH", "Reference must preserve all word IDs and exact supplied text.")
    if not isinstance(word_ids, list) or not 1 <= len(word_ids) <= 5000 or any(not isinstance(key, str) for key in word_ids) or len(set(word_ids)) != len(word_ids):
        raise CompanionError("INVALID_SELECTION", "Select distinct word IDs explicitly.")
    proposals = {proposal["wordId"]: proposal for proposal in receipt["proposals"]}
    rows, unsupported = [], []
    for word_id in word_ids:
        word = ref_words.get(word_id)
        if word is None or word.get("provenance") != "manual" or word.get("locked") is not True:
            raise CompanionError("UNMARKED_REFERENCE", "Each selected word must have protected manual timing.")
        start, end = word["startMs"] + reference["offsetMs"], word["endMs"] + reference["offsetMs"]
        if start < 0 or end <= start or end > reference["source"]["durationMs"]:
            raise CompanionError("INVALID_REFERENCE_INTERVAL", "Reference boundaries must be nonempty and fit the recording.")
        if word_id not in proposals:
            unsupported.append({"wordId": word_id, "reason": "no-candidate-proposal"})
            continue
        proposal = proposals[word_id]
        candidate_start = proposal["startMs"] + baseline["offsetMs"]
        candidate_end = proposal["endMs"] + baseline["offsetMs"]
        rows.append({"wordId": word_id, "referenceStartMs": start, "referenceEndMs": end,
                     "candidateStartMs": candidate_start, "candidateEndMs": candidate_end,
                     "onsetErrorMs": candidate_start - start, "releaseErrorMs": candidate_end - end,
                     "durationErrorMs": (candidate_end - candidate_start) - (end - start)})
    return {"version": "lyricvibe.timing-evaluation.v1", "mediaKey": base_identity["mediaKey"],
            "lyricsHash": baseline["lyrics"]["contentHash"], "recordingSha256": audio_hash,
            "recordingHashBasis": "review-package-metadata-not-rehashed",
            "baselineRevision": baseline["revision"], "referenceRevision": reference["revision"],
            "candidateAdapter": receipt["adapter"], "candidateModel": receipt["model"],
            "inputDigestBasis": "sha256-of-canonical-json-utf8",
            "inputDigests": {"baselineScore": _digest(baseline), "referenceScore": _digest(reference), "receipt": _digest(receipt)},
            "referenceBasis": "caller-asserted-listened-manual-boundaries", "humanReviewIndependentlyVerified": False,
            "errorConvention": "candidate-minus-reference; positive onset/release means late",
            "percentileMethod": "nearest-rank", "selectedWordCount": len(word_ids), "matchedWordCount": len(rows),
            "coverage": len(rows) / len(word_ids), "words": rows, "unsupported": unsupported,
            "summary": {key: _summary([row[key] for row in rows]) for key in ("onsetErrorMs", "releaseErrorMs", "durationErrorMs")},
            "calibrated": False, "automaticAdmissionEnabled": False}


def _read(path):
    with path.open("rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise CompanionError("INPUT_TOO_LARGE", "Evaluation input exceeds 5 MiB.")
    return json.loads(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--word-id", required=True, action="append")
    parser.add_argument("--human-reviewed", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = evaluate(_read(args.package), _read(args.reference), args.word_id, human_reviewed=args.human_reviewed)
        # Never overwrite an input, existing measurement, or another task's file.
        with args.output.open("x", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, allow_nan=False)
            handle.write("\n")
        print(json.dumps({"ok": True, "matchedWordCount": result["matchedWordCount"], "selectedWordCount": result["selectedWordCount"], "calibrated": False}))
        return 0
    except (CompanionError, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": {"code": getattr(error, "code", "EVALUATION_FAILED"), "message": "Timing evaluation failed; inputs and existing outputs were preserved."}}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
