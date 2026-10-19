const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),variant=require('../extension/timing-variant.js');
const base=()=>core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:20000},'[00:01.00]WE GO AGAIN\n[00:10.00]YOU STAY\n[00:19.00]',{provider:'fixture',entryId:'stage',contentHash:'a'.repeat(64)});
const area={id:'center',name:'Center stage',rect:{x:.1,y:.12,width:.8,height:.76},provenance:'manual'};
const region=(score,id,phraseIndex,startMs,endMs,rect=area.rect)=>({id,target:{kind:'phrase',id:score.phrases[phraseIndex].id},startMs,endMs,rect:structuredClone(rect),provenance:'manual'});

test('shared areas assign multiple phrase keyframes and detach to resolved snapshots in revisioned previews',()=>{
 const source=base();for(const word of source.phrases.flatMap(p=>p.words)){word.locked=true;word.provenance='manual';}
 let draft={...variant.merge(source,source),token:'stage-area',previewRevision:0};
 draft=variant.operate(draft,[{type:'setStageArea',area},{type:'setStageRegion',region:region(source,'first',0,1000,8000)},{type:'setStageRegion',region:region(source,'second',1,9000,16000)}]);
 const before=structuredClone(draft.score),regions=draft.score.stageRegions.map(r=>r.id);
 const grouped=variant.operate(draft,{type:'assignStageRegions',regionIds:regions,areaId:area.id});
 assert.deepEqual(grouped.score.stageRegions.map(r=>r.areaId),[area.id,area.id]);
 assert.ok(grouped.score.stageRegions.every(r=>!Object.hasOwn(r,'rect')));
 assert.deepEqual(grouped.score.stageRegions.map(r=>core.resolveStageRegionRect(grouped.score,r)),[area.rect,area.rect]);
 assert.deepEqual(grouped.score.phrases,source.phrases);assert.deepEqual(source.stageAreas,undefined);assert.deepEqual(draft.score,before);
 const movedRect={x:.2,y:.2,width:.6,height:.6},moved=variant.operate(grouped,{type:'setStageArea',area:{...area,rect:movedRect}});
 assert.deepEqual(moved.score.stageRegions.map(r=>core.resolveStageRegionRect(moved.score,r)),[movedRect,movedRect]);
 assert.deepEqual(moved.score.stageRegions,grouped.score.stageRegions,'Moving a shared area does not rewrite its keyframes');
 const detached=variant.operate(moved,{type:'assignStageRegions',regionIds:regions,areaId:null});
 assert.ok(detached.score.stageRegions.every(r=>!Object.hasOwn(r,'areaId')));
 assert.deepEqual(detached.score.stageRegions.map(r=>r.rect),[movedRect,movedRect]);
 assert.deepEqual(detached.score.phrases,source.phrases);
});

test('keyframe split uses exact half-open boundaries, replays deterministically, and rejects endpoints atomically',()=>{
 const source=base(),r=region(source,'long',0,1000,9000),saved=core.applyOperation(source,{type:'setStageRegion',region:r},source.revision);
 for(const atMs of [999,1000,9000,9001,1.5])assert.throws(()=>core.applyOperation(saved,{type:'splitStageRegion',regionId:r.id,atMs,newRegionId:'later'},saved.revision));
 assert.equal(saved.stageRegions.length,1);
 const split=core.applyOperation(saved,{type:'splitStageRegion',regionId:r.id,atMs:5000,newRegionId:'later'},saved.revision);
 assert.deepEqual(split.stageRegions.map(({id,startMs,endMs})=>({id,startMs,endMs})),[{id:'long',startMs:1000,endMs:5000},{id:'later',startMs:5000,endMs:9000}]);
 assert.equal(core.stageRegionAt(split,r.target.id,4999).id,'long');assert.equal(core.stageRegionAt(split,r.target.id,5000).id,'later');
 assert.throws(()=>core.applyOperation(split,{type:'splitStageRegion',regionId:'long',atMs:2000,newRegionId:'later'},split.revision),/unique/);
});

test('legacy inline regions validate and roundtrip unchanged while shared records resolve separately',()=>{
 const source=base(),legacy=region(source,'legacy',0,1000,9000),legacyBytes=JSON.stringify(legacy);
 const withLegacy=core.applyOperation(source,{type:'setStageRegion',region:legacy},source.revision);
 assert.equal(JSON.stringify(core.validateScore(JSON.parse(JSON.stringify(withLegacy))).stageRegions[0]),legacyBytes);
 const withArea=core.applyOperation(withLegacy,{type:'setStageArea',area},withLegacy.revision);
 assert.equal(JSON.stringify(withArea.stageRegions[0]),legacyBytes);
 const shared=core.applyOperation(withArea,{type:'setStageRegion',region:{id:'shared',target:legacy.target,startMs:9000,endMs:10000,areaId:area.id,provenance:'manual'}},withArea.revision);
 assert.deepEqual(core.resolveStageRegionRect(shared,shared.stageRegions[1]),area.rect);
 assert.deepEqual(core.stageRegionAt(shared,legacy.target.id,9500),shared.stageRegions[1]);
 assert.throws(()=>core.applyOperation(shared,{type:'deleteStageArea',areaId:area.id},shared.revision),e=>e.code==='AREA_IN_USE');
 assert.throws(()=>core.applyOperation(shared,{type:'deleteStageArea',areaId:'missing'},shared.revision),e=>e.code==='UNKNOWN_ID');
});

test('stage area and region schema rejects malformed references, identities and bounded-list overflow',()=>{
 const source=base(),r=region(source,'legacy',0,1000,9000);
 for(const change of [{id:''},{id:'x'.repeat(129)},{name:''},{name:'x'.repeat(81)},{name:4},{rect:{x:.99,y:0,width:.02,height:.1}},{provenance:'estimated'}])assert.throws(()=>core.validateScore({...source,stageAreas:[{...area,...change}]}));
 assert.throws(()=>core.validateScore({...source,stageAreas:[area,{...area,name:'duplicate'}]}));
 assert.throws(()=>core.validateScore({...source,stageAreas:Array.from({length:129},(_,i)=>({...area,id:`a${i}`}))}));
 for(const change of [{areaId:'missing'},{areaId:area.id,rect:r.rect},{rect:undefined,areaId:undefined}])assert.throws(()=>core.validateScore({...source,stageAreas:[area],stageRegions:[{...r,...change}]}));
 assert.throws(()=>core.validateScore({...source,stageRegions:Array.from({length:513},(_,i)=>({...r,id:`r${i}`,target:{kind:'phrase',id:source.phrases[0].id},startMs:i*20,endMs:i*20+10}))}));
 assert.throws(()=>core.applyOperation(source,{type:'setStageArea',area},source.revision-1),e=>e.code==='REVISION_CONFLICT');
});
