"""Bounded, optional adapter for Montreal Forced Aligner's legacy ``align_one``.

This adapter is deliberately opt-in: callers must supply every runtime path,
including an isolated MFA root.  It returns review-only timing proposals and
never installs/configures MFA or changes the user's global MFA state.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import unicodedata
import uuid
from typing import Any
from collections.abc import Callable

from .audio_input import AudioInputError, validate_audio_input


MAX_AUDIO_SECONDS = 12.0
MAX_TEXT_CHARS = 20_000
MAX_WORDS = 600
MAX_JSON_BYTES = 2_000_000
MAX_INTERVALS = 20_000
MFA_VERSION = "3.3.10"
_SILENCE_WORDS = {"eps"}
_UNKNOWN_WORDS = {"unk", "unknown", "oov"}


class MFAError(RuntimeError):
    """Safe, non-content-bearing error from the optional MFA adapter."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _normalize_word(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(
        character.casefold()
        for character in value
        if unicodedata.category(character)[0] in {"L", "N"}
    )


def _safe_tier_schema(tiers: dict[Any, Any]) -> str:
    """Describe tier schema without copying annotation labels or source text."""
    rows = []
    for name, tier in tiers.items():
        suffix = name.casefold().rsplit(" - ", 1)[-1] if isinstance(name, str) else ""
        safe_name = suffix if suffix in {"words", "phones"} else "other"
        tier_type = tier.get("type") if isinstance(tier, dict) else None
        if isinstance(tier_type, str):
            folded_type = tier_type.casefold()
            safe_type = folded_type if folded_type in {
                "interval", "intervaltier", "interval_tier", "interval-tier",
                "point", "pointtier", "text", "texttier", "class",
            } else "other-string"
        elif tier_type is None:
            safe_type = "missing"
        elif isinstance(tier_type, bool):
            safe_type = "boolean"
        elif isinstance(tier_type, (int, float)):
            safe_type = "number"
        elif isinstance(tier_type, list):
            safe_type = "array"
        elif isinstance(tier_type, dict):
            safe_type = "object"
        else:
            safe_type = "other"
        entries = tier.get("entries") if isinstance(tier, dict) else None
        count = len(entries) if isinstance(entries, list) else None
        rows.append((safe_name, safe_type, count))
    rows.sort()
    return repr(rows)


def _is_interval_tier(tier: Any) -> bool:
    return (
        isinstance(tier, dict)
        and isinstance(tier.get("type"), str)
        and tier["type"].casefold() in {"interval", "intervaltier", "interval_tier", "interval-tier"}
    )


