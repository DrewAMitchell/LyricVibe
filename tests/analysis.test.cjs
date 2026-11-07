const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnchors, phraseProgress, MediaClock } = require('../extension/analysis/anchors.js');

function score(lines) {
  let ordinal = 0;
  return { revision: 2, offsetMs: 0, lanes: [{ id: 'lead' }], phrases: lines.map((line, i) => ({ id: `p${i}`, laneId: 'lead', startMs: i * 20000, words: line.split(' ').map(text => ({ id: `w${ordinal++}`, text, startMs: 0, endMs: 1, locked: false })) })) };
}
const chunks = words => words.map((text, i) => ({ text, timestamp: [i * 0.3, i * 0.3 + 0.25] }));
const window = { mediaStartMs: 10000, playbackRate: 1, durationSec: 12, evidenceId: 'synthetic-window' };

test('synthetic exact neighboring acoustic tokens map source milliseconds with offset once', () => {
  const s = score(['wake me up tonight']); s.offsetMs = 500;
  const output = matchAnchors(s, chunks(['wake', 'me', 'up', 'tonight']), window);
  assert.equal(output.proposals.length, 4);
  assert.equal(output.proposals[0].startMs, 9500);
  assert.ok(output.proposals.every(p => p.accepted === false));
  assert.equal(output.diagnostics.confidenceValidated, false);
});

test('sequence alignment skips unheard expected words and unmatched ASR words', () => {
  const output = matchAnchors(score(['wake me right up tonight']), chunks(['wake', 'me', 'up', 'tonight', 'hallucination']), window);
  assert.deepEqual(output.proposals.map(p => p.wordId), ['w0', 'w1', 'w3', 'w4']);
  assert.equal(output.diagnostics.unmatchedWords, 1);
});

test('unique neighboring phrase disambiguates a repeated chorus', () => {
  const s = score(['red sky wake me up', 'blue sky wake me up']);
  const output = matchAnchors(s, chunks(['blue', 'sky', 'wake', 'me', 'up']), window);
  assert.deepEqual(output.proposals.map(p => p.wordId), ['w5', 'w6', 'w7', 'w8', 'w9']);
  assert.equal(output.diagnostics.repeatedSequenceAmbiguous, false);
});

test('identical repetitions stay ambiguous despite timing prior', () => {
  const output = matchAnchors(score(['wake me up', 'wake me up']), chunks(['wake', 'me', 'up']), window);
  assert.equal(output.diagnostics.repeatedSequenceAmbiguous, true);
  assert.ok(output.proposals.every(p => p.reviewReason === 'REPEATED_SEQUENCE_AMBIGUOUS' && !p.accepted));
});

test('phrase-only output, missing ends, and unsupported words never acquire invented timings', () => {
  const output = matchAnchors(score(['wake me up']), [{ text: 'wake me', timestamp: [0, 1] }, { text: 'up', timestamp: [1, null] }], window);
  assert.equal(output.proposals.length, 0);
});

test('isolated lexical coincidence is insufficient evidence', () => {
  assert.equal(matchAnchors(score(['wake me up']), chunks(['wake', 'a', 'foreign', 'song']), window).proposals.length, 0);
});

test('phrase progress follows neighboring recognized words without changing score', () => {
  const s = score(['wake me up tonight']), before = JSON.stringify(s);
  assert.deepEqual(phraseProgress(s, chunks(['wake', 'me', 'up']), window), { phraseId: 'p0', wordId: 'w2', heardThroughMs: 10850 });
  assert.equal(JSON.stringify(s), before);
});

test('phrase progress remains unknown for repetitions or isolated matches', () => {
  assert.equal(phraseProgress(score(['wake me up', 'wake me up']), chunks(['wake', 'me', 'up']), window), null);
  assert.equal(phraseProgress(score(['wake me up']), chunks(['wake', 'other', 'things']), window), null);
  assert.equal(phraseProgress(score(['wake', 'me']), chunks(['wake', 'me']), window), null);
});

test('phrase progress can distinguish repeated lyrics at different song positions', () => {
  const s=score(['wake me up','wake me up']);s.phrases[0].startMs=0;s.phrases[0].endMs=3000;s.phrases[1].startMs=20000;s.phrases[1].endMs=23000;
  const hint=phraseProgress(s,chunks(['wake','me','up']),{...window,mediaStartMs:20000,durationSec:2});assert.equal(hint.phraseId,'p1');assert.equal(hint.wordId,'w5');
});

test('media clock uses sample/context position and invalidates pause, seek, rate and identity changes', () => {
  const clock = new MediaClock();
  const snapshot = { currentTimeMs: 1000, playbackRate: 1, paused: false, seeking: false, mediaKey: 'youtube:a' };
  clock.update(snapshot, 4);
  const initialEpoch = clock.epoch;
  assert.equal(clock.mediaAt(4.5), 1500);
  assert.equal(clock.update({ ...snapshot, currentTimeMs: 1500 }, 4.5).discontinuity, false);
  clock.update({ ...snapshot, currentTimeMs: 20000 }, 5);
  assert.ok(clock.epoch > initialEpoch);
  const seekEpoch = clock.epoch;
  clock.update({ ...snapshot, paused: true }, 5.1);
  assert.equal(clock.anchor, null);
  assert.ok(clock.epoch > seekEpoch);
  clock.update({ ...snapshot, playbackRate: 2 }, 6);
  assert.equal(clock.mediaAt(6.5), 2000);
  const rateEpoch = clock.epoch;
  clock.update({ ...snapshot, mediaKey: 'youtube:b' }, 6.5);
  assert.ok(clock.epoch > rateEpoch);
});
