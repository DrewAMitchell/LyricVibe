"""Synthetic integration proof: grouping -> replay -> shared-score preview."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from native.guide_grouping import GuideGroupingError, preview
from native.guide_review import ReviewDocument, ROOT, write_new, decode_audition, add_tap_clicks


@unittest.skipUnless(shutil.which('node'), 'Shared score validation requires Node.js')
class GuideReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['node', '-e', "const c=require('./extension/score-core.js');process.stdout.write(JSON.stringify(c.createScore({videoId:'FIXTURE0004',title:'Fixture',artist:'Fixture',durationMs:10000},'[00:01.00]go stone\\n[00:04.00]',{contentHash:'a'.repeat(64),provider:'fixture'})));"],
                                cwd=ROOT, capture_output=True, text=True, check=True, timeout=10)
        cls.score = json.loads(result.stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.package_path = Path(self.temp.name) / 'package.json'
        self.session_path = Path(self.temp.name) / 'trial.json'
        score = copy.deepcopy(self.score)
        self.words = score['phrases'][0]['words']
        package = {'version': 'lyricvibe.review.v1', 'score': score,
                   'receipt': {'expectedRevision': 0},
                   'audio': {'sha256': 'b' * 64, 'durationMs': 10000, 'sizeBytes': 1}}
        session = {'version': 'lyricvibe.guide-session.v1', 'source': score['source'],
                   'sourceSha256': 'b' * 64, 'scoreRevision': 0,
                   'phraseId': score['phrases'][0]['id'], 'clipStartMs': 1000,
                   'guideDelayMs': 0, 'captureStatus': {'durationMs': 3000},
                   'taps': [{'ordinal': n, 'guideTimeMs': t, 'approximateSourceMs': 1000 + t,
                             'kind': 'manual-syllable-change', 'unitId': None}
                            for n, t in enumerate([100, 700, 900, 1100], 1)]}
        write_new(self.package_path, package); write_new(self.session_path, session)
        self.doc = ReviewDocument(self.package_path, self.session_path)

    def act(self, kind, **fields):
        self.doc.act(dict(type=kind, **fields), self.doc.state['reviewRevision'])

    def grouped(self):
        self.act('assignWordEntrance', tapOrdinal=1, wordId=self.words[0]['id'])
        self.act('assignWordEntrance', tapOrdinal=2, wordId=self.words[1]['id'])
        self.act('assignNote', tapOrdinal=3)
        self.act('assignNote', tapOrdinal=4)
        self.act('setRelease', tapOrdinal=2, endMs=2400)

    def test_group_replay_shared_preview_and_inputs_unchanged(self):
        before = (self.package_path.read_bytes(), self.session_path.read_bytes())
        self.grouped()
        snapshot = preview(self.doc.state)
        self.assertEqual(len(snapshot['groups']), 2)
        self.assertEqual(snapshot['groups'][1]['noteTapOrdinals'], [3, 4])
        result = self.doc.score_preview()
        self.assertEqual(result['operations'], [])
        self.assertFalse(result['automaticAdmissionEnabled'])
        self.assertEqual(result['previewScore']['phrases'][0]['words'][1]['endMs'], 2400)
        confirmed = self.doc.score_preview(True)
        self.assertEqual(len(confirmed['operations']), 2)
        path = Path(self.temp.name) / 'review.json'
        write_new(path, self.doc.draft())
        restored = ReviewDocument(self.package_path, self.session_path)
        restored.replay(json.loads(path.read_text()))
        self.assertEqual(restored.state, self.doc.state)
        self.assertEqual(before, (self.package_path.read_bytes(), self.session_path.read_bytes()))

    def test_undo_monotonic_revision_and_stale_replay_is_atomic(self):
        self.act('ignore', tapOrdinal=1)
        self.act('undo')
        self.assertEqual(self.doc.state['reviewRevision'], 2)
        self.assertEqual(self.doc.state['taps'][0]['assignmentStatus'], 'unreviewed')
        draft = self.doc.draft()
        draft['actions'] = draft['actions'] + [{'expectedRevision': 0, 'operation': {'type': 'ignore', 'tapOrdinal': 2}}]
        before = copy.deepcopy(self.doc.state)
        with self.assertRaises(GuideGroupingError): self.doc.replay(draft)
        self.assertEqual(self.doc.state, before)
        wrong = self.doc.draft(); wrong['binding']['sessionSha256'] = 'c' * 64
        with self.assertRaises(GuideGroupingError): ReviewDocument(self.package_path, self.session_path).replay(wrong)

    def test_incomplete_take_release_and_overwrite_fail_closed(self):
        with self.assertRaises(GuideGroupingError) as failure: self.doc.score_preview()
        self.assertEqual(failure.exception.code, 'REVIEW_INCOMPLETE')
        self.grouped()
        self.act('undo')
        with self.assertRaises(GuideGroupingError) as failure: self.doc.score_preview()
        self.assertEqual(failure.exception.code, 'RELEASE_REQUIRED')
        with self.assertRaises(FileExistsError): write_new(self.session_path, {})

    def test_nonzero_offset_and_invalid_spectrum_are_explicit(self):
        self.grouped()
        self.doc.package['score']['offsetMs'] = 50
        with self.assertRaises(GuideGroupingError) as failure: self.doc.score_preview()
        self.assertEqual(failure.exception.code, 'OFFSET_REVIEW_REQUIRED')
        session = json.loads(self.session_path.read_text())
        session['features'] = {'frames': [{'timeMs': 10, 'spectrum': [2.0] * 32}]}
        self.session_path.write_text(json.dumps(session))
        with self.assertRaises(GuideGroupingError) as failure: ReviewDocument(self.package_path, self.session_path)
        self.assertEqual(failure.exception.code, 'INVALID_FEATURES')

    def test_decoder_stop_kills_and_reaps_owned_child(self):
        stop = threading.Event()
        class FakeProcess:
            def __init__(self): self.killed = False; self.reaped = False; self.returncode = None
            def communicate(self, timeout):
                if self.killed:
                    self.returncode = -1; self.reaped = True; return b'', b''
                stop.set()
                raise subprocess.TimeoutExpired('fixture-decoder', timeout)
            def poll(self): return self.returncode
            def kill(self): self.killed = True
        child = FakeProcess()
        with patch('native.guide_review.shutil.which', return_value='fixture-ffmpeg'), patch('native.guide_review.subprocess.Popen', return_value=child):
            self.assertEqual(decode_audition('fixture.mp4', 0, stop), b'')
        self.assertTrue(child.killed and child.reaped)

    def test_replay_rejects_input_changed_after_open_without_losing_draft(self):
        self.act('ignore', tapOrdinal=1)
        original = copy.deepcopy(self.doc.state)
        draft = self.doc.draft()
        self.session_path.write_text(self.session_path.read_text() + '\n')
        with self.assertRaises(GuideGroupingError) as failure: self.doc.replay(draft)
        self.assertEqual(failure.exception.code, 'INPUT_CHANGED')
        self.assertEqual(self.doc.state, original)

    def test_audible_taps_preserve_length_only_mix_at_source_times_and_clip_safely(self):
        from array import array
        pcm = bytes(16000 * 2)
        mixed = array('h'); mixed.frombytes(add_tap_clicks(pcm, 1000, [500, 1250, 2500]))
        self.assertEqual(len(mixed), 16000)
        self.assertTrue(all(v == 0 for v in mixed[:4000]))
        self.assertTrue(any(v != 0 for v in mixed[4000:4480]))
        self.assertTrue(all(v == 0 for v in mixed[4480:]))
        saturated = array('h', [32767] * 16000).tobytes()
        self.assertEqual(len(add_tap_clicks(saturated, 1000, [1000])), len(saturated))


if __name__ == '__main__': unittest.main()
