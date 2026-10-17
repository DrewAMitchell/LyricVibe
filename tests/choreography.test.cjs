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

const {vinylTrack,vinylAt}=require('../extension/choreography.js');
test('vinyl history keeps earlier words through rests and reconstructs exact prior poses after seeking',()=>{
 const score=performance(),before=JSON.stringify(score),track=vinylTrack(score,text=>text.length*.6);
 const early=vinylAt(track,1500),later=vinylAt(track,4700);assert.ok(later.words.length>early.words.length);assert.equal(later.words[0],early.words[0]);assert.ok(later.glyphs[0].radius<early.glyphs[0].radius);
 vinylAt(track,9000);assert.deepEqual(vinylAt(track,1500),early);assert.equal(vinylAt(track,-1).words.length,0);assert.equal(JSON.stringify(score),before);
 assert.equal(vinylAt(track,4700,{reduced:true}).words.length,later.words.length);assert.ok(later.glyphs.every(g=>!g.current),'history survives a silent gap without pretending words are still sung');
});
test('vinyl full-song capacity retains every nonexcluded word outside the spindle, including overlapping lanes',()=>{
 const score={phrases:[{id:'lead',laneId:'lead',words:Array.from({length:400},(_,i)=>word('w'+i,'REMEMBER',i*300,i*300+500))},{id:'back',laneId:'back',words:[word('b','ECHO',1000,1800),{...word('x','HIDDEN',0,500),excluded:true}]}]};
 const track=vinylTrack(score,text=>text.length*.6),frame=vinylAt(track,130000);assert.equal(frame.words.length,401);assert.equal(frame.glyphs.length,400*8+4);assert.ok(frame.glyphs.every(g=>g.radius>=.18&&g.radius<=1&&g.font>0));assert.equal(frame.words[0],'w0');assert.ok(frame.words.includes('b'));assert.ok(!frame.words.includes('x'));
});

test('vinyl newest words stay large, upright at twelve oclock, and feed down before winding inward',()=>{
 const score={phrases:[{id:'p',laneId:'lead',words:[word('a','READABLE',1000,1900),word('b','NEXT',2000,2900),word('c','LATER',3000,3900)]}]},measure=t=>t.length*.6,track=vinylTrack(score,measure);
 const entering=vinylAt(track,1000).glyphs,landed=vinylAt(track,1400).glyphs;
 assert.ok(entering.every(g=>g.angle===-Math.PI/2&&g.y<-1));assert.ok(landed.every(g=>g.angle===-Math.PI/2&&g.y===-1&&g.font>=.2));assert.ok(Math.abs((landed[0].x+landed.at(-1).x)/2)<.02);
 const later=vinylAt(track,3400),old=later.glyphs.filter(g=>g.wordId==='a'),current=later.glyphs.filter(g=>g.wordId==='c');assert.ok(old.every(g=>g.font<landed[0].font));assert.ok(current.every(g=>g.top&&g.angle===-Math.PI/2&&g.y===-1));
 const long=vinylTrack({phrases:[{...score.phrases[0],words:[...score.phrases[0].words,...Array.from({length:500},(_,i)=>word('extra'+i,'HISTORY',4000+i*300,4300+i*300))]}]},measure);assert.equal(vinylAt(long,1400).glyphs[0].font,landed[0].font,'song length must not shrink new words');
 assert.ok(vinylAt(track,1000,{reduced:true}).glyphs.every(g=>g.y===-1&&!g.feed));
});
test('vinyl overlapping vocals stay upright on separate feed rows and long current words fit',()=>{
 const score={phrases:[{id:'a',laneId:'lead',words:[word('a','SUPERCALIFRAGILISTIC',1000,3000)]},{id:'b',laneId:'back',words:[word('b','ECHO',1200,2600)]}]};const frame=vinylAt(vinylTrack(score,t=>t.length*.6),1600),a=frame.glyphs.filter(g=>g.wordId==='a'),b=frame.glyphs.filter(g=>g.wordId==='b');assert.ok(frame.glyphs.every(g=>g.current&&g.angle===-Math.PI/2));assert.notEqual(a[0].y,b[0].y);assert.ok(a.every(g=>Math.abs(g.x)<.83));
});

test('vinyl feed-to-disc positions, sizes and tangents remain continuous at overlap and release boundaries',()=>{
 const score={phrases:[{id:'p',laneId:'lead',words:[word('a','HOLD',1000,2600),word('b','NEXT',2000,3000),word('c','TURN',3200,4000)]}]},track=vinylTrack(score,t=>t.length*.6);
 const boundaries=[1260,2000,2260,2600,3000,3020,3200,3460,3620,4000];
 for(const time of boundaries){const before=vinylAt(track,time-.001),after=vinylAt(track,time+.001);for(const id of before.words){const a=before.glyphs.filter(g=>g.wordId===id),b=after.glyphs.filter(g=>g.wordId===id);a.forEach((g,i)=>{assert.ok(Math.hypot(g.x-b[i].x,g.y-b[i].y)<.0001,'position jump at '+time);assert.ok(Math.abs(g.font-b[i].font)<.0001,'size jump at '+time);assert.ok(Math.abs(g.angle-b[i].angle)<.0001,'rotation jump at '+time);});}assert.equal(before.pipeWidth,after.pipeWidth,'feed sleeve must not snap width');}
 const prior=vinylAt(track,2100).glyphs.filter(g=>g.wordId==='a'),next=vinylAt(track,2500).glyphs.filter(g=>g.wordId==='a');assert.deepEqual(prior.map(g=>[g.x,g.y,g.font]),next.map(g=>[g.x,g.y,g.font]),'held words retain their row and size while another voice starts');
 const pose=vinylAt(track,2785);vinylAt(track,5000);assert.deepEqual(vinylAt(track,2785),pose,'handoff reconstructs after seek');
});

