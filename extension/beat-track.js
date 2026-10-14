/* Source-clock beat presentation. No score timing mutation or wall-clock progression. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./tap-timing.js'):root.LvTapTiming);if(typeof module==='object'&&module.exports)module.exports=api;root.LvBeatTrack=api;})(globalThis,function(tempo){
  function displayEnds(score,map){
    const ends={};if(!map)return ends;
    for(const phrase of score.phrases){
      if(!(phrase.persistBeats>0))continue;
      const sourceEnd=phrase.endMs+score.offsetMs;if(sourceEnd<0)continue;
      const beat=tempo.tempoAt(map,sourceEnd).beat,until=tempo.tempoTimeAtBeat(map,beat+phrase.persistBeats);
      const next=score.phrases.filter(p=>p.laneId===phrase.laneId&&p.startMs>=phrase.endMs&&p.id!==phrase.id&&p.words.some(w=>!w.excluded)).sort((a,b)=>a.startMs-b.startMs)[0];
      ends[phrase.id]=Math.max(phrase.endMs,Math.min(until-score.offsetMs,next?.startMs??Infinity,score.source.durationMs?score.source.durationMs-score.offsetMs:Infinity));
    }
    return ends;
  }
  function cueAt(cue,map,sourceMs,reducedMotion=false,knownBeat){
    const beat=knownBeat??tempo.tempoAt(map,sourceMs)?.beat;if(beat===undefined||beat<cue.beat||beat>=cue.beat+cue.durationBeats)return null;
    const elapsed=beat-cue.beat,phase=elapsed-Math.floor(elapsed),strength=cue.strength;
    if(reducedMotion)return {scale:1,brightness:1+.12*strength,hue:0,glow:.12*strength};
    const pulse=Math.max(0,1-phase/.35)**2;
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
  return {displayEnds,cueAt,clickSchedule};
});
