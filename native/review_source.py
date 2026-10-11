"""Strict, repeatable package-to-media binding for local review playback."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import threading
from typing import Any, Callable

PACKAGE_VERSION = 'lyricvibe.review.v1'
MAX_PACKAGE_BYTES = 10_000_000
MEDIA_HASH_BLOCK_BYTES = 1_048_576
_SHA256_RE = re.compile(r'^[0-9a-f]{64}$')


def _validate_score(score: Any) -> Any:
    from .companion import _validate_score as validate
    return validate(score)


class ReviewSourceBinding:
    """Callable package loader bound to exact package bytes and source media.

    Score validation is cached for the last exact package snapshot. Media bytes
    are rehashed on every call so the package cache never becomes a media cache.
    """

    def __init__(self, package_path: str | Path, media_path: str | Path, *,
                 validator: Callable[[Any], Any] | None = None,
                 media_hasher_factory: Callable[[], Any] = hashlib.sha256):
        self.package_path = Path(package_path).expanduser().resolve()
        self.media_path = Path(media_path).expanduser().resolve()
        self._validator = validator or _validate_score
        self._media_hasher_factory = media_hasher_factory
        self._cache_lock = threading.Lock()
        self._cached_raw_sha256: str | None = None
        self._cached_raw_bytes: bytes | None = None
        self._cached_package: dict[str, Any] | None = None

    def __call__(self) -> dict[str, Any]:
        package = self._read_validated_package()
        self._verify_media(package)
        return package

    def _read_validated_package(self) -> dict[str, Any]:
        try:
            with self.package_path.open('rb') as package_file:
                raw = package_file.read(MAX_PACKAGE_BYTES + 1)
        except OSError:
            raise ValueError('Review package could not be read.') from None
        if len(raw) > MAX_PACKAGE_BYTES:
            raise ValueError('Review package exceeds its size limit.')

        raw_sha256 = hashlib.sha256(raw).hexdigest()
        with self._cache_lock:
            if (self._cached_raw_sha256 == raw_sha256 and self._cached_raw_bytes == raw
                    and self._cached_package is not None):
                return deepcopy(self._cached_package)

            try:
                package = json.loads(raw.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValueError('Review package is not valid UTF-8 JSON.') from None
            if not isinstance(package, dict) or package.get('version') != PACKAGE_VERSION:
                raise ValueError('Unsupported review package.')
            score = package.get('score')
            if not isinstance(score, dict):
                raise ValueError('Review package has no valid score.')
            try:
                self._validator(score)
            except Exception:
                raise ValueError('Review package score failed shared schema validation.') from None

            audio = package.get('audio')
            if not isinstance(audio, dict):
                raise ValueError('Review package has no audio binding.')
            media_hash = audio.get('sha256')
            media_size = audio.get('sizeBytes')
            if (not isinstance(media_hash, str) or not _SHA256_RE.fullmatch(media_hash)
                    or isinstance(media_size, bool) or not isinstance(media_size, int) or media_size <= 0):
                raise ValueError('Review package audio binding is invalid.')

            self._cached_raw_sha256 = raw_sha256
            self._cached_raw_bytes = raw
            self._cached_package = deepcopy(package)
            return deepcopy(self._cached_package)

    def _verify_media(self, package: dict[str, Any]) -> None:
        expected_hash = package['audio']['sha256']
        expected_size = package['audio']['sizeBytes']
        digest = self._media_hasher_factory()
        byte_count = 0
        try:
            with self.media_path.open('rb') as media_file:
                before = _fstat_signature(media_file.fileno())
                for block in iter(lambda: media_file.read(MEDIA_HASH_BLOCK_BYTES), b''):
                    digest.update(block)
                    byte_count += len(block)
                after = _fstat_signature(media_file.fileno())
        except OSError:
            raise ValueError('Source recording could not be read.') from None

        if (before != after or byte_count != before[0] or byte_count != after[0]
                or byte_count != expected_size or digest.hexdigest() != expected_hash):
            raise ValueError('Source recording does not match this review package.')


def _fstat_signature(descriptor: int) -> tuple[int, int, int, int]:
    import os
    info = os.fstat(descriptor)
    return (info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino)


def load_bound_package(package_path: str | Path, media_path: str | Path) -> dict[str, Any]:
    """One-shot convenience loader for consumers without a long-lived binding."""
    return ReviewSourceBinding(package_path, media_path)()
