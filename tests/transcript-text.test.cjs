const test = require('node:test');
const assert = require('node:assert/strict');
const transcript = require('../extension/transcript-text.js');
const core = require('../extension/score-core.js');

function fixture() {
  const word = (id, text, startMs, endMs, extra = {}) => ({ id, text, startMs, endMs, provenance: 'manual', locked: true, effects: [], ...extra });
  return {
    lanes: [{ id: 'lead', label: 'Lead', role: 'lead' }, { id: 'backing', label: 'Backing', role: 'backing' }],
    phrases: [
      { id: 'p1', laneId: 'lead', startMs: 0, endMs: 2000, words: [word('a', "It's", 0, 300), word('b', 'an', 300, 500), word('c', 'ice-', 500, 900), word('d', 'breaker', 900, 1500)] },
      { id: 'p2', laneId: 'backing', startMs: 2000, endMs: 3000, words: [word('e', 'out', 2000, 2500), word('f', 'hidden', 2500, 2600, { excluded: true })] },
    ],
  };
}

test('toText writes one line per phrase with lane markers for non-lead lanes and hides excluded words', () => {
  assert.equal(transcript.toText(fixture()), "It's an ice- breaker\n[backing] out");
});

test('unchanged text produces no operations', () => {
  const score = fixture();
  assert.deepEqual(transcript.diff(score, transcript.toText(score) + '\n\n'), { operations: [], changes: [] });
});

test('one-for-one word edits respell in place; word-count changes replace; deletions hide', () => {
  const score = fixture();
  const result = transcript.diff(score, "It is an ice-breaker\n[backing] out");
  assert.deepEqual(result.operations, [
    { type: 'replaceWords', phraseId: 'p1', wordIds: ['a'], text: 'It is' },
    { type: 'replaceWords', phraseId: 'p1', wordIds: ['c', 'd'], text: 'ice-breaker' },
  ]);
  const respell = transcript.diff(score, "It's an ice- breakr\n[backing] out");
  assert.deepEqual(respell.operations, [{ type: 'setWordText', wordId: 'd', text: 'breakr' }]);
  assert.equal(respell.changes[0].kind, 'respell');
  const hide = transcript.diff(score, "It's ice- breaker\n[backing] out");
  assert.deepEqual(hide.operations, [{ type: 'setWordExcluded', wordId: 'b', excluded: true }]);
});

test('pure insertions merge into the previous unchanged word, or the next at line start', () => {
  const score = fixture();
  const result = transcript.diff(score, "Oh It's an ice- breaker baby\n[backing] out");
  assert.deepEqual(result.operations, [
    { type: 'replaceWords', phraseId: 'p1', wordIds: ['a'], text: "Oh It's" },
    { type: 'replaceWords', phraseId: 'p1', wordIds: ['d'], text: 'breaker baby' },
  ]);
  assert.deepEqual(result.changes.map(c => c.kind), ['insert', 'insert']);
});

test('insertions on both sides of one word combine into a single replacement', () => {
  const score = { ...fixture(), phrases: [{ ...fixture().phrases[0], words: [fixture().phrases[0].words[0]] }, fixture().phrases[1]] };
  const result = transcript.diff(score, "Oh It's yeah\n[backing] out");
  assert.deepEqual(result.operations, [{ type: 'replaceWords', phraseId: 'p1', wordIds: ['a'], text: "Oh It's yeah" }]);
});

test('lane markers move phrases between lanes; unknown brackets stay lyric text', () => {
  const score = fixture();
  const moved = transcript.diff(score, "It's an ice- breaker\nout");
  assert.deepEqual(moved.operations, [{ type: 'setPhraseLane', phraseId: 'p2', laneId: 'lead' }]);
  const bracket = transcript.diff(score, "[Chorus] It's an ice- breaker\n[backing] out");
  assert.deepEqual(bracket.operations, [{ type: 'replaceWords', phraseId: 'p1', wordIds: ['a'], text: "[Chorus] It's" }]);
});

