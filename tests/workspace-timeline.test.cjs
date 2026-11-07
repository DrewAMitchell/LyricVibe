const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/score-core.js');
const { songRange, intersectingLanes, movedInterval, positionPercent, rulerTicks } = require('../.verification/workspace-timeline.cjs');

function score() {
  return core.createScore({ platform: 'youtube', videoId: 'FIXTURE0001', durationMs: 3600000 },
    '[00:10.00]hello world\n[00:13.00]next phrase\n[59:50.00]last phrase',
    { provider: 'test', contentHash: 'a'.repeat(64) });
}

test('song timeline spans the full source and includes distant phrases with source offset', () => {
  const value=score();value.offsetMs=250;const range=songRange(value);
  assert.deepEqual(range,{startMs:0,endMs:3600000});
  const items=intersectingLanes(value,range).flatMap(lane=>lane.items);
  assert.ok(items.some(item=>item.word.id===value.phrases[0].words[0].id));
  assert.ok(items.some(item=>item.word.id===value.phrases.at(-1).words[0].id));
  assert.equal(positionPercent(3600000,range),100);
  assert.ok(rulerTicks(range,50000).every(ms=>ms>=range.startMs&&ms<=range.endMs));
});

test('overlapping backing words and actual syllables have independent collision-free rows', () => {
  const value = score();
  const lead = value.phrases[0];
  lead.words[0].syllables = [{ id: 's1', text: 'hel', startMs: lead.words[0].startMs, endMs: lead.words[0].endMs }];
  value.lanes.push({ id: 'background-test', label: 'Backing', role: 'backing' });
  value.phrases.push({ ...structuredClone(lead), id: 'backing-test', laneId: 'background-test', words: [{ ...structuredClone(lead.words[0]), id: 'bw', syllables: [] }] });
  const lanes = intersectingLanes(value, { startMs: 9000, endMs: 14000 });
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
const { phraseWindow } = require('../.verification/workspace-timeline.cjs');
test('follow windows keep three or five lead phrases around the source playhead without changing score timing', () => {
  const value=core.createScore({platform:'youtube',videoId:'FIXTURE0001',durationMs:40000},'[00:02]one\n[00:06]two\n[00:10]three\n[00:14]four\n[00:18]five\n[00:22]six',{contentHash:'a'.repeat(64)});
  value.offsetMs=250; const before=JSON.stringify(value),three=phraseWindow(value,14250,3),five=phraseWindow(value,14250,5);
  assert.equal(three.phraseId,value.phrases[3].id);
  assert.ok(three.startMs<=value.phrases[2].startMs+250 && three.endMs>=value.phrases[4].endMs+250);
  assert.ok(five.startMs<three.startMs && five.endMs>three.endMs);
  assert.equal(phraseWindow(value,0,3).phraseId,value.phrases[0].id);
  assert.equal(JSON.stringify(value),before);
});
