const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),S=require('../extension/score-core.js'),L=require('../extension/song-library.js');
const make=(id,title='Example',artist='Artist')=>S.createScore({platform:'youtube',videoId:id,title,artist,durationMs:10000},'[00:01.00]Hello world\n[00:08.00]',{provider:'fixture',entryId:id,contentHash:'a'.repeat(64)});
test('song list uses the same completeness and only a valid source-bound preview; all reads preserve storage',()=>{
  const saved=make('TESTVIDEO01'),preview=S.applyOperation(saved,{type:'setPhraseTiming',phraseId:saved.phrases[0].id,startMs:1000,endMs:8000},saved.revision),store={'lvScore:youtube:TESTVIDEO01':{score:saved},'lvTimingPreview:youtube:TESTVIDEO01':{score:preview,baseRevision:saved.revision,baseHash:saved.lyrics.contentHash},'lvScore:youtube:TESTVIDEO02':{score:make('TESTVIDEO03')},'lvCache:other':{score:saved}};
  const before=JSON.stringify(store),row=L.summarize(store)[0];assert.equal(row.percent,S.timingCompleteness(preview).percent);assert.equal(row.percent,33);assert.equal(row.savedPercent,0);assert.equal(row.preview,true);assert.equal(row.modes.phrase,100);assert.equal(JSON.stringify(store),before);
  assert.equal(L.summarize(store)[1].unavailable,true);
  for(const patch of [{baseRevision:999},{baseHash:'b'.repeat(64)},{score:make('TESTVIDEO02')}]){const bad=structuredClone(store);Object.assign(bad['lvTimingPreview:youtube:TESTVIDEO01'],patch);const current=L.summarize(bad)[0];assert.equal(current.percent,0);assert.equal(current.preview,false);assert.equal(current.stalePreview,true);}
  store['lvTimingPreview:youtube:TESTVIDEO01'].score=structuredClone(saved);assert.equal(L.summarize(store)[0].preview,false);
});
test('search, needs-work and preview filters, and stable numeric/header sorting use compact rows without lyrics',()=>{
  const rows=[{mediaKey:'youtube:TESTVIDEO01',title:'Zulu',artist:'Nova',percent:100,preview:false,modes:{phrase:100,word:100,syllable:100}},{mediaKey:'youtube:TESTVIDEO02',title:'Alpha',artist:'Nova',percent:9,preview:true,modes:{phrase:27,word:0,syllable:0}},{mediaKey:'youtube:TESTVIDEO03',title:'Beta',artist:'Other',percent:80,preview:false,modes:{phrase:100,word:90,syllable:50}},{mediaKey:'youtube:TESTVIDEO04',title:'Empty',artist:'',percent:null,preview:false,modes:{phrase:null,word:null,syllable:null}}];
  assert.deepEqual(L.select(rows).map(r=>r.percent),[null,9,80,100]);assert.deepEqual(L.select(rows,{direction:'desc'}).map(r=>r.percent),[100,80,9,null]);
  assert.deepEqual(L.select(rows,{query:'nova alpha'}).map(r=>r.title),['Alpha']);assert.equal(L.select(rows,{query:'TESTVIDEO03'}).length,1);
  assert.equal(L.select(rows,{filter:'needs-work'}).length,3);assert.equal(L.select(rows,{filter:'complete'}).length,1);assert.equal(L.select(rows,{filter:'preview'})[0].title,'Alpha');
  assert.deepEqual(L.select(rows,{sort:'title'}).map(r=>r.title),['Alpha','Beta','Empty','Zulu']);assert.equal(L.select(rows,{sort:'word',direction:'desc'})[0].title,'Zulu');
  const row=L.summarize({'lvScore:youtube:TESTVIDEO01':{score:make('TESTVIDEO01')}})[0];assert.equal(row.score,undefined);assert.equal(row.lyrics,undefined);
});
test('Songs opener rejects unrelated senders and reuses the existing extension page without source playback calls',async()=>{
  let listener;const calls=[],tabs=[];const chrome={runtime:{id:'fixture',getURL:file=>'chrome-extension://fixture/'+file,onMessage:{addListener:fn=>listener=fn}},tabs:{query:async()=>tabs,create:async options=>{calls.push(['create',options]);tabs.push({id:8,windowId:2,url:options.url});},update:async(...args)=>calls.push(['update',...args])},windows:{update:async(...args)=>calls.push(['focus',...args])}};
  const context=vm.createContext({chrome,URL});const source=fs.readFileSync(require.resolve('../extension/song-library-host.js'),'utf8');vm.runInContext(source,context);const first=listener;vm.runInContext(source,context);assert.equal(listener,first);
  const send=sender=>new Promise(resolve=>listener({type:'LV_SONG_LIBRARY_OPEN'},sender,resolve));
  for(const sender of [{id:'other',frameId:0,url:'https://www.youtube.com/watch?v=TESTVIDEO01'},{id:'fixture',frameId:1,url:'https://www.youtube.com/watch?v=TESTVIDEO01'},{id:'fixture',frameId:0,url:'https://evil.test/'}])assert.equal((await send(sender)).ok,false);
  const sender={id:'fixture',frameId:0,url:'https://www.youtube.com/watch?v=TESTVIDEO01'};assert.equal((await send(sender)).ok,true);assert.equal((await send(sender)).ok,true);assert.equal(calls[0][0],'create');assert.equal(calls[0][1].url,'chrome-extension://fixture/song-library.html');assert.equal(calls[1][0],'update');assert.equal(calls[2][0],'focus');assert.equal(calls.length,3);
});
