/* Opening this local extension page does not start playback or alter a score. */
(function(root){
  if(root.LvSongLibraryHost)return;
  let opening=null;
  async function open(){
    if(opening)return opening;
    opening=(async()=>{const url=chrome.runtime.getURL('song-library.html'),tabs=await chrome.tabs.query({}),existing=tabs.find(t=>t.url===url);if(existing){await chrome.tabs.update(existing.id,{active:true});if(Number.isInteger(existing.windowId))await chrome.windows.update(existing.windowId,{focused:true});}else await chrome.tabs.create({url});return {ok:true};})();
    try{return await opening;}finally{opening=null;}
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.type!=='LV_SONG_LIBRARY_OPEN')return;
    let allowed=false;try{const url=new URL(sender.url||sender.tab?.url);allowed=sender.id===chrome.runtime.id&&sender.frameId===0&&url.protocol==='https:'&&['www.youtube.com','music.youtube.com','youtube.com'].includes(url.hostname);}catch{}
    if(!allowed){respond({ok:false,error:{message:'Open Songs from the LyricVibe sidebar.'}});return;}
    open().then(respond,error=>respond({ok:false,error:{message:error.message}}));return true;
  });
  root.LvSongLibraryHost={open};
})(globalThis);
