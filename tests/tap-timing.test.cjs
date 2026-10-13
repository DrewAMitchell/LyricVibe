const test = require('node:test');
const assert = require('node:assert/strict');
const tap = require('../extension/tap-timing.js');

test('performance events preserve exact raw taps until later count association', () => {
  const units = [
    { id:'a', wordId:'a', phraseId:'p', text:'known', minMs:100, maxMs:500, expectedCount:1 },
    { id:'b', wordId:'b', phraseId:'p', text:'unknown', minMs:100, maxMs:500, expectedCount:null },
  ];
  let take = tap.beginEvents(units);
  take = tap.markEvent(take, 137); take = tap.markEvent(take, 281);
  assert.deepEqual(take.events.map(e=>e.sourceMs), [137,281]);
  assert.deepEqual(take.marks, []); assert.equal(take.index,0);
  const reviewed = tap.associateEvents(take);
  assert.equal(reviewed.ready,false);
  assert.deepEqual(take.events.map(e=>e.sourceMs), [137,281]);
  const edited = tap.associateEvents(take, { counts:{a:1,b:1} });
  assert.equal(edited.ready,true);
  assert.deepEqual(edited.phrases[0].marks.map(m=>[m.wordId,m.startMs,m.endMs]), [['a',137,281],['b',281,500]]);
  assert.equal(edited.phrases[0].counts[1].source,'human');
});

test('performance events consider dictionary alternatives and leave extra or ambiguous taps for review', () => {
  let take = tap.beginEvents([
    { id:'a',wordId:'a',phraseId:'p',text:'a',minMs:100,maxMs:500,expectedCount:1,countOptions:[2] },
  ]);
  take = tap.markEvent(take,120); take=tap.markEvent(take,210);
  let report=tap.associateEvents(take);
  assert.equal(report.ready,true); assert.equal(report.phrases[0].counts[0].count,2);
  take=tap.markEvent(take,510);
  report=tap.associateEvents(take);
  assert.equal(report.ready,false); assert.deepEqual(report.unassigned.map(e=>e.sourceMs),[510]);
  assert.equal(report.phrases[0].marks.length,2);
  assert.equal(report.phrases[0].ready,true);
});

test('performance event undo and stopped phrase rewind retain exact surviving timestamps', () => {
  let take=tap.beginEvents([
    {id:'a',wordId:'a',phraseId:'p1',text:'a',minMs:100,maxMs:500,expectedCount:1},
    {id:'b',wordId:'b',phraseId:'p2',text:'b',minMs:600,maxMs:900,expectedCount:1},
  ]);
  take=tap.markEvent(take,123); take=tap.markEvent(take,650);
  assert.equal(tap.undoEvent(take).lastMs,123);
  take=tap.stopEvents(take);
  const rewound=tap.rewindEvents(take,'p2');
  assert.deepEqual(rewound.events.map(e=>e.sourceMs),[123]);
  assert.equal(rewound.lastMs,123); assert.equal(rewound.status,'stopped');
  assert.deepEqual(tap.undoEvent(rewound).events.map(e=>e.sourceMs),[123,650]);
});

test('event association uses half-open adjacent phrases and never stretches phrase ends to song stop', () => {
  let take=tap.beginEvents([
    {id:'a',wordId:'a',phraseId:'p1',text:'a',minMs:100,maxMs:500,expectedCount:1},
    {id:'b',wordId:'b',phraseId:'p2',text:'b',minMs:500,maxMs:900,expectedCount:1},
  ]);
  take=tap.markEvent(take,500); take=tap.stopEvents(take); take.stoppedScoreMs=1200;
  const report=tap.associateEvents(take);
  assert.equal(report.phrases[0].eventCount,0);
  assert.deepEqual(report.phrases[1].marks.map(m=>[m.startMs,m.endMs]),[[500,900]]);
  take={...take,stoppedScoreMs:700};
  const partial=tap.associateEvents(take).phrases[1];
  assert.equal(partial.ready,false); assert.deepEqual(partial.marks,[]);
  assert.ok(partial.issues.includes('phrase-incomplete'));
});

test('duplicate timestamps and non-syllable event kinds stay captured and require review', () => {
  let take=tap.beginEvents([{id:'a',wordId:'a',phraseId:'p',text:'a',minMs:100,maxMs:500,expectedCount:2}]);
  take=tap.markEvent(take,120); take=tap.markEvent(take,120);
  const report=tap.associateEvents(take);
  assert.ok(report.phrases[0].issues.includes('duplicate-time'));
  assert.deepEqual(report.phrases[0].marks,[]);
  let tonal=tap.beginEvents([{id:'a',wordId:'a',phraseId:'p',text:'a',minMs:100,maxMs:500,expectedCount:1}],{kind:'tonal-shift'});
  tonal=tap.markEvent(tonal,120);
  const tonalReport=tap.associateEvents(tonal);
  assert.equal(tonalReport.phrases[0].eventCount,0);
  assert.deepEqual(tonalReport.unassigned.map(e=>e.sourceMs),[120]);
});

test('a word end is provisional unless a manual boundary lies inside its release window', () => {
  let take=tap.beginEvents([
    {id:'a',wordId:'a',phraseId:'p',text:'stayin',minMs:100,maxMs:2000,expectedCount:2,referenceStartMs:90,referenceEndMs:700,referenceManual:true},
    {id:'b',wordId:'b',phraseId:'p',text:'alive',minMs:100,maxMs:2000,expectedCount:2,referenceStartMs:700,referenceEndMs:1500,referenceManual:false},
  ]);
  for(const ms of [120,400,800,1000]) take=tap.markEvent(take,ms);
  const marks=tap.associateEvents(take).phrases[0].marks;
  // Internal syllables end at the next entrance; word onsets are first entrances.
  assert.deepEqual(marks.map(m=>[m.wordId,m.startMs,m.endMs,m.endSource]),[
    ['a',120,400,'next-entrance'],['a',400,700,'manual-word-boundary'],
    ['b',800,1000,'next-entrance'],['b',1000,2000,'provisional-phrase-end']]);
  // A manual end outside (last onset, next onset] is ignored rather than trusted.
  take={...take,units:take.units.map(u=>u.id==='a'?{...u,referenceEndMs:900}:u)};
  assert.equal(tap.associateEvents(take).phrases[0].marks[1].endSource,'provisional-next-entrance');
});

test('long gaps between entrances are flagged at and inside word boundaries without blocking', () => {
  let take=tap.beginEvents([
    {id:'a',wordId:'a',phraseId:'p',text:'a',minMs:0,maxMs:5000,expectedCount:2},
    {id:'b',wordId:'b',phraseId:'p',text:'b',minMs:0,maxMs:5000,expectedCount:2},
  ]);
  // Held first syllable of "a" (inside-word gap), then even spacing.
  for(const ms of [100,1400,1650,1900]) take=tap.markEvent(take,ms);
  const p=tap.associateEvents(take).phrases[0];
  assert.equal(p.ready,true);
  assert.ok(p.issues.includes('long-gap-boundary'));
  assert.deepEqual(p.gaps.map(g=>[g.afterEventId,g.beforeEventId,g.gapMs,g.atWordBoundary]),[['event-1','event-2',1300,false]]);
  let boundary=tap.beginEvents(take.units);
  for(const ms of [100,350,1700,1950]) boundary=tap.markEvent(boundary,ms);
  const q=tap.associateEvents(boundary).phrases[0];
  assert.deepEqual(q.gaps.map(g=>[g.previousWordId,g.nextWordId,g.atWordBoundary]),[['a','b',true]]);
  // Even spacing produces no gap flags.
  let even=tap.beginEvents(take.units);
  for(const ms of [100,350,600,850]) even=tap.markEvent(even,ms);
  assert.deepEqual(tap.associateEvents(even).phrases[0].gaps,[]);
  assert.throws(()=>tap.associateEvents(even,{gapRatio:1}),/INVALID_GAP|Gap ratio/);
});

