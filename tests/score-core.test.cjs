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
test('manual word illustrations and rocking persist without changing timing and reject unknown art',()=>{
  const base=makeScore(),word=base.phrases[0].words[0],before=[word.startMs,word.endMs];
  const next=score.applyOperation(base,{type:'setWordAppearance',wordId:word.id,appearance:{art:'bills',motion:'rock'}},base.revision);
  assert.deepEqual(next.phrases[0].words[0].appearance,{art:'bills',motion:'rock'});assert.deepEqual([next.phrases[0].words[0].startMs,next.phrases[0].words[0].endMs],before);assert.equal(word.appearance,undefined);
  score.validateScore(JSON.parse(JSON.stringify(next)));
  assert.throws(()=>score.applyOperation(base,{type:'setWordAppearance',wordId:word.id,appearance:{art:'unknown'}},base.revision),/appearance/);
});

test('per-occurrence Unicode spoken syllables roundtrip independently of the display script', () => {
  const base=makeScore('[00:01.00]今夜\n[00:04.00]'),word=base.phrases[0].words[0];
  const next=score.applyOperation(base,{type:'setWordSyllables',wordId:word.id,spokenText:'こんや',syllables:[{id:'unicode-1',text:'こん',startMs:word.startMs,endMs:2000},{id:'unicode-2',text:'や',startMs:2000,endMs:word.endMs}]},base.revision);
  const roundtrip=score.validateScore(JSON.parse(JSON.stringify(next))).phrases[0].words[0];
  assert.equal(roundtrip.text,'今夜');assert.equal(roundtrip.spokenText,'こんや');
  assert.deepEqual(roundtrip.syllables.map(s=>s.text),['こん','や']);
  assert.deepEqual([roundtrip.id,roundtrip.startMs,roundtrip.endMs],[word.id,word.startMs,word.endMs]);
  assert.equal(base.phrases[0].words[0].syllables,undefined);
});

test('word exclusion toggles presentation without changing source text, identity, timing, or the input score', () => {
  const original = makeScore('[00:01.00]See that light\n[00:04.00]');
  const [see, that, light] = original.phrases[0].words;
  const excluded = score.applyOperation(original, { type: 'setWordExcluded', wordId: that.id, excluded: true }, original.revision);
  assert.equal(original.revision, 0);
  assert.equal(that.excluded, undefined);
  const retained = excluded.phrases[0].words[1];
  assert.deepEqual([retained.id, retained.text, retained.startMs, retained.endMs], [that.id, that.text, that.startMs, that.endMs]);
  assert.equal(retained.excluded, true);
  const restored = score.applyOperation(excluded, { type: 'setWordExcluded', wordId: that.id, excluded: false }, excluded.revision);
  assert.equal(restored.phrases[0].words[1].excluded, false);
  assert.deepEqual([restored.phrases[0].words[1].id, restored.phrases[0].words[1].text, restored.phrases[0].words[1].startMs, restored.phrases[0].words[1].endMs], [that.id, that.text, that.startMs, that.endMs]);
});

test('activeAt omits excluded words from returned phrase presentation and fully excluded phrases', () => {
  const original = makeScore('[00:01.00]See that light\n[00:04.00]');
  const [see, that, light] = original.phrases[0].words;
  let edited = score.applyOperation(original, { type: 'setWordExcluded', wordId: that.id, excluded: true }, 0);
  let at = score.activeAt(edited, see.startMs);
  assert.deepEqual(at.phrases[0].words.map(w => w.id), [see.id, light.id]);
  assert.ok(!at.phrases[0].activeWords.includes(that.id));
  edited = score.applyOperation(edited, { type: 'setWordExcluded', wordId: see.id, excluded: true }, edited.revision);
  edited = score.applyOperation(edited, { type: 'setWordExcluded', wordId: light.id, excluded: true }, edited.revision);
  assert.deepEqual(score.activeAt(edited, see.startMs).phrases, []);
});

test('score validation permits legacy omission and rejects nonboolean exclusion', () => {
  const original = makeScore();
  assert.equal(score.validateScore(original), original);
  const malformed = structuredClone(original);
  malformed.phrases[0].words[0].excluded = 'yes';
  errorCode(() => score.validateScore(malformed), 'INVALID_SCORE');
});

test('replaceWords replaces a contiguous interval with estimated evenly divided words and preserves outside identities', () => {
  const original = makeScore('[00:01.00]before See that light after\n[00:06.00]');
  const phrase = original.phrases[0], [before, see, that, light, after] = phrase.words;
  const start = Math.min(see.startMs, that.startMs, light.startMs), end = Math.max(see.endMs, that.endMs, light.endMs);
  const changed = score.applyOperation(original, { type: 'replaceWords', phraseId: phrase.id, wordIds: [see.id, that.id, light.id], text: 'get down' }, original.revision);
  const words = changed.phrases[0].words;
  assert.deepEqual(words.map(w => w.text), ['before', 'get', 'down', 'after']);
  assert.deepEqual([words[0].id, words.at(-1).id], [before.id, after.id]);
  assert.notEqual(words[1].id, see.id);
  assert.deepEqual([words[1].startMs, words[1].endMs, words[2].startMs, words[2].endMs], [start, start + Math.round((end - start) / 2), start + Math.round((end - start) / 2), end]);
  assert.ok(words.slice(1, 3).every(w => w.provenance === 'estimated' && !w.locked));
  assert.equal(changed.lyrics.contentHash, original.lyrics.contentHash);
  assert.equal(original.phrases[0].words.length, 5);
});

