import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native.evaluate_alignment import evaluate, main
from native.companion import CompanionError


class TimingEvaluationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = "const c=require('./extension/score-core.js');process.stdout.write(JSON.stringify(c.createScore({platform:'youtube',videoId:'FIXTURE0001',title:'Fixture',artist:'Fixture',durationMs:10000},'[00:01.00]held fast',{provider:'fixture',contentHash:'a'.repeat(64)})));"
        cls.score = json.loads(subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True).stdout)

    def setUp(self):
        baseline = copy.deepcopy(self.score)
        baseline['offsetMs'] = 100
        self.ids = [word['id'] for phrase in baseline['phrases'] for word in phrase['words']]
        self.package = {'version': 'lyricvibe.review.v1', 'score': baseline, 'audio': {'sha256': 'b' * 64}, 'receipt': {
            'version': 'lyricvibe.alignment.v1', 'mediaKey': 'youtube:FIXTURE0001', 'lyricsHash': 'a' * 64,
            'expectedRevision': baseline['revision'], 'adapter': 'fixture', 'model': 'fixture-not-audio', 'automaticAdmissionEnabled': False,
            'proposals': [{'wordId': self.ids[0], 'startMs': 1400, 'endMs': 1600, 'accepted': False, 'evidenceId': 'fixture'}]}}
        self.reference = copy.deepcopy(baseline)
        self.reference['offsetMs'] = -50
        self.reference['revision'] += 1
        for phrase in self.reference['phrases']:
            for word in phrase['words']:
                word.update(startMs=1300, endMs=2000, provenance='manual', locked=True)

    def compare(self, **kwargs):
        return evaluate(self.package, self.reference, self.ids, human_reviewed=True, **kwargs)

    def test_offsets_signs_coverage_and_no_mutation(self):
        original = copy.deepcopy((self.package, self.reference))
        result = self.compare()
        self.assertEqual(result['words'][0]['onsetErrorMs'], 250)
        self.assertEqual(result['words'][0]['releaseErrorMs'], -250)
        self.assertEqual(result['words'][0]['durationErrorMs'], -500)
        self.assertEqual(result['coverage'], 0.5)
        self.assertEqual(result['summary']['onsetErrorMs']['p90AbsoluteMs'], 250)
        self.assertFalse(result['automaticAdmissionEnabled'])
        self.assertNotIn('held', json.dumps(result))
        self.assertEqual((self.package, self.reference), original)

    def test_review_assertion_is_required_even_when_locked(self):
        with self.assertRaisesRegex(CompanionError, 'Confirm'):
            evaluate(self.package, self.reference, self.ids)

    def test_rejects_estimated_or_unlocked_references(self):
        for field, value in [('locked', False), ('provenance', 'aligned')]:
            reference = copy.deepcopy(self.reference)
            reference['phrases'][0]['words'][0][field] = value
            with self.assertRaises(CompanionError):
                evaluate(self.package, reference, self.ids, human_reviewed=True)

    def test_identity_lexical_and_stale_receipt_rejection(self):
        for change in ['source', 'hash', 'text', 'revision']:
            package, reference = copy.deepcopy(self.package), copy.deepcopy(self.reference)
            if change == 'source': reference['source']['videoId'] = 'FIXTURE0003'
            if change == 'hash': reference['lyrics']['contentHash'] = 'c' * 64
            if change == 'text': reference['phrases'][0]['words'][0]['text'] = 'different'
            if change == 'revision': package['receipt']['expectedRevision'] += 1
            with self.assertRaises(CompanionError):
                evaluate(package, reference, self.ids, human_reviewed=True)

    def test_missing_proposals_do_not_become_zero_error(self):
        self.package['receipt']['proposals'] = []
        result = self.compare()
        self.assertEqual(result['matchedWordCount'], 0)
        self.assertEqual(result['coverage'], 0)
        self.assertIsNone(result['summary']['onsetErrorMs'])

    def test_invalid_selection_and_recording_identity(self):
        for selection in [[], [self.ids[0], self.ids[0]], ['unknown']]:
            with self.assertRaises(CompanionError):
                evaluate(self.package, self.reference, selection, human_reviewed=True)
        for audio in [None, [], {'sha256': 'not-a-digest'}]:
            package = copy.deepcopy(self.package)
            package['audio'] = audio
            with self.assertRaises(CompanionError):
                evaluate(package, self.reference, self.ids, human_reviewed=True)

    def test_cli_preserves_existing_output_and_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            package, reference, output = folder / 'package.json', folder / 'reference.json', folder / 'result.json'
            package.write_text(json.dumps(self.package), encoding='utf-8')
            reference.write_text(json.dumps(self.reference), encoding='utf-8')
            args = ['--package', str(package), '--reference', str(reference), '--word-id', self.ids[0], '--human-reviewed', '--output', str(output)]
            self.assertEqual(main(args), 0)
            first = output.read_bytes()
            self.assertEqual(main(args), 1)
            self.assertEqual(output.read_bytes(), first)
            self.assertEqual(main(args[:-1] + [str(reference)]), 1)
            self.assertEqual(json.loads(reference.read_text()), self.reference)


if __name__ == '__main__':
    unittest.main()