test('partial human counts merge with lexical defaults to resolve an exact total', () => {
  let take=tap.beginEvents([
    {id:'a',wordId:'a',phraseId:'p',text:'a',minMs:100,maxMs:500,expectedCount:1},
    {id:'b',wordId:'b',phraseId:'p',text:'b',minMs:100,maxMs:500,expectedCount:1},
  ]);
  take=tap.markEvent(take,120); take=tap.markEvent(take,210); take=tap.markEvent(take,330);
  const report=tap.associateEvents(take,{counts:{a:2}});
  assert.equal(report.phrases[0].ready,true);
  assert.deepEqual(report.phrases[0].counts.map(c=>[c.count,c.source]),[[2,'human'],[1,'dictionary']]);
});
const scoreCore = require('../extension/score-core.js');
const timingVariant = require('../extension/timing-variant.js');

const units = (count = 3, minMs = 0, maxMs = 10000) => Array.from({ length: count }, (_, i) => ({
  id: `u${i}`, wordId: `w${i}`, ...(i === 1 ? { syllableId: 's1' } : {}), text: `unit${i}`, minMs, maxMs
}));

test('rapid consecutive boundaries are stored as sequential source-time marks', () => {
  let take = tap.begin(units(2));
  take = tap.mark(take, 100);
  take = tap.mark(take, 150);
  take = tap.mark(take, 150);
  take = tap.mark(take, 151);
  assert.equal(take.status, 'complete');
  assert.equal(take.index, 2);
  assert.deepEqual(take.marks, [
    { id: 'u0', wordId: 'w0', startMs: 100, endMs: 150 },
    { id: 'u1', wordId: 'w1', syllableId: 's1', startMs: 150, endMs: 151 }
  ]);
});

test('held key repeat is ignored and does not advance a syllable take', () => {
  let take = tap.begin(units(2), { mode: 'syllable' });
  const first = tap.mark(take, 50);
  assert.equal(tap.mark(first, 99, { repeat: true }), first);
  assert.equal(first.index, 0);
  assert.equal(tap.mark(first, 99, { repeat: true }).pendingStartMs, 50);
  take = tap.mark(first, 100);
  assert.equal(take.index, 1);
  assert.equal(take.marks[0].syllableId, undefined);
});

test('undo clears an in-progress start first, then removes the last completed unit', () => {
  let take = tap.begin(units(2));
  take = tap.mark(take, 10); take = tap.mark(take, 20); take = tap.mark(take, 30);
  assert.equal(take.marks.length, 1);
  take = tap.undo(take);
  assert.equal(take.marks.length, 1);
  assert.equal(take.pendingStartMs, null);
  take = tap.undo(take);
  assert.equal(take.marks.length, 0);
  assert.equal(take.index, 0);
  assert.equal(take.status, 'armed');
});

test('bounds, interval order, and overlap failures are typed and preserve prior takes', () => {
  let take = tap.begin(units(2, 100, 500));
  const snapshot = JSON.stringify(take);
  assert.throws(() => tap.mark(take, 99), { code: 'OUT_OF_BOUNDS' });
  assert.equal(JSON.stringify(take), snapshot);
  take = tap.mark(take, 200);
  assert.throws(() => tap.mark(take, 200), { code: 'INVALID_INTERVAL' });
  take = tap.mark(take, 300);
  const before = take;
  assert.throws(() => tap.mark(take, 299), { code: 'OVERLAP' });
  assert.equal(take, before);
});

test('explicit BPM snaps boundaries to quarter beats relative to the first raw start', () => {
  let take = tap.begin(units(2, 0, 10000), { bpm: 120 });
  take = tap.mark(take, 101); // Origin stays exactly at the first raw start.
  take = tap.mark(take, 231); // 130ms rounds to the nearest 125ms subdivision.
  take = tap.mark(take, 260); // Next start snaps to the preceding end, allowing back-to-back units.
  take = tap.mark(take, 401);
  assert.equal(take.originMs, 101);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[101, 226], [226, 351]]);
});

test('BPM snapping can be disabled and source inputs are never mutated', () => {
  const input = units(1, 0, 1000), original = JSON.stringify(input);
  let take = tap.begin(input);
  take = tap.mark(take, 101);
  take = tap.mark(take, 204);
  assert.equal(take.marks[0].startMs, 101);
  assert.equal(take.marks[0].endMs, 204);
  assert.equal(JSON.stringify(input), original);
  assert.equal(tap.begin(units(1), { bpm: null }).bpm, null);
});

test('stop retains completed marks and discards the unfinished tap', () => {
  let take = tap.begin(units(2));
  take = tap.mark(take, 100); take = tap.mark(take, 200); take = tap.mark(take, 250);
  const stopped = tap.stop(take);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pendingStartMs, null);
  assert.equal(stopped.marks.length, 1);
  assert.equal(tap.mark(stopped, 300, { repeat: true }), stopped);
  assert.throws(() => tap.mark(stopped, 300), { code: 'TAKE_CLOSED' });
});

test('begin rejects empty, malformed, and duplicate unit IDs', () => {
  assert.throws(() => tap.begin([]), { code: 'INVALID_UNITS' });
  assert.throws(() => tap.begin([{ ...units(1)[0] }, { ...units(1)[0] }]), { code: 'INVALID_UNITS' });
  assert.throws(() => tap.begin(units(1), { bpm: 401 }), { code: 'INVALID_BPM' });
});

test('flow cadence closes and opens consecutive units on each boundary tap', () => {
  let take = tap.begin(units(3), { cadence: 'flow' });
  take = tap.mark(take, 100);
  assert.equal(take.index, 0);
  assert.equal(take.pendingStartMs, 100);
  take = tap.mark(take, 200);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 200);
  assert.deepEqual(take.marks, [{ id: 'u0', wordId: 'w0', startMs: 100, endMs: 200 }]);
  take = tap.mark(take, 300);
  assert.equal(take.index, 2);
  assert.equal(take.pendingStartMs, 300);
  take = tap.mark(take, 400);
  assert.equal(take.status, 'complete');
  assert.equal(take.pendingStartMs, null);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 200], [200, 300], [300, 400]]);
});

test('release closes a unit and leaves a silent gap before the next unit starts', () => {
  let take = tap.begin(units(3), { cadence: 'flow' });
  take = tap.mark(take, 100);
  take = tap.release(take, 200);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, null);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 200]]);
  take = tap.mark(take, 500);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 500);
  take = tap.mark(take, 600);
  assert.equal(take.pendingStartMs, 600);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 200], [500, 600]]);
});

test('flow undo reverses one combined boundary action and one release action', () => {
  let take = tap.begin(units(3), { cadence: 'flow' });
  take = tap.mark(take, 100);
  take = tap.mark(take, 200);
  take = tap.mark(take, 300);
  take = tap.undo(take);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 200);
  assert.deepEqual(take.marks.map(({ id }) => id), ['u0']);
  take = tap.release(take, 250);
  take = tap.undo(take);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 200);
  assert.deepEqual(take.marks.map(({ id }) => id), ['u0']);
});

test('flow boundary checks both adjacent unit bounds atomically', () => {
  const constrained = units(2);
  constrained[1] = { ...constrained[1], minMs: 250, maxMs: 500 };
  let take = tap.begin(constrained, { cadence: 'flow' });
  take = tap.mark(take, 100);
  const before = JSON.stringify(take);
  assert.throws(() => tap.mark(take, 200), { code: 'OUT_OF_BOUNDS' });
  assert.equal(JSON.stringify(take), before);
  take = tap.mark(take, 250);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 250);
});

test('flow cadence keeps BPM snapping and ignores repeated key events', () => {
  let take = tap.begin(units(2), { cadence: 'flow', bpm: 120 });
  take = tap.mark(take, 101);
  assert.equal(tap.mark(take, 230, { repeat: true }), take);
  take = tap.mark(take, 231);
  assert.equal(take.pendingStartMs, 226);
  take = tap.mark(take, 401);
  assert.equal(take.status, 'complete');
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[101, 226], [226, 351]]);
});

const syllableUnits = (count, minMs = 100, maxMs = 500) => Array.from({ length: count }, (_, i) => ({
  id: `s${i}`, wordId: 'w0', syllableId: `sy${i}`, text: `part${i}`, minMs, maxMs
}));

