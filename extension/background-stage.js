/* One browser-session owner for unfocused presentation; never owns playback. */
(function(root){
  if(root.LvBackgroundStage)return;
  const key='lvxBackgroundStage';let owner=null,revision=0,queue=Promise.resolve();
  const ready=(async()=>{const data=(await chrome.storage.session.get(key))[key];if(Number.isInteger(data?.revision))revision=data.revision;if(Number.isInteger(data?.tabId)){try{await chrome.tabs.get(data.tabId);owner=data.tabId;}catch{}}})();
  const persist=()=>chrome.storage.session.set({[key]:{tabId:owner,revision}});
  const notify=(tabId,enabled)=>chrome.tabs.sendMessage(tabId,{type:'LV_BACKGROUND_STAGE_STATE',enabled,revision});
  const current=tabId=>({ok:true,enabled:owner===tabId,revision});
  async function change(tabId,enabled){
    await ready;
    if(enabled&&owner===tabId||!enabled&&owner!==tabId)return current(tabId);
    const previous=owner;
    if(previous!==null){
      let exists=true;try{await chrome.tabs.get(previous);}catch{exists=false;}
      if(exists){const answer=await notify(previous,false);if(!answer?.ok)throw Error('The previous live stage did not acknowledge stopping.');}
    }
    owner=enabled?tabId:null;revision++;await persist();
    if(owner!==null)await notify(owner,true);
    return current(tabId);
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(!['LV_BACKGROUND_STAGE_GET','LV_BACKGROUND_STAGE_SET'].includes(message?.type))return;
    if(sender.id!==chrome.runtime.id||!Number.isInteger(sender.tab?.id)||sender.frameId!==0){respond({ok:false,error:{message:'A top-level LyricVibe tab is required.'}});return;}
    if(message.type==='LV_BACKGROUND_STAGE_SET'&&typeof message.enabled!=='boolean'){respond({ok:false,error:{message:'Choose on or off.'}});return;}
    const work=queue.then(async()=>{await ready;return message.type==='LV_BACKGROUND_STAGE_GET'?current(sender.tab.id):change(sender.tab.id,message.enabled);});
    queue=work.catch(()=>{});work.then(respond,error=>respond({ok:false,error:{message:error.message}}));return true;
  });
  chrome.tabs.onRemoved.addListener(tabId=>{queue=queue.then(async()=>{await ready;if(owner===tabId){owner=null;revision++;await persist();}}).catch(()=>{});});
  root.LvBackgroundStage={ready,state:()=>({owner,revision})};
})(globalThis);
