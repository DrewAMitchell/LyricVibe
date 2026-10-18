const test=require('node:test'),assert=require('node:assert/strict'),{layout,readablePages,layoutOrigins}=require('../extension/choreography.js');
const words=Array.from({length:24},(_,i)=>({id:'w'+i,text:['Let','the','music','move','around','the','edges','and','keep','the','picture','clear'][i%12]})),measure=(text,font)=>text.length*font*.55;
test('perimeter paths keep a clear center, disjoint bounds and opt-in top inversion',()=>{
 for(const [width,height]of [[1200,680],[390,700],[740,160]])for(const origin of Object.keys(layoutOrigins).filter(v=>v.startsWith('center-')))for(const upsideDown of [false,true]){
  const options={mode:'puzzle',origin,upsideDown,maxFont:220,minFont:40},slots=readablePages(words,width,height,measure,options)[0].slots,short=Math.min(width,height),core={left:short*.26,right:width-short*.26,top:short*.26,bottom:height-short*.26};assert.equal(slots.length,words.length);
  for(const a of slots){const r={left:a.x-a.boxWidth/2,right:a.x+a.boxWidth/2,top:a.y-a.boxHeight/2,bottom:a.y+a.boxHeight/2};assert.ok(r.left>=0&&r.right<=width&&r.top>=0&&r.bottom<=height,JSON.stringify({origin,width,height,r}));assert.ok(r.right<=core.left||r.left>=core.right||r.bottom<=core.top||r.top>=core.bottom);if(a.edge==='bottom')assert.equal(a.angle,0);if(a.edge==='top')assert.equal(a.angle,upsideDown?180:0);
   for(const b of slots.filter(b=>b.index>a.index))assert.ok(Math.abs(a.x-b.x)>=(a.boxWidth+b.boxWidth)/2-.01||Math.abs(a.y-b.y)>=(a.boxHeight+b.boxHeight)/2-.01,'overlap '+JSON.stringify({a,b,width,height}));
  }
  for(const ring of ['inner','outer']){const bottom=slots.filter(s=>s.edge==='bottom'&&s.ring===ring);assert.ok(bottom.every((s,i)=>!i||s.x>bottom[i-1].x),'upright bottom text reads left to right');}
  assert.equal(slots[0].ring,origin.startsWith('center-out-')?'inner':'outer');assert.deepEqual(slots,layout(words,width,height,measure,options));
 }
});
test('clockwise and counterclockwise traverse opposite edges and long words still fit',()=>{
 const opts={mode:'puzzle',maxFont:100},cw=layout(words,1200,680,measure,{...opts,origin:'center-out-cw'}),ccw=layout(words,1200,680,measure,{...opts,origin:'center-out-ccw'});assert.notDeepEqual(cw,ccw);assert.ok(cw.some(s=>s.edge==='left'));assert.ok(cw.some(s=>s.edge==='right'));assert.ok(Math.max(...cw.filter(s=>s.ring==='inner').map(s=>s.font))<Math.max(...cw.filter(s=>s.ring==='outer').map(s=>s.font)));
 for(const count of [1,2,80]){const w=Array.from({length:count},(_,i)=>({id:'x'+i,text:i?'word':'Supercalifragilisticexpialidocious'})),slots=readablePages(w,320,180,measure,{...opts,origin:'center-in-ccw'})[0].slots;assert.equal(slots.length,count);assert.ok(slots.every(s=>s.x-s.boxWidth/2>=0&&s.x+s.boxWidth/2<=320&&s.y-s.boxHeight/2>=0&&s.y+s.boxHeight/2<=180));}
});