test('subdivide cadence uses one internal tap for two syllables and closes at the parent end', () => {
  let take = tap.begin(syllableUnits(2), { mode: 'syllable', cadence: 'subdivide' });
  assert.equal(take.pendingStartMs, 100);
  take = tap.mark(take, 300);
  assert.equal(take.status, 'complete');
  assert.equal(take.index, 2);
  assert.equal(take.pendingStartMs, null);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 300], [300, 500]]);
});

test('subdivide cadence uses n minus one internal taps for three positive syllable intervals', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'subdivide' });
  take = tap.mark(take, 220);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 220);
  take = tap.mark(take, 350);
  assert.equal(take.status, 'complete');
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 220], [220, 350], [350, 500]]);
  assert.ok(take.marks.every(mark => mark.endMs > mark.startMs));
});

test('subdivide requires syllable mode and a shared positive parent interval', () => {
  assert.throws(() => tap.begin(syllableUnits(2), { cadence: 'subdivide' }), { code: 'INVALID_CADENCE' });
  const differentBounds = syllableUnits(2);
  differentBounds[1] = { ...differentBounds[1], maxMs: 600 };
  assert.throws(() => tap.begin(differentBounds, { mode: 'syllable', cadence: 'subdivide' }), { code: 'INVALID_UNITS' });
  assert.throws(() => tap.begin(syllableUnits(2, 100, 100), { mode: 'syllable', cadence: 'subdivide' }), { code: 'INVALID_UNITS' });
});

test('subdivide undo restores the prior split state and repeated key events do not split', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'subdivide' });
  take = tap.mark(take, 220);
  const beforeRepeat = take;
  assert.equal(tap.mark(take, 300, { repeat: true }), beforeRepeat);
  take = tap.mark(take, 350);
  assert.equal(take.status, 'complete');
  take = tap.undo(take);
  assert.equal(take.index, 1);
  assert.equal(take.pendingStartMs, 220);
  assert.deepEqual(take.marks.map(({ id }) => id), ['s0']);
});

test('one-unit subdivide is complete without a tap, and stop drops only an unfinished child', () => {
  const single = tap.begin(syllableUnits(1), { mode: 'syllable', cadence: 'subdivide' });
  assert.equal(single.status, 'complete');
  assert.deepEqual(single.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 500]]);

  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'subdivide' });
  take = tap.mark(take, 220);
  const stopped = tap.stop(take);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pendingStartMs, null);
  assert.deepEqual(stopped.marks.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [['s0', 100, 220]]);
});

test('subdivide BPM snaps an internal tap while preserving the parent endpoints', () => {
  let take = tap.begin(syllableUnits(2), { mode: 'syllable', cadence: 'subdivide', bpm: 120 });
  take = tap.mark(take, 220);
  assert.equal(take.status, 'complete');
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 225], [225, 500]]);
});

test('phrase mode supports pair and flow capture', () => {
  let take = tap.begin(units(2), { mode: 'phrase' });
  take = tap.mark(take, 100); take = tap.mark(take, 200);
  assert.equal(take.marks[0].id, 'u0');
  take = tap.begin(units(2), { mode: 'phrase', cadence: 'flow' });
  take = tap.mark(take, 100); take = tap.mark(take, 200); take = tap.mark(take, 300);
  assert.equal(take.status, 'complete');
  assert.throws(() => tap.begin(units(2), { mode: 'phrase', cadence: 'subdivide' }), { code: 'INVALID_CADENCE' });
});

test('adjust shifts stopped and complete marks immutably and clears stale undo history', () => {
  let take = tap.begin(units(2), { cadence: 'flow' });
  take = tap.mark(take, 100); take = tap.mark(take, 200); take = tap.mark(take, 300);
  const changed = tap.adjust(take, { id: 'u1', edge: 'move', deltaMs: 20 });
  assert.deepEqual(changed.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 200], [220, 320]]);
  assert.equal(take.marks[1].startMs, 200);
  assert.deepEqual(changed.actionHistory, []);
  assert.equal(tap.undo(changed).marks.length, 1);
  assert.throws(() => tap.adjust(tap.begin(units(1)), { id: 'u0', edge: 'move', deltaMs: 1 }), { code: 'TAKE_OPEN' });
  assert.throws(() => tap.adjust(changed, { id: 'u0', edge: 'move', deltaMs: 200 }), { code: 'OVERLAP' });
  assert.throws(() => tap.adjust(changed, { id: 'u1', edge: 'end', deltaMs: 1.5 }), { code: 'INVALID_ADJUSTMENT' });
});

test('subdivide adjustment moves internal shared boundaries on both children', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'subdivide' });
  take = tap.mark(take, 220); take = tap.mark(take, 350);
  const changed = tap.adjust(take, { id: 's1', edge: 'start', deltaMs: 10 });
  assert.deepEqual(changed.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 230], [230, 350], [350, 500]]);
  assert.throws(() => tap.adjust(take, { id: 's1', edge: 'move', deltaMs: 10 }), { code: 'ADJUST_UNSUPPORTED' });
  assert.throws(() => tap.adjust(take, { id: 's0', edge: 'start', deltaMs: 10 }), { code: 'OUT_OF_BOUNDS' });
  assert.throws(() => tap.adjust(take, { id: 's2', edge: 'end', deltaMs: -10 }), { code: 'OUT_OF_BOUNDS' });
});

test('undo after skipped units returns the removed mark unit position', () => {
  let take = tap.begin(units(4));
  take = tap.reposition(take, 2);
  take = tap.mark(take, 100);
  take = tap.mark(take, 200);
  take = tap.undo(take);
  assert.equal(take.index, 2);
  assert.deepEqual(take.marks, []);
});

test('reposition rewinds immutably, pruning the target and later marks and pending start', () => {
  let take = tap.begin(units(4));
  take = tap.mark(take, 100); take = tap.mark(take, 200);
  take = tap.mark(take, 300); take = tap.mark(take, 400);
  take = tap.mark(take, 500); // pending unit 2
  const before = JSON.stringify(take);
  const rewound = tap.reposition(take, 1);
  assert.equal(JSON.stringify(take), before);
  assert.equal(rewound.index, 1);
  assert.equal(rewound.pendingStartMs, null);
  assert.deepEqual(rewound.marks.map(({ id }) => id), ['u0']);
  assert.equal(rewound.lastMs, 200);
  assert.equal(rewound.originMs, 100);
  assert.equal(rewound.status, 'armed');
  assert.deepEqual(rewound.actionHistory, []);
});

test('reposition drops pending input when advancing and closes complete takes as stopped', () => {
  let take = tap.begin(units(3), { cadence: 'flow' });
  take = tap.mark(take, 100);
  take = tap.reposition(take, 2);
  assert.equal(take.index, 2);
  assert.equal(take.pendingStartMs, null);
  assert.deepEqual(take.marks, []);
  assert.equal(take.status, 'armed');
  assert.equal(take.actionHistory.length, 0);

  let complete = tap.begin(units(1));
  complete = tap.mark(complete, 100); complete = tap.mark(complete, 200);
  const repositioned = tap.reposition(complete, 0);
  assert.equal(repositioned.status, 'stopped');
  assert.equal(repositioned.index, 0);
  assert.equal(repositioned.marks.length, 0);
  assert.equal(repositioned.lastMs, null);
  assert.equal(repositioned.originMs, null);
});

test('reposition rejects invalid indices and syllable modes', () => {
  const take = tap.begin(units(3));
  for (const index of [-1, 3, 1.5, '1']) {
    assert.throws(() => tap.reposition(take, index), { code: 'INVALID_INDEX' });
  }
  const syllables = tap.begin(syllableUnits(2), { mode: 'syllable', cadence: 'subdivide' });
  assert.throws(() => tap.reposition(syllables, 0), { code: 'REPOSITION_UNSUPPORTED' });
});

test('flow recovery clears an open start so a later mark cannot create a false interval', () => {
  let take = tap.begin(units(3), { cadence: 'flow' });
  take = tap.mark(take, 100); // opens unit 0
  take = tap.reposition(take, 1);
  take = tap.mark(take, 500); // starts unit 1, rather than ending unit 0
  take = tap.mark(take, 600);
  assert.deepEqual(take.marks.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [['u1', 500, 600]]);
});

