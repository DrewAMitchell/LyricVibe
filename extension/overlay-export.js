/* Portable render input. Contains one score and its effective presentation only. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./score-core.js'):root.LvScore,typeof module==='object'&&module.exports?require('./tap-timing.js'):root.LvTapTiming,typeof module==='object'&&module.exports?require('./choreography.js'):root.LvChoreography,typeof module==='object'&&module.exports?require('./beat-track.js'):root.LvBeatTrack);if(typeof module==='object'&&module.exports)module.exports=api;root.LvOverlayExport=api;})(globalThis,function(core,timing,choreography,beats){
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  function validate(packet){
    if(!packet||packet.format!=='lyricvibe-overlay'||packet.version!==1)fail('EXPORT_FORMAT','Choose a LyricVibe overlay package.');
    core.validateScore(packet.score);const {score,display:d,clip:c}=packet;
    if(packet.mediaKey!==core.mediaKey(score.source)||packet.lyricsHash!==score.lyrics.contentHash)fail('EXPORT_SOURCE','The render package does not match its score.');
    if(!c||!Number.isSafeInteger(c.startMs)||c.startMs<0||!Number.isSafeInteger(c.endMs)||c.endMs<=c.startMs||!Number.isInteger(c.width)||!Number.isInteger(c.height)||!finite(c.width,16,8192)||!finite(c.height,16,8192)||c.width%2||c.height%2||![24,25,30,50,60].includes(c.fps))fail('EXPORT_CLIP','Choose increasing source seconds, even dimensions up to 8192px, and 24, 25, 30, 50 or 60 fps.');
    if(Number.isFinite(score.source.durationMs)&&c.endMs>score.source.durationMs)fail('EXPORT_CLIP','The clip ends after this recording.');
    if(!d||!core.DISPLAY_CATALOG.looks.includes(d.theme)||!core.DISPLAY_CATALOG.layouts.includes(d.choreography?.mode))fail('EXPORT_LOOK','The render package needs a supported theme and layout.');
    const p=d.placement;if(!p||!finite(p.left,0,100)||!finite(p.top,0,100)||!finite(p.width,20,100)||!finite(p.height,20,100)||p.left+p.width>100.000001||p.top+p.height>100.000001||!finite(p.minFontPx,12,96)||!finite(p.maxFontPx,p.minFontPx,200))fail('EXPORT_PLACEMENT','The lyric area must fit inside the export frame.');
    if(!finite(d.fontScale,.6,1.6)||typeof d.bloom!=='boolean'||typeof d.liteMode!=='boolean'||!['hidden','header','prefix'].includes(d.backingLabel))fail('EXPORT_LOOK','Invalid display settings.');
    choreography.validateWordRuleSets({version:1,activeId:d.wordSet?.id,sets:[d.wordSet]});
    choreography.backingSettings(d.backingDisplay);beats.lingerSettings(d.linger);
    if(d.tempoMap)timing.validateTempoMap(d.tempoMap);
    if((score.stageItems||[]).some(i=>i.response==='bass'&&i.startMs<c.endMs&&i.endMs>c.startMs))fail('EXPORT_LIVE_AUDIO','This clip uses live bass response. Export a section without bass-driven items; recorded audio envelopes are not supported yet.');
    return packet;
  }
  function create(score,display,clip,{view='saved',createdAt=new Date().toISOString()}={}){
    const packet={format:'lyricvibe-overlay',version:1,createdAt,view,mediaKey:core.mediaKey(score.source),lyricsHash:score.lyrics.contentHash,score:clone(score),display:clone(display),clip:clone(clip)};
    return validate(packet);
  }
  function frameCount(packet){validate(packet);return Math.ceil((packet.clip.endMs-packet.clip.startMs)*packet.clip.fps/1000);}
  function sourceTime(packet,index){if(!Number.isInteger(index)||index<0||index>=frameCount(packet))fail('EXPORT_FRAME','Frame index is outside this clip.');return packet.clip.startMs+index*1000/packet.clip.fps;}
  return Object.freeze({validate,create,frameCount,sourceTime});
});