test('replaceWords creates visible text when replacing excluded or mixed selections', () => {
  const original = makeScore('[00:01.00]See that light');
  const phrase = original.phrases[0];
  const excluded = score.applyOperation(original, { type: 'setWordExcluded', wordId: phrase.words[1].id, excluded: true }, original.revision);
  const replaced = score.applyOperation(excluded, { type: 'replaceWords', phraseId: phrase.id, wordIds: phrase.words.map(w => w.id), text: 'get down' }, excluded.revision);
  assert.deepEqual(replaced.phrases[0].words.map(w => w.text), ['get', 'down']);
  assert.ok(replaced.phrases[0].words.every(w => w.excluded !== true));
});

test('replaceWords rejects missing, duplicate, noncontiguous, cross-phrase and invalid text selections', () => {
  const base = makeScore('[00:01.00]one two three\n[00:04.00]four five');
  const [first, second, third] = base.phrases[0].words;
  const phraseId = base.phrases[0].id;
  for (const wordIds of [[first.id, third.id], [first.id, first.id], ['missing'], [first.id, base.phrases[1].words[0].id]]) {
    errorCode(() => score.applyOperation(base, { type: 'replaceWords', phraseId, wordIds, text: 'new words' }, 0), wordIds[0] === 'missing' ? 'UNKNOWN_ID' : 'INVALID_OPERATION');
  }
  for (const text of ['', '  ', 42]) errorCode(() => score.applyOperation(base, { type: 'replaceWords', phraseId, wordIds: [first.id, second.id], text }, 0), 'INVALID_OPERATION');
});

test('phrase syllable capture spans visible words across former word bounds and leaves excluded words intact', () => {
  let base = makeScore('[00:01.00]one skip two\n[00:04.00]');
  const phrase = base.phrases[0];
  for (const word of phrase.words) base = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [{ id: `sy-${word.id}`, text: word.text, startMs: word.startMs, endMs: word.endMs }] }, base.revision);
  const skip = base.phrases[0].words[1];
  base = score.applyOperation(base, { type: 'setWordExcluded', wordId: skip.id, excluded: true }, base.revision);
  base.phrases[0].words[0].effects = [{ type: 'pulse', strength: 0.4 }];
  base.phrases[0].words[0].syllables[0].effects = [{ type: 'tilt', strength: 0.2 }];
  const beforeSkip = structuredClone(base.phrases[0].words[1]);
  const p = base.phrases[0], midpoint = p.startMs + Math.floor((p.endMs - p.startMs) / 2);
  const marks = [
    { syllableId: `sy-${p.words[0].id}`, startMs: p.startMs, endMs: midpoint },
    { syllableId: `sy-${p.words[2].id}`, startMs: midpoint, endMs: p.endMs },
  ];
  const next = score.applyOperation(base, { type: 'setPhraseSyllableTimings', phraseId: p.id, marks }, base.revision);
  assert.deepEqual([next.phrases[0].words[0].startMs, next.phrases[0].words[0].endMs], [p.startMs, midpoint]);
  assert.deepEqual([next.phrases[0].words[2].startMs, next.phrases[0].words[2].endMs], [midpoint, p.endMs]);
  assert.deepEqual(next.phrases[0].words[1], beforeSkip);
  for (const word of [next.phrases[0].words[0], next.phrases[0].words[2]]) {
    assert.equal(word.provenance, 'manual'); assert.equal(word.locked, true);
    assert.equal(word.syllables[0].provenance, 'manual'); assert.equal(word.syllables[0].locked, true);
  }
  assert.deepEqual(next.phrases[0].words[0].effects, [{ type: 'pulse', strength: 0.4 }]);
  assert.deepEqual(next.phrases[0].words[0].syllables[0].effects, [{ type: 'tilt', strength: 0.2 }]);
});

test('phrase syllable capture rejects incomplete, extra, reordered, zero-length, gapped and out-of-parent marks atomically', () => {
  let base = makeScore('[00:01.00]one two\n[00:04.00]');
  const phrase = base.phrases[0];
  for (const word of phrase.words) base = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [{ id: `sy-${word.id}`, text: word.text, startMs: word.startMs, endMs: word.endMs }] }, base.revision);
  const p = base.phrases[0], midpoint = p.startMs + Math.floor((p.endMs - p.startMs) / 2);
  const marks = [
    { syllableId: `sy-${p.words[0].id}`, startMs: p.startMs, endMs: midpoint },
    { syllableId: `sy-${p.words[1].id}`, startMs: midpoint, endMs: p.endMs },
  ];
  const invalid = [
    marks.slice(0, 1), [...marks, { syllableId: 'extra', startMs: p.endMs, endMs: p.endMs + 1 }],
    [...marks].reverse(), [{ ...marks[0], endMs: marks[0].startMs }, marks[1]],
    [marks[0], { ...marks[1], startMs: midpoint + 1 }],
    [{ ...marks[0], startMs: p.startMs - 1 }, marks[1]],
  ];
  for (const [i, badMarks] of invalid.entries()) {
    const snapshot = structuredClone(base);
    errorCode(() => score.applyOperation(base, { type: 'setPhraseSyllableTimings', phraseId: p.id, marks: badMarks }, base.revision), i < 3 ? 'INVALID_OPERATION' : 'INVALID_TIME');
    assert.deepEqual(base, snapshot);
  }
});