test('entrances cadence acknowledges the fixed phrase start and completes one syllable on one press', () => {
  let take = tap.begin(syllableUnits(2), { mode: 'syllable', cadence: 'entrances' });
  take = tap.mark(take, 150);
  assert.equal(take.index, 1);
  assert.equal(take.entranceCount, 1);
  assert.equal(take.pendingStartMs, 100);
  assert.deepEqual(take.marks, []);
  take = tap.mark(take, 300);
  assert.equal(take.status, 'complete');
  assert.equal(take.index, 2);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 300], [300, 500]]);

  let single = tap.begin(syllableUnits(1), { mode: 'syllable', cadence: 'entrances' });
  single = tap.mark(single, 150);
  assert.equal(single.status, 'complete');
  assert.equal(single.index, 1);
  assert.deepEqual(single.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 500]]);
});

test('entrances cadence advances the cue by press count and auto-closes the final syllable', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'entrances' });
  take = tap.mark(take, 150);
  assert.equal(take.index, 1);
  take = tap.mark(take, 230);
  assert.equal(take.index, 2);
  assert.equal(take.pendingStartMs, 230);
  assert.deepEqual(take.marks.map(({ id }) => id), ['s0']);
  take = tap.mark(take, 370);
  assert.equal(take.index, 3);
  assert.equal(take.status, 'complete');
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 230], [230, 370], [370, 500]]);
});

test('entrances rejects invalid parent bounds and strict-bound taps without mutating the take', () => {
  assert.throws(() => tap.begin(syllableUnits(2), { cadence: 'entrances' }), { code: 'INVALID_CADENCE' });
  const mismatched = syllableUnits(2);
  mismatched[1] = { ...mismatched[1], minMs: 120 };
  assert.throws(() => tap.begin(mismatched, { mode: 'syllable', cadence: 'entrances' }), { code: 'INVALID_UNITS' });
  assert.throws(() => tap.begin(syllableUnits(2, 100, 100), { mode: 'syllable', cadence: 'entrances' }), { code: 'INVALID_UNITS' });

  let take = tap.begin(syllableUnits(2), { mode: 'syllable', cadence: 'entrances' });
  assert.throws(() => tap.mark(take, 99), { code: 'OUT_OF_BOUNDS' });
  take = tap.mark(take, 150);
  const before = JSON.stringify(take);
  assert.throws(() => tap.mark(take, 100), { code: 'OUT_OF_BOUNDS' });
  assert.throws(() => tap.mark(take, 500), { code: 'OUT_OF_BOUNDS' });
  assert.equal(JSON.stringify(take), before);
});

test('entrances repeats are ignored and undo reverses each press including completion', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'entrances' });
  take = tap.mark(take, 150);
  const first = take;
  assert.equal(tap.mark(take, 200, { repeat: true }), first);
  take = tap.mark(take, 230);
  take = tap.mark(take, 370);
  assert.equal(take.status, 'complete');
  take = tap.undo(take);
  assert.equal(take.status, 'armed');
  assert.equal(take.index, 2);
  assert.equal(take.entranceCount, 2);
  assert.equal(take.pendingStartMs, 230);
  assert.deepEqual(take.marks.map(({ id }) => id), ['s0']);

  let single = tap.begin(syllableUnits(1), { mode: 'syllable', cadence: 'entrances' });
  single = tap.mark(single, 150);
  single = tap.undo(single);
  assert.equal(single.status, 'armed');
  assert.equal(single.index, 0);
  assert.equal(single.entranceCount, 0);
  assert.deepEqual(single.marks, []);
});

test('stopping entrances keeps closed syllables and continue starts from the next cue', () => {
  let take = tap.begin(syllableUnits(3), { mode: 'syllable', cadence: 'entrances' });
  take = tap.mark(take, 150);
  take = tap.mark(take, 230);
  const stopped = tap.stop(take);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.index, 1);
  assert.equal(stopped.entranceCount, 1);
  assert.equal(stopped.pendingStartMs, null);
  assert.deepEqual(stopped.marks.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [['s0', 100, 230]]);

  take = { ...stopped, status: 'armed' };
  const beforeContinue = JSON.stringify(take);
  assert.throws(() => tap.mark(take, 200), { code: 'OVERLAP' });
  assert.equal(JSON.stringify(take), beforeContinue);
  take = tap.mark(take, 300); // Continue acknowledges the next syllable at the current source time.
  assert.equal(take.index, 2);
  assert.equal(take.pendingStartMs, 300);
  take = tap.mark(take, 400);
  assert.equal(take.status, 'complete');
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 230], [300, 400], [400, 500]]);
});

test('entrance marks apply atomically to one phrase in a preview and preserve the other phrase', () => {
  const source = { platform: 'youtube', videoId: 'FIXTURE0001', title: 'Song', artist: 'Artist', durationMs: 10000 };
  const lyrics = '[00:01.00]sunshine melody\n[00:04.00]still refrain\n[00:06.00]';
  const candidateLyrics = '[00:02.00]sunshine melody\n[00:05.00]still refrain\n[00:07.00]';
  let saved = scoreCore.createScore(source, lyrics, { provider: 'test', contentHash: 'a'.repeat(64) });
  const phraseId = saved.phrases[0].id;
  const wordParts = { sunshine: ['sun', 'shine'], melody: ['mel', 'o', 'dy'] };
  for (const word of saved.phrases[0].words) {
    const parts = wordParts[word.text];
    assert.ok(parts, `expected multi-syllable fixture word: ${word.text}`);
    const span = word.endMs - word.startMs;
    const syllables = parts.map((text, i) => ({
      id: `sy-${word.id}-${i}`, text,
      startMs: word.startMs + Math.floor(span * i / parts.length),
      endMs: word.startMs + Math.floor(span * (i + 1) / parts.length),
      provenance: 'estimated', locked: false,
    }));
    saved = scoreCore.applyOperation(saved, { type: 'setWordSyllables', wordId: word.id, syllables }, saved.revision);
  }
  const preview = timingVariant.merge(saved,
    scoreCore.createScore(source, candidateLyrics, { provider: 'test', contentHash: 'b'.repeat(64) }));
  const phrase = preview.score.phrases[0], untouchedPhrase = structuredClone(preview.score.phrases[1]);
  const originalWords = phrase.words.map(({ id, text }) => [id, text]);
  const originalSyllableIds = phrase.words.flatMap(word => word.syllables.map(syllable => syllable.id));
  const units = phrase.words.flatMap(word => word.syllables.map(syllable => ({
    id: syllable.id, syllableId: syllable.id, wordId: word.id, text: syllable.text,
    minMs: phrase.startMs, maxMs: phrase.endMs,
  })));
  let take = tap.begin(units, { mode: 'syllable', cadence: 'entrances' });
  const span = phrase.endMs - phrase.startMs;
  take = tap.mark(take, phrase.startMs); // Acknowledge the fixed phrase start.
  for (const fraction of [1, 2, 3, 4]) take = tap.mark(take, phrase.startMs + Math.floor(span * fraction / 5));
  assert.equal(take.status, 'complete');
  assert.equal(take.marks.length, units.length);

  const operation = { type: 'setPhraseSyllableTimings', phraseId, marks: take.marks.map(({ syllableId, startMs, endMs }) => ({ syllableId, startMs, endMs })) };
  const capturedPreview = timingVariant.operate(preview, operation);
  const changed = capturedPreview.score.phrases[0];
  assert.equal(changed.id, phraseId);
  assert.deepEqual(changed.words.map(({ id, text }) => [id, text]), originalWords);
  assert.deepEqual(changed.words.map(word => [word.startMs, word.endMs]), changed.words.map(word => [word.syllables[0].startMs, word.syllables.at(-1).endMs]));
  assert.deepEqual(changed.words.flatMap(word => word.syllables.map(syllable => syllable.id)), originalSyllableIds);
  assert.deepEqual(changed.words.flatMap(word => word.syllables.map(syllable => syllable.text)), ['sun', 'shine', 'mel', 'o', 'dy']);
  assert.deepEqual([changed.startMs, changed.endMs], [phrase.startMs, phrase.endMs]);
  assert.deepEqual(capturedPreview.score.phrases[1], untouchedPhrase);
  assert.equal(scoreCore.validateScore(capturedPreview.score), capturedPreview.score);

  const correctedTake = tap.adjust(take, { id: take.marks[2].syllableId, edge: 'start', deltaMs: 10 });
  const correctedOperation = { ...operation, marks: correctedTake.marks.map(({ syllableId, startMs, endMs }) => ({ syllableId, startMs, endMs })) };
  const correctedPreview = timingVariant.operate(capturedPreview, correctedOperation);
  const applied = scoreCore.applyOperation(correctedPreview.score, correctedOperation, correctedPreview.score.revision);
  assert.equal(applied.phrases[0].words[0].syllables[1].endMs, correctedTake.marks[1].endMs);
  assert.equal(applied.phrases[0].words[1].syllables[0].startMs, correctedTake.marks[2].startMs);
  assert.deepEqual(applied.phrases[1], untouchedPhrase);
  assert.deepEqual(applied.phrases[0].words.map(({ id, text }) => [id, text]), originalWords);
  assert.equal(scoreCore.validateScore(applied), applied);
});

