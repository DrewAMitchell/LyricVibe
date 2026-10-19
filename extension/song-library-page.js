(function(){
  const $=id=>document.getElementById(id),state={rows:[],sort:'percent',direction:'asc'},percent=value=>value===null?'—':value+'%';let sequence=0,timer;
  function text(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
  function render(){
    const rows=LvSongLibrary.select(state.rows,{query:$('search').value,filter:$('filter').value,sort:state.sort,direction:state.direction});
    $('count').textContent=`${rows.length} of ${state.rows.length} songs · ${state.rows.filter(r=>r.percent!==100).length} need work`;
    $('empty').hidden=rows.length>0;$('empty').textContent=state.rows.length?'No songs match. Try another search or filter.':'No saved songs yet. Open a YouTube song with LyricVibe to start.';
    const fragment=document.createDocumentFragment();
    for(const row of rows){
      const tr=document.createElement('tr');tr.dataset.mediaKey=row.mediaKey;
      const song=document.createElement('td'),link=text('a',row.title,'song-title');link.href='https://www.youtube.com/watch?v='+encodeURIComponent(row.mediaKey.slice(8));link.target='_blank';link.rel='noopener noreferrer';link.title='Open this recording on YouTube in a new tab';song.append(link,text('span',row.artist||'Artist not listed','artist'));
      if(row.preview)song.append(text('span','Unsaved preview','status'));
      else if(row.stalePreview){const note=text('span','Saved · older preview ignored','status stale');note.title='The stored preview no longer matches this saved revision. Open the song to review it.';song.append(note);}
      if(row.unavailable)song.append(text('span','Score unavailable','status'));
      const total=document.createElement('td'),gauge=document.createElement('div');gauge.className='score'+(row.percent===100?' complete':'');gauge.append(text('strong',percent(row.percent)));
      if(row.percent!==null){const bar=document.createElement('progress');bar.max=100;bar.value=row.percent;bar.setAttribute('aria-label',row.title+' timing completeness');gauge.append(bar);}total.append(gauge);
      total.title=row.unavailable?'Saved score could not be read.':row.percent===null?'No included lyrics to score.':`Phrases ${percent(row.modes.phrase)} · Words ${percent(row.modes.word)} · Syllables ${percent(row.modes.syllable)}. Equal weight across listed lyrics.`;
      if(row.preview)total.append(text('small','Saved '+percent(row.savedPercent),'saved'));
      tr.append(song,total);for(const mode of ['phrase','word','syllable'])tr.append(text('td',percent(row.modes[mode])));fragment.append(tr);
    }
    $('songs').replaceChildren(fragment);
    for(const button of document.querySelectorAll('[data-sort]')){const active=button.dataset.sort===state.sort;button.closest('th').removeAttribute('aria-sort');if(active)button.closest('th').setAttribute('aria-sort',state.direction==='asc'?'ascending':'descending');button.querySelector('span').textContent=active?(state.direction==='asc'?'↑':'↓'):'';}
  }
  async function load(){const request=++sequence;$('refresh').disabled=true;try{const keys=chrome.storage.local.getKeys?(await chrome.storage.local.getKeys()).filter(k=>/^lv(?:Score|TimingPreview):youtube:[A-Za-z0-9_-]{11}$/.test(k)):null;const storage=await chrome.storage.local.get(keys);if(request!==sequence)return;state.rows=LvSongLibrary.summarize(storage);$('error').hidden=true;render();}catch(error){if(request===sequence){$('error').textContent='Could not refresh songs. '+error.message;$('error').hidden=false;$('count').textContent=state.rows.length?'Showing the previous list.':'Songs could not be loaded.';}}finally{if(request===sequence)$('refresh').disabled=false;}}
  $('search').addEventListener('input',render);$('filter').addEventListener('change',render);$('refresh').onclick=()=>void load();
  for(const button of document.querySelectorAll('[data-sort]'))button.onclick=()=>{state.direction=state.sort===button.dataset.sort&&state.direction==='asc'?'desc':'asc';state.sort=button.dataset.sort;render();};
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&Object.keys(changes).some(k=>/^lv(?:Score|TimingPreview):/.test(k))){clearTimeout(timer);timer=setTimeout(()=>void load(),120);}});
  void load();
})();
