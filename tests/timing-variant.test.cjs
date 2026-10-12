const test = require('node:test'), assert = require('node:assert/strict');
const core = require('../extension/score-core.js'), variant = require('../extension/timing-variant.js');
const source = { videoId: 'FIXTURE0001', durationMs: 60000 };
const make = (raw, hash = 'a') => core.createScore(source, raw, { contentHash: hash.repeat(64) });
test('preview migrates catalog estimates and keeps ids, effects, offset and input immutable', () => {
  const base = make('[00:01.00]hello world\n[00:04.00]another line');
  base.offsetMs = 137; base.phrases[0].words[0].effects = [{type:'tilt',strength:.2}];
  const snapshot = JSON.stringify(base);
  const draft = variant.merge(base, make('[00:23.19]hello world\n[00:27.00]another line', 'b'));
  assert.equal(draft.score.phrases[0].startMs, 23190); assert.equal(draft.score.offsetMs, 137);
  assert.equal(draft.score.phrases[0].words[0].id, base.phrases[0].words[0].id);
  assert.deepEqual(draft.score.phrases[0].words[0].effects, base.phrases[0].words[0].effects);
  assert.equal(draft.score.lyrics.contentHash, 'b'.repeat(64)); assert.equal(draft.score.revision, 1);
  assert.equal(JSON.stringify(base), snapshot); assert.equal(draft.changedWords, 4);
});
test('a manual word or syllable protects its whole saved phrase', () => {
  for (const kind of ['word','syllable','aligned']) {
    const base = make('[00:01.00]hello world\n[00:04.00]another line');
    const w = base.phrases[0].words[0];
    if (kind==='word') w.locked=true;
    if (kind==='aligned') w.provenance='aligned';
    if (kind==='syllable') w.syllables=[{...w,id:'syllable',locked:true}];
    const draft = variant.merge(base, make('[00:23.19]hello world\n[00:27.00]another line','b'));
    assert.deepEqual(draft.score.phrases[0], base.phrases[0]);
    assert.equal(draft.score.phrases[1].startMs,27000); assert.equal(draft.protectedIds.length,2);
    assert.throws(()=>variant.tune(draft,[{wordId:w.id,startMs:23000,endMs:24000}]), {code:'MANUAL_PROTECTED'});
    const explicit=variant.tune(draft,[{wordId:w.id,startMs:1100,endMs:1500}],true);
    assert.equal(explicit.score.phrases[0].words[0].startMs,1100);
    assert.equal(base.phrases[0].words[0].startMs,1000);
  }
});
test('changed words, grouping or video never pair by guessed ordinal', () => {
  const base=make('[00:01.00]hello world');
  assert.throws(()=>variant.merge(base,make('[00:22.00]hello there','b')),{code:'LYRICS_CHANGED'});
  const wrong=make('[00:22.00]hello world','b');wrong.source.videoId='FIXTURE0002';
  assert.throws(()=>variant.merge(base,wrong),{code:'SOURCE_MISMATCH'});
});
test('precise preview tuning is repeatable and remains isolated from the saved score', () => {
  const base=make('[00:01.00]hello world');
  let draft=variant.merge(base,make('[00:22.00]hello world','b'));
  const id=draft.score.phrases[0].words[0].id;
  draft=variant.tune(draft,[{wordId:id,startMs:21950,endMs:22200}]);
  draft=variant.tune(draft,[{wordId:id,startMs:21925,endMs:22200}]);
  assert.equal(draft.score.phrases[0].words[0].startMs,21925);
  assert.equal(draft.score.phrases[0].words[0].locked,true);
  assert.equal(base.phrases[0].words[0].startMs,1000);
  assert.throws(()=>variant.tune(draft,[{wordId:id,startMs:21925.5,endMs:22200}]),{code:'INVALID_TIMING'});
});
