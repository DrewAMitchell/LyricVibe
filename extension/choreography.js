/* Deterministic presentation only: no score edits or wall-clock ownership. */
(function(root){
  const clamp=x=>Math.max(0,Math.min(1,x));
  function arrival(now,start,lead=500,reduced=false){return reduced?1:1-Math.pow(1-clamp((now-start+lead)/lead),3);}
  function layout(words,width,height,measure,{mode='fall',upsideDown=false,maxFont=80}={}){
    width=Math.max(1,width);height=Math.max(1,height);
    let font=Math.min(maxFont,height*.28),rows,used;
    for(let attempt=0;attempt<80;attempt++,font*=.9){
      rows=[];let row={items:[],width:0,height:0};const gap=font*.22;
      for(let i=0;i<words.length;i++){
        const angle=mode==='puzzle'?(upsideDown&&i%5===2?180:[0,90,0,-90][i%4]):0;
        const w=Math.max(font*.2,measure(words[i].text,font))+font*.08,h=font*1.3,vertical=Math.abs(angle)===90,bw=vertical?h:w,bh=vertical?w:h;
        if(row.items.length&&row.width+gap+bw>width){rows.push(row);row={items:[],width:0,height:0};}
        const x=row.width+(row.items.length?gap:0);row.items.push({index:i,width:w,height:h,boxWidth:bw,boxHeight:bh,x,angle});row.width=x+bw;row.height=Math.max(row.height,bh);
      }
      if(row.items.length)rows.push(row);used=rows.reduce((sum,r)=>sum+r.height,0)+gap*Math.max(0,rows.length-1);
      if(used<=height&&rows.every(r=>r.width<=width))break;
    }
    let y=(height-used)/2;const slots=[];
    for(const row of rows){for(const item of row.items)slots[item.index]={...item,x:(width-row.width)/2+item.x+item.boxWidth/2,y:y+row.height/2,font};y+=row.height+font*.22;}
    return slots;
  }
  const api={layout,arrival};root.LvChoreography=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
