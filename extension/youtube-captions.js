/* Exact-video caption input. Player URLs stay inside the page and are never persisted. */
(function(root){
  'use strict';
  const MAX_BYTES=1000000,MAX_CUES=10000;
  // Self-contained because Chrome serializes this function into the MAIN world.
  async function readFromPage(videoId){
    const current=()=>new URL(location.href).searchParams.get('v');
    if(current()!==videoId)return {state:'source-changed'};
    const player=document.querySelector('#movie_player');
    const response=player?.getPlayerResponse?.();
    if(response?.videoDetails?.videoId!==videoId)return {state:'source-unready'};
    const renderer=response.captions?.playerCaptionsTracklistRenderer;
    const tracks=renderer?.captionTracks;
    if(!Array.isArray(tracks)||!tracks.length)return {state:'no-tracks'};
    const selected=player.getOption?.('captions','track');
    const preferred=(selected?.languageCode||document.documentElement.lang||navigator.language||'en').split('-')[0];
    const audio=renderer.audioTracks?.[renderer.defaultAudioTrackIndex||0];
    const defaultIndex=audio?.defaultCaptionTrackIndex;
    const ranked=tracks.map((track,index)=>({track,index,rank:
      (track.languageCode===selected?.languageCode?0:track.languageCode?.split('-')[0]===preferred?10:index===defaultIndex?20:30)+(track.kind==='asr'?1:0)
    })).sort((a,b)=>a.rank-b.rank||a.index-b.index);
    const track=ranked[0].track;
    const valid=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['www.youtube.com','music.youtube.com','youtube.com'].includes(u.hostname)&&u.pathname==='/api/timedtext'&&u.searchParams.get('v')===videoId&&u.searchParams.get('lang')===track.languageCode?u:null;}catch{return null;}};
    const nativeTranscript=async()=>{
      // Ask the already loaded YouTube app to load its transcript data. Sending
      // only this read endpoint does not open a panel, select CC or seek/play.
      const app=document.querySelector('ytd-app'),watch=document.querySelector('ytd-watch-flexy'),watchData=watch?.data;
      if(typeof app?.handleCommandWithCommandHandler!=='function'||watchData?.currentVideoEndpoint?.watchEndpoint?.videoId!==videoId)return {state:'unavailable'};
      let params;const find=(x,depth=0)=>{if(params||!x||typeof x!=='object'||depth>30)return;for(const [key,value]of Object.entries(x)){if(key==='getTranscriptEndpoint'&&typeof value?.params==='string'){params=value.params;return;}find(value,depth+1);}};find(watchData);
      if(!params||params.length>20000)return {state:'unavailable'};
      try{if(!atob(decodeURIComponent(params)).includes(videoId))return {state:'source-changed'};}catch{return {state:'invalid'};}
      const prior=document.querySelector('ytd-transcript-renderer')?.data;
      return new Promise(resolve=>{
        let settled=false;const end=result=>{if(settled)return;settled=true;clearTimeout(timer);observer.disconnect();resolve(result);};
        const inspect=()=>{
          if(current()!==videoId||watch.data!==watchData||player.getPlayerResponse?.()?.videoDetails?.videoId!==videoId){end({state:'source-changed'});return;}
          const root=document.querySelector('ytd-transcript-renderer');if(!root?.data||root.data===prior)return;
          const nodes=[];let visits=0;const segments=(x,d=0)=>{if(!x||typeof x!=='object'||d>30||++visits>100000)return;for(const[k,v]of Object.entries(x)){if(k==='transcriptSegmentRenderer')nodes.push(v);else segments(v,d+1);}};segments(root.data);if(!nodes.length)return;
          if(nodes.length>10000){end({state:'too-large'});return;}
          let selectedTitle='';const menu=(x,d=0)=>{if(!x||typeof x!=='object'||d>25)return;for(const[k,v]of Object.entries(x)){if(k==='subMenuItems'&&Array.isArray(v)){selectedTitle=v.find(i=>i.selected)?.title||selectedTitle;}else menu(v,d+1);}};menu(root.data);
          const name=t=>t.name?.simpleText||t.name?.runs?.map(r=>r.text).join('')||'';
          const actual=tracks.find(t=>name(t)===selectedTitle);
          const rows=nodes.map(d=>{return {startMs:Number(d?.startMs),durationMs:Number(d?.endMs)-Number(d?.startMs),text:d?.snippet?.simpleText||d?.snippet?.runs?.map(r=>r.text||'').join('')||''};});
          const body=JSON.stringify(rows);if(body.length>1000000){end({state:'too-large'});return;}
          end({state:'available',videoId,language:actual?.languageCode||'und',kind:actual?(actual.kind==='asr'?'automatic':'authored'):'unknown',format:'cues',body,route:'youtube-transcript'});
        };
        const observer=new MutationObserver(inspect),timer=setTimeout(()=>end({state:'unavailable'}),6000);
        observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
        try{app.handleCommandWithCommandHandler({getTranscriptEndpoint:{params}},watch);queueMicrotask(inspect);}catch{end({state:'unavailable'});}
      });
    };
    const base=valid(track.baseUrl);if(!base)return nativeTranscript();
    // Reuse the player's own delivered URL when available (including its current
    // delivery parameters). Never enable captions or alter their selected track.
    const recent=performance.getEntriesByType('resource').filter(e=>valid(e.name)&&!new URL(e.name).searchParams.has('tlang')).at(-1);
    const url=recent?valid(recent.name):base;url.searchParams.set('fmt','json3');
    try{
      const res=await fetch(url.href,{credentials:'same-origin',signal:AbortSignal.timeout(4000),redirect:'error'});
      if(!res.ok)return nativeTranscript();
      const length=Number(res.headers.get('content-length'));if(length>1000000)return {state:'too-large'};
      const reader=res.body?.getReader();if(!reader)return {state:'empty'};
      const decoder=new TextDecoder();let body='',bytes=0;
      while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1000000){await reader.cancel();return {state:'too-large'};}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();
      if(current()!==videoId||player.getPlayerResponse?.()?.videoDetails?.videoId!==videoId)return {state:'source-changed'};
      if(!body.trim())return nativeTranscript();
      let format='json3';
      if(body.trimStart().startsWith('<')){
        const doc=new DOMParser().parseFromString(body,'text/xml');if(doc.querySelector('parsererror'))return {state:'invalid'};
        const rows=[...doc.querySelectorAll('text[start], p[t]')].map(node=>({startMs:node.hasAttribute('start')?Number(node.getAttribute('start'))*1000:Number(node.getAttribute('t')),durationMs:node.hasAttribute('dur')?Number(node.getAttribute('dur'))*1000:Number(node.getAttribute('d')),text:node.textContent}));
        body=JSON.stringify(rows);format='cues';
      }
      return {state:'available',videoId,language:String(track.languageCode||'').slice(0,35),kind:track.kind==='asr'?'automatic':'authored',format,body};
    }catch{return nativeTranscript();}
  }
  function decode(packet,videoId,durationMs){
    if(packet?.state!=='available'||packet.videoId!==videoId||!['authored','automatic','unknown'].includes(packet.kind)||typeof packet.language!=='string'||!/^[-a-zA-Z0-9]{1,35}$/.test(packet.language)||!Number.isFinite(durationMs)||durationMs<=0||typeof packet.body!=='string'||packet.body.length>MAX_BYTES)return null;
    let data;try{data=JSON.parse(packet.body);}catch{return null;}
    let rows;
    if(packet.format==='cues')rows=data;
    else if(packet.format==='json3'&&Array.isArray(data?.events))rows=data.events.filter(e=>Array.isArray(e?.segs)).map(e=>({startMs:e.tStartMs,durationMs:e.dDurationMs,text:e.segs.map(s=>typeof s?.utf8==='string'?s.utf8:'').join(''),append:e.aAppend===1,window:e.wWinId}));
    if(!Array.isArray(rows)||rows.length>MAX_CUES)return null;
    const cues=[];let total=0;
    for(const row of rows){
      if(!row||typeof row!=='object')continue;
      const startMs=Math.round(Number(row.startMs)),duration=Math.round(Number(row.durationMs));
      const text=typeof row.text==='string'?row.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f♪♫♬♩]/g,'').replace(/\s+/g,' ').trim():'';
      if(!text||!Number.isFinite(startMs)||startMs<0||!Number.isFinite(duration)||duration<=0||startMs>=durationMs)continue;
      const endMs=Math.min(durationMs,startMs+duration);if(endMs<=startMs)continue;
      total+=text.length;if(total>200000)return null;
      const previous=cues.at(-1);
      if(row.append&&previous&&previous.window===row.window&&startMs<=previous.endMs){previous.text+=' '+text;previous.endMs=Math.max(previous.endMs,endMs);continue;}
      // Only eliminate identical same-time events, never repeated sung phrases.
      if(previous?.startMs===startMs&&previous.text===text){previous.endMs=Math.max(previous.endMs,endMs);continue;}
      cues.push({startMs,endMs,text,window:row.window});
    }
    cues.sort((a,b)=>a.startMs-b.startMs);
    if(!cues.length)return null;
    return {videoId,language:packet.language,kind:packet.kind,cues:cues.map(({window,...cue})=>cue)};
  }
  function lrc(caption){
    const stamp=ms=>`[${String(Math.floor(ms/60000)).padStart(2,'0')}:${(ms%60000/1000).toFixed(3).padStart(6,'0')}]`;
    return caption.cues.map(c=>stamp(c.startMs)+c.text+'\n'+stamp(c.endMs)).join('\n');
  }
  function createScore(core,source,caption,contentHash){
    if(source.videoId!==caption.videoId)throw Error('Captions belong to another video.');
    const score=core.createScore(source,'',{provider:`YouTube captions (${caption.kind}, ${caption.language})`,entryId:caption.videoId+':'+caption.language+':'+caption.kind,contentHash});
    score.lyrics.timingBasis='caption-segments';score.lyrics.captionSource={language:caption.language,kind:caption.kind};
    score.lanes=[{id:'lead',role:'lead',label:'Captions · review words'}];
    score.phrases=[];let hasBacking=false;
    // Find balanced spans across cue boundaries; unmatched opening parentheses
    // stay literal, and inner punctuation is kept as source text.
    const texts=caption.cues.map(c=>c.text.replace(/[♪♫♬♩]/gu,'').trim());
    const joined=texts.join('\n'),ranges=[];let depth=0,start=0;
    for(let n=0;n<joined.length;n++){if(joined[n]==='('){if(depth++===0)start=n;}else if(joined[n]===')'&&depth&&--depth===0&&joined.slice(start+1,n).trim())ranges.push({start,end:n});}
    let base=0,rangeIndex=0;
    for(const [i,cue] of caption.cues.entries()){
      const text=texts[i],limit=base+text.length,groups={lead:[],backing:[]};let pos=base;
      const add=(lane,a,b)=>{if(b>a)groups[lane].push(...joined.slice(a,b).trim().split(/\s+/u).filter(Boolean));};
      while(rangeIndex<ranges.length&&ranges[rangeIndex].end<base)rangeIndex++;
      for(let j=rangeIndex;j<ranges.length&&ranges[j].start<limit;j++){
        const range=ranges[j];add('lead',pos,Math.max(pos,range.start));
        add('backing',Math.max(pos,range.start+1),Math.min(limit,range.end));
        pos=Math.min(limit,range.end+1);
      }
      add('lead',pos,limit);base=limit+1;
      for(const laneId of ['lead','backing']){const tokens=groups[laneId];if(!tokens.length)continue;if(laneId==='backing')hasBacking=true;
        const width=tokens.reduce((n,t)=>n+t.length,0);let used=0;
        const words=tokens.map((text,j)=>{const startMs=cue.startMs+Math.round((cue.endMs-cue.startMs)*used/width);used+=text.length;return {id:`caption-${i+1}-${laneId}-word-${j+1}`,text,startMs,endMs:cue.startMs+Math.round((cue.endMs-cue.startMs)*used/width),provenance:'estimated',locked:false,effects:[]};});
        score.phrases.push({id:`caption-${i+1}-${laneId}`,laneId,startMs:cue.startMs,endMs:cue.endMs,endEstimated:false,fadeOutMs:120,words});
      }
    }
    if(hasBacking)score.lanes.push({id:'backing',role:'backing',label:'Suggested backing (inferred)'});
    return core.validateScore(score);
  }
  const api={readFromPage,decode,lrc,createScore};root.LvYoutubeCaptions=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