const wordFrames = () => [
  { id: 'frame-w0', wordId: 'w0', phraseId: 'p0', text: 'hello', minMs: 100, maxMs: 300 },
  { id: 'frame-w1', wordId: 'w1', phraseId: 'p0', text: 'world', minMs: 300, maxMs: 500 },
  { id: 'frame-w2', wordId: 'w2', phraseId: 'p0', text: 'again', minMs: 600, maxMs: 800 },
];

test('word-frames resolve one half-open source frame, rejecting gaps and ambiguous overlaps', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames' });
  take = tap.mark(take, 299);
  assert.equal(take.marks[0].startMs, 100);
  assert.equal(take.marks[0].endMs, 300);
  assert.throws(() => tap.mark(take, 550), { code: 'OUT_OF_BOUNDS' });
  // The shared half-open edge belongs to w1, not w0.
  take = tap.mark(take, 300);
  assert.equal(take.marks[1].wordId, 'w1');

  const overlap = wordFrames();
  overlap[1] = { ...overlap[1], minMs: 250 };
  const ambiguous = tap.begin(overlap, { mode: 'syllable', cadence: 'word-frames' });
  assert.throws(() => tap.mark(ambiguous, 275), { code: 'OUT_OF_BOUNDS' });
  assert.throws(() => tap.begin(wordFrames().map((unit, i) => ({ ...unit, wordId: i ? 'w0' : unit.wordId })),
    { mode: 'syllable', cadence: 'word-frames' }), { code: 'INVALID_UNITS' });
});

test('word-frames split a word on later taps and keep dynamic syllable identities', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames', bpm: 120 });
  take = tap.mark(take, 120);
  take = tap.mark(take, 180);
  take = tap.mark(take, 240);
  assert.deepEqual(take.marks.map(({ id, syllableId, wordId, phraseId, startMs, endMs }) =>
    ({ id, syllableId, wordId, phraseId, startMs, endMs })), [
    { id: 'w0-syllable-1', syllableId: 'w0-syllable-1', wordId: 'w0', phraseId: 'p0', startMs: 100, endMs: 180 },
    { id: 'w0-syllable-2', syllableId: 'w0-syllable-2', wordId: 'w0', phraseId: 'p0', startMs: 180, endMs: 240 },
    { id: 'w0-syllable-3', syllableId: 'w0-syllable-3', wordId: 'w0', phraseId: 'p0', startMs: 240, endMs: 300 },
  ]);
  assert.throws(() => tap.mark(take, 230), { code: 'NON_MONOTONIC_TIME' });
});

test('word-frames preserve untapped words, allow gaps, undo one tap, and continue after stop', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames' });
  take = tap.mark(take, 120);
  take = tap.mark(take, 180);
  take = tap.mark(take, 350); // Skips w1's remaining interpretation; w2 is still untouched.
  assert.deepEqual(take.marks.map(({ wordId }) => wordId), ['w0', 'w0', 'w1']);
  assert.equal(take.marks.find(mark => mark.wordId === 'w2'), undefined);
  const stopped = tap.stop(take);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.lastMs, 350);
  take = { ...stopped, status: 'armed' };
  take = tap.mark(take, 650);
  assert.deepEqual(take.marks.map(({ wordId }) => wordId), ['w0', 'w0', 'w1', 'w2']);
  take = tap.undo(take);
  assert.deepEqual(take.marks.map(({ wordId }) => wordId), ['w0', 'w0', 'w1']);
  assert.equal(take.lastMs, 350);
  assert.equal(take.wordFrameTapCounts.w2, undefined);
});

test('word-frames adjustment moves only an internal same-word boundary', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames' });
  take = tap.mark(take, 120);
  take = tap.mark(take, 180);
  take = tap.mark(take, 350);
  take = tap.stop(take);
  const changed = tap.adjust(take, { id: 'w0-syllable-2', edge: 'start', deltaMs: 10 });
  assert.deepEqual(changed.marks.slice(0, 2).map(({ startMs, endMs }) => [startMs, endMs]), [[100, 190], [190, 300]]);
  assert.throws(() => tap.adjust(take, { id: 'w0-syllable-1', edge: 'start', deltaMs: 1 }), { code: 'OUT_OF_BOUNDS' });
  assert.throws(() => tap.adjust(take, { id: 'w0-syllable-1', edge: 'move', deltaMs: 1 }), { code: 'ADJUST_UNSUPPORTED' });
});

const phraseStreamUnits = ({
  firstStart = 100, firstEnd = 500, secondStart = 600, secondEnd = 900,
  hourExpected = 1, partyExpected = 1, nextExpected = 1,
} = {}) => [
  { id: 'word-hour', wordId: 'hour', phraseId: 'p1', text: 'hour', minMs: firstStart, maxMs: firstEnd, expectedCount: hourExpected },
  { id: 'word-party', wordId: 'party', phraseId: 'p1', text: 'party', minMs: firstStart, maxMs: firstEnd, expectedCount: partyExpected },
  { id: 'word-next', wordId: 'next', phraseId: 'p2', text: 'next', minMs: secondStart, maxMs: secondEnd, expectedCount: nextExpected },
];

test('phrase-stream acknowledges phrase starts, follows expected counts, and keeps the final word open', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 120); // phrase acknowledgement and first syllable on one press
  assert.equal(take.activePhraseId, 'p1');
  assert.equal(take.index, 1);
  assert.deepEqual(take.marks.map(({ wordId, startMs, endMs }) => [wordId, startMs, endMs]), [['hour', 100, 500]]);
  take = tap.mark(take, 250);
  assert.deepEqual(take.marks.map(({ wordId, startMs, endMs }) => [wordId, startMs, endMs]), [
    ['hour', 100, 250], ['party', 250, 500],
  ]);
  assert.equal(take.index, 1);
  take = tap.mark(take, 350);
  assert.deepEqual(take.marks.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [
    ['hour-syllable-1', 100, 250], ['party-syllable-1', 250, 350], ['party-syllable-2', 350, 500],
  ]);
  assert.equal(take.index, 1);
  assert.equal(take.status, 'armed');
  take = tap.mark(take, 650); // entering p2 always selects its first word
  assert.equal(take.activePhraseId, 'p2');
  assert.equal(take.index, 2);
  assert.equal(take.marks.at(-1).wordId, 'next');
});

test('phrase-stream uses unique half-open phrase membership and rejects rests or overlaps atomically', () => {
  const adjacent = tap.begin(phraseStreamUnits({ firstEnd: 500, secondStart: 500 }),
    { mode: 'syllable', cadence: 'phrase-stream' });
  const entered = tap.mark(adjacent, 500);
  assert.equal(entered.activePhraseId, 'p2');

  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  const beforeRest = JSON.stringify(take);
  assert.throws(() => tap.mark(take, 550), { code: 'OUT_OF_BOUNDS' });
  assert.equal(JSON.stringify(take), beforeRest);
  const overlap = tap.begin(phraseStreamUnits({ secondStart: 400 }), { mode: 'syllable', cadence: 'phrase-stream' });
  const beforeOverlap = JSON.stringify(overlap);
  assert.throws(() => tap.mark(overlap, 450), { code: 'AMBIGUOUS_PHRASE' });
  assert.equal(JSON.stringify(overlap), beforeOverlap);
  assert.throws(() => tap.begin(phraseStreamUnits({ partyExpected: 0 }),
    { mode: 'syllable', cadence: 'phrase-stream' }), { code: 'INVALID_UNITS' });
});

