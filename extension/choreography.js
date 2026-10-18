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
  // Bounded painted copies: no cloned DOM, random state or wall-clock animation.
  function accentShadow(type,phase,strength,reduced=false){
    if(reduced||strength<=0)return '';
    if(type==='echo'){
      const drift=(.07+.055*(1-Math.cos(phase*2*Math.PI)))*strength;
      return [1,2,3].map(i=>`${(-drift*i).toFixed(4)}em ${(drift*i*.3).toFixed(4)}em 0 color-mix(in srgb,currentColor ${[30,17,8][i-1]}%,transparent)`).join(',');
    }
    if(type==='glitch'){
      // Two brief splits per second-equivalent phase; no opacity flashing.
      const step=Math.floor(phase*8),burst=step%4===0;
      const d=(burst?.11:.018)*strength*(step%2?-1:1);
      return `${d.toFixed(4)}em 0 0 #47e8ed,${(-d).toFixed(4)}em .015em 0 #f16dbc`;
    }
    return '';
  }
  // Geometry, expression, and authored beat accents use separate transform layers.
  function expressionAt(cue,now,{mode='classic',reduced=false,effects=[],automatic=true}={}){
    const out={x:0,y:0,turn:0,scale:1,color:null,brightness:1,wave:0,wavePhase:0,reason:''};
    if(!cue||now<cue.startMs||now>=cue.endMs)return out;
    const elapsed=now-cue.startMs,t=elapsed/1000,duration=cue.endMs-cue.startMs;
    const envelope=Math.min(1,elapsed/90,(cue.endMs-now)/100),intensity=mode==='puzzle'?1:mode==='fall'?.72:.55;
    if(effects.length){
      out.reason='authored';
      for(const effect of effects){const strength=Math.max(0,Math.min(1,effect.strength??.3));
        if(!reduced&&effect.type==='groove'){out.wave=.16*strength*envelope;out.wavePhase=t*Math.PI*2/1.2;out.waveAxis=effect.axis||'vertical';}
        if(['echo','glitch'].includes(effect.type))out.shadow=accentShadow(effect.type,t,strength*envelope,reduced);
        if(effect.type==='glow')out.brightness=1+strength*(reduced?.2:.5*envelope);
        if(!reduced&&effect.type==='bounce')out.y-=Math.abs(Math.sin(t*Math.PI*2))*strength*12*envelope;
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
      if(!reduced){const ramp=clamp(Math.min(now-held.startMs,held.endMs-now)/280);out.wave=.045*(.65+.35*intensity)*ramp*ramp*(3-2*ramp);out.wavePhase=phase*Math.PI*2/2.8;}
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
  function puzzle(words,width,height,measure,{upsideDown,maxFont,minFont=0,weights}){
    const weight=word=>Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
    let font=Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8);
    for(let attempt=0;attempt<90;attempt++,font*=.94){
      const gap=font*.12;
      const boxes=words.map((word,index)=>{
        const size=Math.min(maxFont,Math.max(minFont,font*weight(word))),angle=upsideDown&&index%5===2?180:0;
        const w=Math.max(size*.2,measure(word.text,size,word))+size*.08,h=size*1.3,vertical=angle===90;
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
      if(font*1.8<=minFont)break;
    }
    return null;
  }
  function ordered(words,width,height,measure,{maxFont,minFont=0,weights}){
    // Measure at the actual font: fixed-pixel tracking must not be scaled a second time.
    const weight=word=>Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
    let best=null;
    for(let count=1;count<=Math.min(4,words.length);count++){
      const rows=Array.from({length:count},()=>[]);
      words.forEach((word,index)=>rows[Math.min(count-1,Math.floor(index*count/words.length))].push({word,index}));
      for(let scale=maxFont/Math.max(1,...words.map(weight)),attempt=0;attempt<90;attempt++,scale*=.94){
        if(best&&scale<=best.scale)break;
        const boxes=rows.map(row=>row.map(({word,index})=>{const font=Math.min(maxFont,Math.max(minFont,scale*weight(word)));return {index,font,width:Math.max(font*.2,measure(word.text,font,word))+font*.08,height:font*1.3,angle:0};}));
        const gap=scale*.16,rowGap=scale*.12,rowWidths=boxes.map(row=>row.reduce((n,b)=>n+b.width,0)+gap*(row.length-1)),rowHeights=boxes.map(row=>Math.max(...row.map(b=>b.height))),totalHeight=rowHeights.reduce((a,b)=>a+b,0)+rowGap*(count-1);
        if(Math.max(...rowWidths)>width||totalHeight>height){if(scale*1.8<=minFont)break;continue;}
        let y=(height-totalHeight)/2;const slots=[];
        boxes.forEach((row,r)=>{let x=0;for(const b of row){slots[b.index]={...b,boxWidth:b.width,boxHeight:b.height,x:x+b.width/2,y:y+rowHeights[r]-b.height/2};x+=b.width+gap;}y+=rowHeights[r]+rowGap;});
        best={scale,slots};break;
      }
    }
    return best?.slots;
  }
  function layout(words,width,height,measure,{mode='fall',upsideDown=false,maxFont=80,minFont=0,weights={},arrangement='chaotic',origin='top-left'}={}){
    width=Math.max(1,width);height=Math.max(1,height);minFont=Math.max(0,minFont);maxFont=Math.max(minFont,maxFont);
    if(!words.length)return [];
    if(mode==='puzzle'&&height>=140&&width>=180&&words.length>=3){
      const packed=arrangement==='ordered'?ordered(words,width,height,measure,{maxFont,minFont,weights}):puzzle(words,width,height,measure,{upsideDown,maxFont,minFont,weights});
      if(packed)return packed.map(slot=>({...slot,x:origin.endsWith('right')?width-slot.x:slot.x,y:origin.startsWith('bottom')?height-slot.y:slot.y}));
    }
    // A shallow strip gets a single readable line, never a squeezed word cloud.
    const singleLine=mode==='puzzle'&&height<140;mode=mode==='puzzle'?'fall':mode;
    const weight=word=>mode==='puzzle'?Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1)):1;
    let font=Math.max(minFont,mode==='puzzle'?Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8):Math.min(maxFont,height*.28)),rows,used;
    for(let attempt=0;attempt<80;attempt++,font=Math.max(minFont,font*.9)){
      rows=[];let row={items:[],width:0,height:0};const gap=font*.22;
      for(let i=0;i<words.length;i++){
        const angle=0;
        const size=font*weight(words[i]),w=Math.max(size*.2,measure(words[i].text,size,words[i]))+size*.08,h=size*1.3,vertical=Math.abs(angle)===90,bw=vertical?h:w,bh=vertical?w:h;
        if(!singleLine&&row.items.length&&row.width+gap+bw>width){rows.push(row);row={items:[],width:0,height:0};}
        const x=row.width+(row.items.length?gap:0);row.items.push({index:i,width:w,height:h,boxWidth:bw,boxHeight:bh,x,angle,font:size});row.width=x+bw;row.height=Math.max(row.height,bh);
      }
      if(row.items.length)rows.push(row);used=rows.reduce((sum,r)=>sum+r.height,0)+gap*Math.max(0,rows.length-1);
      if(used<=height&&rows.every(r=>r.width<=width)||font<=minFont)break;
    }
    let y=(height-used)/2;const slots=[];
    for(const row of rows){for(const item of row.items)slots[item.index]={...item,x:(width-row.width)/2+item.x+item.boxWidth/2,y:y+row.height/2};y+=row.height+font*.22;}
    return slots;
  }

  // Prefer the minimum, but keep the complete phrase visible when it cannot fit.
  function readablePages(words,width,height,measure,options={}){
    const fits=slots=>slots.every(s=>s.x-s.boxWidth/2>=-.01&&s.x+s.boxWidth/2<=width+.01&&s.y-s.boxHeight/2>=-.01&&s.y+s.boxHeight/2<=height+.01);
    let slots=layout(words,width,height,measure,options);
    if(!fits(slots))slots=layout(words,width,height,measure,{...options,minFont:0});
    return [{start:0,end:words.length,slots}];
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
    const rows=[],knots=[];
    tokens.forEach((token,i)=>{let row=rows.findIndex(end=>end<=token.startMs);if(row<0)row=rows.length;rows[row]=token.endMs;token.feedRow=row;token.departMs=token.endMs;const last=knots.at(-1);if(last?.time===token.startMs)last.value=token.center;else knots.push({time:token.startMs,value:token.center,slope:0});});
    for(let i=1;i<knots.length-1;i++){const a=(knots[i].value-knots[i-1].value)/(knots[i].time-knots[i-1].time),b=(knots[i+1].value-knots[i].value)/(knots[i+1].time-knots[i].time);knots[i].slope=a>0&&b>0?2*a*b/(a+b):0;}
    return {tokens,total,decay,entryFont,compression:low,knots,pipeWidth:Math.max(.65,...tokens.map(t=>Math.min(1.65,t.textWidth*entryFont)))+.14};
  }
  function vinylAt(track,clock,{reduced=false}={}){
    const smooth=x=>{const t=clamp(x);return t*t*t*(10+t*(-15+6*t));};
    const started=track.tokens.filter(t=>clock>=t.startMs),knots=track.knots,glyphs=[];
    let head=knots[0]?.value||0;
    for(let i=1;i<knots.length;i++){const a=knots[i-1],b=knots[i];if(clock>=b.time){head=b.value;continue;}if(clock>a.time){const span=b.time-a.time,t=(clock-a.time)/span,t2=t*t,t3=t2*t;head=(2*t3-3*t2+1)*a.value+(t3-2*t2+t)*span*a.slope+(-2*t3+3*t2)*b.value+(t3-t2)*span*b.slope;}break;}
    for(const token of started){
      const current=clock<token.endMs,duration=Math.max(1,Math.min(260,(token.endMs-token.startMs)*.35)),feed=reduced?1:smooth((clock-token.startMs)/duration),handoff=reduced?(clock>=token.departMs?1:0):smooth((clock-token.departMs)/260),fit=Math.min(1,1.65/(track.entryFont*Math.max(.1,token.textWidth))),age=Math.max(0,head-token.center)*handoff,flatten=smooth(age/Math.max(6,token.width));
      const centerW=track.entryFont*track.compression*Math.log1p(age/track.compression),centerR=Math.exp(-track.decay*centerW),centerA=-Math.PI/2-centerW,centerFont=track.entryFont*centerR/(1+age/track.compression)*fit;
      for(const ch of token.chars){
        const d=Math.max(0,age+token.textWidth/2-ch.center),winding=track.entryFont*track.compression*Math.log1p(d/track.compression),curveR=Math.exp(-track.decay*winding),curveA=-Math.PI/2-winding,curveFont=track.entryFont*curveR/(1+d/track.compression)*fit;
        const radius=centerR+(curveR-centerR)*flatten,font=centerFont+(curveFont-centerFont)*flatten,flatX=centerR*Math.cos(centerA)+(ch.center-token.textWidth/2)*centerFont,flatY=centerR*Math.sin(centerA),x=flatX+(curveR*Math.cos(curveA)-flatX)*flatten,y=flatY+(curveR*Math.sin(curveA)-flatY)*flatten-(token.feedRow*.25+(1-feed)*.48)*(1-handoff),angle=-Math.PI/2+(curveA+Math.PI/2)*flatten;
        glyphs.push({wordId:token.id,text:ch.text,radius,angle,font,x,y,current,feed:feed<1,top:handoff===0});
      }
    }
    return {head,words:started.map(t=>t.id),text:started.map(t=>t.text).join(' '),glyphs,pipeWidth:track.pipeWidth};
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
  function backingSettings(value={}){
    return {space:value?.space==='shared'?'shared':'separate',area:Number.isFinite(value?.area)?Math.max(.15,Math.min(.4,value.area)):.25};
  }
  // All backing lanes share one budget, independent of their phrase count.
  function vocalAreas(width,height,hasBacking,value){
    const settings=backingSettings(value),band=hasBacking?height*settings.area:0;
    return {main:{x:0,y:0,width,height:height-(settings.space==='separate'?band:0)},backing:{x:width*.1,y:height-band,width:width*.8,height:band}};
  }
  const firePalettes=Object.freeze({
    ember:['#5a160c','#a72b0c','#e95812','#ff9c27','#ffd263','#fff0b9','#fffef4'],
    blue:['#102e69','#1554a4','#178acb','#37bfe9','#80e5ff','#d5f7ff','#ffffff'],
    violet:['#321458','#662798','#a13dcc','#cf72ee','#efabff','#fbe0ff','#ffffff'],
    green:['#153c27','#247342','#48a94b','#8ad85b','#c6ef8c','#edffd5','#ffffff'],
    crimson:['#4c1126','#8e1939','#ca2c48','#f65a65','#ff9e98','#ffded0','#fffdfa'],
    ghost:['#293c4c','#4b6475','#758e9b','#a8bfc7','#d6e4e6','#f0f7f7','#ffffff']
  });
  // Stateless, advected pixel noise: seeking reconstructs the same fire and
  // there is no short scrolling-image reset. Color never changes its geometry.
  function fireFrame(sourceMs,{color='ember',reduced=false}={}){
    const width=64,height=32,time=reduced?1600:Math.floor(Math.max(0,Number(sourceMs)||0)/83)*83;
    const hash=(x,y)=>{let n=Math.imul(x,374761393)+Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;};
    const noise=(x,y)=>{const a=Math.floor(x),b=Math.floor(y),u=x-a,v=y-b,s=u*u*(3-2*u),t=v*v*(3-2*v);return (hash(a,b)*(1-s)+hash(a+1,b)*s)*(1-t)+(hash(a,b+1)*(1-s)+hash(a+1,b+1)*s)*t;};
    const pixels=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const drift=time*.0023,plume=noise(x/6+noise(y/8,time*.00023)*1.6,y/6+drift);
      const heat=.10+.44*y/(height-1)+plume*.55;
      let index=Math.max(1,Math.min(6,Math.floor(heat*6)));
      if(noise(x*.7,y*.8+time*.008)>.79&&heat>.4)index=6;
      pixels[y*width+x]=index;
    }
    const particles=(count,smoke)=>Array.from({length:count},(_,i)=>{const seed=i+(smoke?47:11),period=(smoke?3100:1700)+hash(seed,3)*1900,age=((time+hash(seed,9)*period)%period)/period;return {x:(hash(seed,4)-.5)*2.5+Math.sin(age*4+seed)*.13,y:(smoke?.15:.55)-age*(smoke?.65:.95),alpha:(smoke?.12:.8)*Math.sin(Math.PI*age),size:smoke?.06+.07*age:.025};});
    return {width,height,time,palette:firePalettes[color]||firePalettes.ember,pixels,embers:reduced?[]:particles(4,false),smoke:reduced?[]:particles(3,true)};
  }
  const api={accentShadow,layout,readablePages,arrival,compose,expressionAt,danceAt,vinylTrack,vinylAt,paintVinyl,backingSettings,vocalAreas,firePalettes,fireFrame};root.LvChoreography=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
