const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),choreo=require('../extension/choreography.js');
test('disco vocabulary shares source-clock local art with stable replay and reduced motion',()=>{
 const s=core.createPlainScore({videoId:'TESTVIDEO01',durationMs:10000},'Groove funk disco ordinary',{contentHash:'f'.repeat(64)}),before=structuredClone(s),cues=choreo.compose(s),words=s.phrases[0].words;
 for(const w of words.slice(0,3)){const cue=cues[w.id];assert.deepEqual(cue.rule.effects,['disco']);const t=w.startMs+(w.endMs-w.startMs)*.25,later=w.startMs+(w.endMs-w.startMs)*.75,a=choreo.wordRuleAt(cue,t);assert.equal(a.disco.beams.length,5);assert.equal(a.disco.facets.length,36);assert.notDeepEqual(choreo.wordRuleAt(cue,later).disco,a.disco);assert.deepEqual(choreo.wordRuleAt(cue,t),a);assert.deepEqual(choreo.wordRuleAt(cue,t,{reduced:true}).disco,choreo.wordRuleAt(cue,later,{reduced:true}).disco);assert.equal(choreo.wordRuleAt(cue,w.endMs),null);}
 assert.ok(!cues[words[3].id].rule);assert.deepEqual(s,before);
 const edited=core.applyOperation(s,{type:'setWordAppearance',wordId:words[3].id,appearance:{art:'disco'}},s.revision);assert.equal(edited.phrases[0].words[3].appearance.art,'disco');assert.deepEqual(edited.phrases[0].words.map(w=>[w.id,w.startMs,w.endMs]),words.map(w=>[w.id,w.startMs,w.endMs]));
});
