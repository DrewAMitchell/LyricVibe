const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),tempo=require('../extension/tap-timing.js'),beats=require('../extension/beat-track.js');
const map=tempo.validateTempoMap({version:1,anchorMs:1000,beatsPerBar:4,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]});
const score=()=>core.createScore({platform:'youtube',videoId:'FIXTURE0001',durationMs:20000},'[00:01.00]Carry on\n[00:10.00]Next phrase\n[00:15.00]',{provider:'fixture',entryId:'a',contentHash:'a'.repeat(64)});
const cue={id:'cue',beat:4,durationBeats:4,effect:'pulse',strength:.6,target:{kind:'lane',id:'lead'},rawSourceMs:3090,snappedSourceMs:3000,provenance:'manual'};
test('beat effects and persistence are revisioned presentation edits that retain timing and locks',()=>{
  const s=score(),p=s.phrases[0],before=JSON.stringify(p.words);let n=core.applyOperation(s,{type:'setBeatCue',cue},s.revision);n=core.applyOperation(n,{type:'setPhrasePersistence',phraseId:p.id,beats:4},n.revision);
  assert.equal(JSON.stringify(n.phrases[0].words),before);assert.deepEqual(n.beatCues,[cue]);assert.equal(s.beatCues,undefined);assert.equal(n.phrases[0].endMs,p.endMs);
  assert.deepEqual(core.validateScore(JSON.parse(JSON.stringify(n))).beatCues,[cue]);
  assert.throws(()=>core.applyOperation(n,{type:'setBeatCue',cue:{...cue,target:{kind:'word',id:'lead'}}},n.revision),{code:'INVALID_SCORE'});
  assert.throws(()=>core.applyOperation(n,{type:'setPhrasePersistence',phraseId:p.id,beats:-1},n.revision),{code:'INVALID_OPERATION'});
  assert.throws(()=>core.applyOperation(n,{type:'deleteBeatCue',cueId:'cue'},0),{code:'REVISION_CONFLICT'});
  assert.deepEqual(core.applyOperation(n,{type:'deleteBeatCue',cueId:'cue'},n.revision).beatCues,[]);
});
test('gap hold counts source-clock beats, clips to the next same-lane phrase and never extends sung words',()=>{
  let s=score();const p=s.phrases[0];s=core.applyOperation(s,{type:'setPhrasePersistence',phraseId:p.id,beats:32},s.revision);const ends=beats.displayEnds(s,map);assert.equal(ends[p.id],10000);
  const active=core.activeAt(s,8000,{displayEnds:ends}).phrases.find(x=>x.id===p.id);assert.ok(active.persisted);assert.equal(active.opacity,1);assert.deepEqual(active.activeWords,[]);assert.equal(active.endMs,p.endMs);
  assert.ok(!core.activeAt(s,10000,{displayEnds:ends}).phrases.some(x=>x.id===p.id));assert.ok(core.activeAt(s,10500,{displayEnds:ends}).phrases.some(x=>x.id!==p.id));
  s.offsetMs=250;const offsetEnds=beats.displayEnds(s,map);assert.equal(offsetEnds[p.id],10000);
});
test('replacing a cue-targeted word keeps its gesture on the phrase and permits saving',()=>{
  let s=score();const p=s.phrases[0],w=p.words[0];s=core.applyOperation(s,{type:'setBeatCue',cue:{...cue,target:{kind:'word',id:w.id}}},s.revision);
  s=core.applyOperation(s,{type:'replaceWords',phraseId:p.id,wordIds:[w.id],text:'Bring it'},s.revision);
  assert.deepEqual(s.beatCues[0].target,{kind:'phrase',id:p.id});assert.equal(s.phrases[0].words[0].text,'Bring');
});
test('beat visuals replay after seek, move with re-tapped phase and reduce motion',()=>{
  assert.ok(beats.cueAt(cue,map,3000).scale>1);assert.equal(beats.cueAt(cue,map,3250).scale,1);assert.equal(beats.cueAt(cue,map,5000),null);
  const shifted={...map,anchorMs:1500};assert.equal(beats.cueAt(cue,shifted,3000),null);assert.ok(beats.cueAt(cue,shifted,3500).scale>1);
  assert.equal(beats.cueAt(cue,map,3000,true).scale,1);assert.equal(beats.cueAt({...cue,effect:'color'},map,3250,true).hue,0);
});
test('click schedule accents tap-aligned beat 1, respects half-speed and recomputes after a backward seek',()=>{
  const first=beats.clickSchedule(map,1000,1)[0];assert.equal(first.beat,0);assert.equal(first.downbeat,true);assert.ok(Math.abs(first.sourceMs-1000)<1e-6);assert.ok(first.delayMs<1e-6);
  const next=beats.clickSchedule(map,1450,.5)[0];assert.equal(next.beat,1);assert.ok(Math.abs(next.delayMs-100)<.001);assert.equal(next.downbeat,false);
  assert.equal(beats.clickSchedule(map,3000,1)[0].downbeat,true);assert.equal(beats.clickSchedule(map,1000,1)[0].beat,0);
  const ramp=tempo.validateTempoMap({...map,segments:[{startMs:0,bpm:60,transition:'linear',provenance:'manual'},{startMs:10000,bpm:180,transition:'step',provenance:'manual'}]});
  for(const event of beats.clickSchedule(ramp,5000,1,1000))assert.ok(Math.abs(tempo.tempoAt(ramp,event.sourceMs).beat-event.beat)<1e-6);
});

