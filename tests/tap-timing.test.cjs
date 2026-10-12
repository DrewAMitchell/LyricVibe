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