def parse_alignment_json(
    payload: bytes | str,
    supplied_text: str,
    duration_seconds: float,
) -> dict[str, Any]:
    """Validate MFA TextGrid JSON and map complete word intervals by ordinal."""
    if not isinstance(supplied_text, str):
        raise MFAError("MFA_TOKEN_MISMATCH", "Supplied text is invalid.")
    try:
        raw = payload.encode("utf-8") if isinstance(payload, str) else payload
        if not isinstance(raw, bytes) or len(raw) > MAX_JSON_BYTES:
            raise MFAError("MFA_INVALID_OUTPUT", "MFA JSON output exceeded its size limit.")
        body = json.loads(raw.decode("utf-8"))
    except MFAError:
        raise
    except (UnicodeError, json.JSONDecodeError, TypeError):
        raise MFAError("MFA_INVALID_OUTPUT", "MFA did not produce valid UTF-8 JSON.") from None

    if not isinstance(body, dict) or not isinstance(body.get("tiers"), dict):
        raise MFAError("MFA_INVALID_OUTPUT", "MFA JSON is missing its tiers object.")
    tiers = body["tiers"]
    # MFA may prefix tier names with the speaker label ("speaker - words").
    # The adapter accepts one unambiguous words tier and rejects multi-speaker
    # outputs rather than merging timelines or ordering across speakers.
    word_tiers = [
        value for name, value in tiers.items()
        if isinstance(name, str) and name.casefold().rsplit(" - ", 1)[-1] == "words"
    ]
    word_tier = word_tiers[0] if len(word_tiers) == 1 else None
    if not _is_interval_tier(word_tier):
        raise MFAError("MFA_INVALID_OUTPUT", f"MFA JSON has no unique interval word tier; sanitized tier schema={_safe_tier_schema(tiers)}.")
    entries = word_tier.get("entries")
    expected = supplied_text.split()
    if not 0 < len(expected) <= MAX_WORDS or not isinstance(entries, list) or len(entries) > MAX_INTERVALS:
        raise MFAError("MFA_TOKEN_MISMATCH", "MFA word count does not match supplied text.")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise MFAError("MFA_INVALID_OUTPUT", "Audio duration is invalid.")
    # Validate every MFA word interval, including the recognized silence
    # intervals that may later be omitted from the user-word mapping.
    all_previous_end = 0.0
    for entry in entries:
        if (
            not isinstance(entry, list) or len(entry) != 3
            or isinstance(entry[0], bool) or not isinstance(entry[0], (int, float))
            or isinstance(entry[1], bool) or not isinstance(entry[1], (int, float))
            or not isinstance(entry[2], str)
        ):
            raise MFAError("MFA_INVALID_OUTPUT", "MFA word interval has invalid fields.")
        interval_start, interval_end = float(entry[0]), float(entry[1])
        if (
            not math.isfinite(interval_start) or not math.isfinite(interval_end)
            or interval_start < 0 or interval_end <= interval_start
            or interval_end > duration_seconds + 0.050
            or interval_start < all_previous_end - 0.001
        ):
            raise MFAError("MFA_INVALID_OUTPUT", "MFA word intervals are out of bounds or out of order.")
        all_previous_end = interval_end
    expected_normalized = [_normalize_word(word) for word in expected]
    ignored_silence_words = 0
    if len(entries) != len(expected):
        output_labels = [entry[2] if isinstance(entry, list) and len(entry) == 3 else None for entry in entries]
        normalized_labels = [_normalize_word(label) for label in output_labels]
        silence_mask = [label in _SILENCE_WORDS for label in normalized_labels]
        non_silence_labels = [label for label, is_silence in zip(normalized_labels, silence_mask) if not is_silence]
        if sum(silence_mask) and non_silence_labels == expected_normalized:
            ignored_silence_words = sum(silence_mask)
            entries = [entry for entry, is_silence in zip(entries, silence_mask) if not is_silence]
        else:
            unknown_count = sum(label in _UNKNOWN_WORDS for label in normalized_labels)
            silence_count = sum(silence_mask)
            other_count = sum(label not in _SILENCE_WORDS | _UNKNOWN_WORDS for label in normalized_labels)
            raise MFAError(
                "MFA_TOKEN_MISMATCH",
                f"MFA word tier count mismatch (expected={len(expected)}, returned={len(entries)}, silence={silence_count}, unknown={unknown_count}, other={other_count}).",
            )
    words: list[dict[str, Any]] = []
    previous_end = 0.0
    for index, (entry, target) in enumerate(zip(entries, expected)):
        if not isinstance(entry, list) or len(entry) != 3:
            raise MFAError("MFA_INVALID_OUTPUT", "MFA word interval has an invalid shape.")
        start, end, label = entry
        if (
            isinstance(start, bool) or not isinstance(start, (int, float))
            or isinstance(end, bool) or not isinstance(end, (int, float))
            or not isinstance(label, str)
        ):
            raise MFAError("MFA_INVALID_OUTPUT", "MFA word interval has invalid fields.")
        start, end = float(start), float(end)
        if (
            not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start or end > duration_seconds + 0.050
            or start < previous_end - 0.001
        ):
            raise MFAError("MFA_INVALID_OUTPUT", "MFA word intervals are out of bounds or out of order.")
        if not _normalize_word(label) or _normalize_word(label) != expected_normalized[index]:
            raise MFAError("MFA_TOKEN_MISMATCH", "MFA word labels differ from supplied text.")
        words.append({
            "wordIndex": index,
            "startMs": round(start * 1000),
            "endMs": round(end * 1000),
        })
        previous_end = end

    phone_tiers = [
        value for name, value in tiers.items()
        if isinstance(name, str) and name.casefold().rsplit(" - ", 1)[-1] == "phones"
    ]
    if len(phone_tiers) > 1:
        raise MFAError("MFA_INVALID_OUTPUT", "MFA returned ambiguous multi-speaker phone intervals.")
    phone_tier = phone_tiers[0] if phone_tiers else None
    phones: list[dict[str, Any]] = []
    if phone_tier is not None:
        if not _is_interval_tier(phone_tier):
            raise MFAError("MFA_INVALID_OUTPUT", "MFA phone tier is malformed.")
        phone_entries = phone_tier.get("entries")
        if not isinstance(phone_entries, list) or len(phone_entries) > MAX_INTERVALS:
            raise MFAError("MFA_INVALID_OUTPUT", "MFA phone tier exceeded its interval limit.")
        phone_previous_end = 0.0
        for entry in phone_entries:
            if (
                not isinstance(entry, list) or len(entry) != 3
                or isinstance(entry[0], bool) or not isinstance(entry[0], (int, float))
                or isinstance(entry[1], bool) or not isinstance(entry[1], (int, float))
                or not isinstance(entry[2], str)
            ):
                raise MFAError("MFA_INVALID_OUTPUT", "MFA phone interval has invalid fields.")
            start, end = float(entry[0]), float(entry[1])
            if (
                not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or end <= start or end > duration_seconds + 0.050
                or start < phone_previous_end - 0.001
            ):
                raise MFAError("MFA_INVALID_OUTPUT", "MFA phone intervals are out of bounds or out of order.")
            phones.append({"startMs": round(start * 1000), "endMs": round(end * 1000)})
            phone_previous_end = end
    return {"words": words, "phones": phones, "ignoredSilenceWordCount": ignored_silence_words}


