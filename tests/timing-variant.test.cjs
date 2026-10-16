const test = require('node:test'), assert = require('node:assert/strict');
const core = require('../extension/score-core.js'), variant = require('../extension/timing-variant.js');
const source = { videoId: 'FIXTURE0001', durationMs: 60000 };
const make = (raw, hash = 'a') => core.createScore(source, raw, { contentHash: hash.repeat(64) });

test('a full-song syllable pass exceeding 128 operations remains one atomic preview edit', () => {
  const base=make('[00:01.00]'+Array.from({length:130},(_,i)=>'word'+i).join(' ')+'\n[00:50.00]');
  const draft=variant.merge(base,base),before=JSON.stringify(draft);
  const operations=base.phrases[0].words.map(w=>({type:'setWordSyllables',wordId:w.id,syllables:[{id:w.id+'-s1',text:w.text,startMs:w.startMs,endMs:w.endMs}]}));
  const changed=variant.operate(draft,operations,true);
  assert.equal(changed.score.phrases[0].words.filter(w=>w.syllables.length===1).length,130);
  assert.throws(()=>variant.operate(draft,[...operations,{type:'setWordSyllables',wordId:'missing',syllables:[]}],true));
  assert.equal(JSON.stringify(draft),before);
  assert.throws(()=>variant.operate(draft,Array(5001).fill(operations[0]),true),{code:'INVALID_OPERATION'});
});

test('excluded-word migration preserves omission across changed timing and requires protected override to restore', () => {
  const base = make('[00:20.00]See that light');
  const word = base.phrases[0].words[1];
  const hidden = core.applyOperation(base, { type: 'setWordExcluded', wordId: word.id, excluded: true }, base.revision);
  const draft = variant.merge(hidden, make('[00:23.19]See that light', 'b'));
  assert.equal(draft.score.phrases[0].words[1].excluded, true);
  assert.ok(draft.protectedIds.includes(word.id));
  assert.equal(draft.score.phrases[0].words[1].startMs, word.startMs);
  assert.throws(() => variant.operate(draft, { type: 'setWordExcluded', wordId: word.id, excluded: false }), { code: 'MANUAL_PROTECTED' });
  const restored = variant.operate(draft, { type: 'setWordExcluded', wordId: word.id, excluded: false }, true);
  assert.equal(restored.score.phrases[0].words[1].excluded, false);
  assert.equal(restored.score.phrases[0].words[1].text, word.text);
});

test('replaceWords is whitelisted for preview edits and protects saved manual timing', () => {
  const base = make('[00:20.00]See that light');
  const phrase = base.phrases[0], selected = phrase.words.slice(0, 3);
  const word = selected[0];
  const manuallyTimed = core.applyOperation(base, { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 5, endMs: word.endMs - 5 }, base.revision);
  const draft = variant.merge(manuallyTimed, make('[00:23.19]See that light', 'b'));
  const op = { type: 'replaceWords', phraseId: phrase.id, wordIds: selected.map(item => item.id), text: 'get down' };
  assert.throws(() => variant.operate(draft, op), { code: 'MANUAL_PROTECTED' });
  const changed = variant.operate(draft, op, true);
  assert.deepEqual(changed.score.phrases[0].words.map(item => item.text), ['get', 'down']);
});

