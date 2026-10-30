const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../extension/choreography.js'),S=require('../extension/score-core.js');
const fixture=()=>({phrases:[{id:'p',laneId:'lead',words:[{id:'a',text:'moon',startMs:0,endMs:800},{id:'b',text:'no',startMs:800,endMs:1100}]}]});
test('held qualification respects threshold and per-word opt-in/out without changing timing',()=>{
  const score=fixture(),before=structuredClone(score);
  assert.equal(C.compose(score,[],{heldRule:'duration',heldMinMs:800}).a.sustained.length,1);
  assert.equal(C.compose(score,[],{heldRule:'duration',heldMinMs:801}).a.sustained.length,0);
  assert.equal(C.compose(score,[],{heldRule:'off'}).a.sustained.length,0);
  assert.deepEqual(score,before);
  score.phrases[0].words[0].appearance={held:'never'};score.phrases[0].words[1].appearance={held:'always'};
  const cues=C.compose(score,[],{heldRule:'off'});assert.equal(cues.a.sustained.length,0);assert.equal(cues.b.sustained.length,1);
  score.phrases[0].words[0].appearance=undefined;score.phrases[0].words[0].syllables=[{id:'s1',startMs:0,endMs:200},{id:'s2',startMs:200,endMs:800}];
  assert.deepEqual(C.compose(score,[],{heldRule:'duration',heldMinMs:600}).a.sustained.map(s=>s.id),['s2']);
});
test('held effect selection preserves authored priority, layers, reduced motion and seek determinism',()=>{
  const cue=C.compose(fixture(),[],{heldRule:'duration',heldMinMs:800}).a;
  const glow=C.expressionAt(cue,400,{heldEffect:'glow'});assert.ok(glow.brightness>1);assert.equal(glow.wave,0);
  assert.equal(C.expressionAt(cue,400,{heldEffect:'off'}).reason,'');
  assert.ok(C.expressionAt(cue,400,{heldEffect:'groove'}).wave>0);
  assert.equal(C.expressionAt(cue,400,{heldEffect:'groove',reduced:true}).wave,0);
  assert.equal(C.expressionAt(cue,400,{heldEffect:'groove',effects:[{type:'glow'}]}).wave,0);
  assert.equal(C.expressionAt(cue,400,{heldEffect:'off',effects:[{type:'glow',_layer:true}]}).wave,0);
  assert.deepEqual(C.expressionAt(cue,400,{heldEffect:'glow'}),glow);
  assert.equal(C.expressionAt(cue,800,{heldEffect:'glow'}).brightness,1);
});
test('word held override round-trips through score operations and rejects unknown values',()=>{
  const score=S.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:3000},'[00:00.00]moon\n[00:02.00]',{provider:'fixture',entryId:'hold',contentHash:'a'.repeat(64)}),id=score.phrases[0].words[0].id;
  const edited=S.applyOperation(score,{type:'setWordAppearance',wordId:id,appearance:{held:'never'}},score.revision);
  assert.equal(edited.phrases[0].words[0].appearance.held,'never');S.validateScore(JSON.parse(JSON.stringify(edited)));
  assert.throws(()=>S.applyOperation(score,{type:'setWordAppearance',wordId:id,appearance:{held:'maybe'}},score.revision),/appearance/);
  assert.equal(S.applyOperation(edited,{type:'setWordAppearance',wordId:id,appearance:null},edited.revision).phrases[0].words[0].appearance,undefined);
});
