/* One worker owns map-history writes across tabs. Re-evaluation is idempotent. */
(function(root){
  if(root.LvEmojiMapHost)return;
  const store=LvEmojiMapHistory.createStore({storage:chrome.storage.local});
  const key=url=>{try{const u=new URL(url);if(u.protocol!=='https:'||!['www.youtube.com','music.youtube.com'].includes(u.hostname)||u.pathname!=='/watch')return null;const id=u.searchParams.get('v');return /^[A-Za-z0-9_-]{11}$/.test(id)?'youtube:'+id:null;}catch{return null;}};
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['LV_EMOJI_MAP_HISTORY','LV_EMOJI_MAP_SAVE'].includes(message?.type))return;
    const guard=async()=>{if(sender.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(sender.tab?.id)||key(sender.url)!==message.mediaKey||key((await chrome.tabs.get(sender.tab.id)).url)!==message.mediaKey)throw Error('The source song changed. Reopen its map editor.');};
    (async()=>{await guard();const result=message.type==='LV_EMOJI_MAP_HISTORY'?await store.list(message):await store.save(message,guard);respond({ok:true,...result});})().catch(error=>respond({ok:false,error:{code:'EMOJI_MAP_SAVE_FAILED',message:error.message}}));return true;
  });
  // Preserve existing saved maps when the feature is first loaded, without
  // changing a song assignment or the currently applied preset.
  const ready=store.checkpoint();ready.catch(()=>{});
  root.LvEmojiMapHost={store,ready};
})(globalThis);