test('phrase syllable performance updates only observed words, keeps phrase bounds and derives word timing from taps', () => {
  const base = makeScore('[00:01.00]one two skip tail\n[00:05.00]');
  const phrase = base.phrases[0], [one, two, skip, tail] = phrase.words;
  one.effects = [{ type: 'pulse', strength: 0.4 }];
  one.syllables = [{ id: 'old-one', text: 'one', startMs: one.startMs, endMs: one.endMs, provenance: 'manual', locked: true, effects: [{ type: 'tilt', strength: 0.2 }] }];
  two.syllables = [{ id: 'old-two', text: 'two', startMs: two.startMs, endMs: two.endMs, provenance: 'manual', locked: true, effects: [] }];
  score.validateScore(base);
  const untouched = structuredClone(skip), oldBounds = [phrase.startMs, phrase.endMs];
  errorCode(() => score.applyOperation(base, { type: 'setPhraseSyllablePerformance', phraseId: phrase.id, words: [{ wordId: one.id, syllables: [{ id: 'old-one', text: 'one', startMs: phrase.startMs, endMs: phrase.startMs + 100 }] }] }, base.revision), 'LOCKED');
  const unlockedOne = score.applyOperation(base, { type: 'setSyllableLock', syllableId: 'old-one', locked: false }, base.revision);
  const unlocked = score.applyOperation(unlockedOne, { type: 'setSyllableLock', syllableId: 'old-two', locked: false }, unlockedOne.revision);
  const next = score.applyOperation(unlocked, { type: 'setPhraseSyllablePerformance', phraseId: phrase.id, words: [
    { wordId: one.id, syllables: [{ id: 'old-one', text: 'one', startMs: phrase.startMs, endMs: phrase.startMs + 400 }] },
    { wordId: two.id, spokenText: 'tu', syllables: [{ id: 'two-t', text: 't', startMs: phrase.startMs + 400, endMs: phrase.startMs + 650 }, { id: 'two-u', text: 'u', startMs: phrase.startMs + 650, endMs: phrase.startMs + 900 }] },
    { wordId: tail.id, syllables: [{ id: 'tail-all', text: 'tail', startMs: phrase.endMs - 700, endMs: phrase.endMs }] },
  ] }, unlocked.revision);
  const result = next.phrases[0];
  assert.deepEqual([result.startMs, result.endMs], oldBounds);
  assert.deepEqual(result.words[2], untouched);
  assert.deepEqual([result.words[0].id, result.words[0].text, result.words[0].startMs, result.words[0].endMs, result.words[0].locked], [one.id, 'one', phrase.startMs, phrase.startMs + 400, true]);
  assert.deepEqual(result.words[0].effects, one.effects);
  assert.deepEqual(result.words[0].syllables[0].effects, [{ type: 'tilt', strength: 0.2 }]);
  assert.deepEqual([result.words[1].text, result.words[1].spokenText, result.words[1].startMs, result.words[1].endMs], ['two', 'tu', phrase.startMs + 400, phrase.startMs + 900]);
  assert.ok(result.words[0].syllables.concat(result.words[1].syllables, result.words[3].syllables).every(item => item.provenance === 'manual' && item.locked));
  assert.equal(result.words[3].syllables.at(-1).endMs, phrase.endMs);
});

test('phrase syllable performance rejects invalid ownership and syllables atomically', () => {
  const base = makeScore('[00:01.00]one two three\n[00:04.00]'), phrase = base.phrases[0], [one, two, three] = phrase.words;
  const op = words => ({ type: 'setPhraseSyllablePerformance', phraseId: phrase.id, words });
  const validOne = { wordId: one.id, syllables: [{ id: 'x', text: 'one', startMs: phrase.startMs, endMs: phrase.startMs + 100 }] };
  const validTwo = { wordId: two.id, syllables: [{ id: 'y', text: 'two', startMs: phrase.startMs + 100, endMs: phrase.startMs + 200 }] };
  const invalidBatches = [
    [validTwo, validOne],
    [validOne, { ...validTwo, wordId: one.id }],
    [validOne, { ...validTwo, syllables: [{ id: 'x', text: 'two', startMs: phrase.startMs + 100, endMs: phrase.startMs + 200 }] }],
    [validOne, { ...validTwo, syllables: [{ id: 'z', text: 'bad', startMs: phrase.startMs + 100, endMs: phrase.startMs + 200 }] }],
    [validOne, { wordId: three.id, syllables: [{ id: 'z', text: 'three', startMs: phrase.endMs, endMs: phrase.endMs }] }],
    [validOne, { wordId: three.id, syllables: [{ id: 'z', text: 'three', startMs: phrase.endMs, endMs: phrase.endMs + 1 }] }],
  ];
  for (const words of invalidBatches) {
    const snapshot = structuredClone(base);
    assert.throws(() => score.applyOperation(base, op(words), base.revision));
    assert.deepEqual(base, snapshot);
  }
});

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

test('hyphenWordParts splits only internal letter or digit joins and preserves source spelling', () => {
  for (const [text, expected] of [
    ['ice-breaker', ['ice-', 'breaker']],
    ['co‐operate', ['co‐', 'operate']],
    ['re‑enter', ['re‑', 'enter']],
    ['A1-B2', ['A1-', 'B2']],
    ['-leading', ['-leading']], ['trailing-', ['trailing-']], ['rock\'n\'roll', ["rock'n'roll"]],
    ['single', ['single']],
  ]) {
    assert.deepEqual(score.hyphenWordParts(text), expected);
    assert.equal(score.hyphenWordParts(text).join(''), text);
  }
});

test('score construction uses nearby blank cues as exact ends and preserves parenthetical suggestions', () => {
  const s = makeScore('[00:01.00]Hello (echo it)\n[00:02.80]\n[00:05.00]Again');
  const lead = s.phrases.find(p => p.laneId === 'lead');
  const backing = s.phrases.find(p => p.laneId === 'backing');
  assert.equal(lead.endMs, 2800);
  assert.equal(lead.endEstimated, false);
  assert.equal(lead.words.map(w => w.text).join(' '), 'Hello');
  assert.equal(backing.words.map(w => w.text).join(' '), 'echo it');
  assert.match(s.lanes.find(l => l.id === 'backing').label, /inferred/i);
  assert.ok(s.phrases.find(p => p.startMs === 5000).endEstimated);
});

