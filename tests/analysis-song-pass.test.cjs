const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/analysis/native-live.js');
const songPass = require('../extension/analysis/song-pass.js');
const core = require('../extension/score-core.js');
test('only word timing changes can rebase an in-progress song capture', () => {
  const score=core.createScore({videoId:'FIXTURE0001',durationMs:30000},'[00:01]hello world\n[00:05]again',{contentHash:'c'.repeat(64)});
  const edited=structuredClone(score);edited.revision++;edited.phrases[0].words[0].endMs-=20;edited.phrases[0].words[0].locked=true;edited.phrases[0].words[0].provenance='manual';
  assert.equal(songPass.canRebaseCapture(score,edited),true);
  for(const mutate of [s=>s.offsetMs++,s=>s.phrases[0].endMs++,s=>s.phrases[0].words[0].text='changed',s=>s.phrases[0].laneId='backing',s=>s.lyrics.contentHash='d'.repeat(64)]){const next=structuredClone(edited);mutate(next);assert.equal(songPass.canRebaseCapture(score,next),false);}
});
test('a manually corrected word bounds the model windows on both sides without changing the score', () => {
  const score=core.createScore({videoId:'FIXTURE0001',durationMs:10000},'[00:01]i love you\n[00:05]again',{contentHash:'e'.repeat(64)});
  const phrase=score.phrases[0],word=phrase.words[1];word.startMs=2200;word.endMs=2800;word.provenance='manual';word.locked=true;
  const original=JSON.stringify(score),windows=songPass.plan(score).windows.filter(w=>w.phraseId===phrase.id);
  assert.deepEqual(windows.map(w=>[w.startMs,w.endMs,w.expectedWords.map(x=>x.text),w.anchor]),[[phrase.startMs,2200,['i'],false],[2200,2800,['love'],true],[2800,phrase.endMs,['you'],false]]);
  assert.ok(windows.every(w=>w.anchored));assert.equal(JSON.stringify(score),original);
});
test('a repeated phrase borrows a labelled relative timing prior only from one matching same-track phrase',()=>{
  const score=core.createScore({videoId:'FIXTURE0001',durationMs:30000},'[00:01]i love you\n[00:08]i love you\n[00:15]other',{contentHash:'f'.repeat(64)});
  const [first,second]=score.phrases;first.startMs=1000;first.endMs=5000;first.endEstimated=false;second.startMs=8000;second.endMs=12000;second.endEstimated=false;
  first.words[1].startMs=2200;first.words[1].endMs=2800;first.words[1].locked=true;first.words[1].provenance='manual';
  const before=JSON.stringify(score),prior=songPass.plan(score).windows.filter(w=>w.phraseId===second.id);
  assert.deepEqual(prior.map(w=>[w.startMs,w.endMs,w.prior]),[[8000,9100,'repeat'],[9100,9900,'repeat'],[9900,12000,'repeat']]);
  assert.equal(JSON.stringify(score),before);
  second.laneId='backing';assert.ok(songPass.plan(score).windows.filter(w=>w.phraseId===second.id).every(w=>!w.anchored));
});
test('song planner includes overlapping lanes and splits long phrases without altering source timing', () => {
  const score = core.createScore({videoId:'FIXTURE0001',durationMs:40000}, '[00:01]alpha beta gamma\n[00:15]other voice\n[00:30]end', {contentHash:'a'.repeat(64)});
  score.phrases[0].endMs=25000;
  score.phrases[0].words[0].startMs=1000; score.phrases[0].words[0].endMs=2000;
  score.phrases[0].words[1].startMs=13000; score.phrases[0].words[1].endMs=14000;
  score.phrases[0].words[2].startMs=24500; score.phrases[0].words[2].endMs=24900;
  score.phrases[1].laneId='backing';
  score.phrases[0].words[0].locked=true;
  const before=JSON.stringify(score), plan=songPass.plan(score);
  const lead=plan.windows.filter(w=>w.phraseId===score.phrases[0].id);
  assert.equal(lead.length, 3);
  assert.ok(lead.every(w=>w.endMs-w.startMs<=11500 && w.segmented && w.overlap));
  assert.ok(lead[0].expectedWords.some(w=>w.wordId===score.phrases[0].words[0].id));
  assert.ok(plan.windows.some(w=>w.phraseId===score.phrases[1].id && w.overlap));
  assert.equal(JSON.stringify(score),before);
});
test('song extraction refuses to disguise missing capture as complete phrase audio', () => {
  const pcm=new Int16Array(16000).fill(1000);
  const full=songPass.extract(pcm,pcm.length,1000,{startMs:1100,endMs:1800});
  assert.equal(full.clipped,false); assert.equal(full.samples.length,11200); assert.ok(full.samples[0]>0);
  assert.equal(songPass.extract(pcm,pcm.length,1000,{startMs:900,endMs:1800}).clipped,true);
  assert.equal(songPass.extract(pcm,pcm.length,1000,{startMs:1800,endMs:2100}).clipped,true);
});


test('adjacent phrases share a bounded model request without merging vocal lanes', () => {
  const score=core.createScore({videoId:'FIXTURE0001',durationMs:30000},'[00:01]first word\n[00:04]second phrase\n[00:15]later phrase',{contentHash:'b'.repeat(64)});
  const plan=songPass.plan(score), first=plan.windows.find(w=>w.expectedWords.some(x=>x.phraseId===score.phrases[0].id));
  assert.ok(first.expectedWords.some(x=>x.phraseId===score.phrases[1].id));
  assert.ok(first.endMs-first.startMs<=11500);
  assert.ok(plan.windows.some(w=>w.expectedWords.some(x=>x.phraseId===score.phrases[2].id)));
});
