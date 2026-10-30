const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../extension/score-core.js'),choreo=require('../extension/choreography.js');
const fixture=()=>core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01.00]HELLO MOON\n[00:05.00]',{provider:'fixture',entryId:'layers',contentHash:'a'.repeat(64)});
const apply=(score,op)=>core.applyOperation(score,op,score.revision);
test('performed layers compose over authored choreography and remove independently without retiming',()=>{
 let score=fixture(),word=score.phrases[0].words[0];word.effects=[{type:'glow',strength:.4}];const before=structuredClone(score.phrases);
 const layer=(id,type)=>({id,kind:'effect',target:{kind:'word',id:word.id},effect:{type,strength:.6},recordedAtMs:1200});
 score=apply(score,{type:'setChoreographyLayer',layer:layer('one','shake')});score=apply(score,{type:'setChoreographyLayer',layer:layer('two','pulse')});
 assert.deepEqual(score.phrases,before);const projected=core.projectChoreographyLayers(score,structuredClone(score.phrases));assert.deepEqual(projected[0].words[0].effects.map(e=>e.type),['glow','shake','pulse']);
 const cue={wordId:word.id,startMs:word.startMs,endMs:word.endMs};const pose=choreo.expressionAt(cue,word.startMs+150,{effects:projected[0].words[0].effects});assert.ok(pose.brightness>1);assert.notEqual(pose.x,0);assert.ok(pose.scale>1);
 score=apply(score,{type:'deleteChoreographyLayer',layerId:'one'});assert.equal(score.choreographyLayers[0].id,'two');assert.deepEqual(score.phrases,before);
 const base=choreo.expressionAt({...cue,rule:{word:'hello',motion:'off',effects:['glow']}},word.startMs+150,{automatic:true,effects:[{type:'shake',strength:.6,_layer:true}]});assert.ok(base.brightness>1);assert.notEqual(base.x,0);
});
test('placement follows stable target timing; ambiguous, missing and invalid inputs never retarget silently',()=>{
 let score=fixture(),word=score.phrases[0].words[0];const layer={id:'place',kind:'placement',target:{kind:'word',id:word.id},position:{x:.25,y:.6},landing:'glide',motion:'rock',recordedAtMs:1200};
 score=apply(score,{type:'setChoreographyLayer',layer});assert.equal(core.choreographyTargetAt(score,word.startMs+1).unit.id,word.id);assert.equal(core.choreographyTargetAt(score,0),null);
 const bad=structuredClone(layer);bad.position.x=2;assert.throws(()=>apply(score,{type:'setChoreographyLayer',layer:bad}));assert.equal(score.choreographyLayers[0].position.x,.25);
 const orphan=structuredClone(score);orphan.choreographyLayers[0].target.id='removed';assert.doesNotThrow(()=>core.validateScore(orphan));assert.equal(core.choreographyTarget(orphan,orphan.choreographyLayers[0].target),null);assert.throws(()=>apply(score,{type:'setChoreographyLayer',layer:orphan.choreographyLayers[0]}));
 const duplicated=structuredClone(score);duplicated.phrases[0].words[1].startMs=word.startMs;duplicated.phrases[0].words[1].endMs=word.endMs;assert.equal(core.choreographyTargetAt(duplicated,word.startMs+1),null);
 assert.throws(()=>core.applyOperation(score,{type:'deleteChoreographyLayer',layerId:'place'},score.revision-1));
});
test('selective base effect removal checks identity and retains siblings',()=>{
 let score=fixture(),word=score.phrases[0].words[0];word.effects=[{type:'glow',strength:.4},{type:'shake',strength:.5}];const target={kind:'word',id:word.id};
 assert.throws(()=>apply(score,{type:'deleteUnitEffect',target,index:0,expectedEffect:word.effects[1]}));
 const changed=apply(score,{type:'deleteUnitEffect',target,index:0,expectedEffect:word.effects[0]});assert.deepEqual(changed.phrases[0].words[0].effects,[word.effects[1]]);assert.equal(score.phrases[0].words[0].effects.length,2);
});

test('syllable layers resolve through score offset and never fall back to the whole word',()=>{
 let score=fixture(),word=score.phrases[0].words[0];score=apply(score,{type:'setWordSyllables',wordId:word.id,syllables:[{id:'hello-1',text:'HEL',startMs:word.startMs,endMs:Math.floor((word.startMs+word.endMs)/2)},{id:'hello-2',text:'LO',startMs:Math.floor((word.startMs+word.endMs)/2),endMs:word.endMs}]});score.offsetMs=-170;
 const syllable=score.phrases[0].words[0].syllables[0];const target=core.choreographyTargetAt(score,syllable.startMs+20-170,'syllable','lead');assert.equal(target.unit.id,syllable.id);
 const before=structuredClone(score.phrases);score=apply(score,{type:'setChoreographyLayer',layer:{id:'syllable-accent',kind:'effect',target:target.target,effect:{type:'shake',strength:.4},recordedAtMs:syllable.startMs+20-170}});
 const projected=core.projectChoreographyLayers(score,structuredClone(score.phrases));assert.equal(projected[0].words[0].syllables[0].effects[0].type,'shake');assert.deepEqual(score.phrases,before);assert.equal(core.choreographyTargetAt(fixture(),1200,'syllable'),null);
});