test('added lines become estimated phrases in the gap; removed lines hide their words', () => {
  const score = fixture();
  const added = transcript.diff(score, "It's an ice- breaker\nnew line here\n[backing] out");
  assert.deepEqual(added.operations, [{ type: 'insertPhrase', afterPhraseId: 'p1', laneId: 'lead', text: 'new line here', startMs: 2000, endMs: 3500 }]);
  const removed = transcript.diff(score, '[backing] out');
  assert.deepEqual(removed.operations.map(o => [o.type, o.wordId]), [['setWordExcluded', 'a'], ['setWordExcluded', 'b'], ['setWordExcluded', 'c'], ['setWordExcluded', 'd']]);
  assert.equal(removed.changes[0].kind, 'delete-line');
});

test('pasting a transcript with extra and missing lines applies through score-core and round-trips', () => {
  let score = core.createScore({ platform: 'youtube', videoId: 'proof123456', title: 'T', artist: 'A', durationMs: 20000 }, '[00:01.00]tokens on the desk\n[00:05.00]we check each token\n[00:09.00]extra verse words\n[00:14.00]last line\n[00:18.00]', { provider: 'proof', entryId: 'p', contentHash: 'c'.repeat(64) });
  const pasted = 'tokens on the desk\nwe check each token fast\nbrand new line\nlast line';
  const { operations, changes } = transcript.diff(score, pasted);
  for (const op of operations) score = core.applyOperation(score, op, score.revision);
  assert.equal(transcript.toText(score), pasted);
  assert.deepEqual(changes.map(c => c.kind).sort(), ['insert', 'respell', 'respell', 'respell']);
  assert.deepEqual(transcript.diff(score, pasted).operations, []);
});

test('diff operations apply cleanly through score-core in emitted order', () => {
  const score = core.createScore({ platform: 'youtube', videoId: 'proof123456', title: 'T', artist: 'A', durationMs: 10000 }, '[00:01.00]one two three\n[00:04.00]four five\n[00:08.00]', { provider: 'proof', entryId: 'p', contentHash: 'a'.repeat(64) });
  const { operations } = transcript.diff(score, 'won two three more\nfive');
  let next = score;
  for (const op of operations) next = core.applyOperation(next, op, next.revision);
  assert.equal(transcript.toText(next), 'won two three more\nfive');
});

test('preview accepts a respell with carried-over syllable timings and a replacement in one batch', () => {
  const variant = require('../extension/timing-variant.js');
  let score = core.createScore({ platform: 'youtube', videoId: 'proof123456', title: 'T', artist: 'A', durationMs: 10000 }, '[00:01.00]stayin awake today\n[00:05.00]', { provider: 'proof', entryId: 'p', contentHash: 'b'.repeat(64) });
  const w = score.phrases[0].words[0];
  score = core.applyOperation(score, { type: 'setWordSyllables', wordId: w.id, syllables: [{ id: 's1', text: 'stay', startMs: w.startMs, endMs: w.startMs + 100 }, { id: 's2', text: 'in', startMs: w.startMs + 100, endMs: w.endMs }] }, score.revision);
  const draft = { score, protectedIds: [w.id] };
  const { operations } = transcript.diff(score, "stayin' awake all night");
  assert.deepEqual(operations.map(o => o.type), ['setWordText', 'replaceWords']);
  const carried = { type: 'setWordSyllables', wordId: w.id, spokenText: 'staying', syllables: [{ id: 's1', text: 'stay', startMs: w.startMs, endMs: w.startMs + 100, provenance: 'manual', locked: true, effects: [] }, { id: 's2', text: 'ing', startMs: w.startMs + 100, endMs: w.endMs, provenance: 'manual', locked: true, effects: [] }] };
  assert.throws(() => variant.operate(draft, [...operations, carried]), /MANUAL_PROTECTED|Enable editing/);
  const next = variant.operate(draft, [...operations, carried], true).score;
  const word = next.phrases[0].words[0];
  assert.equal(word.text, "stayin'"); assert.equal(word.spokenText, 'staying');
  assert.deepEqual(word.syllables.map(s => [s.id, s.text, s.startMs]), [['s1', 'stay', w.startMs], ['s2', 'ing', w.startMs + 100]]);
  assert.equal(transcript.toText(next), "stayin' awake all night");
});