test('phrase-stream reassignLast repairs over-count and under-count ownership without moving boundaries', () => {
  let overCount = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  overCount = tap.mark(overCount, 110);
  overCount = tap.mark(overCount, 220); // expected cursor says party; this tap was actually hour
  const edges = overCount.marks.map(({ startMs, endMs }) => [startMs, endMs]);
  overCount = tap.reassignLast(overCount, -1);
  assert.deepEqual(overCount.marks.map(({ id, wordId }) => [id, wordId]), [
    ['hour-syllable-1', 'hour'], ['hour-syllable-2', 'hour'],
  ]);
  assert.deepEqual(overCount.marks.map(({ startMs, endMs }) => [startMs, endMs]), edges);
  assert.equal(overCount.wordTapCounts.hour, 2);
  assert.equal(overCount.wordTapCounts.party, undefined);
  assert.equal(overCount.index, 1);

  let underCount = tap.begin(phraseStreamUnits({ hourExpected: 2 }), { mode: 'syllable', cadence: 'phrase-stream' });
  underCount = tap.mark(underCount, 110);
  underCount = tap.mark(underCount, 220); // expected cursor says hour; this tap was actually party
  underCount = tap.reassignLast(underCount, 1);
  assert.deepEqual(underCount.marks.map(({ id, wordId }) => [id, wordId]), [
    ['hour-syllable-1', 'hour'], ['party-syllable-1', 'party'],
  ]);
  assert.equal(underCount.wordTapCounts.hour, 1);
  assert.equal(underCount.wordTapCounts.party, 1);
  assert.equal(underCount.index, 1);
});

test('phrase-stream rejects non-monotone ownership and cursor movement preserves marks', () => {
  const units = phraseStreamUnits({ partyExpected: 3 });
  units.splice(2, 0, { id: 'word-third', wordId: 'third', phraseId: 'p1', text: 'third',
    minMs: 100, maxMs: 500, expectedCount: 1 });
  let take = tap.begin(units, { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110); // hour
  take = tap.mark(take, 220); // party, count 1 of 3
  take = tap.mark(take, 320); // party, count 2 of 3
  const before = JSON.stringify(take);
  assert.throws(() => tap.reassignLast(take, -1), { code: 'NON_MONOTONIC_OWNER' });
  assert.equal(JSON.stringify(take), before);

  const markCount = take.marks.length;
  take = tap.moveCursor(take, 1);
  take = tap.moveCursor(take, -1); // back to the latest owner, still monotone
  assert.equal(take.index, 1);
  assert.equal(take.marks.length, markCount);
  const beforeBackward = JSON.stringify(take);
  assert.throws(() => tap.moveCursor(take, -1), { code: 'NON_MONOTONIC_OWNER' });
  assert.equal(JSON.stringify(take), beforeBackward);
});

test('phrase-stream clock-aware cursor movement selects the new phrase before an arrow and reassignment can target the prior tap', () => {
  const units = phraseStreamUnits();
  units.push({ id: 'word-next-two', wordId: 'next-two', phraseId: 'p2', text: 'again',
    minMs: 600, maxMs: 900, expectedCount: 1 });
  let take = tap.begin(units, { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110);
  take = tap.mark(take, 220);
  const priorMarks = structuredClone(take.marks);
  take = tap.moveCursor(take, 1, 650);
  assert.equal(take.activePhraseId, 'p2');
  assert.equal(take.index, 3);
  assert.deepEqual(take.marks, priorMarks);
  take = tap.reassignLast(take, -1); // latest syllable tap still belongs to p1
  assert.equal(take.activePhraseId, 'p2');
  assert.equal(take.index, 3);
  assert.equal(take.marks.at(-1).wordId, 'hour');
  take = tap.mark(take, 660);
  assert.equal(take.marks.at(-1).wordId, 'next-two');
});

test('phrase-stream undo, stop, and adjustment retain partial marks and fixed phrase endpoints', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110); take = tap.mark(take, 220);
  take = tap.undo(take);
  assert.deepEqual(take.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 500]]);
  assert.equal(take.marks.length, 1);
  const stopped = tap.stop(take);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.marks.length, 1);
  const resumed = { ...stopped, status: 'armed' };
  assert.throws(() => tap.adjust(tap.stop(resumed), { id: 'hour-syllable-1', edge: 'start', deltaMs: 1 }), { code: 'OUT_OF_BOUNDS' });

  let split = tap.mark(resumed, 240);
  const adjusted = tap.adjust(tap.stop(split), { id: 'party-syllable-1', edge: 'start', deltaMs: 10 });
  assert.deepEqual(adjusted.marks.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 250], [250, 500]]);
  assert.throws(() => tap.adjust(adjusted, { id: 'hour-syllable-1', edge: 'move', deltaMs: 1 }), { code: 'ADJUST_UNSUPPORTED' });
});

test('restoreWordFrameTake preserves the exact stopped snapshot and one-tap undo history', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames' });
  take = tap.mark(take, 120);
  take = tap.mark(take, 180);
  take = tap.mark(take, 350);
  take = { ...tap.stop(take), stoppedScoreMs: -12 };
  const snapshotJson = JSON.stringify(take);
  const restored = tap.restoreWordFrameTake(JSON.parse(snapshotJson));
  assert.notEqual(restored, take);
  assert.equal(JSON.stringify(restored), snapshotJson);
  assert.equal(restored.stoppedScoreMs, -12);
  const undone = tap.undo(restored);
  assert.deepEqual(undone.marks.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [
    ['w0-syllable-1', 100, 180], ['w0-syllable-2', 180, 300],
  ]);
  assert.equal(undone.lastMs, 180);
  assert.equal(undone.wordFrameTapCounts.w0, 2);

  const empty = tap.restoreWordFrameTake(tap.stop(tap.begin(wordFrames(),
    { mode: 'syllable', cadence: 'word-frames' })));
  assert.equal(empty.index, 0);
  assert.equal(empty.lastMs, null);
  assert.deepEqual(empty.marks, []);
});

test('restoreWordFrameTake rejects tampered frame partitions, counts, identities, and undo history atomically', () => {
  let take = tap.begin(wordFrames(), { mode: 'syllable', cadence: 'word-frames' });
  take = tap.mark(take, 120);
  take = tap.mark(take, 180);
  take = tap.mark(take, 350);
  take = tap.stop(take);
  const tampered = [
    snapshot => { snapshot.marks[0].endMs += 1; },
    snapshot => { snapshot.marks[0].id = 'wrong-id'; },
    snapshot => { snapshot.wordFrameTapCounts.w0 = 99; },
    snapshot => { snapshot.marks[0].phraseId = 'wrong-phrase'; },
    snapshot => { snapshot.actionHistory[0].cadence = 'flow'; },
    snapshot => { snapshot.actionHistory[0].actionHistory = []; },
    snapshot => { snapshot.actionHistory[0].status = 'complete'; },
    snapshot => { snapshot.pendingStartMs = 0; },
  ];
  for (const corrupt of tampered) {
    const snapshot = structuredClone(take);
    corrupt(snapshot);
    const before = JSON.stringify(snapshot);
    assert.throws(() => tap.restoreWordFrameTake(snapshot), { code: 'INVALID_SNAPSHOT' });
    assert.equal(JSON.stringify(snapshot), before);
  }
  const wrongStatus = { ...take, status: 'armed' };
  assert.throws(() => tap.restoreWordFrameTake(wrongStatus), { code: 'INVALID_SNAPSHOT' });
  const oversized = { ...take, units: Array.from({ length: 5001 }, (_, i) => ({ ...wordFrames()[0], id: `u${i}`, wordId: `w${i}` })) };
  assert.throws(() => tap.restoreWordFrameTake(oversized), { code: 'INVALID_SNAPSHOT' });
});