test('display default lingers within and between phrases without changing any sung timing',()=>{
  const s=score(),p=s.phrases[0],w=p.words[0];
  w.syllables=[{id:'s1',text:'Car',startMs:w.startMs,endMs:w.startMs+100,locked:false,provenance:'manual',confidence:1,effects:[]},{id:'s2',text:'ry',startMs:w.endMs-100,endMs:w.endMs,locked:false,provenance:'manual',confidence:1,effects:[]}];
  const original=structuredClone(s),ends=beats.presentationEnds(s,null,{mode:'next',beats:4});
  assert.equal(ends.units.s1,w.endMs-100);
  assert.equal(ends.phrases[p.id],s.phrases[1].startMs);
  const rest=core.activeAt(s,8000,{displayEnds:ends.phrases}).phrases.find(x=>x.id===p.id);
  assert.ok(rest.persisted);assert.equal(rest.opacity,1);assert.deepEqual(rest.activeWords,[]);assert.deepEqual(rest.activeSyllables,[]);
  assert.deepEqual(s,original);assert.deepEqual(beats.presentationEnds(s,null,{mode:'off'}),{phrases:{},units:{}});
});

test('phrase overrides disable or replace the display default and reset through the revisioned operation',()=>{
  let s=score(),p=s.phrases[0];const original=structuredClone(p.words);
  s=core.applyOperation(s,{type:'setPhrasePersistence',phraseId:p.id,beats:0},s.revision);
  assert.equal(beats.displayEnds(s,map,{mode:'next'})[p.id],undefined);
  s=core.applyOperation(s,{type:'setPhrasePersistence',phraseId:p.id,beats:2},s.revision);
  assert.ok(Math.abs(beats.displayEnds(s,map,{mode:'next'})[p.id]-p.endMs-1000)<1e-6);
  s=core.applyOperation(s,{type:'setPhrasePersistence',phraseId:p.id,beats:null},s.revision);
  assert.equal(s.phrases[0].persistBeats,undefined);assert.deepEqual(s.phrases[0].words,original);
  assert.equal(beats.displayEnds(s,null,{mode:'next'})[p.id],10000);
});

test('linger uses song tempo and offset, respects overlapping phrases and each vocal lane, and ends with media',()=>{
  const s=score(),p=s.phrases[0];s.offsetMs=250;
  const ramp=tempo.validateTempoMap({...map,segments:[{startMs:0,bpm:60,transition:'linear',provenance:'manual'},{startMs:10000,bpm:180,transition:'step',provenance:'manual'}]});
  const end=beats.displayEnds(s,ramp,{mode:'beats',beats:2})[p.id];
  assert.ok(Math.abs(tempo.tempoAt(ramp,end+250).beat-tempo.tempoAt(ramp,p.endMs+250).beat-2)<1e-6);
  assert.deepEqual(beats.displayEnds(s,null,{mode:'beats',beats:2}),{});
  const last=s.phrases.at(-1);assert.equal(beats.displayEnds(s,null,{mode:'next'})[last.id],19750);
  const peer={...structuredClone(p),id:'peer',laneId:'backing',startMs:p.endMs-100,endMs:p.endMs+2000};s.phrases.push(peer);
  assert.equal(beats.displayEnds(s,null,{mode:'next'})[p.id],10000,'another lane does not truncate lead');
  peer.laneId=p.laneId;assert.equal(beats.displayEnds(s,null,{mode:'next'})[p.id],undefined,'overlapping lyric prevents stale phrase hold');
});


test('the final phrase in one lane yields to continuing vocals instead of sticking until media end',()=>{
  const s=score(),last=structuredClone(s.phrases[0]);
  s.phrases[0].endMs=3000;s.phrases[0].words.forEach((w,i)=>{w.startMs=1000+i*500;w.endMs=w.startMs+400;});last.id='last-backing';last.laneId='backing';last.startMs=3000;last.endMs=4000;last.words=last.words.map((w,i)=>({...w,id:'backing-'+i,startMs:3000+i*400,endMs:3400+i*400}));
  s.phrases.push(last);
  const original=structuredClone(s),ends=beats.displayEnds(s,null,{mode:'next'});
  assert.equal(ends[last.id],10000,'last backing phrase yields at the next lead entrance');
  assert.ok(core.activeAt(s,11000,{displayEnds:ends}).phrases.every(p=>p.id!==last.id));
  assert.deepEqual(s,original);
  const continuing=structuredClone(s);continuing.phrases[1].startMs=3500;
  assert.equal(beats.displayEnds(continuing,null,{mode:'next'})[last.id],undefined,'already singing voice prevents a stale final-lane hold');
  assert.ok(beats.displayEnds(s,map,{mode:'beats',beats:32})[last.id]>10000,'explicit beat duration retains lane independence');
});

test('Bounce and Glow beat cues preserve timing, replay deterministically and respect reduced motion',()=>{
 for(const effect of ['bounce','glow']){const s=score(),c={...cue,effect};const n=core.applyOperation(s,{type:'setBeatCue',cue:c},s.revision);assert.deepEqual(n.phrases,s.phrases);core.validateScore(JSON.parse(JSON.stringify(n)));const at=3250,first=beats.cueAt(c,map,at);beats.cueAt(c,map,3750);assert.deepEqual(beats.cueAt(c,map,at),first);if(effect==='bounce')assert.ok(first.y<0);else assert.ok(first.brightness>1.2);const reduced=beats.cueAt(c,map,at,true);assert.equal(reduced.y||0,0);assert.equal(reduced.scale,1);}
});
