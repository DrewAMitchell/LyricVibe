const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),variant=require('../extension/timing-variant.js'),choreo=require('../extension/choreography.js');
const make=()=>core.createScore({videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]hello\n[00:02.00]world\n[00:04.00]',{contentHash:'c'.repeat(64)}),item={id:'instrumental',type:'speakers',startMs:10000,endMs:16000,rect:{x:.1,y:.5,width:.8,height:.4},strength:.7,beatsPerPulse:1,provenance:'manual'};
test('performance items are timed source presentation independent of phrases and protected timing',()=>{
 const base=make();base.offsetMs=2300;base.phrases.flatMap(p=>p.words).forEach(w=>{w.locked=true;w.provenance='manual'});const before=structuredClone(base),draft=variant.merge(base,base),updated=variant.operate(draft,{type:'setStageItem',item});assert.deepEqual(updated.score.stageItems,[item]);assert.deepEqual(updated.score.phrases,base.phrases);assert.equal(updated.score.offsetMs,2300);assert.deepEqual(base,before);
 const changed=variant.operate(updated,{type:'setStageItem',item:{...item,strength:.3}});assert.equal(changed.score.stageItems.length,1);assert.equal(changed.score.stageItems[0].strength,.3);const removed=variant.operate(changed,{type:'deleteStageItem',itemId:item.id});assert.deepEqual(removed.score.stageItems,[]);assert.deepEqual(removed.score.phrases,base.phrases);
 for(const patch of [{type:'unknown'},{response:'auto'},{response:null},{endMs:10000},{startMs:-1},{strength:NaN},{strength:2},{beatsPerPulse:0},{rect:{x:.9,y:0,width:.3,height:.4}},{provenance:'guessed'}])assert.throws(()=>core.applyOperation(base,{type:'setStageItem',item:{...item,...patch}},base.revision));
 assert.throws(()=>core.validateScore({...base,stageItems:[item,item]}));assert.throws(()=>core.applyOperation(base,{type:'deleteStageItem',itemId:'missing'},base.revision));
});
test('live bass and beat grid remain independent saved choices; unavailable bass never fabricates beats',()=>{
 const base=make(),live={...item,response:'bass'},updated=core.applyOperation(base,{type:'setStageItem',item:live},base.revision);
 assert.equal(updated.stageItems[0].response,'bass');assert.deepEqual(updated.phrases,base.phrases);
 const at=(response,options={})=>choreo.stagePerformanceAt([{...item,response}],11000,{beat:22,...options})[0].energy;
 assert.equal(at(undefined),at('beat'));assert.equal(at('bass'),0);
 assert.equal(at('bass',{bass:1}),.7);assert.equal(at('bass',{bass:.5}),.35);
 assert.equal(at('beat',{bass:0}),at('beat',{bass:1}));assert.equal(at('bass',{bass:.5,beat:22.5}),.35);
 assert.equal(at('bass',{bass:NaN}),0);assert.equal(at('bass',{bass:4}),.7);
 assert.equal(at('bass',{bass:0,reduced:true}),at('bass',{bass:1,reduced:true}));
});
test('performance source-clock envelope, beat grid, replay, reduced motion and end clearing',()=>{
 assert.deepEqual(choreo.stagePerformanceAt([item],9999),[]);assert.deepEqual(choreo.stagePerformanceAt([item],16000),[]);
 const strong=choreo.stagePerformanceAt([item],11000,{beat:22})[0],weak=choreo.stagePerformanceAt([item],11250,{beat:22.5})[0];assert.ok(strong.cone>weak.cone);assert.deepEqual(strong,choreo.stagePerformanceAt([item],11000,{beat:22})[0]);assert.equal(strong.opacity,1);assert.equal(choreo.stagePerformanceAt([item],10000)[0].opacity,0);assert.ok(choreo.stagePerformanceAt([item],15990)[0].opacity<.01);
 assert.deepEqual(choreo.stagePerformanceAt([item],11000,{reduced:true}),choreo.stagePerformanceAt([item],11500,{reduced:true}));assert.equal(choreo.stagePerformanceAt([{...item,beatsPerPulse:2}],11000,{beat:23})[0].energy,0);
 const noLyrics={...make(),phrases:[],stageItems:[item]};core.validateScore(noLyrics);assert.equal(choreo.stagePerformanceAt(noLyrics.stageItems,11000).length,1);
});