test('held letter wobble is slow, bounded, source-clock repeatable and settles at the held edges',()=>{
 const cue={wordId:'long',startMs:1000,endMs:8000,sustained:[{id:'held',startMs:2000,endMs:7000}]};
 const pose=expressionAt(cue,3200);assert.ok(pose.wave>0&&pose.wave<=.045);assert.ok(pose.color);
 const later=expressionAt(cue,6000);assert.ok(Math.abs(later.wavePhase-pose.wavePhase-Math.PI*2)<1e-10);assert.equal(later.wave,pose.wave);
 assert.deepEqual(expressionAt(cue,3200),pose);
 for(const time of [1000,1999,2000,7000,7999,8000])assert.equal(expressionAt(cue,time).wave,0);
 assert.ok(expressionAt(cue,2001).wave<.00001);assert.ok(expressionAt(cue,6999).wave<.00001);
 for(const options of [{reduced:true},{automatic:false},{effects:[{type:'tilt'}]}])assert.equal(expressionAt(cue,3200,options).wave,0);
});


test('ordered puzzle measures actual font sizes and keeps short capped phrases on one compact row',()=>{
 const words=['READ','THE','WORDS'].map((text,i)=>({id:'spacing-'+i,text})),tracked=(text,font)=>text.length*(font*.55+4);
 const slots=layout(words,1000,500,tracked,{mode:'puzzle',arrangement:'ordered',maxFont:40});
 assert.equal(new Set(slots.map(s=>s.y+s.height/2)).size,1,'a short phrase does not force separate rows');
 for(const s of slots)assert.ok(Math.abs(s.width-(tracked(words[s.index].text,s.font)+s.font*.08))<.001,'slot widths must match real rendered font metrics, including absolute letter spacing');
 for(let i=1;i<slots.length;i++)assert.ok(slots[i].x-slots[i].width/2-(slots[i-1].x+slots[i-1].width/2)<10,'adjacent words have a compact gap');
});


test('preferred minimum yields to fitting the whole phrase without changing words or timing',()=>{
 const words=Array.from({length:18},(_,i)=>({id:'floor-'+i,text:'READABLE',startMs:i*500,endMs:i*500+450})),before=structuredClone(words);
 for(const mode of ['classic','fall','puzzle'])for(const arrangement of ['ordered','chaotic']){
  const options={mode,arrangement,minFont:32,maxFont:120},pages=require('../extension/choreography.js').readablePages(words,420,170,measure,options);
  assert.equal(pages.length,1);assert.ok(pages[0].slots.some(s=>s.font<32));assert.deepEqual(pages.flatMap(p=>p.slots.map(s=>s.index)),words.map((_,i)=>i));
  for(const p of pages)for(const s of p.slots){assert.ok(s.font>0);assert.ok(s.x-s.boxWidth/2>=-.01&&s.x+s.boxWidth/2<=420.01&&s.y-s.boxHeight/2>=-.01&&s.y+s.boxHeight/2<=170.01);}
  assert.deepEqual(require('../extension/choreography.js').readablePages(words,420,170,measure,options),pages);
 }
 assert.deepEqual(words,before);
 const single=require('../extension/choreography.js').readablePages([{id:'long',text:'SUPERCALIFRAGILISTIC'}],160,300,measure,{mode:'puzzle',minFont:32,maxFont:60});assert.ok(single[0].slots[0].font<32);assert.ok(single[0].slots[0].boxWidth<=160.01);
 const short=require('../extension/choreography.js').readablePages([{id:'short',text:'HI'}],420,170,measure,{mode:'classic',minFont:32,maxFont:60});assert.ok(short[0].slots[0].font>=32,'preferred minimum remains when the phrase fits');
});

test('backing has one bounded budget while shared space returns full main height',()=>{
  const {backingSettings,vocalAreas}=require('../extension/choreography.js');
  assert.deepEqual(backingSettings(),{space:'separate',area:.25});
  assert.deepEqual(backingSettings({space:'bad',area:5}),{space:'separate',area:.4});
  assert.equal(backingSettings({area:NaN}).area,.25);
  assert.deepEqual(vocalAreas(1000,800,true),{main:{x:0,y:0,width:1000,height:600},backing:{x:100,y:600,width:800,height:200}});
  assert.equal(vocalAreas(1000,800,true,{space:'shared',area:.3}).main.height,800);
  assert.equal(vocalAreas(1000,800,false).main.height,800);
});
