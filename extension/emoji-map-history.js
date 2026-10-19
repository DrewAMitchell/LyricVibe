/* Serialized, durable map saves. History is independent of transient preset Undo. */
(function(root){
  const c=typeof module==='object'&&module.exports?require('./choreography.js'):root.LvChoreography;
  const clone=v=>structuredClone(v),basis=set=>JSON.stringify({emojiMap:set.emojiMap||[],emojiDictionary:set.emojiDictionary!==false});
  const historyKey=id=>'lvxEmojiMapHistory:'+id;
  function createStore({storage,now=()=>new Date().toISOString(),uuid=()=>crypto.randomUUID(),hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('')}){
    let queue=Promise.resolve();
    const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
    async function library(){const data=await storage.get(['lvxWordRuleSets','lvxWordRules']);return c.validateWordRuleSets(data.lvxWordRuleSets||{version:1,activeId:'default',sets:[{id:'default',name:'Default',rules:data.lvxWordRules||c.defaultWordRules}]});}
    async function history(id){const key=historyKey(id),data=await storage.get(key),value=data[key];if(value&&(value.version!==1||!Array.isArray(value.entries)))throw Error('Saved versions need review; nothing was overwritten.');return value||{version:1,entries:[]};}
    function snapshot(set,kind,sourceVersionId){return {id:uuid(),createdAt:now(),kind,...(sourceVersionId?{sourceVersionId}:{}),emojiMap:clone(set.emojiMap||[]),emojiDictionary:set.emojiDictionary!==false};}
    function target(request,lib){
      if(!/^youtube:[A-Za-z0-9_-]{11}$/.test(request.mediaKey))throw Error('Open a song before saving its map.');
      const raw=lib.sets.find(s=>s.id===request.presetId);if(!raw)throw Error('This preset was removed. Reopen the editor.');
      if(raw.songKey&&raw.songKey!==request.mediaKey)throw Error('This preset belongs to another song.');
      if(!['song','shared'].includes(request.scope)||request.scope==='shared'&&raw.songKey)throw Error('Choose a shared preset to edit its shared map.');
      const id=request.scope==='song'?'song-'+request.mediaKey.slice(8):raw.id;
      return {raw,set:c.resolveWordSet(lib,raw),id};
    }
    return {
      checkpoint:()=>serial(async()=>{
        const lib=await library(),writes={};
        for(const raw of lib.sets){const set=c.resolveWordSet(lib,raw);if(!set.emojiMap?.length)continue;const saved=await history(set.id);if(!saved.entries.length)writes[historyKey(set.id)]={version:1,entries:[snapshot(set,'initial')]};}
        if(Object.keys(writes).length)await storage.set(writes);
        return Object.keys(writes).length;
      }),
      list:request=>serial(async()=>{const lib=await library(),t=target(request,lib);return {presetId:t.id,...clone(await history(t.id))};}),
      save:(request,guard=async()=>{})=>serial(async()=>{
        const lib=await library(),t=target(request,lib);
        if(request.expectedBasis!==basis(t.set)||(lib.songSets?.[request.mediaKey]||null)!==request.expectedAssignment)throw Error('This map or song assignment changed elsewhere. Copy your text, then Revert text before saving.');
        const existing=lib.sets.find(s=>s.id===t.id);
        if(existing&&existing.id!==t.raw.id)throw Error('This song already has a saved map. Select its song preset before saving.');
        const saved=await history(t.id);
        let map,dictionary;
        if(request.restoreId){const version=saved.entries.find(v=>v.id===request.restoreId);if(!version)throw Error('That saved version is no longer available.');map=c.validateEmojiMap(version.emojiMap);dictionary=version.emojiDictionary;}
        else {map=c.validateEmojiMap(request.emojiMap);dictionary=request.emojiDictionary;if(typeof dictionary!=='boolean')throw Error('Choose the dictionary setting.');}
        const entries=[...saved.entries];
        if(!entries.length||basis(entries.at(-1))!==basis(t.set))entries.push(snapshot(t.set,'before-save'));
        let nextSet={...t.raw,emojiDictionary:dictionary,emojiTags:true},bases={...lib.emojiMapBases};
        if(request.scope==='song'){
          const baseId=t.raw.emojiMapBaseId||await hash(JSON.stringify(t.set.emojiMap||[]));
          if(!bases[baseId])bases[baseId]=clone(t.set.emojiMap||[]);
          nextSet={...nextSet,id:t.id,name:existing?.name||'Song '+request.mediaKey.slice(8),songKey:request.mediaKey,emojiMapBaseId:baseId,emojiMapDelta:c.emojiMapDelta(bases[baseId],map)};delete nextSet.emojiMap;
        }else nextSet.emojiMap=map;
        const next=c.validateWordRuleSets({...lib,sets:existing?lib.sets.map(s=>s.id===t.id?nextSet:s):[...lib.sets,nextSet],...(request.scope==='song'?{songSets:{...lib.songSets,[request.mediaKey]:t.id},emojiMapBases:bases}:{})});
        entries.push(snapshot({emojiMap:map,emojiDictionary:dictionary},request.restoreId?'restore':'save',request.restoreId));
        await guard();
        if(JSON.stringify(await library())!==JSON.stringify(lib))throw Error('Presets changed while saving. Your text is retained; try again.');
        await storage.set({lvxWordRuleSets:next,[historyKey(t.id)]:{version:1,entries:entries.slice(-50)}});
        return {library:next,presetId:t.id,versionId:entries.at(-1).id};
      })
    };
  }
  const api={createStore,basis,historyKey};root.LvEmojiMapHistory=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
