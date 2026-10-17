const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),variant=require('../extension/timing-variant.js');
const base=()=>core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:20000},'[00:01.00]WE GO AGAIN\n[00:10.00]YOU STAY\n[00:19.00]',{provider:'fixture',entryId:'stage',contentHash:'a'.repeat(64)});
const region=(s,id='left',startMs=1000,endMs=9000)=>({id,target:{kind:'phrase',id:s.phrases[0].id},startMs,endMs,rect:{x:0,y:.1,width:.5,height:.8},provenance:'manual'});
test('timed regions roundtrip, use raw source time, and have unambiguous boundaries after backward seek',()=>{
 const s=base();s.offsetMs=250;const r=region(s);const next=core.applyOperation(s,{type:'setStageRegion',region:r},s.revision);
 assert.deepEqual(next.phrases,s.phrases);assert.equal(s.stageRegions,undefined);assert.equal(next.revision,s.revision+1);
 for(const time of [1000,6000,8999,1000])assert.deepEqual(core.stageRegionAt(next,r.target.id,time),r);
 assert.equal(core.stageRegionAt(next,r.target.id,999),null);assert.equal(core.stageRegionAt(next,r.target.id,9000),null);
 const adjacent=core.applyOperation(next,{type:'setStageRegion',region:{...r,id:'right',startMs:9000,endMs:10000,rect:{...r.rect,x:.5}}},next.revision);
 assert.equal(core.stageRegionAt(adjacent,r.target.id,9000).id,'right');assert.deepEqual(core.validateScore(JSON.parse(JSON.stringify(adjacent))),adjacent);
 assert.throws(()=>core.applyOperation(adjacent,{type:'setStageRegion',region:{...r,id:'conflict'}},adjacent.revision),/overlapping/);
 assert.throws(()=>core.applyOperation(next,{type:'deleteStageRegion',regionId:r.id},s.revision),e=>e.code==='REVISION_CONFLICT');
 const removed=core.applyOperation(next,{type:'deleteStageRegion',regionId:r.id},next.revision);assert.equal(removed.stageRegions.length,0);
});
test('invalid target, rectangle and interval reject atomically',()=>{
 const s=base(),before=JSON.stringify(s),r=region(s);
 for(const change of [{target:{kind:'word',id:s.phrases[0].words[0].id}},{target:{kind:'phrase',id:'missing'}},{rect:{x:.8,y:0,width:.5,height:.8}},{rect:{x:0,y:0,width:NaN,height:.8}},{startMs:10.5},{endMs:1000},{provenance:'estimated'}])assert.throws(()=>core.applyOperation(s,{type:'setStageRegion',region:{...r,...change}},s.revision),e=>e.code==='INVALID_SCORE');
 assert.equal(JSON.stringify(s),before);
});
test('word appearance catalog is closed and does not change locked timing or text',()=>{
 const s=base(),w=s.phrases[0].words[0];w.locked=true;w.provenance='manual';
 for(const look of core.DISPLAY_CATALOG.looks)for(const motion of core.DISPLAY_CATALOG.motions){const n=core.applyOperation(s,{type:'setWordAppearance',wordId:w.id,appearance:{look,motion}},s.revision);assert.deepEqual({...n.phrases[0].words[0],appearance:undefined},{...w,appearance:undefined});}
 for(const appearance of [{look:'unknown'},{motion:'eval'},{color:'red'},{},[]])assert.throws(()=>core.applyOperation(s,{type:'setWordAppearance',wordId:w.id,appearance},s.revision));
 const n=core.applyOperation(s,{type:'setWordAppearance',wordId:w.id,appearance:{motion:'off'}},s.revision);assert.equal(core.applyOperation(n,{type:'setWordAppearance',wordId:w.id,appearance:null},n.revision).phrases[0].words[0].appearance,undefined);
});
test('region and per-word appearance share protected preview operations and leave timing untouched',()=>{
 const s=base();for(const p of s.phrases)for(const w of p.words){w.locked=true;w.provenance='manual';}
 const draft={...variant.merge(s,s),token:'stage',previewRevision:0};const operations=[{type:'setStageRegion',region:region(s)},{type:'setWordAppearance',wordId:s.phrases[0].words[0].id,appearance:{look:'neon',motion:'bounce'}}];
 const next=variant.operate(draft,operations,false);assert.deepEqual(next.score.stageRegions,[region(s)]);assert.equal(next.score.phrases[0].words[0].appearance.look,'neon');assert.equal(next.score.phrases[0].words[0].startMs,s.phrases[0].words[0].startMs);assert.equal(draft.score.stageRegions,undefined);
});
