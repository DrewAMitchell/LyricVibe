const test=require('node:test'),assert=require('node:assert/strict'),S=require('../extension/score-core.js');
const make=()=>S.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01.00]Hello world\n[00:04.00]Again\n[00:08.00]',{provider:'test',entryId:'coverage',contentHash:'a'.repeat(64)});
test('phrase, word and syllable coverage require every included unit; estimates never count',()=>{
  let s=make();const p=s.phrases[0],w=p.words[0];
  assert.equal(S.phraseTimingCoverage(p).phrase.status,'unstarted');
  s=S.applyOperation(s,{type:'setPhraseTiming',phraseId:p.id,startMs:1000,endMs:4000},s.revision);
  assert.equal(S.phraseTimingCoverage(s.phrases[0]).phrase.status,'complete');assert.equal(S.phraseTimingCoverage(s.phrases[0]).word.status,'unstarted');
  s=S.applyOperation(s,{type:'setWordTiming',wordId:w.id,startMs:1000,endMs:2000},s.revision);
  assert.equal(S.phraseTimingCoverage(s.phrases[0]).word.status,'partial');
  s=S.applyOperation(s,{type:'setWordSyllables',wordId:w.id,syllables:[{id:'hel',text:'Hel',startMs:1000,endMs:1500,provenance:'manual',locked:true},{id:'lo',text:'lo',startMs:1500,endMs:2000,provenance:'estimated',locked:false}]},s.revision);
  const c=S.phraseTimingCoverage(s.phrases[0]);assert.equal(c.syllable.status,'partial');assert.equal(c.syllable.done,1);assert.equal(c.syllable.total,3);assert.equal(c.syllable.nextWordId,w.id);
  const before=JSON.stringify(s);assert.equal(S.timingCoverage(s)[0].modes.syllable.status,'partial');assert.equal(S.timingCoverage(s)[0].modes.syllable.done,0);assert.equal(JSON.stringify(s),before);
});
test('lane coverage separates overlapping backing, excludes hidden lyrics, and survives save roundtrip',()=>{
  const s=make();s.lanes.push({id:'back',role:'backing',label:'Backing'});s.phrases[1].laneId='back';s.phrases[1].startMs=1000;
  for(const w of s.phrases[0].words){w.provenance='manual';w.locked=true;w.syllables=[{id:w.id+'-s',text:w.text,startMs:w.startMs,endMs:w.endMs,provenance:'manual',locked:true,effects:[]}];}
  let lanes=S.timingCoverage(JSON.parse(JSON.stringify(s)));assert.equal(lanes[0].modes.syllable.status,'complete');assert.equal(lanes.find(l=>l.id==='back').modes.word.status,'unstarted');
  s.phrases[1].words[0].excluded=true;lanes=S.timingCoverage(s);assert.equal(lanes.find(l=>l.id==='back').modes.word.status,'empty');assert.equal(lanes.find(l=>l.id==='back').phrases.length,0);
  s.phrases[0].words[0].syllables[0].endMs=s.phrases[0].words[0].syllables[0].startMs;assert.equal(S.timingCoverage(s)[0].modes.syllable.status,'partial');
});