class _WindowsJob:
    """Own a suspended child process tree; closing the job kills descendants."""

    def __init__(self) -> None:
        if os.name != "nt":
            self.handle = None
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION with KILL_ON_JOB_CLOSE.
        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32), ("SchedulingClass", ctypes.c_uint32)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in
                        ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x00002000
        kernel32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel32.CloseHandle(handle)
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
        self.handle = handle
        self.kernel32 = kernel32

    def resume_primary_thread(self, pid: int) -> None:
        """Resume the single initial thread; Popen closes its thread handle."""
        class ThreadEntry32(ctypes.Structure):
            _fields_ = [("dwSize", ctypes.c_uint32), ("cntUsage", ctypes.c_uint32),
                        ("th32ThreadID", ctypes.c_uint32), ("th32OwnerProcessID", ctypes.c_uint32),
                        ("tpBasePri", ctypes.c_int32), ("tpDeltaPri", ctypes.c_int32),
                        ("dwFlags", ctypes.c_uint32)]
        self.kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        self.kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        self.kernel32.Thread32First.argtypes = [ctypes.c_void_p, ctypes.POINTER(ThreadEntry32)]
        self.kernel32.Thread32First.restype = ctypes.c_int
        self.kernel32.Thread32Next.argtypes = [ctypes.c_void_p, ctypes.POINTER(ThreadEntry32)]
        self.kernel32.Thread32Next.restype = ctypes.c_int
        self.kernel32.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        self.kernel32.OpenThread.restype = ctypes.c_void_p
        self.kernel32.ResumeThread.argtypes = [ctypes.c_void_p]
        self.kernel32.ResumeThread.restype = ctypes.c_uint32
        snapshot = self.kernel32.CreateToolhelp32Snapshot(0x00000004, 0)
        invalid_handle = ctypes.c_void_p(-1).value
        if not snapshot or snapshot == invalid_handle:
            raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
        thread_handle = None
        try:
            entry = ThreadEntry32()
            entry.dwSize = ctypes.sizeof(entry)
            matches: list[int] = []
            has_entry = self.kernel32.Thread32First(snapshot, ctypes.byref(entry))
            while has_entry:
                if entry.th32OwnerProcessID == pid:
                    matches.append(int(entry.th32ThreadID))
                has_entry = self.kernel32.Thread32Next(snapshot, ctypes.byref(entry))
            if len(matches) != 1:
                raise OSError("suspended MFA launcher did not have exactly one initial thread")
            thread_handle = self.kernel32.OpenThread(0x0002, False, matches[0])
            if not thread_handle:
                raise OSError(ctypes.get_last_error(), "OpenThread failed")
            if self.kernel32.ResumeThread(thread_handle) == 0xFFFFFFFF:
                raise OSError(ctypes.get_last_error(), "ResumeThread failed")
        finally:
            if thread_handle:
                self.kernel32.CloseHandle(thread_handle)
            self.kernel32.CloseHandle(snapshot)

    def creation_time_filetime(self, process: subprocess.Popen[bytes]) -> int:
        class FileTime(ctypes.Structure):
            _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]
        created, exited, kernel, user = FileTime(), FileTime(), FileTime(), FileTime()
        self.kernel32.GetProcessTimes.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(FileTime), ctypes.POINTER(FileTime),
            ctypes.POINTER(FileTime), ctypes.POINTER(FileTime),
        ]
        self.kernel32.GetProcessTimes.restype = ctypes.c_int
        if not self.kernel32.GetProcessTimes(int(process._handle), ctypes.byref(created), ctypes.byref(exited),
                                             ctypes.byref(kernel), ctypes.byref(user)):
            raise OSError(ctypes.get_last_error(), "GetProcessTimes failed")
        return (int(created.high) << 32) | int(created.low)

    def close(self) -> None:
        if self.handle:
            self.kernel32.CloseHandle(self.handle)
            self.handle = None


