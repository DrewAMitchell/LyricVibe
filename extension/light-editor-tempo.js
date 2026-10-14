(function(){
  const query=new URLSearchParams(location.search),tabId=Number(query.get('sourceTab')),mediaKey=query.get('mediaKey'),$=id=>document.getElementById(id);
  const toggle=document.createElement('button');toggle.id='tempo-view';toggle.textContent='Tempo sections';document.querySelector('.transport').append(toggle);
  const panel=document.createElement('section');panel.id='tempo-sections-panel';panel.hidden=true;
  panel.innerHTML='<div class="phrase-heading"><strong>Tempo sections</strong><span>Drag a block’s edges to set its duration</span></div><div class="tempo-tools"><label>BPM<input id="section-bpm" type="number" min="20" max="400" step="1" value="120"></label><label>Start s<input id="section-start" type="number" min="0" step="0.001"></label><label>End s<input id="section-end" type="number" min="0" step="0.001"></label><button id="section-apply">Save section</button><button id="section-split">Split at playhead</button><button id="section-remove">Remove section</button><button id="section-undo">↶ Undo tempo</button></div><div id="tempo-section-ruler"></div><div id="tempo-section-lane" class="lane"></div><p id="tempo-section-notice" role="status"></p>';
  document.querySelector('main').before(panel);
  const state={map:null,revision:0,durationMs:0,sourceMs:0,index:0,history:[],busy:false};
  const notice=text=>$('tempo-section-notice').textContent=text;
  async function request(type,extra={}){const r=await chrome.runtime.sendMessage({type,tabId,mediaKey,...extra});if(!r?.ok)throw Error(r?.error?.message||'Tempo source unavailable.');return r;}
  function bounds(){return {start:state.map.segments[state.index].startMs,end:state.map.segments[state.index+1]?.startMs??state.durationMs};}
  function render(){
    const lane=$('tempo-section-lane');lane.replaceChildren();$('tempo-section-ruler').replaceChildren();if(!state.map)return;
    for(let i=0;i<=8;i++){const tick=document.createElement('span');tick.textContent=(state.durationMs*i/8000).toFixed(1)+'s';$('tempo-section-ruler').append(tick);}
    state.index=Math.min(state.index,state.map.segments.length-1);
    state.map.segments.forEach((point,index)=>{
      const end=state.map.segments[index+1]?.startMs??state.durationMs,block=document.createElement('button');block.className='tempo-section-block';block.dataset.index=index;block.setAttribute('aria-selected',String(index===state.index));block.style.left=point.startMs/state.durationMs*100+'%';block.style.width=(end-point.startMs)/state.durationMs*100+'%';
      block.innerHTML='<i data-edge="start"></i><span></span><i data-edge="end"></i>';block.querySelector('span').textContent=Math.round(point.bpm)+' BPM';block.title=`${(point.startMs/1000).toFixed(3)}–${(end/1000).toFixed(3)}s · ${point.transition==='linear'?'ramp to next':'fixed BPM'}`;
      block.onclick=()=>{if(block.dataset.dragged){delete block.dataset.dragged;return;}state.index=index;render();};
      block.onpointerdown=event=>{
        if(state.busy||event.button!==0)return;event.preventDefault();state.index=index;const initial=structuredClone(state.map),startX=event.clientX,width=lane.clientWidth,edge=event.target.dataset.edge||'move';let moved=false,next=initial;
        block.setPointerCapture(event.pointerId);
        const move=e=>{const delta=Math.round((e.clientX-startX)/width*state.durationMs);if(Math.abs(e.clientX-startX)>3)moved=true;next=structuredClone(initial);const left=initial.segments[index].startMs,right=initial.segments[index+1]?.startMs??state.durationMs;
          let a=edge==='end'?left:left+delta,b=edge==='start'?right:right+delta;
          if(index===0)a=0;if(index===initial.segments.length-1)b=state.durationMs;
          a=Math.max(index?initial.segments[index-1].startMs+1:0,Math.min(a,right-1));b=Math.min((initial.segments[index+2]?.startMs??state.durationMs+1)-1,Math.max(b,a+1));
          next.segments[index].startMs=a;if(next.segments[index+1])next.segments[index+1].startMs=b;
          block.style.left=a/state.durationMs*100+'%';block.style.width=(b-a)/state.durationMs*100+'%';};
        const end=()=>{block.removeEventListener('pointermove',move);block.removeEventListener('pointerup',end);block.removeEventListener('pointercancel',cancel);if(moved){block.dataset.dragged='true';void commit(next);}else render();};
        const cancel=()=>{block.removeEventListener('pointermove',move);block.removeEventListener('pointerup',end);block.removeEventListener('pointercancel',cancel);render();};
        block.addEventListener('pointermove',move);block.addEventListener('pointerup',end);block.addEventListener('pointercancel',cancel);
      };lane.append(block);
    });
    const p=state.map.segments[state.index],range=bounds();$('section-bpm').value=Math.round(p.bpm);$('section-start').value=range.start/1000;$('section-end').value=range.end/1000;
    $('section-start').disabled=state.index===0;$('section-end').disabled=state.index===state.map.segments.length-1;$('section-remove').disabled=state.index===0;$('section-undo').disabled=!state.history.length;
  }
  async function commit(map,undo=false){
    if(state.busy)return;state.busy=true;try{LvTapTiming.validateTempoMap(map);if(map.segments.some(p=>p.startMs>=state.durationMs))throw Error('Sections must stay inside the recording.');const prior=state.map,r=await request('LV_TEMPO_SET',{map,expectedTempoRevision:state.revision});if(!undo)state.history.push(prior);state.map=r.map;state.revision=r.tempoRevision;notice('Tempo saved. Lyrics and their timing stay unchanged.');render();}catch(error){notice(error.message);render();}finally{state.busy=false;}
  }
  async function open(){panel.hidden=false;document.body.classList.add('tempo-editing');toggle.textContent='Lyric blocks';try{const r=await request('LV_TEMPO_GET');state.map=r.map||{version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]};state.revision=r.tempoRevision;state.durationMs=r.durationMs;state.sourceMs=r.sourceMs;if(!(state.durationMs>0))throw Error('Wait for the recording duration.');render();notice('Select a section, type an integer BPM, or resize its edges.');}catch(error){notice(error.message);}}
  toggle.onclick=()=>{if(panel.hidden)void open();else{panel.hidden=true;document.body.classList.remove('tempo-editing');toggle.textContent='Tempo sections';}};
  $('section-apply').onclick=()=>{if(!state.map)return;try{const bpm=Number($('section-bpm').value),start=Math.round(Number($('section-start').value)*1000),end=Math.round(Number($('section-end').value)*1000);if(!Number.isSafeInteger(bpm)||bpm<20||bpm>400)throw Error('Enter an integer BPM from 20 to 400.');if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||start<0||end>state.durationMs)throw Error('Enter a positive section inside the recording.');const map=structuredClone(state.map),i=state.index;if(i===0&&start!==0)throw Error('The first section starts at zero.');if(i===map.segments.length-1&&end!==state.durationMs)throw Error('The final section ends with the recording.');map.segments[i]={...map.segments[i],startMs:start,bpm,transition:'step',provenance:'manual'};if(map.segments[i+1])map.segments[i+1].startMs=end;void commit(map);}catch(error){notice(error.message);}};
  $('section-split').onclick=()=>{if(!state.map||state.sourceMs<=0||state.sourceMs>=state.durationMs)return;const at=Math.round(state.sourceMs);if(state.map.segments.some(p=>p.startMs===at))return;const bpm=Math.round(LvTapTiming.tempoAt(state.map,at).bpm),map=LvTapTiming.setTempoPoint(state.map,{startMs:at,bpm,transition:'step',provenance:'manual'});state.index=map.segments.findIndex(p=>p.startMs===at);void commit(map);};
  $('section-remove').onclick=()=>{if(state.index===0)return;const map=LvTapTiming.removeTempoPoint(state.map,state.map.segments[state.index].startMs);state.index--;void commit(map);};
  $('section-undo').onclick=()=>{if(!state.history.length||state.busy)return;const map=state.history.pop();void commit(map,true);};
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='LV_SCORE_PLAYBACK'&&message.mediaKey===mediaKey)state.sourceMs=message.mediaMs;});
  window.LvLightTempo={open,getState:()=>structuredClone({...state,history:undefined}),commit};
  if(query.get('mode')==='tempo')void open();
})();
