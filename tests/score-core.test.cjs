const test = require('node:test');
const assert = require('node:assert/strict');
const score = require('../extension/score-core.js');

const HASH = 'a'.repeat(64);
function makeScore(lrc = '[00:01.00]We rise, again!\n[00:04.00]') {
  return score.createScore(
    { platform: 'youtube', videoId: 'FIXTURE0001', title: 'Song', artist: 'Artist', durationMs: 10000 },
    lrc,
    { provider: 'test', entryId: 'one', contentHash: HASH },
  );
}
function allWords(s) { return s.phrases.flatMap(p => p.words.map(word => ({ phrase: p, word }))); }
function errorCode(fn, code) { assert.throws(fn, error => error.code === code); }

test('exports global and CommonJS APIs and resolves only exact YouTube video identities', () => {
  assert.equal(globalThis.LvScore, score);
  assert.equal(score.mediaKey({ url: 'https://www.youtube.com/watch?v=FIXTURE0001&t=3' }), 'youtube:FIXTURE0001');
  assert.equal(score.mediaKey({ url: 'https://music.youtube.com/watch?v=FIXTURE0003' }), 'youtube:FIXTURE0003');
  assert.equal(score.mediaKey({ url: 'https://youtu.be/FIXTURE0003?si=abc' }), 'youtube:FIXTURE0003');
  assert.equal(score.mediaKey({ source: { videoId: 'FIXTURE0001' }, videoId: 'FIXTURE0003' }), 'youtube:FIXTURE0001');
  for (const url of ['https://youtube.com.evil.test/watch?v=FIXTURE0001', 'javascript://youtube.com/watch?v=FIXTURE0001', 'https://youtube.com/watch?v=too-short']) {
    assert.equal(score.mediaKey({ url }), '');
  }
  assert.equal(score.mediaKey({ title: 'Song', artist: 'Artist' }), '');
});

test('parseLrc retains empty cues and expands multiple timestamps', () => {
  assert.deepEqual(score.parseLrc('[00:01.20][00:02.3]hi\n[00:04.00]'), [
    { timeMs: 1200, text: 'hi' }, { timeMs: 2300, text: 'hi' }, { timeMs: 4000, text: '' },
  ]);
  assert.deepEqual(score.parseLrc('[ar:Artist]\nnot a cue'), []);
});

test('score construction uses blank cues as explicit ends and preserves parenthetical suggestions', () => {
  const s = makeScore('[00:01.00]Hello (echo it)\n[00:03.00]\n[00:05.00]Again');
  const lead = s.phrases.find(p => p.laneId === 'lead');
  const backing = s.phrases.find(p => p.laneId === 'backing');
  assert.equal(lead.endMs, 3000);
  assert.equal(lead.endEstimated, false);
  assert.equal(lead.words.map(w => w.text).join(' '), 'Hello');
  assert.equal(backing.words.map(w => w.text).join(' '), 'echo it');
  assert.match(s.lanes.find(l => l.id === 'backing').label, /inferred/i);
  assert.ok(s.phrases.find(p => p.startMs === 5000).endEstimated);
});

test('punctuation pauses are bounded and word estimates do not accumulate rounding drift', () => {
  const s = makeScore('[00:00.00]a, bb! ccc dddd eeeee ffffff');
  const phrase = s.phrases[0];
  assert.equal(phrase.words[0].startMs, phrase.startMs);
  assert.equal(phrase.words.at(-1).endMs, phrase.endMs);
  for (let i = 0; i < phrase.words.length; i++) {
    const w = phrase.words[i];
    assert.ok(w.startMs >= phrase.startMs && w.endMs <= phrase.endMs && w.endMs >= w.startMs);
    if (i) assert.ok(w.startMs >= phrase.words[i - 1].endMs);
  }
  const short = makeScore('[00:00.00]a, bb! ccc dddd eeeee ffffff');
  assert.deepEqual(phrase.words.map(w => [w.startMs, w.endMs]), short.phrases[0].words.map(w => [w.startMs, w.endMs]));
});

test('lanes overlap independently and activeAt uses a pure media clock plus offset', () => {
  const s = makeScore('[00:01.00]lead (back vocal)\n[00:05.00]');
  const backing = s.phrases.find(p => p.laneId === 'backing');
  const shifted = score.applyOperation(s, { type: 'setOffset', offsetMs: 500 }, 0);
  const state = score.activeAt(shifted, 1700);
  assert.ok(state.phrases.some(p => p.laneId === 'lead'));
  assert.ok(state.phrases.some(p => p.laneId === 'backing' && p.id === backing.id));
  assert.equal(score.activeAt(shifted, 500).phrases.length, 0);
  assert.equal(shifted.revision, 1);
  assert.equal(s.offsetMs, 0);
});

