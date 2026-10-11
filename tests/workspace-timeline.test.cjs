const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/score-core.js');
const { phraseRange, intersectingLanes, movedInterval, positionPercent, rulerTicks } = require('../.verification/workspace-timeline.cjs');

function score() {
  return core.createScore({ platform: 'youtube', videoId: 'FIXTURE0001', durationMs: 3600000 },
    '[00:10.00]hello world\n[00:13.00]next phrase\n[59:50.00]last phrase',
    { provider: 'test', contentHash: 'a'.repeat(64) });
}

test('an hour-long score still has a bounded selected-phrase viewport with offset applied once', () => {
  const value = score();
  const phrase = value.phrases[0];
  const initial = phraseRange(value, phrase);
  value.offsetMs = 250;
  const shifted = phraseRange(value, phrase);
  assert.equal(shifted.startMs, initial.startMs + 250);
  assert.equal(shifted.endMs, initial.endMs + 250);
  assert.ok(shifted.endMs - shifted.startMs < 5000);
  const items = intersectingLanes(value, shifted).flatMap(lane => lane.items);
  assert.ok(items.some(item => item.word.id === phrase.words[0].id));
  assert.ok(items.every(item => item.word.startMs < 20000));
  assert.equal(positionPercent(shifted.startMs, shifted), 0);
  assert.equal(positionPercent(shifted.endMs, shifted), 100);
});

test('zoom and start/end phrases stay inside the media duration', () => {
  const value = score();
  for (const phrase of [value.phrases[0], value.phrases.at(-1)]) {
    for (const center of [-100000, 4000000]) {
      const range = phraseRange(value, phrase, 4, center);
      assert.ok(range.startMs >= 0);
      assert.ok(range.endMs <= value.source.durationMs);
      assert.ok(range.endMs > range.startMs);
      assert.ok(range.endMs - range.startMs < 5000);
      assert.ok(rulerTicks(range, 360).every(ms => ms >= range.startMs && ms <= range.endMs));
    }
  }
});

test('overlapping backing words and actual syllables have independent collision-free rows', () => {
  const value = score();
  const lead = value.phrases[0];
  lead.words[0].syllables = [{ id: 's1', text: 'hel', startMs: lead.words[0].startMs, endMs: lead.words[0].endMs }];
  value.lanes.push({ id: 'background-test', label: 'Backing', role: 'backing' });
  value.phrases.push({ ...structuredClone(lead), id: 'backing-test', laneId: 'background-test', words: [{ ...structuredClone(lead.words[0]), id: 'bw', syllables: [] }] });
  const lanes = intersectingLanes(value, phraseRange(value, lead));
  const parent = lanes.flatMap(lane => lane.items).find(item => item.item.id === lead.words[0].id);
  const child = lanes.flatMap(lane => lane.items).find(item => item.item.id === 's1');
  assert.equal(child.row, parent.row + 1);
  assert.equal(lanes.find(lane => lane.id === 'background-test').items[0].row, 0);
  for (const lane of lanes) {
    for (const item of lane.items) {
      for (const other of lane.items) {
        if (item === other || item.row !== other.row) continue;
        assert.ok(item.item.endMs <= other.item.startMs || other.item.endMs <= item.item.startMs);
      }
    }
  }
});

test('dragging and resizing preserve parent containment, duration and integer milliseconds', () => {
  const item = { startMs: 1200, endMs: 1500 };
  assert.deepEqual(movedInterval(item, -9999, 'move', 1000, 2000), { startMs: 1000, endMs: 1300 });
  assert.deepEqual(movedInterval(item, 9999, 'move', 1000, 2000), { startMs: 1700, endMs: 2000 });
  assert.deepEqual(movedInterval(item, 9999, 'start', 1000, 2000), { startMs: 1500, endMs: 1500 });
  assert.deepEqual(movedInterval(item, -9999, 'end', 1000, 2000), { startMs: 1200, endMs: 1200 });
  assert.deepEqual(movedInterval(item, 1.7, 'move', 1000, 2000), { startMs: 1202, endMs: 1502 });
});
