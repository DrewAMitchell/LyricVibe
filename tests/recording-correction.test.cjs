const test=require('node:test'),assert=require('node:assert/strict');
const tap=require('../extension/tap-timing.js');
function fixture(){return tap.begin(['a','b','c','d'].map((id,i)=>({id,phraseId:id,wordId:id+'-word',text:id.toUpperCase(),minMs:0,maxMs:60000,estimatedStartMs:10000+i*10000,estimatedEndMs:15000+i*10000,timingEstimated:true})),{mode:'phrase',cadence:'pairs'});}
test('Backspace removes the live phrase, pulls later cues into its slots, and preserves the held entrance and earlier marks',()=>{
 let s=fixture();s=tap.mark(s,1000);s=tap.release(s,2000);s=tap.mark(s,3000);const before=structuredClone(s),r=tap.removeCurrentPhrase(s);
 assert.deepEqual(s,before);assert.deepEqual(r.units.map(u=>u.id),['a','c','d']);assert.deepEqual(r.units.map(u=>u.estimatedStartMs),[10000,20000,30000]);assert.equal(r.pendingStartMs,3000);assert.equal(r.index,1);assert.deepEqual(r.marks,s.marks);assert.deepEqual(r.removedPhraseIds,['b']);assert.deepEqual(tap.undo(r),{...s,actionHistory:s.actionHistory||[]});
 const end=tap.release(r,4000);assert.deepEqual(end.marks.at(-1),{id:'c',wordId:'c-word',startMs:3000,endMs:4000});assert.equal(end.units[end.index].id,'d');
});
test('Repeated removal without marks is retained, undoable, and ends without an empty armed cursor',()=>{
 const s=fixture();let r=tap.removeCurrentPhrase(s);r=tap.removeCurrentPhrase(r);assert.equal(r.units[0].id,'c');assert.equal(r.units[0].estimatedStartMs,10000);assert.equal(r.pendingStartMs,null);const before=structuredClone(r);r=tap.removeCurrentPhrase(r);r=tap.removeCurrentPhrase(r);assert.equal(r.status,'stopped');assert.equal(r.units.length,0);assert.equal(r.removedPhraseIds.length,4);assert.deepEqual(tap.undo(tap.undo(r)),before);
});
