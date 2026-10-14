const test=require('node:test');
const assert=require('node:assert/strict');
const tap=require('../extension/tap-timing.js');
const point=(startMs,bpm,transition='step')=>({startMs,bpm,transition,provenance:'manual'});
const map=segments=>tap.validateTempoMap({version:1,anchorMs:0,segments});
const near=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);

test('migrated tapped grid preserves BPM and source phase without changing old evidence',()=>{
  const estimate={bpm:120,anchorMs:125,periodMs:500},taps=[125,625,1125,1625];
  const migrated=tap.tempoMapFromEstimate(estimate,taps);
  near(tap.tempoAt(migrated,1625).beat,3);near(tap.tempoAt(migrated,1750).phase,.25);
  migrated.segments[0].taps.push(2000);assert.equal(taps.length,4);assert.equal(estimate.anchorMs,125);
});
test('step changes preserve beat position at boundaries and source-time replay',()=>{
  const m=map([point(0,120),point(10000,60)]);
  near(tap.tempoAt(m,10000).beat,20);near(tap.tempoAt(m,11000).beat,21);
  assert.equal(tap.tempoAt(m,10000).bpm,60);
  near(tap.tempoAt(m,5000).beat,10); // seek back across change
});
test('linear BPM ramp integrates acceleration rather than interpolating beat phase',()=>{
  const m=map([point(0,60,'linear'),point(10000,180),point(20000,90)]);
  near(tap.tempoAt(m,5000).bpm,120);near(tap.tempoAt(m,5000).beat,7.5);
  near(tap.tempoAt(m,10000).beat,20);near(tap.tempoAt(m,15000).beat,35);
  near(tap.tempoAt(m,20000).beat,50);near(tap.tempoAt(m,22000).beat,53);
  for(const ms of [0,125,5000,9999,10000,15000,20000,40000])near(tap.tempoTimeAtBeat(m,tap.tempoAt(m,ms).beat),ms,1e-5);
});
test('point edits are immutable and reject duplicate/unordered times, empty maps and invalid BPM',()=>{
  const original=map([point(0,120)]),edited=tap.setTempoPoint(original,point(10000,90));
  assert.equal(original.segments.length,1);assert.equal(edited.segments.length,2);
  assert.equal(tap.setTempoPoint(edited,point(10000,100)).segments[1].bpm,100);
  assert.equal(tap.removeTempoPoint(edited,10000).segments.length,1);
  for(const invalid of [[],[null],[point(1,120)],[point(0,120),point(0,90)],[point(0,0)],[point(0,Infinity)],[point(0,120,'curve')],[{...point(0,120),taps:['unknown']}]])assert.throws(()=>map(invalid),{code:'INVALID_TEMPO_MAP'});
  assert.throws(()=>tap.removeTempoPoint(edited,0),{code:'INVALID_TEMPO_MAP'});
  assert.throws(()=>tap.removeTempoPoint(edited,100),{code:'INVALID_TEMPO_MAP'});
});
test('quarter beat snap follows ramp in source time with score offset applied once',()=>{
  const m=map([point(0,60,'linear'),point(10000,180)]),offset=200;
  const units=[{id:'w',wordId:'w',text:'word',minMs:0,maxMs:15000}];
  let take=tap.begin(units,{mode:'word',cadence:'pairs',bpm:60,tempoMap:m,tempoOffsetMs:offset});
  const source=5100,snapped=tap.tempoTimeAtBeat(m,Math.round(tap.tempoAt(m,source).beat*4)/4);
  take=tap.mark(take,source-offset);assert.equal(take.pendingStartMs,Math.round(snapped-offset));
  assert.equal(m.segments.length,2);
});
