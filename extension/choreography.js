/* Deterministic presentation only: no score edits or wall-clock ownership. */
(function(root){
  const clamp=x=>Math.max(0,Math.min(1,x));
  const median=values=>{const sorted=values.filter(n=>n>0&&Number.isFinite(n)).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:0;};
  const token=text=>String(text).toLowerCase().replace(/[^a-z']/g,'');
  const lightWords=new Set(['a','an','the','and','or','of','to','in','it','is','as','at','on','for']);
  // Unknown syllable counts remain estimates; they never become timing evidence.
  function syllableCount(word){return word.syllables?.length||Math.max(1,(token(word.text).replace(/e$/,'').match(/[aeiouy]+/g)||[]).length);}
  function compose(score){
    const phrases=score.phrases.map(phrase=>{
      const words=phrase.words.filter(w=>!w.excluded),start=words[0]?.startMs,end=Math.max(...words.map(w=>w.endMs));
      return {phrase,words,start,end,rate:words.reduce((n,w)=>n+syllableCount(w),0)*1000/Math.max(1,end-start)};
    }).filter(p=>p.words.length);
    const typical=median(phrases.map(p=>p.rate)),cues={};
    for(const p of phrases){
      const next=phrases.filter(n=>n.phrase.laneId===p.phrase.laneId&&n.start>p.start).sort((a,b)=>a.start-b.start)[0];
      const gap=next?next.start-p.end:Math.max(0,(score.source?.durationMs??p.end)-(score.offsetMs||0)-p.end);
      const fast=p.rate>=4.5||p.rate>=3&&p.rate>=typical*1.3;
      const perSyllable=median(p.words.map(w=>(w.endMs-w.startMs)/syllableCount(w)));
      p.words.forEach((word,i)=>{
        const count=syllableCount(word),duration=word.endMs-word.startMs;
        const units=word.syllables?.length?word.syllables:[word];
        const sustained=units.filter(u=>u.endMs-u.startMs>=Math.min(1100,Math.max(600,perSyllable*1.65))*(u===word?count:1));
        const text=token(word.text),previous=p.words.slice(Math.max(0,i-2),i).map(w=>token(w.text));
        const direction=text==='up'?[0,-1]:text==='down'?[0,1]:['left','right'].includes(text)&&previous.includes('the')&&previous.includes('to')?[text==='left'?-1:1,0]:null;
        const impact=fast&&gap>=550&&i===p.words.length-1;
        const reasons=[...(sustained.length?['sustained']:[]),...(impact?['fast-then-stop']:[]),...(direction?['direction-'+text]:[])];
        cues[word.id]={wordId:word.id,phraseId:p.phrase.id,startMs:word.startMs,endMs:word.endMs,
          weight:(lightWords.has(text)?.78:1)+Math.min(.25,text.length*.018)+Math.min(.16,(count-1)*.06)+(impact?.4:0)+(sustained.length?.18:0),
          sustained:sustained.map(u=>({id:u.id,startMs:u.startMs,endMs:u.endMs})),impact,direction,reasons,
          evidence:{phraseSyllablesPerSecond:p.rate,pauseAfterMs:gap,syllableBasis:word.syllables?.length?'authored':'estimated-from-spelling'}};
      });
    }
    return cues;
  }
  // Geometry, expression, and authored beat accents use separate transform layers.
  function expressionAt(cue,now,{mode='classic',reduced=false,effects=[],automatic=true}={}){
    const out={x:0,y:0,turn:0,scale:1,color:null,brightness:1,reason:''};
    if(!cue||now<cue.startMs||now>=cue.endMs)return out;
    const elapsed=now-cue.startMs,t=elapsed/1000,duration=cue.endMs-cue.startMs;
    const envelope=Math.min(1,elapsed/90,(cue.endMs-now)/100),intensity=mode==='puzzle'?1:mode==='fall'?.72:.55;
    if(effects.length){
      out.reason='authored';
      for(const effect of effects){const strength=Math.max(0,Math.min(1,effect.strength??.3));
        if(!reduced&&effect.type==='shake')out.x+=Math.sin(t*Math.PI*12.5)*strength*2;
        if(!reduced&&effect.type==='tilt')out.turn+=Math.sin(t*Math.PI/0.6)*strength*2;
        if(!reduced&&effect.type==='pulse')out.scale+=((1-Math.cos(t*Math.PI/.5))/2)*strength*.025;
      }
      return out;
    }
    if(!automatic)return out;
    const held=cue.sustained?.find(u=>now>=u.startMs&&now<u.endMs);
    if(held){
      const phase=(now-held.startMs)/1000,breath=reduced?.5:(1-Math.cos(phase*Math.PI*2/1.15))/2;
      out.scale+=reduced?0:breath*.055*intensity*envelope;
      out.color=`hsl(${(42+breath*24).toFixed(2)} 92% ${(83-breath*15).toFixed(2)}%)`;
      out.brightness=1+breath*.12*envelope;out.reason='sustained';
    }
    if(cue.impact){
      const hit=clamp(1-elapsed/Math.min(360,duration));
      if(!reduced){out.scale+=hit*.11*intensity;out.y+=Math.sin(t*88)*hit*2*intensity;out.x+=Math.sin(t*113)*hit*1.5*intensity;}
      out.color='hsl(38 95% 78%)';out.brightness=1+hit*.2;out.reason='fast-then-stop';
    }
    if(cue.direction&&!reduced){const travel=Math.sin(Math.PI*clamp(elapsed/duration))*7*intensity;out.x+=cue.direction[0]*travel;out.y+=cue.direction[1]*travel;out.reason+=(out.reason?' + ':'')+'direction';}
    return out;
  }

  const dances=['tip','flex','bounce','launch'];
  function danceAt(cue,now,{kind='off',reduced=false,authored=false}={}){
    const out={kind:'off',x:0,y:0,turn:0,tip:0,flex:0,phase:0,scaleX:1,scaleY:1};
    if(!cue||now<cue.startMs||reduced||authored||kind==='off')return out;
    if(kind==='mix'){let hash=0;for(const ch of cue.wordId)hash=(hash*31+ch.charCodeAt(0))>>>0;kind=dances[hash%4];}
    if(!dances.includes(kind))return out;
    const u=clamp((now-cue.startMs)/Math.max(1,cue.endMs-cue.startMs)),t=u*4.2;
    const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};out.kind=kind;
    if(kind==='tip'){
      if(t<2.45)out.tip=0;
      else if(t<2.56)out.tip=-6*Math.sin(Math.PI*(t-2.45)/.11);
      else if(t<3.04)out.tip=82*smooth((t-2.56)/.48);
      else {const s=t-3.04;out.tip=s<.6?82-14*Math.exp(-6.5*s)*Math.abs(Math.sin(2*Math.PI*2.2*s)):82;}
    }else if(kind==='flex'){
      out.flex=Math.sin(t*4.3)*Math.sin(Math.min(1,t/1.9)*Math.PI)*(1-smooth((t-1.15)/1.4))*.20||0;out.phase=t*3.8;
    }else if(kind==='bounce'){
      const flights=[.60,.44,.32,.23,.17],heights=[.62,.34,.19,.10,.05];
      if(t<.68)out.y=-.78*(1-t/.68)**2;
      else {let elapsed=t-.68;for(let i=0;i<flights.length;i++){if(elapsed<flights[i]){const p=elapsed/flights[i];out.y=-heights[i]*4*p*(1-p);break;}elapsed-=flights[i];}}
      if(t>.64&&t<.83){out.scaleY=1-.17*Math.sin(Math.PI*(t-.64)/.19);out.scaleX=1+(1-out.scaleY)*.4;}
    }else if(kind==='launch'){
      const p=clamp(t/1.4);out.x=p===1?0:-.9*(1-p);out.y=-1.05*4*p*(1-p);out.turn=(-10+32*p)*Math.sin(Math.PI*p);
    }
    return out;
  }
  function arrival(now,start,lead=500,reduced=false){return reduced?1:1-Math.pow(1-clamp((now-start+lead)/lead),3);}
  function puzzle(words,width,height,measure,{upsideDown,maxFont,weights}){
    const weight=word=>Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
    let font=Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8);
    for(let attempt=0;attempt<90;attempt++,font*=.94){
      const gap=font*.12;
      const boxes=words.map((word,index)=>{
        const size=font*weight(word),angle=upsideDown&&index%5===2?180:0;
        const w=Math.max(size*.2,measure(word.text,size))+size*.08,h=size*1.3,vertical=angle===90;
        return {index,width:w,height:h,boxWidth:vertical?h:w,boxHeight:vertical?w:h,font:size,angle};
      }).sort((a,b)=>b.boxWidth*b.boxHeight-a.boxWidth*a.boxHeight||a.index-b.index);
      let free=[{x:0,y:0,w:width,h:height}],slots=[],failed=false;
      for(const box of boxes){
        const bw=box.boxWidth+gap,bh=box.boxHeight+gap;
        const candidates=free.filter(r=>r.w>=bw&&r.h>=bh).map(r=>{
          // Fit tightly around the existing words instead of constructing reading rows.
          const cost=Math.min(r.w-bw,r.h-bh)+.15*Math.max(r.w-bw,r.h-bh);
          return {r,cost};
        }).sort((a,b)=>a.cost-b.cost||a.r.y-b.r.y||a.r.x-b.r.x);
        if(!candidates.length){failed=true;break;}
        const r=candidates[0].r;
        // The largest word anchors the composition; subsequent words occupy its pockets.
        const x=slots.length?r.x:r.x+(r.w-bw)*.52,y=slots.length?r.y:r.y+(r.h-bh)*.56;
        const used={x,y,w:bw,h:bh};
        slots.push({...box,x:x+bw/2,y:y+bh/2});
        const split=[];
        for(const f of free){
          if(used.x>=f.x+f.w||used.x+used.w<=f.x||used.y>=f.y+f.h||used.y+used.h<=f.y){split.push(f);continue;}
          if(used.x>f.x)split.push({x:f.x,y:f.y,w:used.x-f.x,h:f.h});
          if(used.x+used.w<f.x+f.w)split.push({x:used.x+used.w,y:f.y,w:f.x+f.w-used.x-used.w,h:f.h});
          if(used.y>f.y)split.push({x:f.x,y:f.y,w:f.w,h:used.y-f.y});
          if(used.y+used.h<f.y+f.h)split.push({x:f.x,y:used.y+used.h,w:f.w,h:f.y+f.h-used.y-used.h});
        }
        free=split.filter((a,i)=>!split.some((b,j)=>i!==j&&a.x>=b.x&&a.y>=b.y&&a.x+a.w<=b.x+b.w&&a.y+a.h<=b.y+b.h&&(a.x>b.x||a.y>b.y||a.w<b.w||a.h<b.h||j<i)));
      }
      if(!failed)return slots.sort((a,b)=>a.index-b.index);
    }
    return null;
  }
  function ordered(words,width,height,measure,{maxFont,weights}){
    // Consecutive words share a row. Choose the largest readable multi-row lockup,
    // retaining each word's emphasis instead of sorting by its physical size.
    let best=null;
    for(let count=2;count<=Math.min(4,words.length);count++){
      const rows=Array.from({length:count},()=>[]);
      words.forEach((word,index)=>rows[Math.min(count-1,Math.floor(index*count/words.length))].push({word,index}));
      const boxes=rows.map(row=>row.map(({word,index})=>{
        const font=Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
        return {index,font,width:Math.max(font*.2,measure(word.text,font))+font*.08,height:font*1.3,angle:0};
      }));
      const rowWidths=boxes.map(row=>row.reduce((n,b)=>n+b.width,0)+.16*(row.length-1));
      const rowHeights=boxes.map(row=>Math.max(...row.map(b=>b.height)));
      const totalHeight=rowHeights.reduce((a,b)=>a+b,0)+.12*(count-1);
      const scale=Math.min(width/Math.max(...rowWidths),height/totalHeight,maxFont/Math.max(...boxes.flat().map(b=>b.font)));
      if(best&&best.scale>=scale)continue;
      let y=(height-totalHeight*scale)/2;const slots=[];
      boxes.forEach((row,r)=>{let x=0;for(const b of row){const w=b.width*scale,h=b.height*scale;slots[b.index]={...b,font:b.font*scale,width:w,height:h,boxWidth:w,boxHeight:h,x:x+w/2,y:y+rowHeights[r]*scale-h/2};x+=w+.16*scale;}y+=(rowHeights[r]+.12)*scale;});
      best={scale,slots};
    }
    return best?.slots;
  }
  function layout(words,width,height,measure,{mode='fall',upsideDown=false,maxFont=80,weights={},arrangement='chaotic',origin='top-left'}={}){
    width=Math.max(1,width);height=Math.max(1,height);
    if(!words.length)return [];
    if(mode==='puzzle'&&height>=140&&width>=180&&words.length>=3){
      const packed=arrangement==='ordered'?ordered(words,width,height,measure,{maxFont,weights}):puzzle(words,width,height,measure,{upsideDown,maxFont,weights});
      if(packed)return packed.map(slot=>({...slot,x:origin.endsWith('right')?width-slot.x:slot.x,y:origin.startsWith('bottom')?height-slot.y:slot.y}));
    }
    // A shallow strip gets a single readable line, never a squeezed word cloud.
    const singleLine=mode==='puzzle'&&height<140;mode=mode==='puzzle'?'fall':mode;
    const weight=word=>mode==='puzzle'?Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1)):1;
    let font=mode==='puzzle'?Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8):Math.min(maxFont,height*.28),rows,used;
    for(let attempt=0;attempt<80;attempt++,font*=.9){
      rows=[];let row={items:[],width:0,height:0};const gap=font*.22;
      for(let i=0;i<words.length;i++){
        const angle=0;
        const size=font*weight(words[i]),w=Math.max(size*.2,measure(words[i].text,size))+size*.08,h=size*1.3,vertical=Math.abs(angle)===90,bw=vertical?h:w,bh=vertical?w:h;
        if(!singleLine&&row.items.length&&row.width+gap+bw>width){rows.push(row);row={items:[],width:0,height:0};}
        const x=row.width+(row.items.length?gap:0);row.items.push({index:i,width:w,height:h,boxWidth:bw,boxHeight:bh,x,angle,font:size});row.width=x+bw;row.height=Math.max(row.height,bh);
      }
      if(row.items.length)rows.push(row);used=rows.reduce((sum,r)=>sum+r.height,0)+gap*Math.max(0,rows.length-1);
      if(used<=height&&rows.every(r=>r.width<=width))break;
    }
    let y=(height-used)/2;const slots=[];
    for(const row of rows){for(const item of row.items)slots[item.index]={...item,x:(width-row.width)/2+item.x+item.boxWidth/2,y:y+row.height/2};y+=row.height+font*.22;}
    return slots;
  }

  // The newest word keeps a fixed readable size. Only accumulated history compresses.
  function vinylTrack(score,measure){
    const tokens=[];let order=0;
    for(const phrase of score.phrases)for(const word of phrase.words){if(word.excluded)continue;tokens.push({id:word.id,phraseId:phrase.id,laneId:phrase.laneId,text:String(word.text).trim().toUpperCase(),startMs:word.startMs,endMs:word.endMs,order:order++});}
    tokens.sort((a,b)=>a.startMs-b.startMs||a.order-b.order);let total=0;
    for(const token of tokens){let x=0;token.chars=Array.from(token.text).map(text=>{const width=Math.max(.05,measure(text));const char={text,center:x+width/2,width};x+=width+.015;return char;});token.offset=total;token.textWidth=x;token.width=x+Math.max(.35,measure(' '));token.center=total+x/2;total+=token.width;}
    const decay=-Math.log(.78)/(2*Math.PI),capacity=Math.log(1/.18)/decay,entryFont=.21;
    // Integral of entryFont/(1+d/compression) gives the angle traveled. Capacity
    // affects distant history, never the font size of the word at the feed mouth.
    let low=.001,high=1e8;
    for(let i=0;i<64;i++){const k=(low+high)/2;if(entryFont*k*Math.log1p(total/k)>capacity)high=k;else low=k;}
    return {tokens,total,decay,entryFont,compression:low};
  }
  function vinylAt(track,clock,{reduced=false}={}){
    const started=track.tokens.filter(t=>clock>=t.startMs),latest=started.at(-1),active=started.filter(t=>clock<t.endMs);
    let head=0;const feeds=new Map();
    for(let i=0;i<started.length;i++){const token=started[i],duration=Math.max(1,Math.min(260,(token.endMs-token.startMs)*.35)),p=reduced?1:1-Math.pow(1-clamp((clock-token.startMs)/duration),3),previous=started[i-1]?.center??token.center;head=Math.max(head,previous+(token.center-previous)*p);feeds.set(token.id,p);}
    const tops=active.length?[...active].reverse():latest?[latest]:[],glyphs=[];
    for(const token of started){
      const row=tops.indexOf(token),current=clock<token.endMs,feed=feeds.get(token.id),fit=Math.min(1,1.65/(track.entryFont*Math.max(.1,token.textWidth))),age=Math.max(0,head-token.center),flatten=clamp(age/Math.max(6,token.width));
      for(const ch of token.chars){
        let x,y,angle,font,radius;
        if(row>=0){font=track.entryFont*fit;radius=1;angle=-Math.PI/2;x=(ch.center-token.textWidth/2)*font;y=-1-row*.25-(reduced?0:(1-feed)*.48);}
        else {const distance=head-token.offset-ch.center,d=Math.max(0,distance),winding=track.entryFont*track.compression*Math.log1p(d/track.compression);radius=Math.exp(-track.decay*winding);angle=-Math.PI/2-winding;font=track.entryFont*radius/(1+d/track.compression)*fit;x=radius*Math.cos(angle);y=radius*Math.sin(angle);const centerW=track.entryFont*track.compression*Math.log1p(age/track.compression),centerR=Math.exp(-track.decay*centerW),centerA=-Math.PI/2-centerW;const flatX=centerR*Math.cos(centerA)+(ch.center-token.textWidth/2)*font,flatY=centerR*Math.sin(centerA);x=flatX+(x-flatX)*flatten;y=flatY+(y-flatY)*flatten;angle=-Math.PI/2+(angle+Math.PI/2)*flatten;}
        glyphs.push({wordId:token.id,text:ch.text,radius,angle,font,x,y,current,feed:row>=0&&feed<1,top:row>=0});
      }
    }
    return {head,words:started.map(t=>t.id),text:started.map(t=>t.text).join(' '),glyphs,pipeWidth:Math.max(.65,...tops.map(t=>Math.min(1.65,t.textWidth*track.entryFont)))+.14};
  }
  function paintVinyl(ctx,track,clock,width,height,{reduced=false,ink='#f5f0e7',accent='#d9543e'}={}){
    const frame=vinylAt(track,clock,{reduced}),R=Math.max(1,Math.min(height*.345,width*.4)),cx=width*.5,cy=height*.59,head=-Math.PI/2;
    ctx.clearRect(0,0,width,height);ctx.save();ctx.fillStyle='#141416';ctx.beginPath();ctx.arc(cx,cy,R*1.09,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#414146';ctx.lineWidth=1;ctx.stroke();
    ctx.strokeStyle='rgba(232,223,208,.08)';ctx.beginPath();for(let f=0;f<80;f+=.08){const r=R*1.07*Math.exp(-track.decay*f),a=head-f;if(r<R*.13)break;f?ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a)):ctx.moveTo(cx+r*Math.cos(a),cy+r*Math.sin(a));}ctx.stroke();
    ctx.fillStyle=accent;ctx.beginPath();ctx.arc(cx,cy,R*.12,0,Math.PI*2);ctx.fill();ctx.fillStyle='#101113';ctx.beginPath();ctx.arc(cx,cy,Math.max(2,R*.014),0,Math.PI*2);ctx.fill();
    // Open-ended feed sleeve above twelve o'clock. Words travel between the rails.
    const mouth=cy-R,pipeTop=Math.max(height*.025,mouth-R*.64),pipeHalf=R*frame.pipeWidth/2;
    const shade=ctx.createLinearGradient(0,pipeTop,0,mouth);shade.addColorStop(0,'rgba(245,240,231,.015)');shade.addColorStop(1,'rgba(245,240,231,.09)');ctx.fillStyle=shade;ctx.fillRect(cx-pipeHalf,pipeTop,pipeHalf*2,mouth-pipeTop);ctx.strokeStyle='#77736d';ctx.lineWidth=Math.max(1,R*.004);ctx.beginPath();for(const side of [-1,1]){ctx.moveTo(cx+side*pipeHalf,pipeTop);ctx.lineTo(cx+side*pipeHalf,mouth-R*.02);ctx.lineTo(cx+side*(pipeHalf+R*.045),mouth+R*.035);}ctx.stroke();ctx.strokeStyle=accent;ctx.lineWidth=Math.max(2,R*.009);ctx.beginPath();ctx.moveTo(cx-pipeHalf-R*.04,mouth+R*.045);ctx.lineTo(cx-pipeHalf+R*.04,mouth+R*.045);ctx.moveTo(cx+pipeHalf-R*.04,mouth+R*.045);ctx.lineTo(cx+pipeHalf+R*.04,mouth+R*.045);ctx.stroke();
    const atlas=ctx.__lvVinylGlyphs||(ctx.__lvVinylGlyphs=new Map());
    for(const glyph of frame.glyphs){const color=glyph.current?ink:'#d0cbc3',key=color+'|'+glyph.text;let sprite=atlas.get(key);
      if(!sprite){const tile=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):ctx.canvas.ownerDocument.createElement('canvas'),brush=tile.getContext('2d');brush.font='800 100px Arial Narrow, Impact, sans-serif';tile.width=Math.ceil(brush.measureText(glyph.text).width)+12;tile.height=150;brush.font='800 100px Arial Narrow, Impact, sans-serif';brush.textAlign='center';brush.textBaseline='middle';brush.fillStyle=color;brush.fillText(glyph.text,tile.width/2,75);sprite=tile;if(atlas.size<512)atlas.set(key,sprite);}
      const scale=R*glyph.font/100;ctx.save();ctx.translate(cx+R*glyph.x,cy+R*glyph.y);ctx.rotate(glyph.angle+Math.PI/2);ctx.globalAlpha=glyph.top?1:.52+.48*glyph.radius;ctx.drawImage(sprite,-sprite.width*scale/2,-75*scale,sprite.width*scale,150*scale);ctx.restore();}
    ctx.restore();return frame;
  }
  const api={layout,arrival,compose,expressionAt,danceAt,vinylTrack,vinylAt,paintVinyl};root.LvChoreography=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