test('a pasted transcript that drops a line and adds a new one in different places', () => {
  let score = core.createScore({ platform: 'youtube', videoId: 'proof123456', title: 'T', artist: 'A', durationMs: 30000 }, '[00:01.00]one two three\n[00:05.00]four five six\n[00:09.00]seven eight nine\n[00:14.00]ten eleven twelve\n[00:20.00]', { provider: 'proof', entryId: 'p', contentHash: 'd'.repeat(64) });
  const pasted = 'one two three\nseven eight nine\nten eleven twelve\nthirteen fourteen';
  const { operations, changes } = transcript.diff(score, pasted);
  assert.deepEqual(changes.map(c => c.kind), ['delete-line', 'add-line']);
  for (const op of operations) score = core.applyOperation(score, op, score.revision);
  assert.equal(transcript.toText(score), pasted);
  const added = score.phrases.at(-1);
  assert.equal(added.words.map(w => w.text).join(' '), 'thirteen fourteen');
  assert.ok(added.startMs >= score.phrases.at(-2).endMs);
});

test('presence holds a short syllable for a minimum time, then fades over the afterglow', () => {
  // "ter," in Sample Track phrase 1: 1412-1637ms, next word at 1881ms.
  const ter = { startMs: 1412, endMs: 1637 };
  assert.equal(core.presenceAt(ter, 1400), 0);
  assert.equal(core.presenceAt(ter, 1500), 1);
  assert.equal(core.presenceAt(ter, 1636), 1);
  const gap = core.presenceAt(ter, 1800);
  assert.ok(gap > 0.3 && gap < 1, `still visible in the gap: ${gap}`);
  assert.equal(core.presenceAt(ter, 1637 + 450), 0);
  // A 40ms tap is held for the minimum visible time.
  assert.equal(core.presenceAt({ startMs: 508, endMs: 549 }, 680), 1);
  assert.equal(core.presenceAt(ter, 1700, { afterglowMs: 0 }), 0);
});

test('whole-word marker changes only display and survives add/remove, replacement and literal escaping',()=>{
 const s=core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01.00]Oh now\n[00:05.00]',{provider:'fixture',entryId:'a',contentHash:'a'.repeat(64)});
 const w=s.phrases[0].words[0],before=JSON.stringify(w),d=transcript.diff(s,'=Oh now');assert.deepEqual(d.operations,[{type:'setWordDisplayMode',wordId:w.id,mode:'whole'}]);
 let next=s;for(const op of d.operations)next=core.applyOperation(next,op,next.revision);
 assert.equal(next.phrases[0].words[0].text,'Oh');assert.equal(next.phrases[0].words[0].displayMode,'whole');assert.equal(transcript.toText(next),'=Oh now');
 assert.equal(transcript.diff(next,transcript.toText(next)).operations.length,0);
 next=core.applyOperation(next,transcript.diff(next,'Oh now').operations[0],next.revision);assert.equal(JSON.stringify(next.phrases[0].words[0]),before);
 const replace=transcript.diff(s,'=Oh =yes now');next=s;for(const op of replace.operations)next=core.applyOperation(next,op,next.revision);assert.equal(transcript.toText(next),'=Oh =yes now');assert.equal(next.phrases[0].words[0].text,'Oh');
 next=core.applyOperation(s,{type:'replaceWords',phraseId:s.phrases[0].id,wordIds:[w.id],text:'==equals'},s.revision);assert.equal(next.phrases[0].words[0].text,'=equals');assert.equal(transcript.toText(next),'==equals now');
});

const applyText = (score, text) => transcript.diff(score, text).operations.reduce((next, op) => core.applyOperation(next, op, next.revision), score);
const backingFixture = () => core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:20000},'[00:01.00]Stay with me\n[00:08.00]Another main phrase\n[00:15.00]',{provider:'fixture',contentHash:'a'.repeat(64)});