def align(
    audio_path: str | Path,
    supplied_text: str,
    *,
    executable: str | Path,
    micromamba_executable: str | Path,
    environment_prefix: str | Path,
    dictionary_path: str | Path,
    acoustic_model_path: str | Path,
    mfa_root_dir: str | Path,
    mamba_root_prefix: str | Path,
    on_lifecycle: Callable[[dict[str, Any]], None],
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Run caller-provisioned MFA3 legacy ``align_one`` and return review-only anchors."""
    if os.name != "nt":
        raise MFAError("MFA_UNSUPPORTED_PLATFORM", "This adapter requires Windows Job Object process-tree cleanup.")
    if not callable(on_lifecycle):
        raise MFAError("MFA_INVALID_ARGUMENT", "A process lifecycle recorder is required for MFA runs.")
    paths = [Path(value).expanduser() for value in (
        executable, micromamba_executable, environment_prefix, dictionary_path,
        acoustic_model_path, mfa_root_dir, mamba_root_prefix,
    )]
    if not all(path.is_absolute() for path in paths) or not all(path.exists() for path in paths):
        raise MFAError("MFA_NOT_READY", "MFA executable, models, and isolated runtime root must exist at explicit absolute paths.")
    (executable_path, micromamba_path, environment, dictionary, acoustic_model,
     runtime_root, mamba_root) = paths
    if (
        not executable_path.is_file() or not micromamba_path.is_file()
        or not environment.is_dir() or not dictionary.is_file()
        or not acoustic_model.exists() or not runtime_root.is_dir()
        or not mamba_root.is_dir()
    ):
        raise MFAError("MFA_NOT_READY", "MFA executable, models, and isolated runtime root are unavailable.")
    try:
        executable_path.relative_to(environment)
    except ValueError:
        raise MFAError("MFA_NOT_READY", "The MFA executable must belong to the explicit isolated environment.") from None
    if not isinstance(supplied_text, str) or not supplied_text.strip() or len(supplied_text) > MAX_TEXT_CHARS:
        raise MFAError("MFA_TOKEN_MISMATCH", "Supplied text is empty or exceeds the adapter limit.")
    expected = supplied_text.split()
    if len(expected) > MAX_WORDS:
        raise MFAError("MFA_TOKEN_MISMATCH", "Supplied text exceeds the adapter word limit.")
    if not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= 300:
        raise MFAError("MFA_INVALID_ARGUMENT", "MFA timeout must be between zero and 300 seconds.")
    try:
        audio = validate_audio_input(audio_path, max_duration_seconds=MAX_AUDIO_SECONDS)
    except AudioInputError as exc:
        raise MFAError(exc.code, str(exc)) from None
    if audio.channels != 1 or audio.sample_width_bytes != 2:
        raise MFAError("UNSUPPORTED_AUDIO_FORMAT", "MFA adapter requires mono 16-bit PCM WAV audio.")

    with tempfile.TemporaryDirectory(prefix="lyricvibe-mfa-") as temp_name:
        temp_dir = Path(temp_name)
        transcript = temp_dir / "input.txt"
        output_dir = temp_dir / "output"
        mfa_scratch = temp_dir / "mfa-scratch"
        output_dir.mkdir()
        mfa_scratch.mkdir()
        transcript.write_text(" ".join(expected), encoding="utf-8")
        output_file = output_dir / f"{audio.path.stem}.json"
        argv = [str(micromamba_path), "run", "-p", str(environment), str(executable_path),
                "align_one", str(audio.path), str(transcript), str(dictionary), str(acoustic_model), str(output_file),
                "--output_format", "json", "--num_jobs", "1",
                "--temporary_directory", str(mfa_scratch)]
        child_env = os.environ.copy()
        child_env["MFA_ROOT_DIR"] = str(runtime_root)
        child_env["MAMBA_ROOT_PREFIX"] = str(mamba_root)
        job = _WindowsJob()
        process: subprocess.Popen[bytes] | None = None
        lifecycle_started = False
        lease_id = uuid.uuid4().hex
        creation_time_filetime: int | None = None
        try:
            flags = getattr(subprocess, "CREATE_SUSPENDED", 0) if os.name == "nt" else 0
            process = subprocess.Popen(argv, cwd=str(temp_dir), env=child_env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False,
                                       creationflags=flags)
            # Register the suspended PID/creation identity before allowing MFA
            # to execute or spawn descendants.
            job.kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            job.kernel32.AssignProcessToJobObject.restype = ctypes.c_int
            if not job.kernel32.AssignProcessToJobObject(job.handle, int(process._handle)):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
            creation_time_filetime = job.creation_time_filetime(process)
            lifecycle_started = True
            on_lifecycle({"event": "started", "pid": process.pid,
                          "creationTimeFiletime": creation_time_filetime, "leaseId": lease_id})
            job.resume_primary_thread(process.pid)
            try:
                return_code = process.wait(timeout=float(timeout_seconds))
            except subprocess.TimeoutExpired:
                job.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # This is only expected when Job Object assignment failed;
                    # the process was still suspended, so it cannot have spawned.
                    process.kill()
                    process.wait(timeout=5)
                raise MFAError("MFA_TIMEOUT", "MFA alignment exceeded its time limit.") from None
            if return_code != 0:
                raise MFAError("MFA_FAILED", "MFA alignment failed; diagnostic output was suppressed.")
            try:
                candidates = list(output_dir.glob("*.json"))
                if len(candidates) != 1:
                    raise MFAError("MFA_INVALID_OUTPUT", "MFA did not create exactly one JSON output.")
                output_file = candidates[0]
                size = output_file.stat().st_size
                if size > MAX_JSON_BYTES:
                    raise MFAError("MFA_INVALID_OUTPUT", "MFA output exceeded its size limit.")
                parsed = parse_alignment_json(output_file.read_bytes(), supplied_text, audio.duration_seconds)
            except MFAError:
                raise
            except OSError:
                raise MFAError("MFA_INVALID_OUTPUT", "MFA did not create the expected JSON output.") from None
        except MFAError:
            raise
        except OSError:
            raise MFAError("MFA_NOT_READY", "MFA could not be launched with the supplied runtime.") from None
        finally:
            if process is not None and process.poll() is None:
                job.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            job.close()
            if lifecycle_started and process is not None and creation_time_filetime is not None:
                try:
                    on_lifecycle({"event": "closed", "pid": process.pid,
                                  "creationTimeFiletime": creation_time_filetime, "leaseId": lease_id})
                except Exception:
                    raise MFAError("MFA_LIFECYCLE_FAILED", "MFA process lease could not be closed in the lifecycle recorder.") from None
    return {"model": "montreal-forced-aligner-legacy", "expectedMfaVersion": MFA_VERSION, **parsed}
