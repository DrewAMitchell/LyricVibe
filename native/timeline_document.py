"""Revisioned local document for direct edits to a validated lyric score."""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_HISTORY = 100
BRIDGE_TIMEOUT_SECONDS = 10
ERROR_MESSAGES = {
    "INVALID_PACKAGE": "The timeline package is missing its score.",
    "INVALID_INPUT": "The timeline input is invalid.",
    "INPUT_TOO_LARGE": "Timeline input exceeds 10 MiB.",
    "OUTPUT_TOO_LARGE": "Timeline score exceeds 10 MiB.",
    "INVALID_SCORE": "The score does not match the shared score format.",
    "REVISION_CONFLICT": "The timeline changed; reload before editing.",
    "UNKNOWN_ID": "The selected score item no longer exists.",
    "LOCKED": "Unlock the protected word or syllable before changing its timing.",
    "NOTHING_TO_UNDO": "There is no earlier timeline edit to restore.",
    "SOURCE_MISMATCH": "Imported score belongs to a different video or lyric revision.",
    "IMPORT_LOCKED_CHANGE": "Import changes a manually locked word or syllable.",
    "IMPORT_FAILED": "The score could not be imported.",
    "EXPORT_EXISTS": "Choose a new file path; exports never replace an existing file.",
    "NODE_UNAVAILABLE": "Node.js is required for shared score validation.",
    "BRIDGE_TIMEOUT": "Shared score validation exceeded its 10-second limit.",
    "BRIDGE_FAILED": "The shared score operation failed.",
    "INVALID_OPERATION": "The requested score operation is invalid.",
    "INVALID_TIME": "Timing values do not fit the score interval.",
    "INVALID_SYLLABLES": "Syllable text or timing does not match the word.",
}


class TimelineError(ValueError):
    """Stable, content-free error from a timeline document operation."""

    def __init__(self, code: str):
        self.code = code if code in ERROR_MESSAGES else "BRIDGE_FAILED"
        super().__init__(ERROR_MESSAGES[self.code])


def _read_json(path: Any, label: str) -> dict[str, Any]:
    try:
        with Path(path).open("rb") as source:
            raw = source.read(MAX_DOCUMENT_BYTES + 1)
    except (OSError, TypeError, ValueError):
        raise TimelineError("INVALID_INPUT") from None
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise TimelineError("INPUT_TOO_LARGE")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise TimelineError("INVALID_INPUT") from None
    if not isinstance(value, dict):
        raise TimelineError("INVALID_INPUT")
    return value


def _json_bytes(value: Any) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        raise TimelineError("INVALID_INPUT") from None
    if len(encoded) + 1 > MAX_DOCUMENT_BYTES:
        raise TimelineError("INPUT_TOO_LARGE")
    return encoded


