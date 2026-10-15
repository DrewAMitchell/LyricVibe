const test=require('node:test'),assert=require('node:assert/strict');
const {layout,arrival}=require('../extension/choreography.js');
const words='LET THE LIGHT FALL INTO PLACE AGAIN'.split(' ').map(text=>({text}));
const measure=(text,font)=>text.length*font*.6;
test('orthogonal puzzle reserves nonoverlapping word bounds and requires opt-in for upside-down words',()=>{
  for(const [width,height]of [[1000,450],[350,200],[180,110]]){
    const slots=layout(words,width,height,measure,{mode:'puzzle'});
    assert.ok(slots.some(s=>Math.abs(s.angle)===90));assert.ok(slots.every(s=>[0,90,-90].includes(s.angle)));
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