test('phrase syllable capture requires override for a saved protected word', () => {
  let base = make('[00:20.00]See that light');
  const phrase = base.phrases[0];
  for (const word of phrase.words) base = core.applyOperation(base, { type: 'setWordSyllables', wordId: word.id, syllables: [{ id: `sy-${word.id}`, text: word.text, startMs: word.startMs, endMs: word.endMs }] }, base.revision);
  const draft = variant.merge(base, make('[00:23.19]See that light', 'b'));
  const p = draft.score.phrases[0], middle = p.startMs + Math.floor((p.endMs - p.startMs) / 2), end1 = p.startMs + Math.floor((p.endMs - p.startMs) / 3), end2 = p.startMs + Math.floor(2 * (p.endMs - p.startMs) / 3);
  const op = { type: 'setPhraseSyllableTimings', phraseId: p.id, marks: [
    { syllableId: `sy-${p.words[0].id}`, startMs: p.startMs, endMs: end1 },
    { syllableId: `sy-${p.words[1].id}`, startMs: end1, endMs: end2 },
    { syllableId: `sy-${p.words[2].id}`, startMs: end2, endMs: p.endMs },
  ] };
  assert.throws(() => variant.operate(draft, op), { code: 'MANUAL_PROTECTED' });
  const edited = variant.operate(draft, op, true);
  assert.equal(edited.score.phrases[0].words[0].endMs, end1);
});

test('phrase performance protects each targeted word and requires explicit unlock for old locked children', () => {
  let base = make('[00:20.00]hour now');
  const phrase = base.phrases[0], word = phrase.words[0];
  word.syllables = [{ id: 'hour-old', text: word.text, startMs: word.startMs, endMs: word.endMs, provenance: 'manual', locked: true, effects: [{ type: 'pulse', strength: 0.3 }] }];
  const draft = variant.merge(base, make('[00:23.00]hour now', 'b'));
  const performance = { type: 'setPhraseSyllablePerformance', phraseId: phrase.id, words: [{ wordId: word.id, syllables: [{ id: 'hour-old', text: word.text, startMs: phrase.startMs, endMs: word.endMs }] }] };
  assert.throws(() => variant.operate(draft, performance), { code: 'MANUAL_PROTECTED' });
  assert.throws(() => variant.operate(draft, performance, true), { code: 'LOCKED' });
  const edited = variant.operate(draft, [
    { type: 'setSyllableLock', syllableId: 'hour-old', locked: false },
    performance,
  ], true);
  assert.deepEqual(edited.score.phrases[0].words[0].syllables[0].effects, [{ type: 'pulse', strength: 0.3 }]);
  assert.equal(edited.score.phrases[0].words[0].syllables[0].locked, true);
});

test('preview lane changes are allowed for a locked phrase and preserve all timing and word state', () => {
  const base = make('[00:20.00]See (echo)');
  const phrase = base.phrases.find(item => item.laneId === 'lead');
  const word = phrase.words[0];
  word.startMs += 7; word.endMs -= 7; word.provenance = 'manual'; word.locked = true;
  word.effects = [{ type: 'pulse', strength: 0.5 }];
  const draft = variant.merge(base, make('[00:23.00]See (echo)', 'b'));
  assert.ok(draft.protectedIds.includes(word.id));
  const before = structuredClone(draft.score.phrases[0]);
  const changed = variant.operate(draft, { type: 'setPhraseLane', phraseId: phrase.id, laneId: 'backing' });
  const after = changed.score.phrases.find(item => item.id === phrase.id);
  assert.equal(after.laneId, 'backing');
  const { laneId: _laneId, ...beforeState } = before;
  const { laneId: _changedLane, ...afterState } = after;
  assert.deepEqual(afterState, beforeState);
  const snapshot = JSON.stringify(draft);
  assert.throws(() => variant.operate(draft, [
    { type: 'setPhraseLane', phraseId: phrase.id, laneId: 'backing' },
    { type: 'setPhraseLane', phraseId: phrase.id, laneId: 'unknown' },
  ]), { code: 'UNKNOWN_ID' });
  assert.equal(JSON.stringify(draft), snapshot);
});
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