test('phrase-stream rewind to an earlier phrase retains only its prefix and Undo restores the exact take', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110); take = tap.mark(take, 220); take = tap.mark(take, 650);
  const before = structuredClone(tap.stop(take));
  const rewound = tap.rewindToPhrase(before, 'p2');
  assert.deepEqual(rewound.marks, before.marks.slice(0, 2));
  assert.equal(rewound.status, 'stopped');
  assert.equal(rewound.index, 2);
  assert.equal(rewound.activePhraseId, null);
  assert.equal(rewound.pendingStartMs, null);
  assert.equal(rewound.openTailId, null);
  assert.equal(rewound.lastMs, rewound.marks.at(-1).startMs);
  assert.deepEqual(rewound.wordTapCounts, { hour: 1, party: 1 });
  assert.deepEqual(rewound.acknowledgedPhraseIds, ['p1']);
  assert.deepEqual(tap.undo(rewound), before);

  // The same stopped snapshot can resume at the seek position and rerecord
  // without duplicate syllable ids or a backwards source-time mark.
  const resumed = { ...rewound, status: 'armed' };
  const rerecorded = tap.mark(resumed, 640);
  assert.deepEqual(rerecorded.marks.map(m => m.id), ['hour-syllable-1', 'party-syllable-1', 'next-syllable-1']);
  assert.ok(rerecorded.marks.every((m, i, all) => i === 0 || m.startMs >= all[i - 1].startMs));
});

test('phrase-stream rewind keeps earlier phrases and rejects non-stopped, wrong cadence, and unknown phrase', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110); take = tap.mark(take, 650);
  const stopped = tap.stop(take);
  const rewound = tap.rewindToPhrase(stopped, 'p2');
  assert.deepEqual(rewound.marks.map(m => m.phraseId), ['p1']);
  assert.throws(() => tap.rewindToPhrase({ ...stopped, status: 'armed' }, 'p2'), { code: 'TAKE_NOT_STOPPED' });
  assert.throws(() => tap.rewindToPhrase({ ...stopped, cadence: 'word-frames' }, 'p2'), { code: 'CADENCE_UNSUPPORTED' });
  assert.throws(() => tap.rewindToPhrase(stopped, 'missing'), { code: 'UNKNOWN_PHRASE' });
});

test('restorePhraseStreamTake round trips current and rewound snapshots and rejects tampering', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110); take = tap.mark(take, 220); take = tap.mark(take, 650);
  const current = tap.stop(take);
  for (const snapshot of [current, tap.rewindToPhrase(current, 'p2')]) {
    snapshot.stoppedScoreMs = -10;
    const encoded = JSON.stringify(snapshot);
    const restored = tap.restorePhraseStreamTake(JSON.parse(encoded));
    assert.notEqual(restored, snapshot);
    assert.equal(JSON.stringify(restored), encoded);
  }
  const invalid = [
    s => { s.marks[0].id = 'bad'; },
    s => { s.wordTapCounts.hour = 7; },
    s => { s.marks[1].startMs = 120; },
    s => { s.units[0].expectedCount = 0; },
    s => { s.actionHistory[0].actionHistory = []; },
    s => { s.actionHistory[0].status = 'complete'; },
  ];
  for (const corrupt of invalid) {
    const snapshot = structuredClone(current); corrupt(snapshot);
    assert.throws(() => tap.restorePhraseStreamTake(snapshot), { code: 'INVALID_SNAPSHOT' });
  }
});