test('estimated phrases end conservatively across long instrumental gaps', () => {
  const s = makeScore('[00:00.00]one two three\n[00:30.00]');
  const phrase = s.phrases[0];
  assert.equal(phrase.endMs, 1950);
  assert.equal(phrase.endEstimated, true);
  assert.equal(score.activeAt(s, 10000).phrases.length, 0);
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

test('comma and terminal punctuation create explicit gaps only between words', () => {
  const comma = makeScore('[00:00.00]hello, world\n[00:02.00]').phrases[0];
  assert.equal(comma.words[1].startMs - comma.words[0].endMs, 120);
  const terminal = makeScore('[00:00.00]hello! world\n[00:02.00]').phrases[0];
  assert.equal(terminal.words[1].startMs - terminal.words[0].endMs, 180);
  const trailing = makeScore('[00:00.00]hello!\n[00:02.00]').phrases[0];
  assert.deepEqual([trailing.words[0].startMs, trailing.words[0].endMs], [trailing.startMs, trailing.endMs]);
});

test('short phrases proportionally cap punctuation gaps at 35 percent and preserve monotonic timings', () => {
  const phrase = makeScore('[00:00.00]a, b, c, d, e, f, g, h, i, j\n[00:00.20]').phrases[0];
  const pauseTotal = phrase.words.slice(0, -1).reduce((sum, word, i) => sum + phrase.words[i + 1].startMs - word.endMs, 0);
  assert.ok(pauseTotal <= (phrase.endMs - phrase.startMs) * 0.35);
  assert.ok(pauseTotal > 0);
  for (let i = 0; i < phrase.words.length; i++) {
    assert.ok(phrase.words[i].startMs <= phrase.words[i].endMs);
    if (i) assert.ok(phrase.words[i].startMs >= phrase.words[i - 1].endMs);
  }
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

test('validated operations are revisioned, immutable, and locked manual timing remains manually editable', () => {
  const s = makeScore();
  const { word, phrase } = allWords(s)[0];
  const next = score.applyOperation(s, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs + 100, endMs: phrase.startMs + 400 }, 0);
  assert.notEqual(next, s);
  assert.equal(s.revision, 0);
  const edited = allWords(next).find(pair => pair.word.id === word.id).word;
  assert.equal(edited.provenance, 'manual');
  assert.equal(edited.locked, true);
  errorCode(() => score.applyOperation(next, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs, endMs: phrase.startMs + 100 }, 0), 'REVISION_CONFLICT');
  const adjusted = score.applyOperation(next, { type: 'setWordTiming', wordId: word.id, startMs: phrase.startMs + 50, endMs: phrase.startMs + 350 }, 1);
  const adjustedWord = allWords(adjusted).find(pair => pair.word.id === word.id).word;
  assert.deepEqual([adjustedWord.startMs, adjustedWord.endMs], [phrase.startMs + 50, phrase.startMs + 350]);
  assert.equal(adjustedWord.provenance, 'manual');
  assert.equal(adjustedWord.locked, true);
  const aligned = score.applyAlignment(adjusted, [
    { wordId: word.id, startMs: phrase.startMs + 800, endMs: phrase.startMs + 1100, accepted: true, evidenceId: 'manual-word-protected' },
  ], 2);
  const alignedWord = allWords(aligned).find(pair => pair.word.id === word.id).word;
  assert.deepEqual([alignedWord.startMs, alignedWord.endMs], [adjustedWord.startMs, adjustedWord.endMs]);
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
  assert.deepEqual([movedPhrase.words[0].startMs, movedPhrase.words[0].endMs], [2308, 2769]);
  assert.equal(movedPhrase.words[0].locked, true);
  assert.ok(movedPhrase.words.slice(1).every(w => w.startMs >= 2000 && w.endMs <= 5000));
});

test('alignment proposals validate identity and timing, honor locks, and do not add duplicate evidence', () => {
  let s = makeScore('[00:01.00]one two\n[00:04.00]');
  const p = s.phrases[0], first = p.words[0], second = p.words[1];
  s = score.applyOperation(s, { type: 'setWordLock', wordId: first.id, locked: true }, 0);
  const result = score.applyAlignment(s, [
    { wordId: first.id, startMs: 1100, endMs: 1400, accepted: true, evidenceId: 'audio-a' },
    { wordId: second.id, startMs: 4000, endMs: 4300, accepted: true, evidenceId: 'audio-a', confidence: 0.8 },
    { wordId: second.id, startMs: 4100, endMs: 4400, accepted: true, evidenceId: 'audio-a', confidence: 0.95 },
    { wordId: second.id, startMs: 4400, endMs: 4500, accepted: false, evidenceId: 'audio-b' },
  ], 1);
  assert.deepEqual([result.phrases[0].words[0].startMs, result.phrases[0].words[0].endMs], [first.startMs, first.endMs]);
  assert.deepEqual([result.phrases[0].words[1].startMs, result.phrases[0].words[1].endMs], [4000, 4300]);
  assert.equal(result.phrases[0].endMs, 4300);
  assert.equal(result.phrases[0].words[1].provenance, 'aligned');
  errorCode(() => score.applyAlignment(s, [{ wordId: 'missing', startMs: 1, endMs: 2, accepted: true, evidenceId: 'e' }], 1), 'UNKNOWN_ID');
});

test('complete alignment replaces estimated phrase bounds so old captions do not linger into rests', () => {
  const source = makeScore('[00:01.00]one two');
  const phrase = source.phrases[0];
  assert.equal(phrase.endEstimated, true);
  const proposals = phrase.words.map((word, index) => ({ wordId: word.id, startMs: 3000 + index * 400, endMs: 3300 + index * 400, accepted: true, evidenceId: `whole-path-${index}` }));
  const next = score.applyAlignment(source, proposals, source.revision);
  assert.deepEqual([next.phrases[0].startMs, next.phrases[0].endMs], [3000, 3700]);
  assert.equal(score.activeAt(next, 1500).phrases.length, 0);
  assert.equal(score.activeAt(next, 3750).phrases.length, 0);
  assert.ok(score.activeAt(next, 3650).phrases[0].opacity < 1);
  assert.equal(source.phrases[0].startMs, 1000);
});

test('alignment may expand an estimated phrase, while explicit ends stay hard and locked timings stay put', () => {
  let estimated = makeScore('[00:01.00]one two\n[00:04.00]');
  const estimatedPhrase = estimated.phrases[0];
  const lockedId = estimatedPhrase.words[0].id;
  estimated = score.applyOperation(estimated, { type: 'setWordTiming', wordId: lockedId, startMs: 1100, endMs: 1300 }, 0);
  const aligned = score.applyAlignment(estimated, [
    { wordId: lockedId, startMs: 5000, endMs: 5300, accepted: true, evidenceId: 'locked' },
    { wordId: estimatedPhrase.words[1].id, startMs: 6000, endMs: 6300, accepted: true, evidenceId: 'late-vocal' },
  ], 1);
  assert.deepEqual([aligned.phrases[0].words[0].startMs, aligned.phrases[0].words[0].endMs], [1100, 1300]);
  assert.deepEqual([aligned.phrases[0].startMs, aligned.phrases[0].endMs], [1000, 6300]);

  const explicit = makeScore('[00:01.00]one two\n[00:02.20]');
  assert.equal(explicit.phrases[0].endEstimated, false);
  errorCode(() => score.applyAlignment(explicit, [
    { wordId: explicit.phrases[0].words[0].id, startMs: 3000, endMs: 3300, accepted: true, evidenceId: 'outside' },
  ], 0), 'INVALID_TIME');
  const locked = score.applyOperation(explicit, { type: 'setWordTiming', wordId: explicit.phrases[0].words[0].id, startMs: 1100, endMs: 1300 }, 0);
  const unchanged = score.applyAlignment(locked, [
    { wordId: explicit.phrases[0].words[0].id, startMs: 5000, endMs: 5300, accepted: true, evidenceId: 'locked-outside' },
  ], 1);
  assert.deepEqual([unchanged.phrases[0].words[0].startMs, unchanged.phrases[0].words[0].endMs], [1100, 1300]);
});

test('a mixed alignment batch with one invalid accepted proposal rejects atomically', () => {
  const s = makeScore('[00:01.00]one two\n[00:04.00]');
  const phrase = s.phrases[0];
  const before = structuredClone(s);
  errorCode(() => score.applyAlignment(s, [
    { wordId: phrase.words[0].id, startMs: 4000, endMs: 4300, accepted: true, evidenceId: 'valid-first' },
    { wordId: phrase.words[1].id, startMs: 4400, endMs: 4200, accepted: true, evidenceId: 'invalid-reversed' },
  ], 0), 'INVALID_TIME');
  assert.deepEqual(s, before);
});

test('syllable segmentation preserves punctuation, uses global IDs, and exposes active syllable IDs', () => {
  const base = makeScore('[00:01.00]sing! now\n[00:04.00]');
  const word = base.phrases[0].words[0];
  const splitAt = word.startMs + Math.floor((word.endMs - word.startMs) / 2);
  const split = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'syllable-1', text: 'sing', startMs: word.startMs, endMs: splitAt },
    { id: 'syllable-2', text: '!', startMs: splitAt, endMs: word.endMs },
  ] }, 0);
  const target = split.phrases[0].words[0];
  assert.equal(target.syllables.map(syllable => syllable.text).join(''), target.text);
  assert.deepEqual(target.syllables.map(syllable => [syllable.provenance, syllable.locked]), [['manual', true], ['manual', true]]);
  assert.ok(score.activeAt(split, splitAt).phrases[0].activeSyllables.includes('syllable-2'));
  const directTiming = score.applyOperation(split, { type: 'setSyllableTiming', syllableId: 'syllable-2', startMs: splitAt + 10, endMs: word.endMs }, 1);
  const retimedSyllable = score.applyOperation(directTiming, { type: 'setSyllableTiming', syllableId: 'syllable-2', startMs: splitAt + 20, endMs: word.endMs - 10 }, 2);
  assert.equal(retimedSyllable.phrases[0].words[0].syllables[1].locked, true);
  assert.equal(retimedSyllable.phrases[0].words[0].syllables[1].provenance, 'manual');
  assert.deepEqual([retimedSyllable.phrases[0].words[0].syllables[1].startMs, retimedSyllable.phrases[0].words[0].syllables[1].endMs], [splitAt + 20, word.endMs - 10]);
  const aligned = score.applyAlignment(retimedSyllable, [
    { wordId: word.id, startMs: word.startMs + 200, endMs: word.endMs - 100, accepted: true, evidenceId: 'manual-syllable-protected' },
  ], 3);
  assert.deepEqual([aligned.phrases[0].words[0].syllables[1].startMs, aligned.phrases[0].words[0].syllables[1].endMs], [splitAt + 20, word.endMs - 10]);
  const estimatedSplit = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'estimated-first', text: 'sing', startMs: word.startMs, endMs: splitAt, provenance: 'estimated', locked: false },
    { id: 'estimated-punctuation', text: '!', startMs: splitAt, endMs: word.endMs, provenance: 'estimated', locked: false },
  ] }, 0);
  assert.deepEqual(estimatedSplit.phrases[0].words[0].syllables.map(item => [item.provenance, item.locked]), [['estimated', false], ['estimated', false]]);
  errorCode(() => score.applyOperation(split, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'replacement', text: 'sing!', startMs: word.startMs, endMs: word.endMs },
  ] }, 1), 'LOCKED');
  let unlocked = score.applyOperation(split, { type: 'setSyllableLock', syllableId: 'syllable-1', locked: false }, 1);
  unlocked = score.applyOperation(unlocked, { type: 'setSyllableLock', syllableId: 'syllable-2', locked: false }, 2);
  unlocked = score.applyOperation(unlocked, { type: 'setWordLock', wordId: word.id, locked: true }, 3);
  const replaced = score.applyOperation(unlocked, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'replacement-a', text: 'si', startMs: word.startMs, endMs: splitAt },
    { id: 'replacement-b', text: 'ng!', startMs: splitAt, endMs: word.endMs },
  ] }, 4);
  assert.equal(replaced.phrases[0].words[0].locked, true);
  assert.equal(replaced.phrases[0].words[0].syllables.map(item => item.text).join(''), 'sing!');
  let clearable = score.applyOperation(replaced, { type: 'setSyllableLock', syllableId: 'replacement-a', locked: false }, 5);
  clearable = score.applyOperation(clearable, { type: 'setSyllableLock', syllableId: 'replacement-b', locked: false }, 6);
  const cleared = score.applyOperation(clearable, { type: 'setWordSyllables', wordId: word.id, syllables: [] }, 7);
  assert.deepEqual(cleared.phrases[0].words[0].syllables, []);
  assert.equal(score.validateScore(cleared), cleared);
});