test('hyphenParts split a compound word into protected word cues and preserve appearance', () => {
  const base=make('[00:01.00]ice-breaker now');
  const original=base.phrases[0].words[0];
  original.effects=[{type:'pulse',strength:0.6}];
  original.reveal={type:'sweep',easing:'linear'};
  const draft=variant.merge(base,make('[00:22.00]ice-breaker now','b'));
  const word=draft.score.phrases[0].words[0];
  const split=variant.tune(draft,[{wordId:word.id,startMs:22000,endMs:22400,hyphenParts:[
    {text:'ice-',startMs:22000,endMs:22150},{text:'breaker',startMs:22200,endMs:22400},
  ]}]);
  const [first,second]=split.score.phrases[0].words;
  assert.deepEqual([first.id,first.text,first.startMs,first.endMs],[word.id,'ice-',22000,22150]);
  assert.deepEqual([second.id,second.text,second.startMs,second.endMs],[`${word.id}-hyphen-2`,'breaker',22200,22400]);
  for(const part of [first,second]) {
    assert.equal(part.locked,true); assert.equal(part.provenance,'manual');
    assert.deepEqual(part.effects,original.effects); assert.deepEqual(part.reveal,original.reveal);
  }
  assert.equal(split.score.phrases[0].words.map(w=>w.text).join(' '),'ice- breaker now');
  assert.equal(variant.tune(split,[{wordId:first.id,startMs:22000,endMs:22160}]).score.phrases[0].words[0].endMs,22160); // same-preview manual repair stays editable
  const protectedDraft={...draft,protectedIds:[word.id]};
  assert.throws(()=>variant.tune(protectedDraft,[{wordId:word.id,startMs:22000,endMs:22400,hyphenParts:[{text:'ice-',startMs:22000,endMs:22150},{text:'breaker',startMs:22200,endMs:22400}]}]),{code:'MANUAL_PROTECTED'});
});

test('hyphenParts reject authored syllables, partial or invalid parts and timing collisions atomically', () => {
  const base=make('[00:01.00]ice-breaker later');
  const original=base.phrases[0].words[0];
  const draft=variant.merge(base,make('[00:22.00]ice-breaker later','b'));
  const word=draft.score.phrases[0].words[0], before=JSON.stringify(draft);
  const change=(parts,endMs=22400)=>({wordId:word.id,startMs:22000,endMs,hyphenParts:parts});
  for(const bad of [
    change([{text:'ice-',startMs:22000,endMs:22200}]),
    change([{text:'wrong-',startMs:22000,endMs:22100},{text:'breaker',startMs:22100,endMs:22400}]),
    change([{text:'ice-',startMs:22000,endMs:22200},{text:'breaker',startMs:22100,endMs:22400}]),
    change([{text:'ice-',startMs:22000,endMs:22100},{text:'breaker',startMs:22100,endMs:22400}],22450),
  ]) assert.throws(()=>variant.tune(draft,[bad]),{code:'INVALID_TIMING'});
  const collision=structuredClone(draft);collision.score.phrases[0].words[1].id=`${word.id}-hyphen-2`;
  assert.throws(()=>variant.tune(collision,[change([
    {text:'ice-',startMs:22000,endMs:22100},{text:'breaker',startMs:22100,endMs:22400},
  ])]),{code:'INVALID_TIMING'});
  assert.equal(JSON.stringify(draft),before);
  const syllabled=structuredClone(draft);
  syllabled.score.phrases[0].words[0].syllables=[{id:'authored',text:word.text,startMs:word.startMs,endMs:word.endMs,provenance:'manual',locked:true,effects:[]}];
  assert.throws(()=>variant.tune(syllabled,[change([
    {text:'ice-',startMs:22000,endMs:22100},{text:'breaker',startMs:22100,endMs:22400},
  ])],true),{code:'INVALID_SYLLABLES'});
  assert.equal(JSON.stringify(draft),before);
});

