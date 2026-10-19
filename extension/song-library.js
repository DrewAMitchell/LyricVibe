/* Read-only projection of the score owner's existing local records. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./score-core.js'):root.LvScore);if(typeof module==='object'&&module.exports)module.exports=api;else root.LvSongLibrary=api;})(globalThis,function(core){
  const modes=['phrase','word','syllable'];
  function coverage(score){
    const result=core.timingCompleteness(score);
    return {percent:result.percent,modes:Object.fromEntries(modes.map(mode=>{
      const entries=result.lanes.map(l=>l.modes[mode]),possible=entries.reduce((n,c)=>n+c.possible,0),credit=entries.reduce((n,c)=>n+c.credit,0);
      return [mode,!possible?null:entries.every(c=>c.status==='complete'||c.status==='empty')?100:Math.min(99,Math.round(100*credit/possible))];
    }))};
  }
  function summarize(storage){
    const rows=[];
    for(const [key,record] of Object.entries(storage)){
      const match=/^lvScore:(youtube:[A-Za-z0-9_-]{11})$/.exec(key);if(!match)continue;
      const mediaKey=match[1],row={mediaKey,title:mediaKey.slice(8),artist:'',percent:null,savedPercent:null,modes:{phrase:null,word:null,syllable:null},preview:false,stalePreview:false,unavailable:false};
      try{
        const saved=core.validateScore(record.score);if(core.mediaKey(saved.source)!==mediaKey)throw Error('Source mismatch');
        row.title=saved.source.title||row.title;row.artist=saved.source.artist||'';
        let current=saved;const preview=storage['lvTimingPreview:'+mediaKey];
        if(preview){
          try{core.validateScore(preview.score);if(preview.baseRevision!==saved.revision||preview.baseHash!==saved.lyrics.contentHash||core.mediaKey(preview.score.source)!==mediaKey)throw Error('Stale preview');
            if(JSON.stringify(preview.score)!==JSON.stringify(saved)){current=preview.score;row.preview=true;}
          }catch{row.stalePreview=true;}
        }
        row.savedPercent=coverage(saved).percent;Object.assign(row,coverage(current));
      }catch{row.unavailable=true;}
      rows.push(row);
    }
    return rows;
  }
  function select(rows,{query='',filter='all',sort='percent',direction='asc'}={}){
    const tokens=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),keys=new Set(['title','percent',...modes]),key=keys.has(sort)?sort:'percent';
    const value=row=>key==='title'?row.title:key==='percent'?row.percent:row.modes[key];
    return rows.filter(row=>tokens.every(t=>(row.title+' '+row.artist+' '+row.mediaKey).toLocaleLowerCase().includes(t))&&(filter==='needs-work'?row.percent!==100:filter==='complete'?row.percent===100:filter==='preview'?row.preview:true)).sort((a,b)=>{
      const av=value(a),bv=value(b),order=key==='title'?av.localeCompare(bv):(av??-1)-(bv??-1);
      return order*(direction==='desc'?-1:1)||a.title.localeCompare(b.title)||a.mediaKey.localeCompare(b.mediaKey);
    });
  }
  return {summarize,select};
});