test('parentheses default to estimated backing at the main phrase beginning without changing authored main words', () => {
  let score=backingFixture();
  score=core.applyOperation(score,{type:'setWordTiming',wordId:score.phrases[0].words[0].id,startMs:1000,endMs:1400},score.revision);
  const original=structuredClone(score.phrases),text='Stay with me (with me)\nAnother main phrase',next=applyText(score,text);
  assert.deepEqual(next.phrases.filter(p=>p.laneId==='lead'),original);
  const back=next.phrases.find(p=>p.laneId==='backing');
  assert.equal(back.startMs,original[0].startMs);assert.equal(back.endEstimated,true);
  assert.deepEqual(back.words.map(w=>w.text),['with','me']);
  assert.ok(back.words.every(w=>w.provenance==='estimated'&&!w.locked));
  assert.deepEqual(transcript.diff(next,text).operations,[]);
  assert.deepEqual(transcript.diff(next,transcript.toText(next)).operations,[]);
});

test('multiple and nested groups become backing in written order; punctuation and display markers survive',()=>{
  const next=applyText(backingFixture(),'Stay(=oh) with (yeah (yeah)) me!\nAnother main phrase');
  assert.equal(transcript.toText(next),'Stay with me!\n[backing] =oh yeah yeah\nAnother main phrase');
  assert.equal(next.phrases[1].words[0].displayMode,'whole');
});

test('parentheses-only lines follow the preceding main phrase; a standalone first line still works',()=>{
  const score=backingFixture(),text='Stay with me\n(with me)\nAnother main phrase',next=applyText(score,text);
  assert.equal(next.phrases[1].startMs,score.phrases[0].startMs);
  assert.deepEqual(transcript.diff(next,text).operations,[]);
  const solo=applyText({...score,phrases:[]},'(oh yeah)');
  assert.equal(solo.phrases.length,1);assert.equal(solo.phrases[0].laneId,'backing');
});

test('new main lines and their parenthetical backing retain source order and their own beginning anchors',()=>{
  const score=backingFixture(),text='Stay with me\nBrand new line (echo)\nAnother main phrase',next=applyText(score,text);
  assert.equal(transcript.toText(next),'Stay with me\nBrand new line\n[backing] echo\nAnother main phrase');
  const added=next.phrases[1],back=next.phrases[2];assert.equal(back.startMs,added.startMs);
  assert.deepEqual(next.phrases[0],score.phrases[0]);assert.deepEqual(next.phrases[3],score.phrases[1]);
  assert.deepEqual(transcript.diff(next,text).operations,[]);
});

test('existing custom backing lanes and manually corrected backing timing survive shorthand reapplication',()=>{
  const score=backingFixture();score.lanes[1]={id:'harmony',role:'backing',label:'Harmony'};
  const text='Stay with me (echo)\nAnother main phrase';let next=applyText(score,text),back=next.phrases[1];
  assert.equal(back.laneId,'harmony');
  next=core.applyOperation(next,{type:'setPhraseTiming',phraseId:back.id,startMs:2000,endMs:2500},next.revision);
  assert.deepEqual(transcript.diff(next,text).operations,[]);
  next=applyText(next,'Stay with me\n[harmony] (echo)\nAnother main phrase');
  assert.equal(next.phrases[1].startMs,2000);assert.equal(next.phrases.length,3);
});

test('unfinished parentheses remain literal and empty parentheses do not create empty phrases',()=>{
  const score=backingFixture(),next=applyText(score,'Stay with me (unfinished\nAnother main phrase');
  assert.equal(transcript.toText(next),'Stay with me (unfinished\nAnother main phrase');
  assert.deepEqual(transcript.diff(score,'Stay with me ()\nAnother main phrase').operations,[]);
});

test('near-end backing starts at the last main word; existing backing timing is retained',()=>{
 const score=backingFixture(),text='Stay with me (with me)\nAnother main phrase';
 const result=transcript.diff(score,text,{backingStart:'near-end'});
 const next=result.operations.reduce((s,op)=>core.applyOperation(s,op,s.revision),score);
 assert.equal(next.phrases.find(p=>p.laneId==='backing').startMs,score.phrases[0].words.at(-1).startMs);
 assert.deepEqual(transcript.diff(next,text,{backingStart:'beginning'}).operations,[]);
 assert.throws(()=>transcript.diff(score,text,{backingStart:'guess'}),/beginning or near-end/);
});