test('a saved manual hyphen split remains protected when the candidate still has its compound word', () => {
  const base=make('[00:01.00]ice-breaker stays\n[00:04.00]free');
  const saved=variant.merge(base,make('[00:22.00]ice-breaker stays\n[00:25.00]free','b'));
  const compound=saved.score.phrases[0].words[0];
  const split=variant.tune(saved,[{wordId:compound.id,startMs:1100,endMs:1500,hyphenParts:[
    {text:'ice-',startMs:1100,endMs:1250},{text:'breaker',startMs:1300,endMs:1500},
  ]}],true);
  const candidate=make('[00:35.00]ice-breaker stays\n[00:39.00]free','c');
  const migrated=variant.merge(split.score,candidate);
  assert.deepEqual(migrated.score.phrases[0].words,split.score.phrases[0].words);
  assert.deepEqual(migrated.protectedIds,split.score.phrases[0].words.map(w=>w.id));
  assert.deepEqual(migrated.preservedPhraseIds,[split.score.phrases[0].id]);
  assert.equal(migrated.score.phrases[1].startMs,39000);
});

test('syllable operations preserve the preview revision and support tapping plus repeat manual timing', () => {
  const base=make('[00:01.00]hello world'), before=JSON.stringify(base);
  const draft=variant.merge(base,make('[00:22.00]hello world','b'));
  const word=draft.score.phrases[0].words[0], originalPreviewRevision=draft.score.revision;
  const split=variant.operate(draft,{type:'setWordSyllables',wordId:word.id,startTapping:true,syllables:[
    {id:'hel',text:'hel',startMs:22000,endMs:22100},{id:'lo',text:'lo',startMs:22100,endMs:22200},
  ]});
  const children=split.score.phrases[0].words[0].syllables;
  assert.equal(children.map(s=>s.text).join(''),'hello');
  assert.ok(children.every(s=>s.startMs>=word.startMs&&s.endMs<=word.endMs));
  assert.ok(children.every(s=>s.provenance==='estimated'&&!s.locked));
  assert.equal(split.score.revision,originalPreviewRevision);
  let timed=variant.operate(split,{type:'setSyllableTiming',syllableId:'hel',startMs:22010,endMs:22110});
  timed=variant.operate(timed,{type:'setSyllableTiming',syllableId:'hel',startMs:22020,endMs:22120});
  assert.deepEqual([timed.score.phrases[0].words[0].syllables[0].startMs,timed.score.phrases[0].words[0].syllables[0].endMs],[22020,22120]);
  assert.equal(timed.score.phrases[0].words[0].syllables[0].locked,true);
  assert.equal(timed.score.source.videoId,base.source.videoId);
  assert.equal(timed.score.lyrics.contentHash,'b'.repeat(64));
  assert.equal(timed.score.revision,originalPreviewRevision);
  assert.equal(JSON.stringify(base),before);
});

