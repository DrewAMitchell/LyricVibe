/* Source-bound lightweight editor. All edits use the shared preview owner. */
(() => {
  const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
  const tabId = Number(params.get('sourceTab')), mediaKey = params.get('mediaKey');
  const state = {score:null, draft:null, phrase:0, wordId:null, trackId:'lead', busy:false, auditioned:false, dirty:false, editRevision:null, closed:false};
  let range = {start:0,end:1000}, polling, replacementWordId=null, deferredPreview=null, pronunciationKey=null, pronunciationSuggestion=null;
  const notice = text => { $('notice').textContent = text; };
  const phrase = () => state.draft?.score.phrases[state.phrase];
  const word = () => phrase()?.words.find(w=>w.id===state.wordId) || phrase()?.words[0];
  const target = () => $('target').value === 'word' ? word() : word()?.syllables?.find(s=>s.id===$('target').value);
  const trackLabel=lane=>lane?.id==='backing'?'Backing':lane?.id==='lead'?'Lead':lane?.label||lane?.id||'Track';
  const phraseIndices=()=>state.draft?.score.phrases.flatMap((p,i)=>state.trackId==='all'||p.laneId===state.trackId?[i]:[])||[];
  const stateToggles = new Map();
  function syncToggle(id) {
    const input=$(id),button=stateToggles.get(id);if(!input||!button)return;
    button.disabled=input.disabled;button.setAttribute('aria-pressed',String(input.checked));button.classList.toggle('is-on',input.checked);
  }
  function installStateToggle(id) {
    const input=$(id),label=input?.closest('label');if(!input||!label)return;
    const caption=label.textContent.trim();label.classList.add('source-toggle');label.setAttribute('aria-hidden','true');input.tabIndex=-1;
    const button=document.createElement('button');button.type='button';button.id=`toggle-${id}`;button.className='state-toggle';button.textContent=caption;button.setAttribute('aria-label',caption);button.setAttribute('aria-pressed',String(input.checked));
    button.addEventListener('click',()=>{if(button.disabled)return;input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));syncToggle(id);});
    label.insertAdjacentElement('afterend',button);stateToggles.set(id,button);syncToggle(id);
  }
  ['loop','follow','excluded'].forEach(installStateToggle);
  async function request(type, extra={}) {
    const result = await chrome.runtime.sendMessage({type,tabId,mediaKey,expectedRevision:state.score?.revision,lyricsHash:state.score?.lyrics.contentHash,token:state.draft?.token,previewRevision:state.draft?.previewRevision,...extra});
    if (!result?.ok) throw Error(result?.error?.message || 'The video connection is unavailable.');
    return result;
  }
  async function run(work) {
    if(state.busy)return;state.busy=true;buttons();
    try {await work();}catch(error){notice(error.message);}finally{state.busy=false;if(deferredPreview?.token===state.draft?.token&&deferredPreview.previewRevision>state.draft.previewRevision)setDraft(deferredPreview);deferredPreview=null;buttons();}
  }
  function buttons() {
    const ready=!!state.draft;
    for(const id of ['play','pause','audition','use-times','earlier','later','excluded','loop','follow','target','start','end','replace-through','replacement','replace-words','phrase-track'])$(id).disabled=state.busy||!ready;
    for(const b of $('tracks').querySelectorAll('button'))b.disabled=state.busy||state.dirty||b.dataset.empty==='true';
    for(const b of $('pronunciation-choices').querySelectorAll('button'))b.disabled=state.busy||state.dirty||b.getAttribute('aria-pressed')==='true';
    const indices=phraseIndices(),position=indices.indexOf(state.phrase);
    $('previous').disabled=state.busy||state.dirty||position<=0;$('next').disabled=state.busy||state.dirty||position>=indices.length-1;
    for(const id of stateToggles.keys())syncToggle(id);
    $('save').disabled=state.busy||!ready||!state.auditioned||state.dirty;
    $('undo').disabled=state.busy||!state.draft?.undoScores?.length;
    $('save-status').textContent=!ready?'Saved · reopen Sync to continue':state.dirty?'Use exact times first':state.auditioned?'Ready to save this iteration':'Audition preview before saving';
    const blocked=$('save').disabled||Boolean(state.saveError),reason=state.busy?'Updating preview…':!ready?'Reopen Sync to prepare this video’s preview.':state.dirty?'Use exact times for your typed changes first.':!state.auditioned?'Audition preview at 1× before saving.':state.saveError||'Ready to save this iteration.';
    $('save-wrap').dataset.blocked=String(blocked);$('save-wrap').tabIndex=blocked?0:-1;$('save-wrap').setAttribute('aria-label',blocked?'Save unavailable: '+reason:'Save timings');$('save-reason').textContent=blocked?reason:'';
  }
  function setDraft(draft) {
    state.draft=draft;state.auditioned=false;
    if(!draft){buttons();return;}
    state.phrase=Math.min(state.phrase,draft.score.phrases.length-1);
    if(state.trackId!=='all'&&!draft.score.lanes.some(l=>l.id===state.trackId))state.trackId=draft.score.lanes.find(l=>l.role==='lead')?.id||'all';
    if(state.trackId!=='all'&&phrase()?.laneId!==state.trackId){const candidates=phraseIndices();if(candidates.length)state.phrase=candidates.reduce((a,b)=>Math.abs(b-state.phrase)<Math.abs(a-state.phrase)?b:a);else state.trackId='all';state.wordId=null;}
    render();
  }
  async function tune(extra) {
    if(state.dirty&&state.editRevision!==state.draft.previewRevision)throw Error('The preview changed while you were typing. Select this word again to reload its times.');
    const result=await request('LV_TIMING_TUNE',{...extra,allowProtected:true});
    state.dirty=false;state.editRevision=null;setDraft(result.preview);
    notice('Preview updated in YouTube. Audition, then Save timings to keep this iteration.');
  }
  async function seek(ms) { await request('LV_SCORE_SEEK',{mediaMs:Math.max(0,Math.round(ms+state.draft.score.offsetMs))}); }
  function selectWord(id, seekVideo=true) {
    state.wordId=id;state.dirty=false;state.editRevision=null;render();
    if(seekVideo)run(async()=>{await seek(word().startMs-150);if($('loop').checked)await updateLoop();});
  }
  function selectPhrase(index) {
    if(state.busy||!state.draft)return;
    if(state.dirty){notice('Use exact times before changing phrases.');return;}
    state.phrase=Math.max(0,Math.min(index,state.draft.score.phrases.length-1));state.wordId=phrase().words[0]?.id;
    state.dirty=false;render();run(async()=>{await seek(phrase().startMs-300);if($('loop').checked)await updateLoop();});
  }
  function selectAdjacentPhrase(direction,step=1){const indices=phraseIndices(),position=indices.indexOf(state.phrase);const next=indices[Math.max(0,Math.min(position+direction*step,indices.length-1))];if(next!==undefined)selectPhrase(next);}
  function selectTrack(trackId){
    if(state.busy||!state.draft||state.dirty)return;
    state.trackId=trackId;const indices=phraseIndices();
    if(!indices.length){state.trackId='all';return;}
    if(!indices.includes(state.phrase)){const sourceMs=phrase()?.startMs||0;state.phrase=indices.reduce((a,b)=>Math.abs(state.draft.score.phrases[b].startMs-sourceMs)<Math.abs(state.draft.score.phrases[a].startMs-sourceMs)?b:a);state.wordId=null;}
    render();[...$('tracks').children].find(b=>b.dataset.track===trackId)?.focus();notice(trackId==='all'?'Showing every vocal track; follow stays on the selected phrase’s lane.':'Showing '+trackLabel(state.draft.score.lanes.find(l=>l.id===trackId))+'. Navigation and follow stay on this track; playback still includes both vocal lanes.');
  }
  function selectAdjacentWord(direction) {
    if(state.busy||!state.draft)return;
    const rows=state.draft.score.phrases,words=phraseIndices().flatMap(index=>rows[index].words.map(w=>({word:w,phrase:index})));
    const current=words.findIndex(x=>x.word.id===word().id),next=words[Math.max(0,Math.min(current+direction,words.length-1))];
    state.phrase=next.phrase;selectWord(next.word.id);
  }
  function fields() {
    const w=word(),item=target();if(!w||!item)return;
    $('selected-word').textContent=w.text;$('excluded').checked=!!w.excluded;
    if(!state.dirty){$('start').value=item.startMs;$('end').value=item.endMs;}
  }
  function render() {
    const p=phrase(),w=word();if(!p||!w)return;
    $('source-name').textContent=state.draft.score.source.title||mediaKey;
    $('phrase-position').textContent=`Phrase ${state.phrase+1} / ${state.draft.score.phrases.length} · ${trackLabel(state.draft.score.lanes.find(l=>l.id===p.laneId))}`;
    const tracks=$('tracks');tracks.replaceChildren();
    for(const lane of [{id:'all',label:'All'},...state.draft.score.lanes]){const count=state.draft.score.phrases.filter(row=>lane.id==='all'||row.laneId===lane.id).length,b=document.createElement('button');b.type='button';b.dataset.track=lane.id;b.dataset.empty=String(!count);b.textContent=`${lane.id==='all'?'All':trackLabel(lane)} · ${count}`;b.setAttribute('aria-pressed',String(state.trackId===lane.id));b.onclick=()=>selectTrack(lane.id);tracks.append(b);}
    const trackSelect=$('phrase-track');trackSelect.replaceChildren();for(const lane of state.draft.score.lanes)trackSelect.add(new Option(trackLabel(lane),lane.id));trackSelect.value=p.laneId;
    $('phrase-text').textContent=p.words.filter(x=>!x.excluded).map(x=>x.text).join(' ')||'Entire phrase excluded from this recording';
    const phrases=$('phrases');phrases.replaceChildren();
    const indices=phraseIndices(),position=indices.indexOf(state.phrase),from=Math.max(0,Math.min(position-2,indices.length-5));
    for(const i of indices.slice(from,from+5)){
      const row=state.draft.score.phrases[i],b=document.createElement('button'),s=document.createElement('small');
      s.textContent=`${(row.startMs/1000).toFixed(2)}s · ${i+1} · ${trackLabel(state.draft.score.lanes.find(l=>l.id===row.laneId))}`;b.append(s,document.createTextNode(row.words.map(x=>x.text).join(' ')));b.dataset.phrase=row.id;b.dataset.track=row.laneId;
      b.setAttribute('aria-current',String(i===state.phrase));b.addEventListener('click',()=>selectPhrase(i));phrases.append(b);
    }
    range={start:Math.max(0,Math.min(p.startMs,...p.words.map(x=>x.startMs))-250),end:Math.max(p.endMs,...p.words.map(x=>x.endMs))+250};
    const ruler=$('ruler');ruler.replaceChildren();for(let i=0;i<=4;i++){const s=document.createElement('span');s.textContent=((range.start+(range.end-range.start)*i/4)/1000).toFixed(2)+'s';s.style.left=(i*24)+'%';ruler.append(s);}
    renderLane($('words'),p.words,false);renderLane($('syllables'),w.syllables||[],true);
    const oldTarget=$('target').value;$('target').replaceChildren(new Option('Word','word'));
    for(const s of w.syllables||[])$('target').add(new Option(s.text,s.id));
    if([...$('target').options].some(o=>o.value===oldTarget))$('target').value=oldTarget;
    const replacementEnd=$('replace-through'),oldEnd=replacementEnd.value,oldText=$('replacement').value,keepReplacement=replacementWordId===w.id;replacementEnd.replaceChildren();
    for(const item of p.words.slice(p.words.findIndex(x=>x.id===w.id)))replacementEnd.add(new Option(item.text,item.id));
    if(keepReplacement&&[...replacementEnd.options].some(o=>o.value===oldEnd))replacementEnd.value=oldEnd;
    $('replacement').value=keepReplacement?oldText:'';replacementWordId=w.id;
    renderPronunciation();
    fields();buttons();
    phrases.querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function renderPronunciation(){
    const w=word(),key=`${state.draft.token}:${w.id}:${w.text}:${w.spokenText||''}`,choices=$('pronunciation-choices');
    choices.replaceChildren();
    if(pronunciationKey!==key){
      pronunciationKey=key;pronunciationSuggestion=null;$('pronunciation-hint').textContent='Checking the packaged pronunciation dictionary…';
      chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_SUGGEST',text:w.text,...(w.spokenText?{spokenText:w.spokenText}:{})}).then(r=>{if(pronunciationKey!==key)return;pronunciationSuggestion=r?.ok?r.suggestion:{status:'unavailable',parts:[]};renderPronunciation();buttons();},()=>{if(pronunciationKey===key){pronunciationSuggestion={status:'unavailable',parts:[]};renderPronunciation();buttons();}});
      return;
    }
    if(!pronunciationSuggestion)return;
    const suggestion=pronunciationSuggestion,alternatives=suggestion.alternatives|| (suggestion.parts?.length?[{count:suggestion.parts.length,parts:suggestion.parts}]:[]),current=w.syllables?.length?w.syllables.map(s=>s.text).join('|'):suggestion.status==='ambiguous'?null:w.spokenText||w.text;
    for(const alternative of alternatives){if(!alternative.parts?.length)continue;const b=document.createElement('button');b.type='button';b.dataset.count=alternative.count;b.textContent=`${alternative.count} ${alternative.count===1?'syllable':'syllables'} · ${alternative.parts.join('|')}`;b.setAttribute('aria-pressed',String(current===alternative.parts.join('|')));b.onclick=()=>usePronunciation(alternative.parts);choices.append(b);}
    $('pronunciation-hint').textContent=suggestion.status==='ambiguous'?`Sung as ${suggestion.syllableCounts.join(' or ')} syllables. Choose this occurrence’s pronunciation; word timing and display text stay fixed. Its syllable boundaries restart as estimates. Undo is available.`:alternatives.length?'Spelling suggestions are not audio alignment. Choosing one resets this word’s syllable boundaries to estimates.':'No usable dictionary split. Custom | spelling remains available in Sync by ear → Syllable spelling.';
  }
  function usePronunciation(parts){return run(async()=>{
    if(state.dirty)throw Error('Use exact times before changing syllables.');const w=word(),span=w.endMs-w.startMs,spoken=parts.join('');
    if(span<parts.length)throw Error('This word needs a longer interval before splitting it.');
    const operations=(w.syllables||[]).filter(s=>s.locked).map(s=>({type:'setSyllableLock',syllableId:s.id,locked:false}));
    operations.push({type:'setWordSyllables',wordId:w.id,spokenText:spoken===w.text?null:spoken,startTapping:true,syllables:parts.map((text,i)=>({id:`${w.id}-syllable-${i+1}`,text,startMs:w.startMs+Math.round(span*i/parts.length),endMs:w.startMs+Math.round(span*(i+1)/parts.length)}))});
    await tune({operations});notice(`This occurrence now has ${parts.length} syllables. Word timing and displayed lyric are unchanged; adjust its estimated child boundaries and audition before saving.`);
  });}
  function position(b,item) {b.style.left=((item.startMs-range.start)/(range.end-range.start)*100)+'%';b.style.width=Math.max(.5,(item.endMs-item.startMs)/(range.end-range.start)*100)+'%';}
  function renderLane(container,items,isSyllable) {
    container.replaceChildren();
    for(const item of items){
      const b=document.createElement('button');b.textContent=item.text;b.dataset.id=item.id;b.dataset.start=item.startMs;b.dataset.end=item.endMs;b.classList.toggle('excluded',!!item.excluded);
      b.setAttribute('aria-label',`${item.text}, ${item.startMs} to ${item.endMs} milliseconds${item.excluded?', excluded':''}`);
      b.setAttribute('aria-selected',String(isSyllable?$('target').value===item.id:word().id===item.id));position(b,item);
      for(const edge of ['start','end']){const h=document.createElement('span');h.className='handle '+edge;h.dataset.edge=edge;b.append(h);}
      b.addEventListener('click',()=>{if(b.dataset.dragged==='true'){delete b.dataset.dragged;return;}if(isSyllable){$('target').value=item.id;state.dirty=false;fields();for(const s of container.children)s.setAttribute('aria-selected',String(s.dataset.id===item.id));run(()=>seek(item.startMs-100));}else selectWord(item.id);});
      b.addEventListener('pointerdown',event=>{
        if(state.busy||event.button!==0)return;
        const initial=event.clientX,edge=event.target.dataset.edge||'move',width=container.getBoundingClientRect().width;let moved=false,interval=null;
        b.setPointerCapture(event.pointerId);
        const move=e=>{if(Math.abs(e.clientX-initial)<3&&!moved)return;moved=true;const delta=Math.round((e.clientX-initial)/width*(range.end-range.start)/10)*10;
          interval={startMs:item.startMs+(edge==='end'?0:delta),endMs:item.endMs+(edge==='start'?0:delta)};position(b,interval);};
        const finish=e=>{b.removeEventListener('pointermove',move);b.removeEventListener('pointerup',finish);b.removeEventListener('pointercancel',cancel);if(b.hasPointerCapture(e.pointerId))b.releasePointerCapture(e.pointerId);if(!moved)return;b.dataset.dragged='true';
          run(async()=>{try{if(isSyllable){state.dirty=false;await tune({operation:{type:'setSyllableTiming',syllableId:item.id,...interval}});}else{state.wordId=item.id;state.dirty=false;await tune({changes:[{wordId:item.id,...interval}]});}}finally{render();}});};
        const cancel=()=>{b.removeEventListener('pointermove',move);b.removeEventListener('pointerup',finish);b.removeEventListener('pointercancel',cancel);position(b,item);};
        b.addEventListener('pointermove',move);b.addEventListener('pointerup',finish);b.addEventListener('pointercancel',cancel);
      });container.append(b);
    }
  }
  async function commitTimes(startMs,endMs) {
    if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||endMs<=startMs)throw Error('Enter whole milliseconds, with end after start.');
    const item=target();await tune($('target').value==='word'?{changes:[{wordId:word().id,startMs,endMs}]}:{operation:{type:'setSyllableTiming',syllableId:item.id,startMs,endMs}});
  }
  const nudge=delta=>run(()=>{const t=target(),edge=$('edge').value;return commitTimes(t.startMs+(edge==='end'?0:delta),t.endMs+(edge==='start'?0:delta));});
  $('earlier').onclick=()=>nudge(-10);$('later').onclick=()=>nudge(10);
  for(const id of ['start','end'])$(id).oninput=()=>{if(!state.dirty)state.editRevision=state.draft.previewRevision;state.dirty=true;buttons();};
  $('target').onchange=()=>{state.dirty=false;fields();};
  $('use-times').onclick=()=>run(()=>commitTimes(Number($('start').value),Number($('end').value)));
  $('excluded').onchange=()=>run(async()=>{try{await tune({operation:{type:'setWordExcluded',wordId:word().id,excluded:$('excluded').checked}});}finally{fields();}});
  $('replace-words').onclick=()=>run(async()=>{
    const p=phrase(),from=p.words.findIndex(w=>w.id===word().id),to=p.words.findIndex(w=>w.id===$('replace-through').value),text=$('replacement').value.trim();
    if(!text||to<from)throw Error('Choose an end word and enter replacement lyrics.');
    if(state.dirty)throw Error('Use exact times first, or reselect the word to discard those typed times.');
    await tune({operation:{type:'replaceWords',phraseId:p.id,wordIds:p.words.slice(from,to+1).map(w=>w.id),text}});
    state.wordId=phrase().words[from].id;render();notice('Lyric text replaced in preview. New word boundaries are estimates inside the original span; audition before saving.');
  });
  $('previous').onclick=()=>selectAdjacentPhrase(-1,4);$('next').onclick=()=>selectAdjacentPhrase(1,4);
  $('phrase-track').onchange=()=>run(async()=>{try{if(state.dirty)throw Error('Use exact times before changing vocal tracks.');const laneId=$('phrase-track').value,phraseId=phrase().id,wordId=word().id,all=state.trackId==='all';const r=await request('LV_TIMING_TUNE',{operation:{type:'setPhraseLane',phraseId,laneId},allowProtected:true});state.phrase=r.preview.score.phrases.findIndex(p=>p.id===phraseId);state.wordId=wordId;state.trackId=all?'all':laneId;setDraft(r.preview);notice('Phrase moved to '+trackLabel(state.draft.score.lanes.find(l=>l.id===laneId))+'. Timings are unchanged. Audition, then Save timings; Undo restores its prior track.');}catch(error){$('phrase-track').value=phrase()?.laneId;throw error;}}).finally(()=>document.getElementById('phrase-track').focus());
  $('return').onclick=()=>run(async()=>{await chrome.tabs.update(tabId,{active:true});const tab=await chrome.tabs.get(tabId);await chrome.windows.update(tab.windowId,{focused:true});});
  $('play').onclick=()=>run(()=>request('LV_SCORE_TRANSPORT',{action:'play'}));$('pause').onclick=()=>run(()=>request('LV_SCORE_TRANSPORT',{action:'pause'}));
  $('speed').onchange=()=>run(()=>request('LV_SCORE_TRANSPORT',{action:'setRate',rate:Number($('speed').value)}));
  const updateLoop=()=>request('LV_SCORE_TRANSPORT',$('loop').checked?{action:'setLoop',loop:{startMs:Math.max(0,phrase().startMs+state.draft.score.offsetMs-250),endMs:phrase().endMs+state.draft.score.offsetMs+250}}:{action:'clearLoop'});
  $('loop').onchange=()=>run(updateLoop);
  $('audition').onclick=()=>run(async()=>{if(state.dirty)throw Error('Use exact times first.');await request('LV_SCORE_TRANSPORT',{action:'setRate',rate:1});$('speed').value='1';await seek(phrase().startMs-300);await request('LV_SCORE_TRANSPORT',{action:'play'});state.auditioned=true;notice('Preview is playing in YouTube. Save timings keeps this partial iteration, including exclusions.');});
  $('undo').onclick=()=>run(async()=>{state.dirty=false;const phraseId=phrase().id,wordId=word().id,all=state.trackId==='all';const result=await request('LV_TIMING_UNDO');state.phrase=result.preview.score.phrases.findIndex(p=>p.id===phraseId);state.wordId=wordId;state.trackId=all?'all':result.preview.score.phrases[state.phrase].laneId;setDraft(result.preview);notice('Last preview edit undone in YouTube. Saved timings are unchanged.');});
  $('save').onclick=()=>run(async()=>{state.saveError=null;try{if(!state.auditioned||state.dirty)throw Error('Audition this preview before saving.');const r=await request('LV_TIMING_APPLY');state.score=r.score;state.draft=null;setDraft((await request('LV_TIMING_PREPARE',{fromSaved:true})).preview);notice('Timings saved. Keep refining here; each save has its own undo in YouTube.');buttons();}catch(error){state.saveError=error.message;throw error}});
  document.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key)||event.metaKey||event.target.matches('input,textarea,select,[contenteditable=true]'))return;
    const direction=event.key==='ArrowLeft'?-1:1;
    if(event.ctrlKey&&!event.altKey){event.preventDefault();event.stopPropagation();if(state.dirty){notice('Use exact times before changing selection.');return;}event.shiftKey?selectAdjacentPhrase(direction):selectAdjacentWord(direction);}
    else if(event.altKey&&!event.ctrlKey){event.preventDefault();event.stopPropagation();nudge(direction*(event.shiftKey?50:10));}
  });
  chrome.runtime.onMessage.addListener(message=>{
    if(message.tabId!==tabId||message.mediaKey!==mediaKey)return;
    if(message.type==='LV_TIMING_PREVIEW_UPDATED'&&state.draft?.token===message.preview.token){if(message.preview.previewRevision>state.draft.previewRevision){if(state.busy){if(!deferredPreview||message.preview.previewRevision>deferredPreview.previewRevision)deferredPreview=message.preview;}else setDraft(message.preview);}}
    if(message.type==='LV_TIMING_PREVIEW_CLOSED'){state.draft=null;notice('Preview closed in YouTube. Reopen Sync there to continue.');buttons();}
    if(message.type==='LV_SCORE_UPDATED'&&state.score&&message.score.revision!==state.score.revision){state.score=message.score;state.draft=null;notice('Saved score changed. Reopen Sync in YouTube for a fresh preview.');buttons();}
  });
  async function poll() {
    if(state.closed)return;
    try{const c=await chrome.tabs.sendMessage(tabId,{type:'LV_ANALYSIS_CLOCK'});if(c.mediaKey!==mediaKey||c.isAd)throw Error('Source changed or advertisement active.');
      const now=c.currentTimeMs-(state.draft?.score.offsetMs||0),head=$('playhead');
      const followLane=state.trackId==='all'?phrase()?.laneId:state.trackId,laneInfo=state.draft?.score.lanes.find(l=>l.id===followLane),laneActive=state.draft?.score.phrases.some(p=>p.laneId===followLane&&now>=p.startMs&&now<p.endMs&&p.words.some(w=>!w.excluded));
      $('clock').textContent=`${(c.currentTimeMs/1000).toFixed(3)}s · ${c.paused?'paused':'playing'}${laneInfo?' · '+trackLabel(laneInfo)+(!c.paused&&!laneActive?' rest':''):''}`;
      if(state.draft&&!c.paused&&$('follow').checked&&!$('loop').checked&&!state.busy&&!state.dirty&&!document.activeElement?.closest('aside')&&document.activeElement?.id!=='phrase-track'&&!document.querySelector('.lane button:active')){
        const rows=state.draft.score.phrases,current=phrase(),lane=current?.laneId;
        if(!(now>=current.startMs&&now<current.endMs)){
          let index=rows.findIndex(p=>p.laneId===(state.trackId==='all'?lane:state.trackId)&&now>=p.startMs&&now<p.endMs&&p.words.some(w=>!w.excluded));
          if(index>=0&&index!==state.phrase){state.phrase=index;state.wordId=phrase().words.find(w=>!w.excluded)?.id;state.editRevision=null;render();}
        }
      }
      head.style.display=now>=range.start&&now<=range.end?'block':'none';
      const lane=$('words');head.style.left=(lane.offsetLeft+(now-range.start)/(range.end-range.start)*lane.clientWidth)+'px';
      for(const b of document.querySelectorAll('.lane button'))b.classList.toggle('playing',!b.classList.contains('excluded')&&now>=Number(b.dataset.start)&&now<Number(b.dataset.end));
    }catch(error){$('clock').textContent='YouTube connection unavailable';}
    polling=setTimeout(poll,100);
  }
  window.LvLightEditor=Object.freeze({getState:()=>JSON.parse(JSON.stringify(state))});
  const viewControls=()=>[...document.querySelectorAll('input[id],select[id]')].map(e=>({id:e.id,value:e.value,checked:e.checked}));
  function restoreViewControls(restore){
    for(const saved of restore.controls||[]){const e=$(saved.id);if(!e||saved.id==='phrase-track')continue;if(e.tagName==='SELECT'&&![...e.options].some(o=>o.value===saved.value))continue;e.value=saved.value;if(e.type==='checkbox')e.checked=!!saved.checked;}
    for(const saved of restore.details||[]){const e=$(saved.id);if(e?.tagName==='DETAILS')e.open=!!saved.open;}
    buttons();if(restore.focusId)$(restore.focusId)?.focus();
  }
  window.addEventListener('pagehide',()=>{state.closed=true;clearTimeout(polling);sessionStorage.setItem('lvLightRestore',JSON.stringify({mediaKey,token:state.draft?.token,revision:state.draft?.previewRevision,phrase:state.phrase,wordId:state.wordId,trackId:state.trackId,target:$('target').value,start:$('start').value,end:$('end').value,dirty:state.dirty,editRevision:state.editRevision,auditioned:state.auditioned,controls:viewControls(),details:[...document.querySelectorAll('details[id]')].map(e=>({id:e.id,open:e.open})),focusId:document.activeElement?.id}));});
  run(async()=>{if(!Number.isSafeInteger(tabId)||tabId<=0||!mediaKey)throw Error('Open this editor from Sync in YouTube.');state.score=(await request('LV_SCORE_GET')).score;const current=await request('LV_TIMING_CURRENT');state.score=current.score;setDraft(current.preview||(await request('LV_TIMING_PREPARE',{fromSaved:true})).preview);const restore=JSON.parse(sessionStorage.getItem('lvLightRestore')||'null');if(restore&&restore.mediaKey===mediaKey&&restore.token===state.draft.token&&restore.revision===state.draft.previewRevision){state.phrase=Math.max(0,Math.min(restore.phrase,state.draft.score.phrases.length-1));state.wordId=restore.wordId;state.trackId=restore.trackId==='all'?'all':state.draft.score.lanes.some(l=>l.id===restore.trackId)&&phrase()?.laneId===restore.trackId?restore.trackId:phrase()?.laneId||state.trackId;render();if([...$('target').options].some(o=>o.value===restore.target))$('target').value=restore.target;fields();$('start').value=restore.start;$('end').value=restore.end;state.dirty=!!restore.dirty;state.editRevision=restore.editRevision;state.auditioned=!!restore.auditioned;restoreViewControls(restore);}notice('Select a word to seek YouTube. Exclude unsung text or refine the blocks, then audition and save.');poll();});
})();
