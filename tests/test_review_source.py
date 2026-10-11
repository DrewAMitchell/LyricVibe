import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from native.review_source import MAX_PACKAGE_BYTES, ReviewSourceBinding


class CountingHasher:
    def __init__(self, owner):
        self.owner = owner
        self.inner = hashlib.sha256()

    def update(self, block):
        self.owner['bytes'] += len(block)
        self.inner.update(block)

    def hexdigest(self):
        return self.inner.hexdigest()


class ReviewSourceBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.package_path = self.root / 'review.json'
        self.media_path = self.root / 'take.bin'
        self.media = b'original-media-bytes'
        self.media_path.write_bytes(self.media)
        self.package = {
            'version': 'lyricvibe.review.v1',
            'score': {'source': {'videoId': 'source-id'}, 'revision': 1},
            'audio': {'sha256': hashlib.sha256(self.media).hexdigest(), 'sizeBytes': len(self.media)},
        }
        self._write_package()
        self.validation_calls = []

    def tearDown(self):
        self.temp.cleanup()

    def _write_package(self, raw=None):
        self.package_path.write_bytes(raw if raw is not None else json.dumps(self.package).encode('utf-8'))

    def _binding(self, *, validator=None, media_hasher_factory=hashlib.sha256):
        if validator is None:
            validator = lambda score: self.validation_calls.append(score.copy())
        return ReviewSourceBinding(self.package_path, self.media_path, validator=validator,
                                   media_hasher_factory=media_hasher_factory)

    def test_validation_is_cached_by_exact_raw_bytes_and_return_values_are_defensive(self):
        binding = self._binding()
        first = binding()
        first['score']['source']['videoId'] = 'poisoned'
        second = binding()
        self.assertEqual(len(self.validation_calls), 1)
        self.assertEqual(second['score']['source']['videoId'], 'source-id')

        # Semantically equivalent JSON is still a new exact-byte snapshot.
        self._write_package(json.dumps(self.package, indent=2).encode('utf-8'))
        third = binding()
        self.assertEqual(third['score']['source']['videoId'], 'source-id')
        self.assertEqual(len(self.validation_calls), 2)

    def test_media_is_rehashed_when_stat_changes_even_if_bytes_match(self):
        hash_work = {'bytes': 0}
        binding = self._binding(media_hasher_factory=lambda: CountingHasher(hash_work))
        self.assertEqual(binding()['audio']['sha256'], self.package['audio']['sha256'])
        initial_hash_bytes = hash_work['bytes']
        stat = self.media_path.stat()
        os.utime(self.media_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
        self.assertEqual(binding()['audio']['sha256'], self.package['audio']['sha256'])
        self.assertEqual(hash_work['bytes'], initial_hash_bytes + len(self.media))
        self.assertEqual(len(self.validation_calls), 1)

    def test_same_size_media_mutation_is_rejected_on_cached_package_call(self):
        binding = self._binding()
        binding()
        self.media_path.write_bytes(b'changed-media-byte!!')
        self.assertEqual(self.media_path.stat().st_size, len(self.media))
        with self.assertRaisesRegex(ValueError, 'does not match'):
            binding()
        self.assertEqual(len(self.validation_calls), 1)

    def test_invalid_source_identity_prevents_media_open(self):
        missing_media = self.root / 'does-not-exist.bin'
        def reject_identity(_score):
            raise ValueError('source identity rejected')
        binding = ReviewSourceBinding(self.package_path, missing_media, validator=reject_identity)
        with self.assertRaisesRegex(ValueError, 'shared schema validation'):
            binding()

    def test_shared_score_validator_runs_once_per_changed_package_bytes(self):
        def validator(score):
            self.validation_calls.append(score['revision'])
            if score.get('revision') == 99:
                raise ValueError('validator detail must not escape')

        binding = self._binding(validator=validator)
        binding()
        binding()
        self.package['score']['revision'] = 2
        self._write_package()
        binding()
        self.package['score']['revision'] = 99
        self._write_package()
        with self.assertRaisesRegex(ValueError, 'shared schema validation'):
            binding()
        self.assertEqual(self.validation_calls, [1, 2, 99])

    def test_package_snapshot_is_bounded_before_validation(self):
        self.package_path.write_bytes(b'x' * (MAX_PACKAGE_BYTES + 1))
        binding = self._binding()
        with self.assertRaisesRegex(ValueError, 'size limit'):
            binding()
        self.assertEqual(self.validation_calls, [])


if __name__ == '__main__':
    unittest.main()