test('spokenText supports phonetic syllables without changing display text or timing', () => {
  const base = makeScore('[00:01.00]24 now\n[00:04.00]');
  const word = base.phrases[0].words[0];
  const original = [word.startMs, word.endMs, word.locked, word.provenance];
  const splitAt = word.startMs + Math.floor((word.endMs - word.startMs) / 3);
  const split = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, spokenText: 'twentyfour', syllables: [
    { id: 'spoken-a', text: 'twen', startMs: word.startMs, endMs: splitAt, provenance: 'estimated', locked: false },
    { id: 'spoken-b', text: 'ty', startMs: splitAt, endMs: splitAt + 1, provenance: 'estimated', locked: false },
    { id: 'spoken-c', text: 'four', startMs: splitAt + 1, endMs: word.endMs, provenance: 'estimated', locked: false },
  ] }, 0);
  const target = split.phrases[0].words[0];
  assert.equal(target.text, '24');
  assert.equal(target.spokenText, 'twentyfour');
  assert.deepEqual(target.syllables.map(child => child.text), ['twen', 'ty', 'four']);
  assert.deepEqual([target.startMs, target.endMs, target.locked, target.provenance], original);
  assert.equal(score.validateScore(split), split);
  const ordinary = structuredClone(base);
  errorCode(() => score.applyOperation(ordinary, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'ordinary-bad', text: 'twentyfour', startMs: word.startMs, endMs: word.endMs },
  ] }, 0), 'INVALID_SYLLABLES');
  const malformed = [ '', 'has|pipe', 'x'.repeat(257), 123 ];
  for (const spokenText of malformed) errorCode(() => score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, spokenText, syllables: [] }, 0), 'INVALID_SYLLABLES');
  const corrupted = structuredClone(base); corrupted.phrases[0].words[0].spokenText = 'bad|alias';
  assert.throws(() => score.validateScore(corrupted), error => error.code === 'INVALID_SCORE');
  const locked = structuredClone(split); locked.phrases[0].words[0].syllables[0].locked = true;
  const before = structuredClone(locked);
  errorCode(() => score.applyOperation(locked, { type: 'setWordSyllables', wordId: word.id, spokenText: 'bad|alias', syllables: [] }, 1), 'LOCKED');
  assert.deepEqual(locked, before);
  const cleared = score.applyOperation(split, { type: 'setWordSyllables', wordId: word.id, spokenText: null, syllables: [] }, 1);
  assert.equal(cleared.phrases[0].words[0].spokenText, undefined);
  assert.deepEqual(cleared.phrases[0].words[0].syllables, []);
  const changed = score.applyOperation(split, { type: 'setWordText', wordId: word.id, text: 'twenty-four' }, 1);
  assert.equal(changed.phrases[0].words[0].spokenText, undefined);
  assert.equal(changed.phrases[0].words[0].syllables, undefined);
});

