/* Source-clock beat presentation. No score timing mutation or wall-clock progression. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./tap-timing.js'):root.LvTapTiming);if(typeof module==='object'&&module.exports)module.exports=api;root.LvBeatTrack=api;})(globalThis,function(tempo){
  function lingerSettings(value={}){
    return {mode:['off','next','beats'].includes(value?.mode)?value.mode:'off',beats:Number.isFinite(value?.beats)&&value.beats>=.25&&value.beats<=64?value.beats:4};
  }
  function phraseLinger(phrase,settings){return phrase.persistBeats!==undefined?{mode:phrase.persistBeats>0?'beats':'off',beats:phrase.persistBeats}:lingerSettings(settings);}
  function lingerEnd(end,next,score,map,settings){
    const sourceEnd=end+score.offsetMs;
    if(settings.mode==='off'||sourceEnd<0)return end;
    const until=settings.mode==='next'?Infinity:map?tempo.tempoTimeAtBeat(map,tempo.tempoAt(map,sourceEnd).beat+settings.beats)-score.offsetMs:end;
    const mediaEnd=Number.isFinite(score.source.durationMs)&&score.source.durationMs>0?score.source.durationMs-score.offsetMs:Number.isFinite(next)?next:Number.isFinite(until)?until:end;
    return Math.max(end,Math.min(until,next??mediaEnd,mediaEnd));
  }
  function displayEnds(score,map,settings){
    const ends={};
    for(const phrase of score.phrases){
      const policy=phraseLinger(phrase,settings),audible=score.phrases.filter(p=>p.id!==phrase.id&&p.words.some(w=>!w.excluded));
      let peers=audible.filter(p=>p.laneId===phrase.laneId);
      // A finished vocal lane must not leave its last line beside the rest of the song.
      // Keep independent lanes while they continue; only an unbounded final hold yields.
      if(policy.mode==='next'&&!peers.some(p=>p.endMs>phrase.endMs))peers=audible;
      const next=peers.filter(p=>p.startMs>=phrase.endMs).sort((a,b)=>a.startMs-b.startMs)[0];
      const overlap=peers.some(p=>p.startMs<phrase.endMs&&p.endMs>phrase.endMs);
      const end=overlap?phrase.endMs:lingerEnd(phrase.endMs,next?.startMs,score,map,policy);
      if(end>phrase.endMs)ends[phrase.id]=end;
    }
    return ends;
  }
  function presentationEnds(score,map,settings){
    const units={},atoms=score.phrases.flatMap(p=>p.words.filter(w=>!w.excluded).flatMap(w=>(w.syllables?.length?w.syllables:[w]).map(u=>({...u,laneId:p.laneId}))));
    for(const phrase of score.phrases){
      const policy=phraseLinger(phrase,settings),lane=atoms.filter(u=>u.laneId===phrase.laneId);
      for(const word of phrase.words.filter(w=>!w.excluded))for(const item of [word,...(word.syllables||[])]){
        const other=lane.filter(u=>u.id!==item.id),next=other.filter(u=>u.startMs>=item.endMs).sort((a,b)=>a.startMs-b.startMs)[0];
        if(other.some(u=>u.startMs<item.endMs&&u.endMs>item.endMs))continue;
        const end=lingerEnd(item.endMs,next?.startMs,score,map,policy);
        if(end>item.endMs)units[item.id]=end;
      }
    }
    return {phrases:displayEnds(score,map,settings),units};
  }
  function cueAt(cue,map,sourceMs,reducedMotion=false,knownBeat){
    const beat=knownBeat??tempo.tempoAt(map,sourceMs)?.beat;if(beat===undefined||beat<cue.beat||beat>=cue.beat+cue.durationBeats)return null;
    const elapsed=beat-cue.beat,phase=elapsed-Math.floor(elapsed),strength=cue.strength;
    if(reducedMotion)return {scale:1,brightness:1+.12*strength,hue:0,glow:.12*strength};
    const pulse=Math.max(0,1-phase/.35)**2;
    if(['echo','glitch'].includes(cue.effect))return {scale:1,brightness:1,hue:0,glow:0,accent:{type:cue.effect,phase:elapsed/2,strength:strength*Math.min(1,elapsed/.15,(cue.durationBeats-elapsed)/.15)}};
    if(cue.effect==='groove')return {scale:1,brightness:1,hue:0,glow:0,groove:{phase:elapsed*Math.PI,strength:strength*Math.min(1,elapsed/.25,(cue.durationBeats-elapsed)/.25),axis:cue.axis||'vertical'}};
    if(cue.effect==='bounce')return {scale:1,brightness:1+.1*strength,hue:0,glow:0,y:-Math.sin(Math.PI*phase)*12*strength};
    if(cue.effect==='glow')return {scale:1,brightness:1+.5*strength,hue:0,glow:.5*strength};
    if(cue.effect==='breath'){const wave=(1-Math.cos(2*Math.PI*elapsed/4))/2;return {scale:1+.05*strength*wave,brightness:1+.2*strength*wave,hue:0,glow:.2*strength*wave};}
    if(cue.effect==='color')return {scale:1,brightness:1+.2*strength,hue:35*strength*Math.sin(2*Math.PI*elapsed/4),glow:.2*strength};
    return {scale:1+.09*strength*pulse,brightness:1+.35*strength*pulse,hue:0,glow:.3*strength*pulse};
  }
  function clickSchedule(map,sourceMs,rate=1,lookAheadMs=120){
    if(!map||!Number.isFinite(sourceMs)||sourceMs<0||!Number.isFinite(rate)||rate<=0)return [];
    const first=Math.ceil(tempo.tempoAt(map,sourceMs).beat-1e-7)+0,last=Math.floor(tempo.tempoAt(map,sourceMs+lookAheadMs*rate).beat+1e-7),events=[];
    for(let beat=first;beat<=last&&events.length<16;beat++){
      const at=tempo.tempoTimeAtBeat(map,beat);if(at===null)continue;
      events.push({beat,sourceMs:at,delayMs:Math.max(0,(at-sourceMs)/rate),downbeat:((beat%(map.beatsPerBar||4))+(map.beatsPerBar||4))%(map.beatsPerBar||4)===0});
    }
    return events;
  }
  return {displayEnds,presentationEnds,lingerSettings,cueAt,clickSchedule};
});
