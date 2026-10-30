const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../extension/score-core.js'),choreo=require('../extension/choreography.js');
const fixture=()=>core.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01.00]HELLO MOON\n[00:05.00]',{provider:'fixture',entryId:'path',contentHash:'c'.repeat(64)});
const layer=(score,path)=>({id:'path-1',kind:'placement',target:{kind:'word',id:score.phrases[0].words[0].id},position:{x:.8,y:.7},landing:'settle',motion:'off',recordedAtMs:1200,path});
const apply=(s,l)=>core.applyOperation(s,{type:'setChoreographyLayer',layer:l},s.revision);
test('quadratic path uses authored progress, clamps endpoints and honors reduced motion',()=>{
 const score=fixture(),before=structuredClone(score.phrases),l=layer(score,{kind:'quadratic',start:{x:.2,y:.3},control:{x:.5,y:.1}}),result=apply(score,l);
 assert.deepEqual(result.phrases,before);assert.deepEqual(choreo.pathPosition(l,-1),l.path.start);assert.deepEqual(choreo.pathPosition(l,2),l.position);
 const mid=choreo.pathPosition(l,.5);assert.ok(Math.abs(mid.x-.5)<1e-10);assert.ok(Math.abs(mid.y-.3)<1e-10);assert.deepEqual(choreo.pathPosition(l,.2,true),l.position);
 const changed=structuredClone(l);changed.position={x:.9,y:.8};assert.equal(apply(result,changed).choreographyLayers.length,1);assert.deepEqual(score.phrases,before);
});
test('recorded samples interpolate by source-time fraction and reject invalid or unbounded paths atomically',()=>{
 const score=fixture(),l=layer(score,{kind:'recorded',points:[{t:0,x:.1,y:.2},{t:.25,x:.4,y:.6},{t:1,x:.8,y:.7}]});apply(score,l);
 const point=choreo.pathPosition(l,.125);assert.ok(Math.abs(point.x-.25)<1e-10);assert.ok(Math.abs(point.y-.4)<1e-10);
 for(const mutate of [l=>l.path.points[0].t=.1,l=>l.path.points[1].t=0,l=>l.path.points[1].x=NaN,l=>l.path.points.at(-1).x=.7,l=>l.path.points=Array(129).fill({t:0,x:0,y:0}),l=>l.path.kind='unknown']){const bad=structuredClone(l);mutate(bad);assert.throws(()=>apply(score,bad));assert.equal(score.choreographyLayers,undefined);}
});