test('syllable timing, lock, effect, word resize, and text edits preserve valid boundaries', () => {
  const base = makeScore('[00:01.00]sing! now\n[00:04.00]');
  const word = base.phrases[0].words[0];
  const splitAt = word.startMs + Math.floor((word.endMs - word.startMs) / 2);
  let s = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'syllable-a', text: 'sing', startMs: word.startMs, endMs: splitAt },
    { id: 'syllable-b', text: '!', startMs: splitAt, endMs: word.endMs },
  ] }, 0);
  s = score.applyOperation(s, { type: 'setSyllableLock', syllableId: 'syllable-b', locked: false }, 1);
  s = score.applyOperation(s, { type: 'setSyllableTiming', syllableId: 'syllable-b', startMs: splitAt + 10, endMs: word.endMs - 10 }, 2);
  assert.equal(s.phrases[0].words[0].syllables[1].locked, true);
  assert.equal(s.phrases[0].words[0].syllables[1].provenance, 'manual');
  s = score.applyOperation(s, { type: 'setSyllableEffect', syllableId: 'syllable-b', effect: { type: 'pulse', strength: 0.5 } }, 3);
  assert.deepEqual(s.phrases[0].words[0].syllables[1].effects, [{ type: 'pulse', strength: 0.5 }]);
  const resized = score.applyOperation(s, { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs - 100 }, 4);
  const resizedWord = resized.phrases[0].words[0];
  assert.ok(resizedWord.syllables.every(item => item.startMs >= resizedWord.startMs && item.endMs <= resizedWord.endMs));
  const phraseResized = score.applyOperation(resized, { type: 'setPhraseTiming', phraseId: resized.phrases[0].id, startMs: 2000, endMs: 4000 }, 5);
  const phraseWord = phraseResized.phrases[0].words[0];
  assert.ok(phraseWord.syllables.every(item => item.startMs >= phraseWord.startMs && item.endMs <= phraseWord.endMs));
  const unchangedText = score.applyOperation(phraseResized, { type: 'setWordText', wordId: word.id, text: phraseWord.text }, 6);
  assert.equal(unchangedText.phrases[0].words[0].syllables.length, 2);
  const changedText = score.applyOperation(unchangedText, { type: 'setWordText', wordId: word.id, text: 'vocal!' }, 7);
  assert.equal(changedText.phrases[0].words[0].syllables, undefined);
});

