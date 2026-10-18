const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const LvScore=require('../extension/score-core.js'),LvTapTiming=require('../extension/tap-timing.js');
const source=fs.readFileSync(require.resolve('../extension/content.js'),'utf8');
const helpers=source.slice(source.indexOf('  function timedTakeTargets('),source.indexOf('  function recordingReport('));
function fixture(){
 const score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]Main line\n[00:05.00]Other line\n[00:10.00]',{contentHash:'a'.repeat(64)});
 const draft={score,token:'t',previewRevision:0,baseHash:score.lyrics.contentHash,baseRevision:0};
 const p=score.phrases[0],take=LvTapTiming.stop(LvTapTiming.mark(LvTapTiming.mark(LvTapTiming.begin([{id:p.id,phraseId:p.id,wordId:p.words[0].id,text:'Main line',minMs:0,maxMs:30000}],{mode:'phrase'}),1200),4200));
 const context={LvScore,timing:{draft},tapping:{take,binding:'youtube:TESTVIDEO01:t:0'},rawTake:t=>['performance-events','word-holds'].includes(t?.cadence),tapBinding:()=>`youtube:TESTVIDEO01:t:${context.timing.draft.previewRevision}`,recordingContext:()=>({mediaKey:'youtube:TESTVIDEO01',lyricsHash:score.lyrics.contentHash})};
 vm.createContext(context);vm.runInContext(helpers,context);
 return {context,draft,next:()=>({...structuredClone(draft),previewRevision:1}),run:preview=>{context.next=preview;vm.runInContext('rebindRecording(next)',context)}};
}
test('adding backing elsewhere retains captured phrase bytes and follows the new preview',()=>{
 const f=fixture(),before=JSON.stringify(f.context.tapping.take),next=f.next();next.score.phrases.push({...structuredClone(next.score.phrases[1]),id:'backing-added',laneId:'backing'});f.run(next);
 assert.equal(f.context.tapping.binding,'youtube:TESTVIDEO01:t:1');assert.equal(JSON.stringify(f.context.tapping.take),before);
});
test('edits to captured targets, lane, offset or source never relabel old evidence',()=>{
 for(const change of [p=>p.score.phrases[0].words[0].text='Changed',p=>p.score.phrases[0].words[0].startMs+=100,p=>p.score.phrases[0].laneId='backing',p=>p.score.offsetMs=100,p=>p.score.source.videoId='TESTVIDEO02']){
  const f=fixture(),next=f.next(),before=JSON.stringify(f.context.tapping.take);change(next);f.run(next);assert.equal(f.context.tapping.binding,'youtube:TESTVIDEO01:t:0');assert.equal(JSON.stringify(f.context.tapping.take),before);
 }
});
test('an old empty listening cursor cannot block a fresh pass after transcript corrections',()=>{
 const f=fixture(),t=f.context.tapping;t.take={...t.take,marks:[],actionHistory:[],status:'stopped',pendingStartMs:null};f.context.timing.draft.previewRevision=4;const next=f.next();next.previewRevision=4;next.score.phrases[0].words[0].text='Corrected';const before=JSON.stringify(next);f.run(next);assert.equal(t.take,null);assert.equal(JSON.stringify(next),before);
});
test('empty-looking take with undo evidence or a pending hold is retained',()=>{
 for(const patch of [{actionHistory:[{marks:[{id:'old'}]}]},{pendingStartMs:1000},{status:'armed'}]){
 const f=fixture();Object.assign(f.context.tapping.take,{marks:[],actionHistory:[],status:'stopped',pendingStartMs:null},patch);f.context.timing.draft.previewRevision=4;const before=JSON.stringify(f.context.tapping.take);f.run(f.next());assert.equal(JSON.stringify(f.context.tapping.take),before);assert.equal(f.context.tapping.binding,'youtube:TESTVIDEO01:t:0');
 }
});