test('explicitly unlocking protected syllables permits a tapping split while preserving the locked word', () => {
  const base = make('[00:20.00]singing night');
  const phrase = base.phrases[0], word = phrase.words[0];
  const middle = word.startMs + Math.floor((word.endMs - word.startMs) / 2);
  word.provenance = 'manual'; word.locked = true;
  word.syllables = [
    { id: 'old-sing', text: 'sing', startMs: word.startMs, endMs: middle, provenance: 'manual', locked: true, effects: [] },
    { id: 'old-ing', text: 'ing', startMs: middle, endMs: word.endMs, provenance: 'manual', locked: true, effects: [] },
  ];
  const draft = variant.merge(base, make('[00:22.00]singing night', 'b'));
  const protectedWord = draft.score.phrases[0].words[0];
  const untouchedWord = structuredClone(draft.score.phrases[0].words[1]);
  const before = JSON.stringify(draft);
  const replacementStart = protectedWord.startMs + Math.floor((protectedWord.endMs - protectedWord.startMs) * 2 / 5);
  const unlockAndReplace = [
    { type: 'setSyllableLock', syllableId: 'old-sing', locked: false },
    { type: 'setSyllableLock', syllableId: 'old-ing', locked: false },
    { type: 'setWordSyllables', wordId: protectedWord.id, startTapping: true, syllables: [
      { id: 'new-sing', text: 'sing', startMs: protectedWord.startMs, endMs: replacementStart },
      { id: 'new-ing', text: 'ing', startMs: replacementStart, endMs: protectedWord.endMs },
    ] },
  ];

  assert.throws(() => variant.operate(draft, unlockAndReplace), { code: 'MANUAL_PROTECTED' });
  assert.equal(JSON.stringify(draft), before);
  const invalidBatch = structuredClone(unlockAndReplace);
  invalidBatch[2].syllables[1].text = 'wrong';
  assert.throws(() => variant.operate(draft, invalidBatch, true), { code: 'INVALID_SYLLABLES' });
  assert.equal(JSON.stringify(draft), before);

  const updated = variant.operate(draft, unlockAndReplace, true);
  const result = updated.score.phrases[0].words[0];
  assert.deepEqual([result.text, result.startMs, result.endMs, result.locked, result.provenance],
    [protectedWord.text, protectedWord.startMs, protectedWord.endMs, true, 'manual']);
  assert.deepEqual(result.syllables.map(({ id, text, startMs, endMs, provenance, locked }) => [id, text, startMs, endMs, provenance, locked]), [
    ['new-sing', 'sing', protectedWord.startMs, replacementStart, 'estimated', false],
    ['new-ing', 'ing', replacementStart, protectedWord.endMs, 'estimated', false],
  ]);
  assert.deepEqual(updated.score.phrases[0].words[1], untouchedWord);
});

test('syllable operation batches are atomic, whitelisted and protect preserved phrase syllables', () => {
  const base=make('[00:01.00]hello world\n[00:04.00]another line');
  const protectedWord=base.phrases[0].words[0];
  protectedWord.locked=true;
  protectedWord.syllables=[{id:'protected-child',text:protectedWord.text,startMs:protectedWord.startMs,endMs:protectedWord.endMs,provenance:'manual',locked:true,effects:[]}];
  const draft=variant.merge(base,make('[00:22.00]hello world\n[00:25.00]another line','b'));
  const word=draft.score.phrases[1].words[0], untouched=JSON.stringify(draft);
  const middle=word.startMs+Math.floor((word.endMs-word.startMs)/2);
  assert.throws(()=>variant.operate(draft,[
    {type:'setWordSyllables',wordId:word.id,syllables:[{id:'an',text:'an',startMs:word.startMs,endMs:middle},{id:'other',text:'other',startMs:middle,endMs:word.endMs}]},
    {type:'setWordTiming',wordId:word.id,startMs:25000,endMs:25500},
  ]),{code:'INVALID_OPERATION'});
  assert.equal(JSON.stringify(draft),untouched);
  assert.throws(()=>variant.operate(draft,{type:'setWordSyllables',wordId:base.phrases[0].words[0].id,syllables:[]}),{code:'MANUAL_PROTECTED'});
  assert.throws(()=>variant.operate(draft,{type:'setSyllableTiming',syllableId:'protected-child',startMs:1100,endMs:1200}),{code:'MANUAL_PROTECTED'});
  assert.throws(()=>variant.operate(draft,{type:'setWordSyllables',wordId:protectedWord.id,syllables:[]},true),{code:'LOCKED'});
  assert.throws(()=>variant.operate(draft,{type:'setWordSyllables',wordId:word.id,syllables:[
    {id:'a',text:'an',startMs:25000,endMs:25100},{id:'b',text:'other line',startMs:25100,endMs:25500},
  ]}),{code:'INVALID_SYLLABLES'});
  assert.throws(()=>variant.operate(draft,{type:'setSyllableTiming',syllableId:'protected-child',startMs:1100,endMs:1100},true),{code:'INVALID_TIME'});
});

