"""Pure, review-only grouping of manually confirmed guide taps.

Tap-to-unit identity is always explicit. This module derives numeric review
intervals only; it never edits a score or guesses a syllable segmentation.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import re
from typing import Any

from .pronunciation import lookup_word


REVIEW_VERSION = "lyricvibe.guide-review.v1"
SESSION_VERSION = "lyricvibe.guide-session.v1"
PACKAGE_VERSION = "lyricvibe.review.v1"
MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_CAPTURE_MS = 12_000
MAX_TAPS = 240  # 12 seconds at the UI's 50 ms repeat debounce.
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TAP_KINDS = {"manual-syllable-change", "manual-syllable-onset", "manual-note-change"}
_AUDIO_KEYS = {"audio", "pcm", "pcmbase64", "samples", "rawaudio", "audiobytes", "audiobase64", "audiopayload"}


class GuideGroupingError(ValueError):
    """Typed, content-free validation or review-operation failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _load(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, dict):
        obj = value
        try:
            encoded = json.dumps(obj, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            raise GuideGroupingError("INVALID_INPUT", f"{label} must be finite JSON data.") from None
        if len(encoded) > MAX_INPUT_BYTES:
            raise GuideGroupingError("INPUT_TOO_LARGE", f"{label} exceeds the 5 MiB bound.")
        return deepcopy(obj)
    try:
        path = Path(value).expanduser()
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise GuideGroupingError("INPUT_TOO_LARGE", f"{label} exceeds the 5 MiB bound.")
        obj = json.loads(path.read_text(encoding="utf-8"))
    except GuideGroupingError:
        raise
    except (OSError, TypeError, UnicodeError, json.JSONDecodeError):
        raise GuideGroupingError("INPUT_READ_FAILED", f"{label} could not be read as JSON.") from None
    if not isinstance(obj, dict):
        raise GuideGroupingError("INVALID_INPUT", f"{label} must be a JSON object.")
    return obj


def _reject_audio_payloads(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(key, str) and key.casefold().replace("_", "") in _AUDIO_KEYS:
                raise GuideGroupingError("AUDIO_PAYLOAD_FORBIDDEN", "Guide session contains an audio payload field.")
            _reject_audio_payloads(child)
    elif isinstance(value, list):
        for child in value:
            _reject_audio_payloads(child)


def _int(value: Any, *, minimum: int = 0, maximum: int = 2**53 - 1) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _safe_interval(start: Any, end: Any) -> bool:
    return _int(start) and _int(end) and start < end


def _unit_records(score: dict[str, Any], phrase: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    words = phrase.get("words")
    if not isinstance(words, list) or len(words) > 5_000:
        raise GuideGroupingError("INVALID_PHRASE", "Selected phrase word list is invalid or too large.")

    def add(unit_id: str, word: dict[str, Any], kind: str, start: Any, end: Any, child_locked: bool, child_id: str | None, word_index: int, child_index: int) -> None:
        if not unit_id or unit_id in seen_ids:
            raise GuideGroupingError("INVALID_SCORE_IDS", "Selected phrase contains duplicate or empty unit IDs.")
        seen_ids.add(unit_id)
        reason = None
        if not _safe_interval(start, end):
            reason = "invalid-score-interval"
        elif word.get("locked") is True:
            reason = "word-locked"
        elif child_locked:
            reason = "syllable-locked"
        result.append({
            "unitId": unit_id,
            "parentWordId": word["id"],
            "syllableId": child_id,
            "kind": kind,
            "wordIndex": word_index,
            "childIndex": child_index,
            "scoreStartMs": start if _int(start) else None,
            "scoreEndMs": end if _int(end) else None,
            "status": "available" if reason is None else "blocked",
            "reason": reason,
        })

    for word_index, word in enumerate(words):
        if not isinstance(word, dict) or not isinstance(word.get("id"), str) or not isinstance(word.get("text"), str):
            raise GuideGroupingError("INVALID_PHRASE", "Selected phrase contains an invalid word record.")
        children = word.get("syllables")
        if isinstance(children, list) and children:
            for child_index, child in enumerate(children):
                if not isinstance(child, dict) or not isinstance(child.get("id"), str):
                    raise GuideGroupingError("INVALID_SYLLABLES", "Existing syllable records need stable IDs.")
                add(child["id"], word, "syllable", child.get("startMs"), child.get("endMs"), child.get("locked") is True, child["id"], word_index, child_index)
            continue
        pronunciation = lookup_word(word["text"])
        counts = {entry.get("syllableCount") for entry in pronunciation.get("pronunciations", [])}
        if pronunciation.get("status") == "found" and counts == {1}:
            add(word["id"], word, "whole-word", word.get("startMs"), word.get("endMs"), False, None, word_index, 0)
        else:
            result.append({
                "unitId": None,
                "parentWordId": word["id"],
                "syllableId": None,
                "kind": "unavailable",
                "wordIndex": word_index,
                "childIndex": 0,
                "scoreStartMs": word.get("startMs") if _int(word.get("startMs")) else None,
                "scoreEndMs": word.get("endMs") if _int(word.get("endMs")) else None,
                "status": "unavailable",
                "reason": "syllable-segmentation-required" if counts and len(counts) == 1 else "ambiguous-or-unknown-pronunciation",
            })
    return result


def _word_unit_records(phrase: dict[str, Any]) -> list[dict[str, Any]]:
    """Offer explicit word-scope targets without claiming syllable support."""
    records: list[dict[str, Any]] = []
    for word_index, word in enumerate(phrase["words"]):
        children = word.get("syllables") if isinstance(word.get("syllables"), list) else []
        reason = "word-locked" if word.get("locked") is True else "syllable-locked" if any(
            isinstance(child, dict) and child.get("locked") is True for child in children
        ) else None
        records.append({
            # A virtual review key, distinct from any score syllable ID.
            "unitId": f"@word:{word['id']}",
            "parentWordId": word["id"],
            "syllableId": None,
            "kind": "word",
            "wordIndex": word_index,
            "childIndex": -1,
            "scoreStartMs": word.get("startMs") if _int(word.get("startMs")) else None,
            "scoreEndMs": word.get("endMs") if _int(word.get("endMs")) else None,
            "status": "available" if reason is None else "blocked",
            "reason": reason,
        })
    return records


def _validate_virtual_word_ids(score: dict[str, Any], phrase: dict[str, Any]) -> None:
    """Keep synthetic whole-word keys outside the legal score ID namespace."""
    actual_ids: set[str] = set()
    for score_phrase in score.get("phrases", []):
        if not isinstance(score_phrase, dict) or not isinstance(score_phrase.get("words"), list):
            continue
        for word in score_phrase["words"]:
            if not isinstance(word, dict):
                continue
            if isinstance(word.get("id"), str):
                actual_ids.add(word["id"])
            syllables = word.get("syllables")
            if isinstance(syllables, list):
                actual_ids.update(item["id"] for item in syllables if isinstance(item, dict) and isinstance(item.get("id"), str))
    virtual_ids = {f"@word:{word['id']}" for word in phrase.get("words", []) if isinstance(word, dict) and isinstance(word.get("id"), str)}
    if actual_ids.intersection(virtual_ids):
        raise GuideGroupingError("RESERVED_UNIT_COLLISION", "A whole-word review key collides with an existing score unit ID.")


def load_review(package: Any, session: Any) -> dict[str, Any]:
    """Validate the package/session binding and return a detached numeric review state."""
    package_obj = _load(package, "Review package")
    session_obj = _load(session, "Guide session")
    _reject_audio_payloads(session_obj)
    if package_obj.get("version") != PACKAGE_VERSION or session_obj.get("version") != SESSION_VERSION:
        raise GuideGroupingError("UNSUPPORTED_VERSION", "Review package or guide session version is unsupported.")

    score = package_obj.get("score")
    audio = package_obj.get("audio")
    if not isinstance(score, dict) or not isinstance(audio, dict):
        raise GuideGroupingError("INVALID_PACKAGE", "Review package must include score and audio metadata.")
    source = score.get("source")
    session_source = session_obj.get("source")
    score_revision = score.get("revision")
    video_id = source.get("videoId") if isinstance(source, dict) else None
    session_video_id = session_source.get("videoId") if isinstance(session_source, dict) else None
    audio_hash = audio.get("sha256")
    session_hash = session_obj.get("sourceSha256")
    if (
        not isinstance(video_id, str) or video_id != session_video_id
        or source.get("platform") != "youtube"
        or session_source.get("platform") != "youtube"
        or not isinstance(audio_hash, str) or not _SHA256_RE.fullmatch(audio_hash)
        or audio_hash != session_hash
    ):
        raise GuideGroupingError("SOURCE_MISMATCH", "Review package and guide session source identity do not match.")
    receipt = package_obj.get("receipt")
    if not isinstance(receipt, dict):
        raise GuideGroupingError("INVALID_PACKAGE", "Review package receipt metadata is missing.")
    if (
        not _int(score_revision)
        or score_revision != session_obj.get("scoreRevision")
        or receipt.get("expectedRevision") != score_revision
    ):
        raise GuideGroupingError("REVISION_MISMATCH", "Guide session revision does not match the package score.")

    phrase_id = session_obj.get("phraseId")
    if not isinstance(phrase_id, str) or not phrase_id:
        raise GuideGroupingError("INVALID_PHRASE", "Guide session must identify one score phrase.")
    phrases = score.get("phrases")
    lanes = score.get("lanes")
    if not isinstance(phrases, list) or not isinstance(lanes, list):
        raise GuideGroupingError("INVALID_SCORE", "Review package score lacks phrase or lane lists.")
    phrase = next((candidate for candidate in phrases if isinstance(candidate, dict) and candidate.get("id") == phrase_id), None)
    if phrase is None:
        raise GuideGroupingError("PHRASE_MISMATCH", "Guide session phrase is not present in the package score.")
    lane_roles = {lane.get("id"): lane.get("role") for lane in lanes if isinstance(lane, dict)}
    if lane_roles.get(phrase.get("laneId")) != "lead":
        raise GuideGroupingError("PHRASE_NOT_LEAD", "Guide review requires a lead-lane phrase.")
    phrase_start, phrase_end = phrase.get("startMs"), phrase.get("endMs")
    if not _safe_interval(phrase_start, phrase_end):
        raise GuideGroupingError("INVALID_PHRASE", "Selected phrase has invalid source-time bounds.")
    audio_duration = audio.get("durationMs")
    source_duration = source.get("durationMs")
    if not _int(audio_duration, minimum=1) or not _int(source_duration, minimum=1):
        raise GuideGroupingError("INVALID_PACKAGE", "Package audio and score source durations must be positive integers.")

    clip_start = session_obj.get("clipStartMs")
    guide_delay = session_obj.get("guideDelayMs")
    capture = session_obj.get("captureStatus")
    duration = capture.get("durationMs") if isinstance(capture, dict) else None
    if not _int(clip_start) or not _int(guide_delay) or not _int(duration, maximum=MAX_CAPTURE_MS) or duration <= 0:
        raise GuideGroupingError("INVALID_SESSION_CLOCK", "Guide session capture clock or duration is invalid.")
    taps_in = session_obj.get("taps")
    if not isinstance(taps_in, list) or len(taps_in) > MAX_TAPS:
        raise GuideGroupingError("INVALID_TAPS", "Guide session tap list is invalid or exceeds the 12-second bound.")
    taps: list[dict[str, Any]] = []
    ordinals: set[int] = set()
    previous_ordinal = 0
    previous_time = -1
    for tap in taps_in:
        if not isinstance(tap, dict):
            raise GuideGroupingError("INVALID_TAPS", "Guide session tap record is invalid.")
        ordinal, guide_time, kind = tap.get("ordinal"), tap.get("guideTimeMs"), tap.get("kind")
        if not _int(ordinal, minimum=1) or ordinal in ordinals or ordinal <= previous_ordinal:
            raise GuideGroupingError("INVALID_TAPS", "Tap ordinals must be unique and strictly increasing.")
        if not _int(guide_time) or guide_time > duration or guide_time <= previous_time or not isinstance(kind, str) or kind not in _TAP_KINDS:
            raise GuideGroupingError("INVALID_TAPS", "Tap times must increase within the capture and tap kinds must be recognized.")
        if tap.get("unitId") is not None:
            raise GuideGroupingError("PREASSIGNED_TAP", "Guide taps must remain unassigned until an explicit review operation.")
        expected_source = clip_start + guide_time - guide_delay
        if not _int(tap.get("approximateSourceMs")) or tap.get("approximateSourceMs") != expected_source or expected_source < 0 or expected_source > min(audio_duration, source_duration):
            raise GuideGroupingError("INVALID_SESSION_CLOCK", "Tap source-time estimate does not match the declared guide delay.")
        parent = tap.get("withinTapOrdinal")
        if parent is not None and (not _int(parent, minimum=1) or parent >= ordinal):
            raise GuideGroupingError("INVALID_TAPS", "Tap parent must refer to an earlier tap ordinal.")
        taps.append({
            "ordinal": ordinal,
            "kind": kind,
            "guideTimeMs": guide_time,
            "sourceTimeEstimateMs": expected_source,
            "withinTapOrdinal": parent,
            "assignmentStatus": "unreviewed",
            "unitId": None,
            "unitKind": None,
            "parentTapOrdinal": None,
            "blockers": [],
        })
        ordinals.add(ordinal)
        previous_ordinal, previous_time = ordinal, guide_time

    unit_records = _unit_records(score, phrase)
    _validate_virtual_word_ids(score, phrase)
    word_unit_records = _word_unit_records(phrase)
    return {
        "version": REVIEW_VERSION,
        "reviewRevision": 0,
        "source": {"videoId": video_id, "audioSha256": audio_hash, "scoreRevision": score_revision, "phraseId": phrase_id},
        "phraseBounds": {"startMs": phrase_start, "endMs": phrase_end},
        "units": unit_records,
        "wordUnits": word_unit_records,
        "taps": taps,
        "assignments": {},
        "releases": {},
    }


def _tap(state: dict[str, Any], ordinal: Any) -> dict[str, Any]:
    if not _int(ordinal, minimum=1):
        raise GuideGroupingError("INVALID_TAP_ORDINAL", "Tap ordinal must be a positive integer.")
    found = next((item for item in state.get("taps", []) if item.get("ordinal") == ordinal), None)
    if found is None:
        raise GuideGroupingError("UNKNOWN_TAP", "Tap ordinal is not in this review.")
    return found


def _unit(state: dict[str, Any], unit_id: Any) -> dict[str, Any]:
    if not isinstance(unit_id, str) or not unit_id:
        raise GuideGroupingError("INVALID_UNIT_ID", "A confirmed entrance needs an explicit unit ID.")
    found = next((item for item in state.get("units", []) + state.get("wordUnits", []) if item.get("unitId") == unit_id), None)
    if found is None:
        raise GuideGroupingError("UNKNOWN_UNIT", "Unit ID is not available in the selected phrase.")
    return found


def _position(state: dict[str, Any], unit_id: str) -> tuple[int, int]:
    unit = _unit(state, unit_id)
    return unit["wordIndex"], unit["childIndex"]


def _assigned_unit_for_tap(state: dict[str, Any], tap: dict[str, Any]) -> dict[str, Any] | None:
    if tap.get("assignmentStatus") != "entrance":
        return None
    return next((unit for unit in state.get("units", []) + state.get("wordUnits", []) if unit.get("unitId") == tap.get("unitId")), None)


def _reject_crossed_notes(state: dict[str, Any], entrance_ordinal: int) -> None:
    for note in state["taps"]:
        parent = note.get("parentTapOrdinal")
        if note.get("assignmentStatus") == "note" and parent is not None and parent < entrance_ordinal < note["ordinal"]:
            raise GuideGroupingError("NOTE_SCOPE_CONFLICT", "This entrance would split a note change from its assigned parent group.")


def _entrances(state: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(
        (item for item in state["taps"] if item.get("assignmentStatus") == "entrance"),
        key=lambda item: item["ordinal"],
    )


def apply_operation(state: dict[str, Any], expected_revision: int, operation: dict[str, Any]) -> dict[str, Any]:
    """Apply one explicit reviewer choice and return a new state without mutating input."""
    if not isinstance(state, dict) or state.get("version") != REVIEW_VERSION:
        raise GuideGroupingError("INVALID_REVIEW", "Review state is invalid.")
    if not _int(expected_revision) or expected_revision != state.get("reviewRevision"):
        raise GuideGroupingError("REVISION_CONFLICT", "Review changed; reload its current state before acting.")
    if not isinstance(operation, dict) or not isinstance(operation.get("type"), str):
        raise GuideGroupingError("INVALID_OPERATION", "A typed review operation is required.")
    new_state = deepcopy(state)
    op = operation["type"]
    tap = _tap(new_state, operation.get("tapOrdinal"))
    prior_status = tap["assignmentStatus"]
    if op == "assignEntrance":
        existing_assignment = new_state["assignments"].get(str(tap["ordinal"]))
        if existing_assignment is not None and (existing_assignment.get("type") != "entrance" or existing_assignment.get("unitId") != operation.get("unitId")):
            raise GuideGroupingError("TAP_ALREADY_ASSIGNED", "Clear the current tap decision before changing its meaning.")
        if tap["kind"] == "manual-note-change":
            raise GuideGroupingError("TAP_KIND_MISMATCH", "A note-change tap cannot become a lyric entrance.")
        unit = _unit(new_state, operation.get("unitId"))
        if unit not in new_state["units"]:
            raise GuideGroupingError("UNIT_SCOPE_MISMATCH", "Word-scope targets require the explicit assignWordEntrance operation.")
        _reject_crossed_notes(new_state, tap["ordinal"])
        if any(item.get("assignmentStatus") == "entrance" and item.get("unitId") == unit["unitId"] and item["ordinal"] != tap["ordinal"] for item in new_state["taps"]):
            raise GuideGroupingError("UNIT_ALREADY_ASSIGNED", "A lyric unit can have only one confirmed entrance tap.")
        for other in _entrances(new_state):
            other_unit = _assigned_unit_for_tap(new_state, other)
            if other["ordinal"] == tap["ordinal"] or other_unit is None:
                continue
            same_word = other_unit["parentWordId"] == unit["parentWordId"]
            word_scope_conflict = same_word and (unit["kind"] != "syllable" or other_unit["kind"] != "syllable")
            if word_scope_conflict:
                raise GuideGroupingError("WORD_SCOPE_CONFLICT", "Use either whole-word or syllable entrances for a word, not both.")
            if (other["ordinal"] < tap["ordinal"] and _position(new_state, other["unitId"]) >= _position(new_state, unit["unitId"])) or (other["ordinal"] > tap["ordinal"] and _position(new_state, other["unitId"]) <= _position(new_state, unit["unitId"])):
                raise GuideGroupingError("UNIT_ORDER_CONFLICT", "Confirmed entrance assignments must follow score-unit order.")
        tap.update({"assignmentStatus": "entrance", "unitId": unit["unitId"], "unitKind": unit["kind"], "parentTapOrdinal": None, "blockers": [] if unit["status"] == "available" else [unit["reason"]]})
        new_state["assignments"][str(tap["ordinal"])] = {"type": "entrance", "unitId": unit["unitId"]}
        new_state["releases"].pop(str(tap["ordinal"]), None)
    elif op == "assignWordEntrance":
        if tap["kind"] == "manual-note-change":
            raise GuideGroupingError("TAP_KIND_MISMATCH", "A note-change tap cannot become a whole-word entrance.")
        existing_assignment = new_state["assignments"].get(str(tap["ordinal"]))
        if existing_assignment is not None and (existing_assignment.get("type") != "entrance" or existing_assignment.get("unitId") != f"@word:{operation.get('wordId')}"):
            raise GuideGroupingError("TAP_ALREADY_ASSIGNED", "Clear the current tap decision before changing its meaning.")
        word_id = operation.get("wordId")
        unit = next((item for item in new_state["wordUnits"] if item["parentWordId"] == word_id), None)
        if unit is None:
            raise GuideGroupingError("UNKNOWN_WORD", "Word ID is not present in the selected phrase.")
        _reject_crossed_notes(new_state, tap["ordinal"])
        if any(item.get("assignmentStatus") == "entrance" and _assigned_unit_for_tap(new_state, item) is not None and _assigned_unit_for_tap(new_state, item)["parentWordId"] == word_id and item["ordinal"] != tap["ordinal"] for item in new_state["taps"]):
            raise GuideGroupingError("WORD_ALREADY_ASSIGNED", "A word can have only one whole-word entrance.")
        for other in _entrances(new_state):
            other_unit = _assigned_unit_for_tap(new_state, other)
            if other["ordinal"] == tap["ordinal"] or other_unit is None:
                continue
            if other_unit["parentWordId"] == word_id:
                raise GuideGroupingError("WORD_SCOPE_CONFLICT", "Use either whole-word or syllable entrances for a word, not both.")
            if (other["ordinal"] < tap["ordinal"] and _position(new_state, other["unitId"]) >= _position(new_state, unit["unitId"])) or (other["ordinal"] > tap["ordinal"] and _position(new_state, other["unitId"]) <= _position(new_state, unit["unitId"])):
                raise GuideGroupingError("UNIT_ORDER_CONFLICT", "Confirmed entrance assignments must follow score-unit order.")
        tap.update({"assignmentStatus": "entrance", "unitId": unit["unitId"], "unitKind": "word", "parentTapOrdinal": None, "blockers": [] if unit["status"] == "available" else [unit["reason"]]})
        new_state["assignments"][str(tap["ordinal"])] = {"type": "entrance", "unitId": unit["unitId"]}
        new_state["releases"].pop(str(tap["ordinal"]), None)
    elif op == "assignNote":
        if tap["kind"] == "manual-syllable-onset":
            raise GuideGroupingError("TAP_KIND_MISMATCH", "A syllable-onset tap cannot become a note change.")
        if str(tap["ordinal"]) in new_state["assignments"] and prior_status != "note":
            raise GuideGroupingError("TAP_ALREADY_ASSIGNED", "Clear the current tap assignment before changing its meaning.")
        parent_ordinal = operation.get("parentTapOrdinal")
        if parent_ordinal is None:
            parent_ordinal = tap.get("withinTapOrdinal")
        if parent_ordinal is None:
            prior_entrances = [item for item in _entrances(new_state) if item["ordinal"] < tap["ordinal"]]
            parent_ordinal = prior_entrances[-1]["ordinal"] if prior_entrances else None
        parent_tap = next((item for item in _entrances(new_state) if item["ordinal"] == parent_ordinal), None)
        if parent_tap is None or parent_ordinal >= tap["ordinal"]:
            raise GuideGroupingError("NOTE_PARENT_REQUIRED", "A note change must follow and reference an assigned entrance.")
        following = next((item for item in _entrances(new_state) if item["ordinal"] > parent_ordinal), None)
        if following is not None and tap["ordinal"] >= following["ordinal"]:
            raise GuideGroupingError("NOTE_OUTSIDE_GROUP", "A note change cannot cross the next confirmed entrance.")
        new_state["assignments"][str(tap["ordinal"])] = {"type": "note", "parentTapOrdinal": parent_ordinal}
        tap.update({"assignmentStatus": "note", "unitId": None, "unitKind": None, "parentTapOrdinal": parent_ordinal, "blockers": []})
    elif op == "ignore":
        if any(item.get("assignmentStatus") == "note" and item.get("parentTapOrdinal") == tap["ordinal"] for item in new_state["taps"]):
            raise GuideGroupingError("ASSIGNED_NOTES_EXIST", "Clear note changes before ignoring their parent entrance.")
        new_state["assignments"][str(tap["ordinal"])] = {"type": "ignore"}
        new_state["releases"].pop(str(tap["ordinal"]), None)
        tap.update({"assignmentStatus": "ignored", "unitId": None, "unitKind": None, "parentTapOrdinal": None, "blockers": []})
    elif op == "clear":
        if prior_status == "entrance" and any(item.get("assignmentStatus") == "note" and item.get("parentTapOrdinal") == tap["ordinal"] for item in new_state["taps"]):
            raise GuideGroupingError("ASSIGNED_NOTES_EXIST", "Clear note changes before clearing their parent entrance.")
        new_state["assignments"].pop(str(tap["ordinal"]), None)
        new_state["releases"].pop(str(tap["ordinal"]), None)
        tap.update({"assignmentStatus": "unreviewed", "unitId": None, "unitKind": None, "parentTapOrdinal": None, "blockers": []})
    elif op == "setRelease":
        if prior_status != "entrance":
            raise GuideGroupingError("RELEASE_REQUIRES_ENTRANCE", "A typed release boundary must close an assigned entrance.")
        end_ms = operation.get("endMs")
        start_ms = tap["sourceTimeEstimateMs"]
        next_entrance = next((item for item in _entrances(new_state) if item["ordinal"] > tap["ordinal"]), None)
        if next_entrance is not None:
            raise GuideGroupingError("RELEASE_NOT_FINAL", "Typed release applies only to the final assigned entrance.")
        attached_notes = [item["sourceTimeEstimateMs"] for item in new_state["taps"] if item.get("assignmentStatus") == "note" and item.get("parentTapOrdinal") == tap["ordinal"]]
        if not _int(end_ms) or end_ms <= start_ms or end_ms <= max(attached_notes, default=start_ms) or end_ms > new_state["phraseBounds"]["endMs"]:
            raise GuideGroupingError("INVALID_RELEASE", "Release must be after its entrance and within phrase bounds.")
        new_state["releases"][str(tap["ordinal"])] = end_ms
    else:
        raise GuideGroupingError("UNKNOWN_OPERATION", "Review operation type is unsupported.")
    new_state["reviewRevision"] += 1
    return new_state


def preview(state: dict[str, Any]) -> dict[str, Any]:
    """Return a text-free numeric grouping preview recomputed from assignments."""
    if not isinstance(state, dict) or state.get("version") != REVIEW_VERSION:
        raise GuideGroupingError("INVALID_REVIEW", "Review state is invalid.")
    units = {unit["unitId"]: unit for unit in state["units"] + state.get("wordUnits", []) if unit.get("unitId") is not None}
    entrances = _entrances(state)
    groups: list[dict[str, Any]] = []
    tap_rows: list[dict[str, Any]] = []
    closed_units: list[dict[str, Any]] = []
    group_blockers: dict[int, list[str]] = {}
    for index, entrance in enumerate(entrances):
        unit = units.get(entrance["unitId"])
        following = entrances[index + 1] if index + 1 < len(entrances) else None
        start_ms = entrance["sourceTimeEstimateMs"]
        explicit_end = state["releases"].get(str(entrance["ordinal"]))
        end_ms = following["sourceTimeEstimateMs"] if following is not None else explicit_end
        requires_release = following is None and explicit_end is None
        blockers = list(entrance.get("blockers", []))
        bounds = state["phraseBounds"]
        if start_ms < bounds["startMs"] or start_ms >= bounds["endMs"]:
            blockers.append("entrance-outside-phrase")
        if end_ms is not None and (end_ms <= start_ms or end_ms > bounds["endMs"]):
            blockers.append("interval-outside-phrase")
        note_ordinals = [tap["ordinal"] for tap in state["taps"] if tap.get("assignmentStatus") == "note" and tap.get("parentTapOrdinal") == entrance["ordinal"]]
        if following is not None and any(ordinal >= following["ordinal"] for ordinal in note_ordinals):
            blockers.append("note-outside-group")
        group = {
            "tapOrdinal": entrance["ordinal"],
            "unitId": entrance["unitId"],
            "parentWordId": unit["parentWordId"] if unit else None,
            "syllableId": unit["syllableId"] if unit else None,
            "unitKind": unit["kind"] if unit else None,
            "startMs": start_ms,
            "endMs": end_ms,
            "endSource": "next-confirmed-entrance" if following is not None else "typed-release" if explicit_end is not None else None,
            "requiresRelease": requires_release,
            "provisional": following is not None,
            "noteTapOrdinals": note_ordinals,
            "blockers": sorted(set(blockers)),
        }
        groups.append(group)
        group_blockers[entrance["ordinal"]] = group["blockers"]
        if end_ms is not None and start_ms < end_ms and not blockers and unit is not None:
            closed_units.append({
                "wordId": unit["parentWordId"],
                "syllableId": unit["syllableId"],
                "unitId": unit["unitId"],
                "unitKind": unit["kind"],
                "startMs": start_ms,
                "endMs": end_ms,
            })

    for tap in state["taps"]:
        row = {
            "ordinal": tap["ordinal"],
            "kind": tap["kind"],
            "guideTimeMs": tap["guideTimeMs"],
            "sourceTimeEstimateMs": tap["sourceTimeEstimateMs"],
            "assignmentStatus": tap["assignmentStatus"],
            "unitId": tap["unitId"],
            "unitKind": tap["unitKind"],
            "parentTapOrdinal": tap["parentTapOrdinal"],
            "blockers": sorted(set(tap["blockers"] + group_blockers.get(tap["ordinal"], []))),
        }
        tap_rows.append(row)

    targets = sorted(state["units"] + state.get("wordUnits", []), key=lambda unit: (unit["wordIndex"], unit["childIndex"]))
    last_entrance = max(entrances, key=lambda entrance: _position(state, entrance["unitId"]), default=None)
    if last_entrance is None:
        next_unit = next((unit["unitId"] for unit in targets if unit.get("status") == "available" and unit.get("unitId") is not None), None)
    else:
        last_unit = _unit(state, last_entrance["unitId"])
        last_position = _position(state, last_entrance["unitId"])
        next_unit = next((unit["unitId"] for unit in targets if unit.get("status") == "available" and unit.get("unitId") is not None and (unit["wordIndex"] > last_unit["wordIndex"] if last_unit["kind"] == "word" else (unit["wordIndex"], unit["childIndex"]) > last_position)), None)
    return {
        "version": REVIEW_VERSION,
        "reviewRevision": state["reviewRevision"],
        "source": deepcopy(state["source"]),
        "phraseBounds": deepcopy(state["phraseBounds"]),
        "units": [{key: unit.get(key) for key in ("unitId", "parentWordId", "syllableId", "kind", "scoreStartMs", "scoreEndMs", "status", "reason")} for unit in state["units"]],
        "wordUnits": [{key: unit.get(key) for key in ("unitId", "parentWordId", "syllableId", "kind", "scoreStartMs", "scoreEndMs", "status", "reason")} for unit in state.get("wordUnits", [])],
        "taps": tap_rows,
        "groups": groups,
        "resolvedUnitIds": [entrance["unitId"] for entrance in entrances],
        "closedUnits": closed_units,
        "nextUnitId": next_unit,
    }


__all__ = ["GuideGroupingError", "load_review", "apply_operation", "preview", "REVIEW_VERSION"]
