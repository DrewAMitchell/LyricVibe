const test=require('node:test'),assert=require('node:assert/strict');
const {layout,arrival,compose,expressionAt}=require('../extension/choreography.js');
const words='LET THE LIGHT FALL INTO PLACE AGAIN'.split(' ').map(text=>({text}));
const measure=(text,font)=>text.length*font*.6;
test('upright puzzle reserves nonoverlapping word bounds and requires opt-in for upside-down words',()=>{
  for(const [width,height]of [[1000,450],[350,200],[180,110]]){
    const slots=layout(words,width,height,measure,{mode:'puzzle'});
    assert.ok(slots.every(s=>s.angle===0),'automatic scattered layouts keep words upright');
    for(const s of slots){assert.ok(s.x-s.boxWidth/2>=-.001&&s.x+s.boxWidth/2<=width+.001);assert.ok(s.y-s.boxHeight/2>=-.001&&s.y+s.boxHeight/2<=height+.001);}
    for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){const a=slots[i],b=slots[j];assert.ok(Math.abs(a.x-b.x)>=(a.boxWidth+b.boxWidth)/2-.001||Math.abs(a.y-b.y)>=(a.boxHeight+b.boxHeight)/2-.001);}
    assert.deepEqual(slots,layout(words,width,height,measure,{mode:'puzzle'}));
  }
  assert.ok(layout(words,1000,450,measure,{mode:'puzzle',upsideDown:true}).some(s=>s.angle===180));
});
test('fall arrival is reconstructed from source time and settles exactly at entrance',()=>{
  assert.equal(arrival(499,1000),0);assert.equal(arrival(1000,1000),1);assert.equal(arrival(1500,1000),1);
  assert.equal(arrival(750,1000),.875);assert.equal(arrival(0,1000,500,true),1);
  assert.ok(layout(words,800,300,measure,{mode:'fall'}).every(s=>s.angle===0));
});

const word=(id,text,startMs,endMs,syllables)=>({id,text,startMs,endMs,effects:[],...(syllables?{syllables}:{} )});
function performance(){return {source:{durationMs:10000},phrases:[
  {id:'fast',laneId:'lead',words:['RUN','TO','THE','EDGE','STOP'].map((text,i)=>word('f'+i,text,i*160,(i+1)*160))},
  {id:'held',laneId:'lead',words:[word('h','HIGH',2200,4500)]},
  {id:'direction',laneId:'lead',words:[word('up','UP',5000,5500),word('right','RIGHT',5600,6100)]}
]};}
test('timing suggests held expression and a final fast-phrase impact without modifying sung edges',()=>{
  const score=performance(),before=JSON.stringify(score),cues=compose(score);
  assert.equal(cues.f4.impact,true);assert.equal(cues.f3.impact,false);
  assert.equal(cues.h.sustained.length,1);assert.ok(cues.h.weight>cues.f1.weight);
  assert.deepEqual(cues.up.direction,[0,-1]);assert.equal(cues.right.direction,null,'ambiguous RIGHT is not a direction');
  assert.equal(JSON.stringify(score),before);
  score.phrases[1].words[0].startMs=850;
  assert.equal(compose(score).f4.impact,false,'continuous phrases do not receive a false stop');
});
test('static layouts express held syllables, respect authored effects and reconstruct exactly after seek',()=>{
  const cues=compose(performance()),cue=cues.h;
  const still=expressionAt(cue,2775,{mode:'classic'}),puzzle=expressionAt(cue,2775,{mode:'puzzle'});
  assert.ok(still.scale>1&&still.color);assert.ok(puzzle.scale>still.scale);
  expressionAt(cue,4300);assert.deepEqual(expressionAt(cue,2775,{mode:'classic'}),still);
  const manual=expressionAt(cue,2775,{effects:[{type:'shake',strength:.8}]});
  assert.equal(manual.reason,'authored');assert.equal(manual.color,null);assert.equal(manual.scale,1);assert.notEqual(manual.x,0);
  const reduced=expressionAt(cues.f4,680,{reduced:true});assert.deepEqual([reduced.x,reduced.y,reduced.turn,reduced.scale],[0,0,0,1]);
  const off=expressionAt(cue,2775,{automatic:false});assert.equal(off.color,null);assert.equal(off.scale,1);
  assert.equal(expressionAt(cue,4500).color,null,'release ends expression even if display lingers');
});
test('weighted puzzle fills more of the available stage while preserving readable nonoverlapping slots',()=>{
  const score=performance(),words=score.phrases[0].words,cues=compose(score);
  const slots=layout(words,1000,500,measure,{mode:'puzzle',maxFont:200,weights:cues});
  assert.ok(slots[4].font>slots[1].font,'the stop is visually heavier than TO');
  assert.ok(Math.max(...slots.map(s=>s.font))>140,'the puzzle is no longer capped at 28% of height');
  for(const a of slots){assert.ok(a.font<=200);assert.ok(a.x-a.boxWidth/2>=-.01&&a.x+a.boxWidth/2<=1000.01);assert.ok(a.y-a.boxHeight/2>=-.01&&a.y+a.boxHeight/2<=500.01);}
  for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){const a=slots[i],b=slots[j];assert.ok(Math.abs(a.x-b.x)>=(a.boxWidth+b.boxWidth)/2-.01||Math.abs(a.y-b.y)>=(a.boxHeight+b.boxHeight)/2-.01);}
});

