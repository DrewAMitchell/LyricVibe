// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe unrecorded-parts proof Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({content:fs.readFileSync(path.join(root,'extension/content.css'),'utf8')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-stage-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport};})();'));

  page.setDefaultTimeout(5000);
  await page.addStyleTag({content:'body{margin:0;min-height:100vh;background:#060c10}#activate,#next{position:fixed;left:-999px}video{display:none}'});
  await evaluate(()=>{
    const q=__qa;const s=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]MAIN ONE\n[00:02.00]MAIN TWO\n[00:03.00]MAIN THREE\n[00:04.00]ECHO\n[00:05.00]HARMONY\n[00:20.00]',{provider:'fixture',entryId:'parts',contentHash:'a'.repeat(64)});
    s.lanes.find(l=>l.role==='lead').label='Solo';const backing=s.lanes.find(l=>l.role==='backing');backing.label='Crowd';s.lanes.push({id:'harmony',role:'backing',label:'High harmony'});
    s.phrases.forEach((p,i)=>{p.startMs=[1000,5000,10000,3000,2000][i];p.endMs=[3000,7000,12000,4000,3500][i];p.words.forEach((w,j)=>{w.startMs=p.startMs+Math.floor((p.endMs-p.startMs)*j/p.words.length);w.endMs=p.startMs+Math.floor((p.endMs-p.startMs)*(j+1)/p.words.length);});});s.phrases[3].laneId=backing.id;s.phrases[4].laneId='harmony';LvScore.validateScore(s);q.state.score=s;window.__originalPhrases=JSON.stringify(s.phrases);window.__originalPlacement=JSON.stringify(q.placement);q.root.classList.add('lvx-active');q.state.active=true;document.querySelector('video').currentTime=3;
    __store['lvScore:youtube:TESTVIDEO01']={score:structuredClone(s),history:[],review:[]};
    chrome.runtime.getURL=p=>'chrome-extension://fixture/'+p;
    chrome.storage.local.get=async(keys,cb)=>{const r=structuredClone(keys==null?__store:typeof keys==='string'?{[keys]:__store[keys]}:Object.fromEntries(keys.map(k=>[k,__store[k]])));cb?.(r);return r;};
    chrome.storage.local.set=async(items)=>{Object.assign(__store,structuredClone(items));};chrome.storage.local.remove=async(keys)=>{for(const k of [].concat(keys))delete __store[k];};chrome.storage.session={get:async()=>({}),remove:async()=>{}};
    chrome.runtime.onMessage.addListener=fn=>window.__hostListener=fn;
    window.__hostMessage=(message,sender={id:'fixture',frameId:0,url:location.href,tab:{id:1,url:location.href}})=>new Promise(resolve=>{if(__hostListener(message,sender,resolve)!==true)resolve({ok:true});});
    chrome.runtime.sendMessage=message=>['LV_SCORE_UPDATED','LV_TIMING_PREVIEW_UPDATED','LV_TIMING_PREVIEW_CLOSED'].includes(message.type)?Promise.resolve({ok:true}):__hostMessage(message);
    chrome.tabs={sendMessage:async(id,message)=>{if(message.type==='LV_GET_HINTS')return {url:location.href,duration:30,mediaReady:true,isAd:false};let answer;for(const fn of __messageListeners)fn(structuredClone(message),{},r=>answer=r);return answer||{ok:true};}};
  });
  await evaluate(fs.readFileSync(path.join(root,'extension/score-host.js'),'utf8'));


  await evaluate(require('./capture-audio-fixture.cjs'));
  await evaluate(async()=>{const q=__qa;q.tempo.mediaKey=LvScore.mediaKey(q.state.score.source);q.tempo.map=LvTapTiming.validateTempoMap({version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]});q.refreshTempoGate();const r=await q.timingRequest('LV_TIMING_PREPARE',{fromSaved:true});q.timing.draft=r.preview;q.syncPanel.hidden=false;q.setTimingWorkspace('record');q.timing.phraseIndex=0;q.tapping.wordId=q.timing.draft.score.phrases[0].words[0].id;document.querySelector('video').currentTime=1;document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-scope]').value='lane';q.refreshTimingPanel();window.__before=JSON.stringify(q.timing.draft.score);});
  const waitFor=async(fn)=>{const end=Date.now()+6000;while(!await evaluate(fn)){if(Date.now()>end)throw Error('Timed out: '+fn+' '+await evaluate(()=>JSON.stringify({notice:document.querySelector('.lvx-sync-notice').textContent,run:__qa.getPartRun(),take:__qa.tapping.take,phraseIndex:__qa.timing.phraseIndex})));await new Promise(r=>setTimeout(r,40));}};

  await evaluate(()=>{
    const s=__qa.timing.draft.score;
    for(const p of s.phrases.filter(p=>['phrase-1','phrase-3','phrase-5'].includes(p.id)))for(const w of p.words){w.provenance='manual';w.locked=true;}
    window.__completed=s.phrases.filter(p=>['phrase-1','phrase-3','phrase-5'].includes(p.id)).map(p=>JSON.stringify(p));
    __qa.refreshTimingPanel();
  });
  await page.getByRole('button',{name:'Record unrecorded parts',exact:true}).click();
  assert.match(await page.locator('[data-sync=other-parts-hint]').textContent(),/2 unfinished phrases/);
  await page.locator('.lvx-sync-panel').screenshot({path:path.join(root,'docs/record-unrecorded-parts.png')});
  await evaluate(async()=>__qa.armTapTake());
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.phraseId)),['phrase-4']);
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].id),'phrase-4','first unfinished backing phrase becomes input target');
  const mark=async(start,end)=>evaluate(`(()=>{const q=__qa,v=document.querySelector('video');v.currentTime=${start};q.markTapTime();v.currentTime=${end};q.markTapTime({release:true});})()`);
  await mark(3.1,3.9);
  await waitFor(()=>__qa.getPartRun()?.index===1&&__qa.tapping.take?.status==='armed'&&!__qa.timing.busy);
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.phraseId)),['phrase-2']);
  await mark(5.1,6.9);
  await waitFor(()=>!__qa.getPartRun()&&!__qa.tapping.take&&!__qa.timing.busy);
  assert.equal(await evaluate(()=>document.querySelector('video').paused),true);
  assert.deepEqual(await evaluate(()=>__qa.timing.draft.score.phrases.filter(p=>['phrase-1','phrase-3','phrase-5'].includes(p.id)).map(p=>JSON.stringify(p))),await evaluate(()=>__completed));
  assert.equal(await evaluate(()=>JSON.stringify(__qa.state.score.phrases)),await evaluate(()=>__originalPhrases));
  assert.equal(await evaluate(()=>__store.lvxRecordUnrecordedParts),true);
  await evaluate(()=>{__qa.timing.phraseIndex=0;__qa.refreshTimingPanel();});
  await evaluate(async()=>__qa.armTapTake());
  assert.equal(await evaluate(()=>__qa.tapping.take),null);
  assert.equal(await evaluate(()=>document.querySelector('video').paused),true);
  assert.match(await page.locator('.lvx-sync-notice').textContent(),/already have this timing/);
  await page.getByRole('button',{name:'Record unrecorded parts',exact:true}).click();
  await evaluate(async()=>__qa.armTapTake());
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.phraseId)),['phrase-1','phrase-2','phrase-3'],'off retains ordinary rerecording');
  await evaluate(async()=>__qa.stopTapTake());
  // Partial word pass must never overwrite the completed word in the same phrase.
  await evaluate(()=>{
    const q=__qa,p=q.timing.draft.score.phrases[0];p.words[0].provenance='manual';p.words[0].locked=true;p.words[1].locked=false;
    q.timing.phraseIndex=0;q.tapping.wordId=p.words[0].id;document.querySelector('video').currentTime=1;document.querySelector('video').paused=true;
    document.querySelector('[data-sync=tap-mode]').value='word';document.querySelector('[data-sync=tap-scope]').value='phrase';
    q.refreshTimingPanel();window.__word=JSON.stringify(p.words[0]);
  });
  await page.getByRole('button',{name:'Record unrecorded parts',exact:true}).click();
  await evaluate(async()=>__qa.armTapTake());
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.wordId)),['phrase-1-word-2']);
  await mark(1.8,2.9);
  await waitFor(()=>__qa.getPartRun()?.index===1&&__qa.tapping.take?.status==='armed'&&!__qa.timing.busy);
  await mark(3.1,3.9);
  await waitFor(()=>!__qa.getPartRun()&&!__qa.tapping.take&&!__qa.timing.busy);
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0].words[0])),await evaluate(()=>__word));
  await evaluate(()=>{
    const q=__qa,s=q.timing.draft.score;
    for(const p of s.phrases)for(const w of p.words)w.syllables=p.id==='phrase-4'?[]:[{id:w.id+'-s1',text:w.text,startMs:w.startMs,endMs:w.endMs,provenance:'manual',locked:true,effects:[]}];
    q.timing.phraseIndex=0;q.tapping.wordId=s.phrases[0].words[0].id;document.querySelector('video').currentTime=1;
    document.querySelector('[data-sync=tap-mode]').value='syllable';document.querySelector('[data-sync=tap-syllable-flow]').value='phrase';document.querySelector('[data-sync=record-repeat]').checked=true;
    const send=chrome.runtime.sendMessage;chrome.runtime.sendMessage=m=>m.type==='LV_PRONUNCIATION_SUGGEST'?Promise.resolve({ok:true,suggestion:{status:'known',parts:[m.text],alternatives:[]}}):send(m);
    q.refreshTimingPanel();window.__syllableMain=JSON.stringify(s.phrases[0]);
  });
  await evaluate(async()=>__qa.armTapTake());
  assert.equal(await evaluate(()=>__qa.tapping.take.units[0].text),'ECHO');
  await evaluate(()=>{document.querySelector('video').currentTime=3.2;__qa.markTapTime();});
  await evaluate(async()=>__qa.keepSyllableAndNext());
  assert.equal(await evaluate(()=>__qa.getPartRun()),null,'unrecorded run does not loop already completed parts');
  assert.equal(await evaluate(()=>__qa.tapping.take),null);
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0])),await evaluate(()=>__syllableMain));
  const checks=['Completed Main and backing phrases skipped; unfinished backing remains reachable through a completed Main anchor','Next unfinished Main phrase selected and run ends paused','Completed phrase bytes and saved score unchanged','No remaining targets does not arm or play; switch off allows rerecording','Partial word pass keeps completed word bytes unchanged','New preference persists independently of legacy tour preference','Syllable practice skips complete Main before spelling preparation, keeps its review step and ends even with Repeat enabled'];
  fs.writeFileSync(path.join(root,'docs/unrecorded-parts-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Actual Chrome content UI and score host with synthetic media/storage; no human song edits.',checks},null,2)+'\n');
  console.log(JSON.stringify({checks}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