def _invoke(action: str, **values: Any) -> dict[str, Any]:
    executable = shutil.which("node")
    if not executable:
        raise TimelineError("NODE_UNAVAILABLE")
    request = _json_bytes({"action": action, **values})
    try:
        result = subprocess.run(
            [executable, str(ROOT / "scripts" / "timeline-score-bridge.cjs")],
            input=request,
            capture_output=True,
            timeout=BRIDGE_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise TimelineError("BRIDGE_TIMEOUT") from None
    except OSError:
        raise TimelineError("BRIDGE_FAILED") from None
    if len(result.stdout) > MAX_DOCUMENT_BYTES:
        raise TimelineError("OUTPUT_TOO_LARGE")
    try:
        response = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise TimelineError("BRIDGE_FAILED") from None
    if not isinstance(response, dict) or response.get("ok") is not True or not isinstance(response.get("score"), dict):
        error = response.get("error") if isinstance(response, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        raise TimelineError(code if isinstance(code, str) else "BRIDGE_FAILED")
    return response["score"]


def _words(score: dict[str, Any]):
    for phrase in score.get("phrases", []):
        for word in phrase.get("words", []):
            yield phrase, word


def _find_word(score: dict[str, Any], word_id: Any):
    return next(((phrase, word) for phrase, word in _words(score) if word.get("id") == word_id), None)


def _check_edit_locks(score: dict[str, Any], operation: dict[str, Any]) -> None:
    kind = operation.get("type")
    if kind in {"setWordLock", "setSyllableLock", "setWordTiming", "setSyllableTiming"}:
        # Direct timing is an intentional manual edit, not alignment admission.
        # It preserves protection while allowing iterative move/resize gestures.
        return
    if kind in {"setWordText", "setWordSyllables"}:
        found = _find_word(score, operation.get("wordId"))
        if found is None:
            return  # Shared core reports its stable UNKNOWN_ID error.
        _phrase, word = found
        if word.get("locked") or any(item.get("locked") for item in word.get("syllables", [])):
            raise TimelineError("LOCKED")
    elif kind == "setPhraseTiming":
        phrase = next((item for item in score.get("phrases", []) if item.get("id") == operation.get("phraseId")), None)
        if phrase is None:
            return
        if any(word.get("locked") or any(child.get("locked") for child in word.get("syllables", [])) for word in phrase.get("words", [])):
            raise TimelineError("LOCKED")


def _index_words(score: dict[str, Any]) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    return {word["id"]: (phrase, word) for phrase, word in _words(score)}


def _assert_locked_preserved(current: dict[str, Any], incoming: dict[str, Any]) -> None:
    new_words = _index_words(incoming)
    for _phrase, word in _words(current):
        protected = bool(word.get("locked"))
        new_entry = new_words.get(word.get("id"))
        if protected:
            if new_entry is None:
                raise TimelineError("IMPORT_LOCKED_CHANGE")
            new_word = new_entry[1]
            if not new_word.get("locked") or any(new_word.get(key) != word.get(key) for key in ("text", "startMs", "endMs", "provenance")):
                raise TimelineError("IMPORT_LOCKED_CHANGE")
        old_children = word.get("syllables", [])
        candidate_children = new_entry[1].get("syllables", []) if new_entry else []
        new_children = {child.get("id"): child for child in candidate_children}
        if protected and [child.get("id") for child in candidate_children] != [child.get("id") for child in old_children]:
            raise TimelineError("IMPORT_LOCKED_CHANGE")
        for child in old_children:
            new_child = new_children.get(child.get("id"))
            if protected:
                if new_child is None or any(
                    new_child.get(key) != child.get(key)
                    for key in ("id", "text", "startMs", "endMs", "provenance", "locked")
                ):
                    raise TimelineError("IMPORT_LOCKED_CHANGE")
            elif child.get("locked") and (new_child is None or not new_child.get("locked") or any(
                new_child.get(key) != child.get(key) for key in ("text", "startMs", "endMs", "provenance")
            )):
                raise TimelineError("IMPORT_LOCKED_CHANGE")


class TimelineDocument:
    """An editable score with a separate document revision and bounded undo."""

    def __init__(self, package_path: Any):
        self.package_path = Path(package_path)
        package = _read_json(self.package_path, "package")
        if package.get("version") != "lyricvibe.review.v1" or not isinstance(package.get("score"), dict):
            raise TimelineError("INVALID_PACKAGE")
        self._package = deepcopy(package)
        self._score = _invoke("validate", score=deepcopy(package["score"]))
        self._revision = 0
        self._history: list[dict[str, Any]] = []

    @property
    def package(self) -> dict[str, Any]:
        return deepcopy(self._package)

    @property
    def score(self) -> dict[str, Any]:
        return deepcopy(self._score)

    @property
    def revision(self) -> int:
        return self._revision

    def _expect(self, expected_revision: int) -> None:
        if type(expected_revision) is not int or expected_revision != self._revision:
            raise TimelineError("REVISION_CONFLICT")

    def _remember(self) -> None:
        self._history.append(deepcopy(self._score))
        if len(self._history) > MAX_HISTORY:
            del self._history[0]

    def act(self, operation: dict[str, Any], expected_revision: int) -> dict[str, Any]:
        self._expect(expected_revision)
        if not isinstance(operation, dict):
            raise TimelineError("INVALID_OPERATION")
        _check_edit_locks(self._score, operation)
        updated = _invoke("apply", score=deepcopy(self._score), operation=deepcopy(operation), expectedRevision=self._score["revision"])
        self._remember()
        self._score = updated
        self._revision += 1
        return self.score

    def undo(self, expected_revision: int) -> dict[str, Any]:
        self._expect(expected_revision)
        if not self._history:
            raise TimelineError("NOTHING_TO_UNDO")
        restored = deepcopy(self._history[-1])
        restored["revision"] = self._score["revision"] + 1
        restored = _invoke("validate", score=restored)
        self._history.pop()
        self._score = restored
        self._revision += 1
        return self.score

    def import_score(self, path: Any, expected_revision: int) -> dict[str, Any]:
        self._expect(expected_revision)
        try:
            incoming = _read_json(path, "score")
        except TimelineError as error:
            if error.code == "INVALID_INPUT":
                raise TimelineError("IMPORT_FAILED") from None
            raise
        candidate = _invoke("validate", score=incoming)
        original = self._package["score"]
        source, lyrics = candidate.get("source", {}), candidate.get("lyrics", {})
        original_source, original_lyrics = original.get("source", {}), original.get("lyrics", {})
        if source.get("videoId") != original_source.get("videoId") or lyrics.get("contentHash") != original_lyrics.get("contentHash"):
            raise TimelineError("SOURCE_MISMATCH")
        _assert_locked_preserved(self._score, candidate)
        candidate["revision"] = max(candidate["revision"], self._score["revision"] + 1)
        candidate = _invoke("validate", score=candidate)
        self._remember()
        self._score = candidate
        self._revision += 1
        return self.score

    def export(self, path: Any) -> Path:
        validated = _invoke("validate", score=deepcopy(self._score))
        encoded = _json_bytes(validated)
        target = Path(path)
        try:
            with target.open("xb") as output:
                output.write(encoded)
                output.write(b"\n")
        except FileExistsError:
            raise TimelineError("EXPORT_EXISTS") from None
        except OSError:
            raise TimelineError("BRIDGE_FAILED") from None
        return target


__all__ = ["TimelineDocument", "TimelineError", "MAX_HISTORY"]