test('restorePhraseStreamTake accepts signed stopped offsets preserved in resumed undo history', () => {
  let take = tap.begin(phraseStreamUnits(), { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110);
  const stopped = { ...tap.stop(take), stoppedScoreMs: -35 };
  const resumed = { ...stopped, status: 'armed' };
  const retaken = tap.stop(tap.mark(resumed, 220));
  assert.equal(retaken.stoppedScoreMs, -35);
  assert.ok(retaken.actionHistory.some(entry => entry.stoppedScoreMs === -35));
  const restored = tap.restorePhraseStreamTake(retaken);
  assert.deepEqual(restored, retaken);
  assert.throws(() => tap.restorePhraseStreamTake({ ...retaken, stoppedScoreMs: 1.5 }), { code: 'INVALID_SNAPSHOT' });
});

test('restorePhraseStreamTake accepts an armed cross-phrase cursor with prior marks and no open tail', () => {
  const units = phraseStreamUnits();
  units.push({ id: 'word-next-again', wordId: 'next-again', phraseId: 'p2', text: 'again',
    minMs: 600, maxMs: 900, expectedCount: 1 });
  let take = tap.begin(units, { mode: 'syllable', cadence: 'phrase-stream' });
  take = tap.mark(take, 110);
  take = tap.moveCursor(take, 1, 650);
  assert.equal(take.activePhraseId, 'p2');
  assert.equal(take.openTailId, null);
  assert.deepEqual(tap.restorePhraseStreamTake(tap.stop(take)), tap.stop(take));
});

test('word pass claims recorded syllables by press and ends the last syllable at release', () => {
  const units=[
    {wordId:'w1',phraseId:'p',text:"stayin'",minMs:0,maxMs:5000,expectedCount:2},
    {wordId:'w2',phraseId:'p',text:'alive',minMs:0,maxMs:5000,expectedCount:2},
  ];
  const syllables=[100,400,1000,1300].map((ms,i)=>({id:`event-${i+1}`,kind:'syllable-entrance',sourceMs:ms}));
  let take=tap.beginWordHolds(units,syllables);
  take=tap.pressWord(take,160); take=tap.releaseWord(take,820);   // reaction-late press still claims 100
  take=tap.pressWord(take,1040); take=tap.releaseWord(take,2100); // held final syllable
  assert.equal(take.status,'complete');
  const p=tap.associateWordHolds(take).phrases[0];
  assert.equal(p.ready,true); assert.deepEqual(p.issues,[]);
  assert.deepEqual(p.marks.map(m=>[m.wordId,m.startMs,m.endMs,m.endSource]),[
    ['w1',100,400,'next-entrance'],['w1',400,820,'word-release'],
    ['w2',1000,1300,'next-entrance'],['w2',1300,2100,'word-release']]);
  // Raw syllable entrances never move.
  assert.deepEqual(take.syllableEvents.map(e=>e.sourceMs),[100,400,1000,1300]);
});

test('word pass flags a syllable after release, count differences and unheld words', () => {
  const units=[
    {wordId:'a',phraseId:'p',text:'a',minMs:0,maxMs:5000,expectedCount:1},
    {wordId:'b',phraseId:'p',text:'b',minMs:0,maxMs:5000,expectedCount:1},
    {wordId:'c',phraseId:'q',text:'c',minMs:5000,maxMs:9000,expectedCount:1},
  ];
  const syllables=[100,900,2000].map((ms,i)=>({id:`e${i}`,sourceMs:ms}));
  let take=tap.beginWordHolds(units,syllables);
  take=tap.pressWord(take,100); take=tap.releaseWord(take,300);
  take=tap.pressWord(take,2000); take=tap.releaseWord(take,2400);
  take=tap.stopWordHolds(take);
  const r=tap.associateWordHolds(take);
  const p=r.phrases[0];
  assert.deepEqual(p.words.map(w=>[w.wordId,w.count,w.issues]),[['a',2,['syllable-after-release','count-differs','release-before-last-syllable']],['b',1,[]]]);
  assert.deepEqual(p.marks.filter(m=>m.wordId==='a').map(m=>[m.startMs,m.endMs,m.endSource]),[[100,900,'next-entrance'],[900,2000,'provisional-next-press']]);
  assert.equal(p.ready,true);
  assert.equal(r.phrases[1].heldCount,0); assert.equal(r.phrases[1].ready,false);
  // A partially held phrase blocks only itself.
  let partial=tap.beginWordHolds(units,syllables);
  partial=tap.pressWord(partial,100); partial=tap.releaseWord(partial,300); partial=tap.stopWordHolds(partial);
  const q=tap.associateWordHolds(partial).phrases[0];
  assert.ok(q.issues.includes('word-not-held')); assert.equal(q.ready,false);
});

test('word pass falls back to the press when no syllable was recorded and supports undo, skip and rewind', () => {
  const units=[
    {wordId:'a',phraseId:'p1',text:'a',minMs:0,maxMs:1000,expectedCount:1},
    {wordId:'b',phraseId:'p2',text:'b',minMs:1000,maxMs:3000,expectedCount:1},
  ];
  let take=tap.beginWordHolds(units,[]);
  take=tap.pressWord(take,200); take=tap.releaseWord(take,600);
  const m=tap.associateWordHolds(take).phrases[0];
  assert.deepEqual(m.marks.map(x=>[x.startMs,x.endMs,x.startSource]),[[200,600,'word-press']]);
  assert.ok(m.issues.includes('no-syllable-claimed'));
  assert.throws(()=>tap.releaseWord(take,700),/Press before/);
  take=tap.pressWord(take,1200);
  assert.throws(()=>tap.skipWords(take,1),/Release/);
  take=tap.undoWordHold(take); assert.equal(take.pendingStartMs,null);
  take=tap.skipWords(take,-1); assert.equal(take.index,0); assert.deepEqual(take.holds,[]);
  take=tap.pressWord(take,250); take=tap.releaseWord(take,650); take=tap.pressWord(take,1100); take=tap.releaseWord(take,1500);
  const rewound=tap.rewindWordHolds(take,'p2');
  assert.deepEqual(rewound.holds.map(h=>h.wordId),['a']); assert.equal(rewound.index,1);
});

test('a Words hold take becomes a word pass, merging hyphen parts and applying the score offset', () => {
  const pairs={cadence:'pairs',status:'complete',marks:[
    {id:'a__take-part-1',wordId:'a',startMs:100,endMs:200},{id:'a__take-part-2',wordId:'a',startMs:220,endMs:390},
    {id:'b',wordId:'b',startMs:500,endMs:900}]};
  const units=[
    {wordId:'a',phraseId:'p',text:'ice-night',minMs:0,maxMs:2000,expectedCount:2},
    {wordId:'b',phraseId:'p',text:'long',minMs:0,maxMs:2000,expectedCount:1},
    {wordId:'c',phraseId:'q',text:'more',minMs:2000,maxMs:3000,expectedCount:1}];
  const syllables=[110,250,520].map((ms,i)=>({id:`e${i}`,kind:'syllable-entrance',sourceMs:ms+10}));
  const take=tap.wordHoldsFromPairs(pairs,units,syllables,10);
  assert.equal(take.status,'stopped'); assert.equal(take.index,2);
  assert.deepEqual(take.holds.map(h=>[h.wordId,h.pressMs,h.releaseMs]),[['a',110,400],['b',510,910]]);
  const p=tap.associateWordHolds(take).phrases[0];
  assert.equal(p.ready,true);
  assert.deepEqual(p.marks.map(m=>[m.wordId,m.startMs,m.endMs,m.endSource]),[['a',120,260,'next-entrance'],['a',260,400,'word-release'],['b',530,910,'word-release']]);
  assert.throws(()=>tap.wordHoldsFromPairs({cadence:'entrances',marks:[]},units,syllables),/Words hold take/);
});

test('word pass trims a legato release at the next entrance and flags it', () => {
  const units=[{wordId:'a',phraseId:'p',text:'a',minMs:0,maxMs:3000,expectedCount:1},{wordId:'b',phraseId:'p',text:'b',minMs:0,maxMs:3000,expectedCount:1}];
  let take=tap.beginWordHolds(units,[{id:'e1',sourceMs:100},{id:'e2',sourceMs:560}]);
  // Converted hold pairs can overlap even though one live key cannot.
  take={...take,holds:[{wordId:'a',phraseId:'p',pressMs:100,releaseMs:650},{wordId:'b',phraseId:'p',pressMs:520,releaseMs:900}]};
  const p=tap.associateWordHolds(take).phrases[0];
  assert.deepEqual(p.marks.map(m=>[m.startMs,m.endMs,m.endSource]),[[100,560,'word-release-trimmed'],[560,900,'word-release']]);
  assert.deepEqual(p.words[0].issues,['release-overlaps-next']); assert.equal(p.ready,true);
});

test('retiming one phrase replaces only its holds and returns the cursor', () => {
  const units=[
    {wordId:'a',phraseId:'p1',text:'a',minMs:0,maxMs:1000,expectedCount:1},
    {wordId:'b',phraseId:'p1',text:'b',minMs:0,maxMs:1000,expectedCount:1},
    {wordId:'c',phraseId:'p2',text:'c',minMs:1000,maxMs:2000,expectedCount:1},
    {wordId:'d',phraseId:'p3',text:'d',minMs:2000,maxMs:3000,expectedCount:1}];
  let take=tap.beginWordHolds(units,[]);
  for(const [p,r] of [[100,300],[400,600],[1100,1500]]){take=tap.pressWord(take,p);take=tap.releaseWord(take,r);}
  take=tap.stopWordHolds(take); assert.equal(take.index,3);
  take={...tap.retimePhraseHolds(take,'p1'),status:'armed'};
  assert.equal(take.index,0); assert.equal(take.lastMs,null);
  take=tap.pressWord(take,120); take=tap.releaseWord(take,320);
  take=tap.pressWord(take,380); take=tap.releaseWord(take,700);
  assert.equal(take.status,'stopped'); assert.equal(take.index,3); assert.equal(take.retime,null);
  assert.deepEqual(take.holds.map(h=>[h.wordId,h.pressMs,h.releaseMs]).sort(),[['a',120,320],['b',380,700],['c',1100,1500]]);
  // Stopping partway restores the untouched word's earlier hold.
  let partial={...tap.retimePhraseHolds(take,'p1'),status:'armed'};
  partial=tap.pressWord(partial,130); partial=tap.releaseWord(partial,330); partial=tap.stopWordHolds(partial);
  assert.deepEqual(partial.holds.map(h=>[h.wordId,h.pressMs]).sort(),[['a',130],['b',380],['c',1100]]);
  assert.equal(partial.index,3);
  assert.throws(()=>tap.retimePhraseHolds({...take,status:'armed'},'p1'),/Stop the pass/);
});

test('a quick word keeps the tap inside its hold even when the next press follows within the lead', () => {
  // Real Sample Track case: "bust a move" with a brief "a".
  const units=['bust','a','move'].map((text,i)=>({wordId:text,phraseId:'p',text,minMs:0,maxMs:30000,expectedCount:1}));
  const syllables=[19021,19261,19387].map((ms,i)=>({id:`e${i}`,sourceMs:ms}));
  let take=tap.beginWordHolds(units,syllables);
  take={...take,holds:[{wordId:'bust',phraseId:'p',pressMs:18991,releaseMs:19087},{wordId:'a',phraseId:'p',pressMs:19272,releaseMs:19318},{wordId:'move',phraseId:'p',pressMs:19407,releaseMs:19521}]};
  const p=tap.associateWordHolds(take).phrases[0];
  // 19261 precedes a's press by 11ms -> "a"; 19387 precedes move's press by 20ms -> "move".
  assert.deepEqual(p.words.map(w=>[w.text,w.count]),[['bust',1],['a',1],['move',1]]);
  assert.equal(p.ready,true); assert.ok(!p.issues.includes('order-conflict'));
});

test('tap tempo fits period and phase, tolerating jitter and a skipped beat', () => {
  // 120 BPM (500ms) with beats on 250 + 500n; jittered taps and one skipped beat.
  const taps=[10250,10760,11245,12255,12748,13252,13751];
  const t=tap.estimateTempo(taps);
  assert.ok(Math.abs(t.bpm-120)<1,`bpm ${t.bpm}`);
  assert.ok(Math.abs(t.anchorMs-250)<=15,`anchor ${t.anchorMs}`);
  assert.ok(t.residualMs<15); assert.equal(t.count,7);
  assert.equal(tap.estimateTempo([1000,1500,2000]),null);
  assert.equal(tap.estimateTempo([0,5000,10000,15000]),null); // 12 BPM is out of range
  assert.throws(()=>tap.estimateTempo([1.5,2,3,4]),/whole milliseconds/);
});
