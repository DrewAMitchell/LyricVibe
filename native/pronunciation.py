"""Offline CMUdict lookup for pronunciation and syllable-count hints.

This lookup describes dictionary pronunciations. It does not infer sung word
or syllable timing, and an out-of-vocabulary result is never guessed from
spelling.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import re
import unicodedata
from typing import Any
import gzip


DICT_PATH = Path(__file__).resolve().parent / "data" / "cmudict.dict.gz"
SOURCE_COMMIT = "74790861f652b15e4ac49015a90074ad62a27690"
SOURCE_URL = f"https://github.com/cmusphinx/cmudict/blob/{SOURCE_COMMIT}/cmudict.dict"
SOURCE_LICENSE = "Carnegie Mellon University two-clause BSD license; see native/data/cmudict.LICENSE"
SOURCE_SHA256 = "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22"

_VARIANT_RE = re.compile(r"^(.*?)(?:\((\d+)\))?$")
_WORD_RE = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*")
_VOWEL_RE = re.compile(r"^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)([012])$")


def normalize_word(word: str) -> str:
    """Normalize a surface token to a CMUdict key without inferring sounds."""
    normalized = unicodedata.normalize("NFKC", word).casefold().replace("’", "'")
    return normalized.strip("\t\r\n .,!?;:\"()[]{}")


@lru_cache(maxsize=1)
def _dictionary() -> dict[str, list[tuple[int, tuple[str, ...]]]]:
    """Load the pinned, compressed source dictionary once per process."""
    entries: dict[str, list[tuple[int, tuple[str, ...]]]] = {}
    with gzip.open(DICT_PATH, "rt", encoding="ascii") as source:
        for line in source:
            if not line or line[0] in ";\n":
                continue
            fields = line.strip().split()
            if len(fields) < 2:
                continue
            match = _VARIANT_RE.fullmatch(fields[0])
            if not match:
                continue
            key = match.group(1).casefold()
            variant = int(match.group(2) or 1)
            entries.setdefault(key, []).append((variant, tuple(fields[1:])))
    for pronunciations in entries.values():
        pronunciations.sort(key=lambda item: item[0])
    return entries


def _render_pronunciation(variant: int, phones: tuple[str, ...]) -> dict[str, Any]:
    nuclei: list[dict[str, Any]] = []
    for index, phone in enumerate(phones):
        match = _VOWEL_RE.fullmatch(phone)
        if match:
            nuclei.append({"phonemeIndex": index, "phone": match.group(1), "stress": int(match.group(2))})
    return {
        "variant": variant,
        "phonemes": list(phones),
        "vowelNuclei": nuclei,
        "syllableCount": len(nuclei),
        "stressPattern": [nucleus["stress"] for nucleus in nuclei],
    }


def lookup_word(word: str) -> dict[str, Any]:
    """Return all dictionary alternatives, nuclei and stress for one word.

    ``out-of-vocabulary`` is explicit. No spelling-based syllable or phone
    guess is returned when CMUdict has no entry.
    """
    if not isinstance(word, str) or not word.strip():
        raise ValueError("word must be a nonempty string")
    normalized = normalize_word(word)
    pronunciations = _dictionary().get(normalized, [])
    return {
        "status": "found" if pronunciations else "out-of-vocabulary",
        "normalized": normalized,
        "source": {
            "name": "CMUdict",
            "commit": SOURCE_COMMIT,
            "sha256": SOURCE_SHA256,
            "license": SOURCE_LICENSE,
        },
        "pronunciations": [_render_pronunciation(number, phones) for number, phones in pronunciations],
        "timingClaim": "none; dictionary phones and syllable counts do not locate sung word or syllable boundaries",
    }


def lookup_text(text: str) -> list[dict[str, Any]]:
    """Look up whitespace-delimited English lyric tokens without storing text."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return [lookup_word(match.group(0)) for match in _WORD_RE.finditer(text)]


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("words", nargs="*", help="English words to look up; use --stdin for private input")
    parser.add_argument("--stdin", action="store_true", help="read one word or phrase from stdin")
    args = parser.parse_args()
    query = sys.stdin.read() if args.stdin else " ".join(args.words)
    print(json.dumps(lookup_text(query), ensure_ascii=True, separators=(",", ":")))