test('validated operations are revisioned, immutable, and manual timing becomes locked', () => {
  const s = makeScore();
  const { word, phrase } = allWords(s)[0];
  const next = score.applyOperation(s, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs + 100, endMs: phrase.startMs + 400 }, 0);
  assert.notEqual(next, s);
  assert.equal(s.revision, 0);
  const edited = allWords(next).find(pair => pair.word.id === word.id).word;
  assert.equal(edited.provenance, 'manual');
  assert.equal(edited.locked, true);
  errorCode(() => score.applyOperation(next, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs, endMs: phrase.startMs + 100 }, 0), 'REVISION_CONFLICT');
  errorCode(() => score.applyOperation(next, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs, endMs: phrase.startMs + 100 }, 1), 'LOCKED');
  errorCode(() => score.applyOperation(s, { type: 'setWordEffect', wordId: word.id, effect: { type: 'pulse', strength: 2 } }, 0), 'INVALID_EFFECT');
  errorCode(() => score.applyOperation(s, { type: 'setWordText', wordId: 'missing', text: 'x' }, 0), 'UNKNOWN_ID');
});

test('phrase timing moves and rescales contained words as one deliberate manual operation', () => {
  let s = makeScore('[00:01.00]one two three\n[00:04.00]');
  const p = s.phrases[0];
  const lockedId = p.words[0].id;
  s = score.applyOperation(s, { type: 'setWordTiming', wordId: lockedId, startMs: 1200, endMs: 1500 }, 0);
  const moved = score.applyOperation(s, { type: 'setPhraseTiming', phraseId: p.id, startMs: 2000, endMs: 5000 }, 1);
  const movedPhrase = moved.phrases[0];
  assert.deepEqual([movedPhrase.words[0].startMs, movedPhrase.words[0].endMs], [2200, 2500]);
  assert.equal(movedPhrase.words[0].locked, true);
  assert.ok(movedPhrase.words.slice(1).every(w => w.startMs >= 2000 && w.endMs <= 5000));
});

test('alignment proposals validate identity and timing, honor locks, and do not add duplicate evidence', () => {
  let s = makeScore('[00:01.00]one two\n[00:04.00]');
  const p = s.phrases[0], first = p.words[0], second = p.words[1];
  s = score.applyOperation(s, { type: 'setWordLock', wordId: first.id, locked: true }, 0);
  const result = score.applyAlignment(s, [
    { wordId: first.id, startMs: 1100, endMs: 1400, accepted: true, evidenceId: 'audio-a' },
    { wordId: second.id, startMs: 2500, endMs: 2900, accepted: true, evidenceId: 'audio-a', confidence: 0.8 },
    { wordId: second.id, startMs: 2600, endMs: 3000, accepted: true, evidenceId: 'audio-a', confidence: 0.95 },
    { wordId: second.id, startMs: 3000, endMs: 3100, accepted: false, evidenceId: 'audio-b' },
  ], 1);
  assert.deepEqual([result.phrases[0].words[0].startMs, result.phrases[0].words[0].endMs], [first.startMs, first.endMs]);
  assert.deepEqual([result.phrases[0].words[1].startMs, result.phrases[0].words[1].endMs], [2500, 2900]);
  assert.equal(result.phrases[0].words[1].provenance, 'aligned');
  errorCode(() => score.applyAlignment(s, [{ wordId: 'missing', startMs: 1, endMs: 2, accepted: true, evidenceId: 'e' }], 1), 'UNKNOWN_ID');
});

test('import validation rejects malformed IDs, times, lanes, effects, and hashes', () => {
  const s = makeScore();
  for (const alter of [
    x => { x.source.videoId = 'wrong'; },
    x => { x.phrases[0].words[0].startMs = -1; },
    x => { x.phrases[0].words[0].endMs = x.phrases[0].words[0].startMs - 1; },
    x => { x.phrases[0].laneId = 'unknown'; },
    x => { x.phrases[0].words[0].effects = [{ type: 'glow', strength: 0.5 }]; },
    x => { x.lyrics.contentHash = 'weak'; },
    x => { x.phrases[0].words.push({ ...x.phrases[0].words[0] }); },
  ]) {
    const bad = structuredClone(s); alter(bad);
    errorCode(() => score.validateScore(bad), 'INVALID_SCORE');
  }
  errorCode(() => score.createScore({ videoId: 'FIXTURE0001', durationMs: 1 }, '', {}), 'INVALID_LYRICS');
});