test('automatic word alignment skips syllable locks and rescales estimated unlocked children', () => {
  const base = makeScore('[00:01.00]sing!\n[00:04.00]');
  const word = base.phrases[0].words[0];
  const midpoint = word.startMs + Math.floor((word.endMs - word.startMs) / 2);
  const estimated = structuredClone(base);
  estimated.phrases[0].words[0].syllables = [
    { id: 'estimated-1', text: 'sing', startMs: word.startMs, endMs: midpoint, provenance: 'estimated', locked: false, effects: [] },
    { id: 'estimated-2', text: '!', startMs: midpoint, endMs: word.endMs, provenance: 'estimated', locked: false, effects: [] },
  ];
  score.validateScore(estimated);
  const aligned = score.applyAlignment(estimated, [
    { wordId: word.id, startMs: 5000, endMs: 6000, accepted: true, evidenceId: 'audio-estimated' },
  ], 0);
  const alignedWord = aligned.phrases[0].words[0];
  assert.deepEqual(alignedWord.syllables.map(item => [item.startMs, item.endMs]), [[5000, 5500], [5500, 6000]]);
  assert.ok(alignedWord.syllables.every(item => item.provenance === 'estimated' && !item.locked));
  assert.equal(aligned.phrases[0].endMs, 6000);

  const locked = score.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'locked-syllable', text: word.text, startMs: word.startMs, endMs: word.endMs },
  ] }, 0);
  const skipped = score.applyAlignment(locked, [
    { wordId: word.id, startMs: 5000, endMs: 6000, accepted: true, evidenceId: 'audio-locked' },
  ], 1);
  assert.deepEqual([skipped.phrases[0].words[0].startMs, skipped.phrases[0].words[0].endMs], [word.startMs, word.endMs]);
});

test('syllable validation rejects duplicate IDs, non-concatenating text, and child timing outside word', () => {
  const base = makeScore('[00:01.00]sing! now\n[00:04.00]');
  const word = base.phrases[0].words[0];
  const child = { id: 'bad-child', text: word.text, startMs: word.startMs, endMs: word.endMs, provenance: 'estimated', locked: false, effects: [] };
  for (const [id, text, startMs, endMs] of [
    [word.id, word.text, word.startMs, word.endMs],
    ['text-child', 'different', word.startMs, word.endMs],
    ['late-child', word.text, word.startMs, word.endMs + 1],
  ]) {
    const bad = structuredClone(base);
    bad.phrases[0].words[0].syllables = [{ ...child, id, text, startMs, endMs }];
    errorCode(() => score.validateScore(bad), 'INVALID_SCORE');
  }
});

test('word and syllable reveal settings are revisioned independently of timing, locks, and effects', () => {
  const base = makeScore('[00:01.00]sing!\n[00:04.00]');
  const word = base.phrases[0].words[0];
  let s = score.applyOperation(base, { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 10, endMs: word.endMs - 10 }, 0);
  s = score.applyOperation(s, { type: 'setWordEffect', wordId: word.id, effect: { type: 'pulse', strength: 0.4 } }, 1);
  const timing = [s.phrases[0].words[0].startMs, s.phrases[0].words[0].endMs];
  s = score.applyOperation(s, { type: 'setWordReveal', wordId: word.id, reveal: { type: 'sweep', easing: 'ease-in-out' } }, 2);
  assert.deepEqual([s.phrases[0].words[0].startMs, s.phrases[0].words[0].endMs], timing);
  assert.equal(s.phrases[0].words[0].locked, true);
  assert.deepEqual(s.phrases[0].words[0].effects, [{ type: 'pulse', strength: 0.4 }]);
  s = score.applyOperation(s, { type: 'setWordReveal', wordId: word.id, reveal: null }, 3);
  assert.equal(s.phrases[0].words[0].reveal, null);
  assert.deepEqual(s.phrases[0].words[0].effects, [{ type: 'pulse', strength: 0.4 }]);

  const child = { id: 'reveal-syllable', text: word.text, startMs: timing[0], endMs: timing[1] };
  s = score.applyOperation(s, { type: 'setWordSyllables', wordId: word.id, syllables: [child] }, 4);
  s = score.applyOperation(s, { type: 'setSyllableEffect', syllableId: child.id, effect: { type: 'tilt', strength: 0.25 } }, 5);
  const childTiming = [s.phrases[0].words[0].syllables[0].startMs, s.phrases[0].words[0].syllables[0].endMs];
  s = score.applyOperation(s, { type: 'setSyllableReveal', syllableId: child.id, reveal: { type: 'sweep', easing: 'ease-out' } }, 6);
  const updated = s.phrases[0].words[0].syllables[0];
  assert.deepEqual([updated.startMs, updated.endMs], childTiming);
  assert.equal(updated.locked, true);
  assert.deepEqual(updated.effects, [{ type: 'tilt', strength: 0.25 }]);
  const badWordReveal = structuredClone(s); badWordReveal.phrases[0].words[0].reveal = { type: 'sweep', easing: 'bounce' };
  errorCode(() => score.validateScore(badWordReveal), 'INVALID_SCORE');
  const badSyllableReveal = structuredClone(s); badSyllableReveal.phrases[0].words[0].syllables[0].reveal = { type: 'fade', easing: 'linear' };
  errorCode(() => score.validateScore(badSyllableReveal), 'INVALID_SCORE');
  errorCode(() => score.applyOperation(s, { type: 'setSyllableReveal', syllableId: child.id, reveal: { type: 'sweep', easing: 'bounce' } }, 7), 'INVALID_REVEAL');
  errorCode(() => score.applyOperation(s, { type: 'setWordReveal', wordId: word.id, reveal: { type: 'fade', easing: 'linear' } }, 7), 'INVALID_REVEAL');
});

