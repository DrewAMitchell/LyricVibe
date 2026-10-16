/* Song-level controls share the lightweight editor's revisioned preview. */
(function(root) {
  root.LvLightArrange = { create({state, request, run, tune, setDraft, notice, selectPhrase, phraseIndices}) {
    const $ = id => document.getElementById(id), map = $('phrase-map');
    let selected = new Set(), anchor = null, sources = [], gesture = null, scale = {start:0,end:1}, offsetRevision = null;
    const ready = () => state.draft && !state.busy && !state.dirty;
    const revision = () => state.draft ? `${state.draft.token}:${state.draft.previewRevision}` : null;
    const rows = () => phraseIndices().map(i => state.draft.score.phrases[i]);
    function buttons() {
      for (const id of ['song-offset','apply-offset','phrase-zoom','select-phrases','clear-phrases','phrase-shift','sync-source','refresh-sync-sources','copy-offset']) $(id).disabled = !ready();
      for (const id of ['shift-earlier','shift-later']) $(id).disabled = !ready() || !selected.size;
      $('copy-sync').disabled = !ready() || !$('sync-source').value;
      for (const block of map.querySelectorAll('[data-phrase]')) block.disabled = !ready();
    }
    function selection() {
      for (const block of map.querySelectorAll('[data-phrase]')) block.setAttribute('aria-selected', String(selected.has(block.dataset.phrase)));
      $('phrase-selection').textContent = selected.size ? `${selected.size} phrase${selected.size === 1 ? '' : 's'} selected` : 'No phrases selected';
      buttons();
    }
    function choose(id, event) {
      const ids = rows().map(p => p.id);
      if (event.shiftKey && anchor && ids.includes(anchor)) {
        const a = ids.indexOf(anchor), b = ids.indexOf(id), range = ids.slice(Math.min(a,b), Math.max(a,b)+1);
        selected = new Set(event.ctrlKey || event.metaKey ? [...selected,...range] : range);
      } else if (event.ctrlKey || event.metaKey) { selected.has(id) ? selected.delete(id) : selected.add(id); anchor = id; }
      else { selected = new Set([id]); anchor = id; }
      selection();
    }
    function render() {
      if (!state.draft) return;
      if (gesture) { gesture.cancel(); notice('The preview changed during the drag. Select the phrases and try again.'); }
      const score = state.draft.score, visible = rows(), ids = new Set(visible.map(p => p.id));
      selected = new Set([...selected].filter(id => ids.has(id)));
      if (document.activeElement !== $('song-offset')) { $('song-offset').value = score.offsetMs; offsetRevision = revision(); }
      const start = Math.min(0,...visible.map(p => p.startMs+score.offsetMs));
      scale = {start,end:Math.max(1,score.source.durationMs,...visible.map(p => p.endMs+score.offsetMs))};
      map.replaceChildren(); map.style.width = `${Number($('phrase-zoom').value)*100}%`;
      for (let i=0;i<=8;i++) { const tick=document.createElement('small');tick.className='phrase-map-tick';tick.textContent=((start+(scale.end-start)*i/8)/1000).toFixed(1)+'s';tick.style.left=(i*100/8)+'%';map.append(tick); }
      let row = 0;
      for (const lane of score.lanes) {
        const lanePhrases = visible.filter(p => p.laneId === lane.id).sort((a,b) => a.startMs-b.startMs), ends = [];
        if (!lanePhrases.length) continue;
        for (const p of lanePhrases) {
          let level=ends.findIndex(end => end<=p.startMs);if(level<0)level=ends.length;ends[level]=p.endMs;
          const block=document.createElement('button');block.type='button';block.dataset.phrase=p.id;block.dataset.lane=lane.id;
          block.textContent=p.words.filter(w=>!w.excluded).map(w=>w.text).join(' ') || '(not sung)';
          block.title=`${lane.label} · ${((p.startMs+score.offsetMs)/1000).toFixed(3)}–${((p.endMs+score.offsetMs)/1000).toFixed(3)}s · ${block.textContent}`;
          block.setAttribute('aria-label',block.title);block.style.left=((p.startMs+score.offsetMs-start)/(scale.end-start)*100)+'%';block.style.width=Math.max(.25,(p.endMs-p.startMs)/(scale.end-start)*100)+'%';block.style.top=(32+(row+level)*38)+'px';map.append(block);
        }
        row += ends.length;
      }
      map.style.height=(Math.max(1,row)*38+70)+'px';
      const outside=score.phrases.filter(p=>p.words.some(w=>!w.excluded)&&(p.startMs+score.offsetMs<0||p.endMs+score.offsetMs>score.source.durationMs)).length;
      $('timing-copy-note').textContent=[score.lyrics.timingCopy ? `Copied from “${score.lyrics.timingCopy.title || score.lyrics.timingCopy.mediaKey.slice(8)}” · audition against this recording.` : '',outside ? `${outside} phrase${outside===1?' extends':'s extend'} beyond this video's bounds; move or exclude unsung material before saving.` : ''].filter(Boolean).join(' ');
      selection();
    }
    async function shift(deltaMs, expected=revision()) {
      if (expected!==revision()) throw Error('The preview changed during selection. Try the move again.');
      if (!Number.isSafeInteger(deltaMs)) throw Error('Enter a whole-millisecond shift.');
      if (!selected.size || !deltaMs) return;
      await tune({operation:{type:'shiftPhrases',phraseIds:[...selected],deltaMs}});
      notice(`Moved ${selected.size} phrases ${Math.abs(deltaMs)} ms ${deltaMs<0?'earlier':'later'}. Word and syllable spacing is unchanged. Undo restores the move.`);
    }
    $('apply-offset').onclick=()=>run(async()=>{
      if(offsetRevision!==revision())throw Error('The preview changed while you were entering the offset. Reselect the offset field and try again.');
      const value=$('song-offset').value;if(!value.trim()||!Number.isSafeInteger(Number(value)))throw Error('Enter a whole-millisecond offset.');
      await tune({operation:{type:'setOffset',offsetMs:Number(value)}});notice('Whole-song offset updated in preview. + is later, − is earlier. Audition before saving.');
    });
    $('song-offset').onfocus=()=>{offsetRevision=revision();};
    $('phrase-zoom').oninput=render;
    $('select-phrases').onclick=()=>{selected=new Set(rows().map(p=>p.id));selection();};
    $('clear-phrases').onclick=()=>{selected.clear();selection();};
    for(const [id,direction] of [['shift-earlier',-1],['shift-later',1]])$(id).onclick=()=>run(()=>{const amount=Number($('phrase-shift').value);if(!Number.isSafeInteger(amount)||amount<=0)throw Error('Enter a positive whole-millisecond move.');return shift(direction*amount);});
    map.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&gesture){event.preventDefault();gesture.cancel();return;}
      if(event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();if(ready())run(()=>shift((event.key==='ArrowLeft'?-1:1)*(event.shiftKey?50:10)));}
    });
    map.addEventListener('click',event=>{if(event.detail!==0||!ready())return;const block=event.target.closest('[data-phrase]');if(block){choose(block.dataset.phrase,event);selectPhrase(state.draft.score.phrases.findIndex(p=>p.id===block.dataset.phrase));}});
    map.addEventListener('pointerdown',event=>{
      if(!ready()||event.button!==0||gesture)return;
      event.preventDefault();map.focus({preventScroll:true});
      const block=event.target.closest('[data-phrase]'),id=block?.dataset.phrase,initial={x:event.clientX,y:event.clientY},bounds=map.getBoundingClientRect(),prior=new Set(selected),expected=revision();
      if(id&&!selected.has(id))choose(id,event);
      const blocks=[...map.querySelectorAll('[data-phrase]')],positions=blocks.map(b=>({b,rect:b.getBoundingClientRect()}));
      const marquee=document.createElement('div');marquee.className='phrase-marquee';marquee.hidden=true;map.append(marquee);
      let moved=false,delta=0;map.setPointerCapture(event.pointerId);
      const cleanup=()=>{map.removeEventListener('pointermove',move);map.removeEventListener('pointerup',finish);map.removeEventListener('pointercancel',cancel);map.removeEventListener('lostpointercapture',cancel);if(map.hasPointerCapture(event.pointerId))map.releasePointerCapture(event.pointerId);marquee.remove();for(const b of blocks)b.style.transform='';gesture=null;};
      const cancel=()=>{cleanup();selected=prior;selection();};
      const move=e=>{
        if(Math.hypot(e.clientX-initial.x,e.clientY-initial.y)<4&&!moved)return;moved=true;
        if(id){delta=Math.round((e.clientX-initial.x)/bounds.width*(scale.end-scale.start)/10)*10;for(const b of blocks)if(selected.has(b.dataset.phrase))b.style.transform=`translateX(${delta/(scale.end-scale.start)*bounds.width}px)`;}
        else {const left=Math.min(initial.x,e.clientX),right=Math.max(initial.x,e.clientX),top=Math.min(initial.y,e.clientY),bottom=Math.max(initial.y,e.clientY);marquee.hidden=false;Object.assign(marquee.style,{left:(left-bounds.left)+'px',top:(top-bounds.top)+'px',width:(right-left)+'px',height:(bottom-top)+'px'});selected=new Set(event.ctrlKey||event.metaKey||event.shiftKey?prior:[]);for(const {b,rect} of positions)if(rect.right>=left&&rect.left<=right&&rect.bottom>=top&&rect.top<=bottom)selected.add(b.dataset.phrase);selection();}
      };
      const finish=()=>{cleanup();if(moved&&id)run(()=>shift(delta,expected));else if(!moved&&id){selected=prior;choose(id,event);selectPhrase(state.draft.score.phrases.findIndex(p=>p.id===id));}else if(!moved&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey){selected.clear();selection();}};
      gesture={cancel};map.addEventListener('pointermove',move);map.addEventListener('pointerup',finish);map.addEventListener('pointercancel',cancel);map.addEventListener('lostpointercapture',cancel);
    });
    async function loadSources() {
      sources=(await request('LV_TIMING_SOURCES')).sources;const previous=$('sync-source').value;
      $('sync-source').replaceChildren(new Option(sources.length?'Choose a saved video':'No other saved synchronizations',''));
      for(const s of sources)$('sync-source').add(new Option(`${s.title||s.mediaKey.slice(8)}${s.artist?' · '+s.artist:''} · ${s.mediaKey.slice(8)}`,s.mediaKey));
      if(sources.some(s=>s.mediaKey===previous))$('sync-source').value=previous;sourceInfo();
    }
    function sourceInfo(){const s=sources.find(s=>s.mediaKey===$('sync-source').value);$('copy-source-info').textContent=s?`${s.phraseCount} phrases · ${(s.durationMs/1000).toFixed(1)}s · saved offset ${s.offsetMs} ms. Additional offset is added to this value.`:'';buttons();}
    $('sync-source').onchange=sourceInfo;
    $('refresh-sync-sources').onclick=()=>run(loadSources);
    $('copy-sync-panel').ontoggle=()=>{if($('copy-sync-panel').open&&ready()&&!sources.length)run(loadSources);};
    $('copy-sync').onclick=()=>run(async()=>{
      const source=sources.find(s=>s.mediaKey===$('sync-source').value),input=$('copy-offset').value;
      if(!source)throw Error('Choose a saved synchronization.');if(!input.trim()||!Number.isSafeInteger(Number(input)))throw Error('Enter a whole-millisecond additional offset.');
      const result=await request('LV_TIMING_COPY',{sourceMediaKey:source.mediaKey,sourceRevision:source.revision,sourceLyricsHash:source.lyricsHash,deltaMs:Number(input)});
      selected.clear();state.phrase=0;state.wordId=null;state.trackId='all';setDraft(result.preview);
      notice('Copied into this video’s preview. The original is unchanged. Adjust the offset or phrase sections, audition, then Save timings. Undo restores the prior preview.');
    });
    return {render,buttons,interacting:()=>!!gesture};
  }};
})(globalThis);
