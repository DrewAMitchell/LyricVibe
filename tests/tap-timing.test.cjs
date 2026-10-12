const test = require('node:test');
const assert = require('node:assert/strict');
const tap = require('../extension/tap-timing.js');

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