test('appearance effects can change a protected manual word without changing its timing', () => {
  const base=make('[00:01.00]hello world');
  const word=base.phrases[0].words[0];
  word.locked=true;
  word.provenance='manual';
  word.syllables=[{id:'hello-first',text:word.text,startMs:word.startMs,endMs:word.endMs,provenance:'manual',locked:true,effects:[]}];
  const draft=variant.merge(base,make('[00:22.00]hello world','b'));
  const protectedWord=draft.score.phrases[0].words[0];
  const timing=[protectedWord.startMs,protectedWord.endMs,protectedWord.syllables[0].startMs,protectedWord.syllables[0].endMs];
  const updated=variant.operate(draft,[
    {type:'setWordEffect',wordId:protectedWord.id,effect:{type:'tilt',strength:0.4}},
    {type:'setSyllableEffect',syllableId:'hello-first',effect:{type:'pulse',strength:0.7}},
  ]);
  const result=updated.score.phrases[0].words[0];
  assert.deepEqual([result.startMs,result.endMs,result.syllables[0].startMs,result.syllables[0].endMs],timing);
  assert.deepEqual(result.effects,[{type:'tilt',strength:0.4}]);
  assert.deepEqual(result.syllables[0].effects,[{type:'pulse',strength:0.7}]);
  assert.equal(updated.score.revision,draft.score.revision);
  assert.deepEqual(base.phrases[0].words[0].effects,[]);
});

test('effect operation batches reject unknown syllables and illegal types atomically', () => {
  const base=make('[00:01.00]hello world');
  const draft=variant.merge(base,make('[00:22.00]hello world','b'));
  const word=draft.score.phrases[0].words[0];
  const untouched=JSON.stringify(draft);
  assert.throws(()=>variant.operate(draft,[
    {type:'setWordEffect',wordId:word.id,effect:{type:'shake',strength:0.5}},
    {type:'setSyllableEffect',syllableId:'missing-syllable',effect:{type:'tilt',strength:0.5}},
  ]),{code:'UNKNOWN_ID'});
  assert.equal(JSON.stringify(draft),untouched);
  assert.throws(()=>variant.operate(draft,{type:'setWordEffect',wordId:word.id,effect:{type:'sparkle',strength:0.5}}),{code:'INVALID_EFFECT'});
  assert.throws(()=>variant.operate(draft,{type:'setWordReveal',wordId:word.id,reveal:null}),{code:'INVALID_OPERATION'});
});

test('phrase capture rescales preview contents atomically and rejects protected phrases', () => {
  const base=make('[00:01.00]hello world\n[00:03.00]again');
  const draft=variant.merge(base,make('[00:22.00]hello world\n[00:24.00]again','b'));
  const phrase=draft.score.phrases[0], original=JSON.stringify(draft);
  const updated=variant.operate(draft,{type:'setPhraseTiming',phraseId:phrase.id,startMs:23000,endMs:25000});
  assert.equal(JSON.stringify(draft),original);
  assert.deepEqual([updated.score.phrases[0].startMs,updated.score.phrases[0].endMs],[23000,25000]);
  assert.ok(updated.score.phrases[0].words.every(w=>w.startMs>=23000&&w.endMs<=25000));
  assert.equal(updated.score.revision,draft.score.revision);
  const guarded={...draft,protectedIds:[phrase.words[0].id]};
  assert.throws(()=>variant.operate(guarded,{type:'setPhraseTiming',phraseId:phrase.id,startMs:23000,endMs:25000}),{code:'MANUAL_PROTECTED'});
  assert.doesNotThrow(()=>variant.operate(guarded,{type:'setPhraseTiming',phraseId:phrase.id,startMs:23000,endMs:25000},true));
  assert.throws(()=>variant.operate(draft,[{type:'setPhraseTiming',phraseId:phrase.id,startMs:23000,endMs:25000},{type:'setPhraseTiming',phraseId:'missing',startMs:1,endMs:2}]),{code:'UNKNOWN_ID'});
  assert.equal(JSON.stringify(draft),original);
});


