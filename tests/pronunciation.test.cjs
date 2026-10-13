const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pronunciation = require('../extension/pronunciation.js');
const { buildPronunciation, SOURCE_COMMIT, SOURCE_SHA256, GZIP_SHA256 } = require('../scripts/build-pronunciation.cjs');

const counts = {
  metadata: { source: 'fixture', language: 'en' },
  entries: { about: [2], baby: [2], stone: [1], twenty: [2], four: [1], variant: [2, 3] },
};

test('build compiles pinned CMUdict variants into sorted unique positive vowel counts and copies its license', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricvibe-pronunciation-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const result = buildPronunciation(outDir);
  const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'pronunciation-counts.json'), 'utf8'));
  assert.equal(result.metadata.commit, SOURCE_COMMIT);
  assert.equal(result.metadata.sha256, SOURCE_SHA256);
  assert.equal(result.metadata.gzipSha256, GZIP_SHA256);
  assert.equal(result.metadata.language, 'en');
  assert.equal(saved.entries.about.length, 1);
  // The real dictionary contains the word "entries"; it is not a wrapper.
  assert.deepEqual(pronunciation.suggest('about', saved.entries).parts, ['a', 'bout']);
  assert.deepEqual(pronunciation.suggest('24', saved.entries).parts, ['twen', 'ty', 'four']);
  for (const word of ['hour', 'hours', 'our', 'fire']) assert.deepEqual(saved.entries[word], [1, 2]);
  const curated = new Map([['hour', ['hou', 'r']], ['hours', ['hou', 'rs']], ['our', ['ou', 'r']], ['fire', ['fi', 're']]]);
  for (const [word, expected] of curated) {
    const result = pronunciation.suggest(word, saved.entries);
    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.parts, []);
    const candidate = result.alternatives.find(item => item.count === 2);
    assert.deepEqual(candidate.parts, expected);
    assert.equal(candidate.method, 'dictionary-count+curated-spelling');
    assert.equal(candidate.parts.join(''), word);
  }
  const punctuated = pronunciation.suggest('Hour!', saved.entries);
  assert.deepEqual(punctuated.alternatives.find(item => item.count === 2).parts, ['Hou', 'r!']);
  assert.equal(punctuated.alternatives.find(item => item.count === 2).parts.join(''), 'Hour!');
  assert.ok(Object.values(saved.entries).every((values) => values.length &&
    values.every((value, index) => Number.isSafeInteger(value) && value > 0 && (!index || values[index - 1] < value))));
  assert.match(fs.readFileSync(path.join(outDir, 'pronunciation-LICENSE.txt'), 'utf8'), /Carnegie Mellon University/);
});

test('unique dictionary count gates heuristic splits and preserves original case and punctuation', () => {
  const about = pronunciation.suggest('About!', counts);
  assert.equal(about.status, 'suggested');
  assert.equal(about.spokenText, 'About!');
  assert.deepEqual(about.syllableCounts, [2]);
  assert.deepEqual(about.parts, ['A', 'bout!']);
  assert.equal(about.parts.join(''), about.spokenText);

  const baby = pronunciation.suggest('baby', counts);
  assert.deepEqual(baby.parts, ['ba', 'by']);
  assert.equal(baby.parts.join(''), baby.spokenText);
  const heldStone = pronunciation.suggest('stone', counts);
  assert.deepEqual(heldStone.parts, ['stone']);
  assert.equal(heldStone.parts.join(''), heldStone.spokenText);
  assert.equal(heldStone.syllableCounts[0], 1);
});

test('unknown and multiple-count dictionary entries produce no guessed parts', () => {
  const unknown = pronunciation.suggest('madeup', counts);
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknown.parts, []);
  assert.equal(unknown.reason, 'word-not-in-pronunciation-index');

  const ambiguous = pronunciation.suggest('variant', counts);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.syllableCounts, [2, 3]);
  assert.deepEqual(ambiguous.parts, []);
  assert.ok(Array.isArray(ambiguous.alternatives));
  assert.ok(ambiguous.alternatives.every(item => [2, 3].includes(item.count) && item.parts.join('') === ambiguous.spokenText));
  assert.equal(pronunciation.suggest('unknownword', counts).alternatives, undefined);
});

test('numbers zero through ninety-nine use component pronunciations, retain display token, and attach punctuation last', () => {
  const number = pronunciation.suggest('24,', counts);
  assert.equal(number.status, 'suggested');
  assert.equal(number.spokenText, 'twentyfour,');
  assert.deepEqual(number.syllableCounts, [3]);
  assert.deepEqual(number.parts, ['twen', 'ty', 'four,']);
  assert.equal(number.parts.join(''), number.spokenText);
  assert.equal(number.method, 'cmudict-count+number-spelling');
  assert.deepEqual(pronunciation.suggest('100', counts).parts, []);
});

test('explicit spoken override is honored only as a single cleaned word', () => {
  const result = pronunciation.suggest('Xylophone?', counts, 'about');
  assert.equal(result.status, 'suggested');
  assert.equal(result.spokenText, 'about?');
  assert.deepEqual(result.parts, ['a', 'bout?']);
  assert.equal(result.parts.join(''), result.spokenText);
  assert.equal(pronunciation.suggest('word', counts, 'about now').reason,
    'spoken-override-must-be-one-ascii-word');
});

test('a dictionary count does not force a spelling split when the heuristic cannot match it', () => {
  const result = pronunciation.suggest('about', { entries: { about: [3] } });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.parts, []);
  assert.equal(result.reason, 'orthographic-split-unavailable');
});
