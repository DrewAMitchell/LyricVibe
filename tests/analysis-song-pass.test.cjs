const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/analysis/native-live.js');
const songPass = require('../extension/analysis/song-pass.js');
const core = require('../extension/score-core.js');
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