test('phrase group shifts preserve every child interval, lock, exclusion and lane atomically',()=>{
  let base=make('[00:01.00]hello world\n[00:05.00]second phrase\n[00:09.00]third phrase');
  const w=base.phrases[0].words[0];base=core.applyOperation(base,{type:'setWordSyllables',wordId:w.id,syllables:[{id:'held-syllable',text:w.text,startMs:w.startMs+10,endMs:w.endMs-10}]},base.revision);
  base=core.applyOperation(base,{type:'setWordExcluded',wordId:base.phrases[1].words[0].id,excluded:true},base.revision);
  const draft=variant.merge(base,base),before=JSON.stringify(draft),ids=base.phrases.slice(0,2).map(p=>p.id);
  assert.throws(()=>variant.operate(draft,{type:'shiftPhrases',phraseIds:ids,deltaMs:275}),{code:'MANUAL_PROTECTED'});
  const shifted=variant.operate(draft,{type:'shiftPhrases',phraseIds:ids,deltaMs:275},true);
  for(let i=0;i<2;i++){const expected=structuredClone(base.phrases[i]);for(const item of [expected,...expected.words.flatMap(w=>[w,...(w.syllables||[])])]){item.startMs+=275;item.endMs+=275;}assert.deepEqual(shifted.score.phrases[i],expected);}
  assert.deepEqual(shifted.score.phrases[2],base.phrases[2]);assert.equal(JSON.stringify(draft),before);
  for(const op of [{phraseIds:ids,deltaMs:-1001},{phraseIds:[ids[0],'missing'],deltaMs:10},{phraseIds:[ids[0],ids[0]],deltaMs:10},{phraseIds:ids,deltaMs:.5}])assert.throws(()=>variant.operate(draft,{type:'shiftPhrases',...op},true));
  assert.equal(JSON.stringify(draft),before);
});

test('copying a saved synchronization rebinds only the destination, offset and explicit provenance',()=>{
  const base=make('[00:01.00]old target lyrics','b'),draft=variant.merge(base,base);
  let saved=core.createScore({videoId:'FIXTURE0003',durationMs:90000},'[00:03.00]hello world',{contentHash:'c'.repeat(64)});
  saved=core.applyOperation(saved,{type:'setWordSyllables',wordId:saved.phrases[0].words[0].id,syllables:[{id:'copy-child',text:'hello',startMs:3000,endMs:3200}]},saved.revision);
  saved=core.applyOperation(saved,{type:'setOffset',offsetMs:500},saved.revision);
  saved.beatCues=[{id:'beat-1',beat:2,durationBeats:1,effect:'pulse',strength:.5,provenance:'manual',target:{kind:'screen'}}];
  const original=JSON.stringify(saved),copied=variant.copyToRecording(draft,saved,-1200);
  assert.deepEqual(copied.score.source,base.source);assert.deepEqual(copied.score.phrases,saved.phrases);assert.equal(copied.score.offsetMs,-700);assert.equal(copied.score.beatCues,undefined);
  assert.deepEqual(copied.score.lyrics.timingCopy,{mediaKey:'youtube:FIXTURE0003',title:saved.source.title,revision:saved.revision,lyricsHash:saved.lyrics.contentHash});
  assert.equal(copied.score.lyrics.contentHash,saved.lyrics.contentHash);assert.equal(JSON.stringify(saved),original);
  assert.throws(()=>variant.copyToRecording(draft,base,0),{code:'SOURCE_MISMATCH'});assert.throws(()=>variant.copyToRecording(draft,saved,.5),{code:'INVALID_TIME'});
  assert.throws(()=>variant.operate(copied,{type:'setOffset',offsetMs:2000}),{code:'MANUAL_PROTECTED'});
  const offset=variant.operate(copied,{type:'setOffset',offsetMs:2000},true);assert.deepEqual(offset.score.phrases,saved.phrases);assert.equal(offset.score.offsetMs,2000);
});