test('revealProgress is deterministic across pause, seek, offset, and easing modes', () => {
  const linear = { startMs: 100, endMs: 200, reveal: { type: 'sweep', easing: 'linear' } };
  assert.equal(score.revealProgress(linear, 150), 0.5);
  assert.equal(score.revealProgress(linear, 150), score.revealProgress(linear, 150)); // Paused at the same media clock.
  assert.equal(score.revealProgress(linear, 125), 0.25); // Seeking backward recomputes from media time.
  assert.equal(score.revealProgress(linear, 200, 50), 0.5); // Offset is applied once: 200 - 50 = 150.
  assert.equal(score.revealProgress({ ...linear, reveal: null }, 99), 0);
  assert.equal(score.revealProgress({ ...linear, reveal: null }, 100), 1);
  assert.equal(score.revealProgress({ startMs: 100, endMs: 100, reveal: { type: 'sweep', easing: 'linear' } }, 99), 0);
  assert.equal(score.revealProgress({ startMs: 100, endMs: 100, reveal: { type: 'sweep', easing: 'linear' } }, 100), 1);
  assert.equal(score.revealProgress({ ...linear, reveal: { type: 'sweep', easing: 'ease-out' } }, 150), 0.875);
  assert.equal(score.revealProgress({ ...linear, reveal: { type: 'sweep', easing: 'ease-in-out' } }, 125), 0.15625);
  errorCode(() => score.revealProgress(linear, Infinity), 'INVALID_TIME');
  errorCode(() => score.revealProgress({ ...linear, endMs: NaN }, 150), 'INVALID_TIME');
});

test('import validation rejects malformed IDs, times, lanes, effects, and hashes', () => {
  const s = makeScore();
  for (const alter of [
    x => { x.source.videoId = 'wrong'; },
    x => { x.phrases[0].words[0].startMs = -1; },
    x => { x.phrases[0].words[0].endMs = x.phrases[0].words[0].startMs - 1; },
    x => { x.phrases[0].laneId = 'unknown'; },
    x => { x.phrases[0].words[0].effects = [{ type: 'unknown-effect', strength: 0.5 }]; },
    x => { x.lyrics.contentHash = 'weak'; },
    x => { x.phrases[0].words.push({ ...x.phrases[0].words[0] }); },
  ]) {
    const bad = structuredClone(s); alter(bad);
    errorCode(() => score.validateScore(bad), 'INVALID_SCORE');
  }
  errorCode(() => score.createScore({ videoId: 'FIXTURE0001', durationMs: 1 }, '', {}), 'INVALID_LYRICS');
});

test('recorded word bounds remain authoritative while syllables occupy intervals inside them',()=>{
 const s=makeScore('[00:01.00]Oh\n[00:04.00]'),p=s.phrases[0],w=p.words[0];
 const operation={type:'setPhraseSyllablePerformance',phraseId:p.id,words:[{wordId:w.id,startMs:1100,endMs:2300,spokenText:'OhOh',syllables:[{id:'o1',text:'Oh',startMs:1200,endMs:1500},{id:'o2',text:'Oh',startMs:1800,endMs:2200}]}]};
 const n=score.applyOperation(s,operation,s.revision),word=n.phrases[0].words[0];assert.deepEqual([word.startMs,word.endMs],[1100,2300]);assert.deepEqual(word.syllables.map(x=>[x.startMs,x.endMs]),[[1200,1500],[1800,2200]]);
 errorCode(()=>score.applyOperation(s,{...operation,words:[{...operation.words[0],startMs:1300}]},s.revision),'INVALID_TIME');
});


test('saved syllables retain source-bound note events and uncalibrated capture-speed evidence through export and retiming',()=>{
 const base=makeScore('[00:01.00]hello\n[00:04.00]'),p=base.phrases[0],w=p.words[0];
 const evidence={captureId:'capture-proof',eventId:'event-1',sourceMs:1100,releaseMs:2500,playbackRate:.5,relativeWeight:4,basis:'equal-input-error-speed-prior',calibrated:false,noteEvents:[{eventId:'event-2',sourceMs:1500,playbackRate:.5,relativeWeight:4,basis:'equal-input-error-speed-prior',calibrated:false,kind:'note-change'}]};
 const op={type:'setPhraseSyllablePerformance',phraseId:p.id,words:[{wordId:w.id,syllables:[{id:'capture-s',text:'hello',startMs:1100,endMs:2500,captureEvidence:evidence}]}]};
 const next=score.applyOperation(base,op,base.revision);assert.deepEqual(next.phrases[0].words[0].syllables[0].captureEvidence,evidence);
 const serialized=JSON.parse(JSON.stringify(next));score.validateScore(serialized);
 const moved=score.applyOperation(next,{type:'setSyllableTiming',syllableId:'capture-s',startMs:1200,endMs:2400},next.revision);
 assert.deepEqual(moved.phrases[0].words[0].syllables[0].captureEvidence,evidence,'score editing never rewrites original observations');
 const bad=structuredClone(op);bad.words[0].syllables[0].captureEvidence.relativeWeight=100;assert.throws(()=>score.applyOperation(base,bad,base.revision),/speed prior/);
});