test('ordered puzzle keeps phrase order, emphasis and corner origins without changing chaotic default',()=>{
  const score=performance(),words=score.phrases[0].words,weights=compose(score),opts={mode:'puzzle',maxFont:200,weights};
  const chaotic=layout(words,1000,500,measure,opts),ordered=layout(words,1000,500,measure,{...opts,arrangement:'ordered'});
  assert.deepEqual(chaotic,layout(words,1000,500,measure,{...opts,arrangement:'chaotic'}));assert.notDeepEqual(chaotic,ordered);
  assert.ok(new Set(ordered.map(s=>s.y+s.height/2)).size>1);assert.ok(ordered[4].font>ordered[1].font);
  for(let i=1;i<ordered.length;i++){const a=ordered[i-1],b=ordered[i];assert.ok(b.y+b.height/2>a.y+a.height/2-.01&&(b.y+b.height/2>a.y+a.height/2+.01||b.x>a.x));}
  for(const origin of ['top-left','top-right','bottom-left','bottom-right']){
    const slots=layout(words,1000,500,measure,{...opts,arrangement:'ordered',origin});
    slots.forEach((s,i)=>{assert.equal(s.x,origin.endsWith('right')?1000-ordered[i].x:ordered[i].x);assert.equal(s.y,origin.startsWith('bottom')?500-ordered[i].y:ordered[i].y);assert.equal(s.angle,0);});
  }
  assert.ok(layout(words,1000,120,measure,{...opts,arrangement:'ordered'}).every(s=>s.angle===0));
});

const {danceAt}=require('../extension/choreography.js');
test('dance gestures reconstruct from source time, keep backward fall flat, and respect authored/reduced motion',()=>{
 const cue={wordId:'word-1',startMs:1000,endMs:5200};
 for(const kind of ['tip','flex','bounce','launch','mix']){
  const pose=danceAt(cue,1800,{kind});danceAt(cue,5000,{kind});assert.deepEqual(danceAt(cue,1800,{kind}),pose);
  assert.equal(danceAt(cue,999,{kind}).kind,'off');assert.equal(danceAt(cue,1800,{kind,reduced:true}).kind,'off');assert.equal(danceAt(cue,1800,{kind,authored:true}).kind,'off');
 }
 assert.equal(danceAt(cue,5200,{kind:'tip'}).tip,82);assert.equal(danceAt(cue,9000,{kind:'tip'}).tip,82);
 assert.equal(danceAt(cue,2400,{kind:'launch'}).x,0);assert.equal(danceAt(cue,5200,{kind:'bounce'}).y,0);
 assert.notEqual(danceAt(cue,1800,{kind:'flex'}).flex,0);assert.equal(danceAt(cue,5200,{kind:'flex'}).flex,0);
});
