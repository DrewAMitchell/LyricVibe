const test=require('node:test'),assert=require('node:assert/strict'),core=require('../extension/score-core.js'),text=require('../extension/transcript-text.js'),variant=require('../extension/timing-variant.js');
const source={videoId:'TESTVIDEO01',durationMs:30000},meta={contentHash:'a'.repeat(64)};
const apply=(score,operations)=>operations.reduce((s,op)=>core.applyOperation(s,op,s.revision),score);
test('standalone and inline singers import without sung markers or header timing slots',()=>{
 const s=core.createPlainScore(source,'[Bubi]\none two\nthree four\n[Alice]five [Bubi]six',meta);
 assert.deepEqual(s.lanes.filter(l=>l.id.startsWith('vocal')).map(l=>[l.label,l.role]),[['Bubi','lead'],['Alice','lead']]);
 assert.deepEqual(s.phrases.map(p=>p.words.map(w=>w.text).join(' ')),['one two','three four','five','six']);
 assert.deepEqual(s.phrases.map(p=>p.startMs),[0,10000,20000,20000]);
 assert.equal(core.activeAt(s,20001).phrases.filter(p=>p.laneId.startsWith('vocal')).length,2);
 assert.deepEqual(text.diff(s,text.toText(s)).operations,[]);
 const lrc=core.createScore(source,'[Bubi]\n[00:01]one two\n[00:04][Alice]three four',meta);
 assert.deepEqual(lrc.phrases.map(p=>lrc.lanes.find(l=>l.id===p.laneId).label),['Bubi','Alice']);
 assert.deepEqual(core.parseLrc('[Chorus]\n[00:01]one\n[00:02]two'),[{timeMs:1000,text:'one'},{timeMs:2000,text:'two'}]);
});
test('inline reassignment partitions timed words without changing IDs, locks, syllables or effects',()=>{
 let s=core.createScore(source,'[00:01]one two three four\n[00:05]again',meta);
 s.phrases[0].words.forEach(w=>{w.locked=true;w.provenance='manual';w.effects=[{type:'glow',strength:.5}];w.syllables=[{id:w.id+'-syllable',text:w.text,startMs:w.startMs,endMs:w.endMs,provenance:'manual',locked:true,effects:[]}];});
 core.validateScore(s);const before=structuredClone(s.phrases.flatMap(p=>p.words));
 const plan=text.diff(s,'[Bubi]one two [Alice]three four\nagain');
 assert(plan.operations.some(o=>o.type==='splitPhraseLanes'));
 const draft={score:s,protectedIds:before.map(w=>w.id)};
 const out=variant.operate(draft,plan.operations).score;
 assert.deepEqual(out.phrases.flatMap(p=>p.words),before);
 assert.deepEqual(out.phrases.map(p=>out.lanes.find(l=>l.id===p.laneId).label),['Bubi','Alice','Lead']);
 assert.deepEqual(text.diff(out,text.toText(out)).operations,[]);
});
test('track name and role edits preserve timing and remain resolvable after reopening',()=>{
 const s=core.createPlainScore(source,'[Bubi]\none two\n[Alice]\nthree four',meta),lane=s.lanes.find(l=>l.label==='Bubi');
 const plan=text.diff(s,text.toText(s),{laneEdits:[{id:lane.id,label:'Singer 1',role:'backing'}]}),out=apply(s,plan.operations);
 assert.deepEqual(out.phrases,s.phrases);assert.match(text.toText(out),/\[Singer 1\]/);
 assert.deepEqual(text.diff(out,text.toText(out)).operations,[]);
 assert.throws(()=>apply(s,[{type:'setLane',laneId:lane.id,label:'Alice',role:'lead'}]),/distinct/);
 assert.throws(()=>apply(s,[{type:'splitPhraseLanes',phraseId:s.phrases[0].id,parts:[{laneId:'lead',wordIds:[s.phrases[0].words[0].id]},{laneId:'backing',wordIds:[s.phrases[0].words[0].id]}]}]),/partition/);
});
test('previously imported singer headers are hidden while sung words retain exact recorded data',()=>{
 let s=core.createScore(source,'[00:00]header\n[00:01]one two\n[00:04]three four',meta);
 s=core.applyOperation(s,{type:'setWordText',wordId:s.phrases[0].words[0].id,text:'[Bubi]'},s.revision);
 const before=structuredClone(s.phrases.slice(1)),plan=text.diff(s,text.toText(s)),out=apply(s,plan.operations);
 assert.equal(out.phrases[0].words[0].excluded,true);
 assert.deepEqual(out.phrases.slice(1).map(p=>p.words),before.map(p=>p.words));
 assert(out.phrases.slice(1).every(p=>p.laneId===out.lanes.find(l=>l.label==='Bubi').id));
 assert.deepEqual(text.diff(out,text.toText(out)).operations,[]);
});

test('joint singer headers share one duet track regardless of name order',()=>{
 const s=core.createPlainScore(source,'[Bubi & Ironmouse]\none two\n[Ironmouse & Bubi]\nthree four',meta);
 assert.equal(s.lanes.filter(l=>l.id.startsWith('vocal')).length,1);
 assert.equal(s.phrases[0].laneId,s.phrases[1].laneId);
 assert.deepEqual(text.diff(s,text.toText(s)).operations,[]);
});
