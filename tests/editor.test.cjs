const test = require('node:test');
test('source playback uses Chrome sender tab identity and rejects unrelated or malformed clocks', () => {
  const editor = require('../extension/editor.js');
  const message = { type: 'LV_SCORE_PLAYBACK', mediaKey: 'youtube:source', mediaMs: 12345, paused: false };
  const sender = { id: 'extension', tab: { id: 7 } };
  const accepts = (m, s) => editor.sourcePlayback(m, s, 'extension', 7, 'youtube:source');
  assert.equal(accepts(message, sender), true);
  assert.equal(accepts({ ...message, tabId: 7 }, { ...sender, tab: { id: 8 } }), false);
  assert.equal(accepts(message, { id: 'extension' }), false);
  assert.equal(accepts(message, { ...sender, id: 'other' }), false);
  assert.equal(accepts({ ...message, mediaKey: 'youtube:other' }, sender), false);
  assert.equal(accepts({ ...message, mediaMs: NaN }, sender), false);
});
const assert = require('node:assert/strict');
const core = require('../extension/score-core.js');
const { sourceTab, boundary, assertImport, seekTarget, syllablesForSplit, reviewProtection } = require('../extension/editor.js');
const { revealProgress } = core;
function fixture() {
  return core.createScore({ platform: 'youtube', videoId: 'FIXTURE0001', title: 'Test', artist: '', durationMs: 20000 }, '[00:03.00]first second\n[00:08.00]', { provider: 'test', entryId: null, contentHash: 'a'.repeat(64) });
}
test('source tab parsing binds an explicit integral target and rejects malformed values', () => {
  assert.equal(sourceTab('?sourceTab=42'), 42);
  assert.equal(sourceTab('?tabId=18'), 18);
  assert.equal(sourceTab('?sourceTab=-1'), null);
  assert.equal(sourceTab('?sourceTab=1.5'), null);
  assert.equal(sourceTab(''), null);
});
test('seeking uses known duration bounds while unknown duration never clamps to zero', () => {
  assert.equal(seekTarget(8500, 0), 8500);
  assert.equal(seekTarget(8500, 8000), 8000);
  assert.equal(seekTarget(-100, 0), 0);
});
test('sweep exposure follows bounded source time, one offset, and explicit easing', () => {
  const token = { startMs: 1000, endMs: 2000, reveal: { type: 'sweep', easing: 'linear' } };
  assert.equal(revealProgress(token, 900), 0);
  assert.equal(revealProgress(token, 1500), 0.5);
  assert.equal(revealProgress(token, 2500), 1);
  assert.equal(revealProgress(token, 1750, 250), 0.5);
  token.reveal.easing = 'ease-out';
  assert.equal(revealProgress(token, 1500), 0.875);
  token.reveal.easing = 'ease-in-out';
  assert.equal(revealProgress(token, 1250), 0.15625);
  assert.equal(revealProgress(token, 1750), 0.84375);
  assert.equal(revealProgress({ ...token, endMs: 1000 }, 1000), 1);
  assert.equal(revealProgress({ startMs: 1000, endMs: 2000 }, 0), 0);
  assert.equal(revealProgress({ startMs: 1000, endMs: 2000 }, 1000), 1);
});
test('review rejects acceptance for locked syllables even when the parent word is unlocked', () => {
  assert.equal(reviewProtection(undefined), 'Unavailable word');
  assert.equal(reviewProtection({ locked: true }), 'Locked');
  assert.equal(reviewProtection({ locked: false, syllables: [{ locked: true }] }), 'Protected syllable');
  assert.equal(reviewProtection({ locked: false, syllables: [{ locked: false }] }), '');
});
test('syllable split preserves exact word text with bounded estimated intervals and distinct ids', () => {
  const word = { id: 'word', text: 'together!', startMs: 1000, endMs: 2001 };
  const syllables = syllablesForSplit(word, 'to|ge|ther!', index => `s-${index}`);
  assert.equal(syllables.map(s => s.text).join(''), word.text);
  assert.equal(syllables[0].startMs, word.startMs);
  assert.equal(syllables.at(-1).endMs, word.endMs);
  assert.equal(new Set(syllables.map(s => s.id)).size, 3);
  assert.ok(syllables.every(s => s.provenance === 'estimated' && !s.locked && s.startMs <= s.endMs));
  assert.deepEqual(syllablesForSplit(word, ''), []);
  assert.throws(() => syllablesForSplit(word, 'to|ge|ther'), { code: 'INVALID_SYLLABLE_SPLIT' });
  assert.throws(() => syllablesForSplit(word, 'to||gether!'), { code: 'INVALID_SYLLABLE_SPLIT' });
});
test('drag operations remain within their phrase and use the validated revisioned edit path', () => {
  const score = fixture(); const phrase = score.phrases[0]; const word = phrase.words[0];
  const op = boundary(word, 'start', -100000, score.source.durationMs, phrase.startMs, phrase.endMs);
  const next = core.applyOperation(score, op, score.revision);
  assert.equal(next.phrases[0].words[0].startMs, phrase.startMs);
  assert.equal(next.phrases[0].words[0].locked, true);
  assert.equal(next.phrases[0].words[0].provenance, 'manual');
  assert.equal(next.revision, 1);
  assert.equal(score.phrases[0].words[0].locked, false);
  const endOp = boundary(word, 'end', 100000, score.source.durationMs, phrase.startMs, phrase.endMs);
  assert.equal(endOp.endMs, phrase.endMs);
});
test('dragging cannot invert word boundaries, including a zero-length phrase', () => {
  assert.deepEqual(boundary({ id: 'w', startMs: 100, endMs: 200 }, 'start', 1000, 1000), { type: 'setWordTiming', wordId: 'w', startMs: 200, endMs: 200 });
  assert.deepEqual(boundary({ id: 'w', startMs: 100, endMs: 100 }, 'end', 1000, 1000, 100, 100), { type: 'setWordTiming', wordId: 'w', startMs: 100, endMs: 100 });
});
test('import enforces exact media identity, lyric hash, and score validation', () => {
  const score = fixture(); const incoming = structuredClone(score);
  assert.equal(assertImport(score, incoming, core), incoming);
  incoming.source.videoId = 'FIXTURE0003';
  assert.throws(() => assertImport(score, incoming, core), { code: 'SOURCE_MISMATCH' });
  incoming.source.videoId = score.source.videoId; incoming.lyrics.contentHash = 'b'.repeat(64);
  assert.throws(() => assertImport(score, incoming, core), { code: 'LYRICS_MISMATCH' });
  incoming.lyrics.contentHash = score.lyrics.contentHash; incoming.offsetMs = NaN;
  assert.throws(() => assertImport(score, incoming, core), { code: 'INVALID_SCORE' });
});
