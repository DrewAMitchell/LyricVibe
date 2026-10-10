"""Derive plain-language review progress from a numeric grouping preview.

This module is presentation state only. It does not mutate assignments,
calculate timing, inspect lyrics, or make score changes.
"""
from __future__ import annotations

from typing import Any


_BLOCKERS = {
    "word-locked": {
        "kind": "locked-unit",
        "title": "This word is locked",
        "recovery": "Choose an unlocked lyric unit or clear this tap assignment.",
    },
    "syllable-locked": {
        "kind": "locked-unit",
        "title": "This syllable is locked",
        "recovery": "Choose an unlocked lyric unit or clear this tap assignment.",
    },
    "entrance-outside-phrase": {
        "kind": "outside-phrase",
        "title": "This entrance falls outside the phrase",
        "recovery": "Clear the assignment or choose a tap inside the phrase.",
    },
    "interval-outside-phrase": {
        "kind": "outside-phrase",
        "title": "This group extends outside the phrase",
        "recovery": "Set a release inside the phrase or move the next entrance earlier.",
    },
    "note-outside-group": {
        "kind": "group-boundary",
        "title": "A note tap falls after the next entrance",
        "recovery": "Assign that note tap to the following lyric group, or clear it.",
    },
}


def derive_review_flow(snapshot: dict[str, Any], selectedOrdinal: int | None = None) -> dict[str, Any]:
    """Return small UI-ready progress and recovery state for a preview snapshot.

    The selected tap stays current when valid. Otherwise focus moves to the
    first tap needing review, then to the first tap in the take. Counts include
    only taps with a decision and no blocker.
    """
    if not isinstance(snapshot, dict):
        raise ValueError("Review snapshot must be an object.")
    taps, groups, closed_units = snapshot.get("taps"), snapshot.get("groups"), snapshot.get("closedUnits")
    if not isinstance(taps, list) or not isinstance(groups, list) or not isinstance(closed_units, list):
        raise ValueError("Review snapshot is missing progress data.")
    if any(not isinstance(tap, dict) or type(tap.get("ordinal")) is not int for tap in taps):
        raise ValueError("Review snapshot contains an invalid tap.")
    if any(not isinstance(group, dict) or type(group.get("tapOrdinal")) is not int for group in groups):
        raise ValueError("Review snapshot contains an invalid group.")
    if not taps:
        return {
            "phase": "empty", "reviewed": 0, "total": 0,
            "currentTapOrdinal": None, "nextUnresolvedTapOrdinal": None,
            "activeGroup": None, "releaseTapOrdinal": None,
            "previewReady": False, "blocker": None,
        }

    unresolved = [tap for tap in taps if tap.get("assignmentStatus") == "unreviewed" or tap.get("blockers")]
    reviewed = sum(
        tap.get("assignmentStatus") in {"entrance", "note", "ignored"} and not tap.get("blockers")
        for tap in taps
    )
    selected = next((tap for tap in taps if tap["ordinal"] == selectedOrdinal), None)
    current = selected or (unresolved[0] if unresolved else taps[0])
    active_group = next(
        (group for group in reversed(groups) if group["tapOrdinal"] <= current["ordinal"]),
        None,
    )
    release_group = next((group for group in groups if group.get("requiresRelease") is True), None)

    blocker_tap = current if current.get("blockers") else (unresolved[0] if unresolved and unresolved[0].get("blockers") else None)
    blocker = None
    if blocker_tap is not None:
        code = next((item for item in blocker_tap["blockers"] if item in _BLOCKERS), None)
        detail = _BLOCKERS.get(code, {
            "kind": "review-needed",
            "title": "This tap needs another look",
            "recovery": "Clear this decision and assign the tap again.",
        })
        blocker = {"tapOrdinal": blocker_tap["ordinal"], **detail}
    elif not unresolved and not release_group and not closed_units:
        blocker = {
            "tapOrdinal": current["ordinal"],
            "kind": "no-closeable-group",
            "title": "No lyric group is ready to preview",
            "recovery": "Assign at least one tap as a lyric entrance, then set its final release.",
        }

    if unresolved:
        phase = "review"
    elif release_group is not None:
        phase = "release"
    elif closed_units:
        phase = "ready"
    else:
        phase = "review"

    active = None
    if active_group is not None:
        active = {
            "tapOrdinal": active_group["tapOrdinal"],
            "unitId": active_group.get("unitId"),
            "parentWordId": active_group.get("parentWordId"),
            "startMs": active_group.get("startMs"),
            "endMs": active_group.get("endMs"),
            "requiresRelease": active_group.get("requiresRelease") is True,
            "blocked": bool(active_group.get("blockers")),
            "noteTapOrdinals": list(active_group.get("noteTapOrdinals", []))
            if isinstance(active_group.get("noteTapOrdinals", []), list) else [],
            "noteTapCount": len(active_group.get("noteTapOrdinals", []))
            if isinstance(active_group.get("noteTapOrdinals", []), list) else 0,
        }
    return {
        "phase": phase,
        "reviewed": reviewed,
        "total": len(taps),
        "currentTapOrdinal": current["ordinal"],
        "nextUnresolvedTapOrdinal": unresolved[0]["ordinal"] if unresolved else None,
        "activeGroup": active,
        "releaseTapOrdinal": release_group["tapOrdinal"] if release_group is not None else None,
        "previewReady": phase == "ready",
        "blocker": blocker,
    }


__all__ = ["derive_review_flow"]
