// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe unrecorded-parts proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,plainTimingNotice,wordTimingUnits,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport,finishMissingParts,captureTarget};})();'));

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
  await evaluate(()=>{
    const q=__qa,s=q.timing.draft.score;for(const w of s.phrases[1].words){w.provenance='estimated';w.locked=false;}
    q.timing.phraseIndex=0;q.tapping.wordId=s.phrases[0].words[0].id;document.querySelector('video').currentTime=1;document.querySelector('video').paused=true;
    document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-scope]').value='lane';document.querySelector('[data-sync=record-repeat]').checked=false;
    q.refreshTimingPanel();window.__lastPhrase=JSON.stringify(s.phrases[2]);
  });
  await evaluate(async()=>__qa.armTapTake());
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.phraseId)),['phrase-2']);
  await page.keyboard.press('Backspace');
  assert.equal(await evaluate(()=>__qa.tapping.take.units.some(u=>u.phraseId==='phrase-3')),false,'Backspace must not append completed phrases');
  await evaluate(async()=>__qa.stopTapTake());
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[2])),await evaluate(()=>__lastPhrase));
  // A deliberate recovery loop skips complete phrases and crosses phrase boundaries.
  await evaluate(()=>{const q=__qa,s=q.timing.draft.score;for(const p of s.phrases)for(const w of p.words){w.provenance='manual';w.locked=true;}for(const id of ['phrase-1','phrase-3'])for(const w of s.phrases.find(p=>p.id===id).words){w.provenance='estimated';w.locked=false;}q.timing.phraseIndex=0;q.tapping.wordId=s.phrases[0].words[0].id;document.querySelector('video').paused=true;document.querySelector('[data-sync=tap-mode]').value='word';document.querySelector('[data-sync=record-repeat]').checked=false;document.querySelector('[data-sync=record-other-parts]').checked=false;window.__finishedMiddle=JSON.stringify(s.phrases[1]);q.refreshTimingPanel();});
  await evaluate(async()=>__qa.finishMissingParts());
  assert.equal(await page.locator('[data-sync=record-other-parts]').isChecked(),true);
  assert.equal(await page.locator('[data-sync=record-repeat]').isChecked(),true);
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].id),'phrase-1');
  await evaluate(()=>{document.querySelector('video').currentTime=3.1;window.__didLoop=__qa.repeatCapture();});
  assert.equal(await evaluate(()=>__didLoop),true,'unfinished phrase loops without overwriting it');
  assert.ok(await evaluate(()=>document.querySelector('video').currentTime<1));
  await evaluate(()=>{const q=__qa,v=document.querySelector('video');q.timing.phraseIndex=0;v.currentTime=.1;v.paused=false;q.refreshTimingPanel();q.refreshRecordingTransport();window.__forwardTake=JSON.stringify(q.tapping.take);});
  assert.equal(await page.locator('[data-record-forward]').isDisabled(),false);
  assert.match(await page.locator('[data-record-forward]').textContent(),/Next lead-in/);
  await page.locator('[data-record-forward]').click();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].id),'phrase-1','lead-in navigation keeps the selected capture phrase');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.tapping.take)),await evaluate(()=>__forwardTake),'lead-in navigation leaves the full take and cursor unchanged');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),.2,'missing-only mode still jumps to the configured lead-in before the next lyric');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[1])),await evaluate(()=>__finishedMiddle));
  await page.locator('[data-sync=tap-mark]').focus();await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),.2,'Shift+Right remains a lead-in shortcut in missing-only mode');
  await page.getByRole('button',{name:'Close error details',exact:true}).click();
  await page.screenshot({path:path.join(root,'docs/unrecorded-recovery-loop.png')});
  await evaluate(()=>{
    const q=__qa,s=q.timing.draft.score,v=document.querySelector('video'),previous=s.phrases.find(p=>p.id==='phrase-1'),current=s.phrases.find(p=>p.id==='phrase-3');
    for(const w of previous.words){w.provenance='manual';w.locked=true;}
    window.__previousTiming=JSON.stringify(previous);
    document.querySelector('[data-sync=record-other-parts]').checked=true;document.querySelector('[data-sync=record-repeat]').checked=true;document.querySelector('[data-sync=tap-mode]').value='word';
    q.timing.phraseIndex=s.phrases.indexOf(current);q.tapping.wordId=current.words[0].id;
    const units=current.words.filter(w=>!w.excluded).map(w=>({id:w.id,wordId:w.id,phraseId:current.id,text:w.text,minMs:0,maxMs:s.source.durationMs,referenceStartMs:w.startMs,estimatedStartMs:w.startMs}));
    q.tapping.take=LvTapTiming.beginWordHolds(units,[]);q.tapping.binding=q.tapBinding();q.tapping.take.index=0;q.tapping.take.status='armed';
    v.currentTime=10.5;v.paused=false;q.refreshTimingPanel();
  });
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].id),'phrase-1','second Back reaches the completed previous phrase in missing-only mode');
  assert.ok(await evaluate(()=>__qa.tapping.take.units.some(u=>u.phraseId==='phrase-1')),'previous phrase targets are added to the active take');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0])),await evaluate(()=>__previousTiming),'navigation alone preserves completed timing');
  await evaluate(()=>{const q=__qa,v=document.querySelector('video');v.currentTime=1.2;v.paused=false;q.markTapTime();v.currentTime=1.5;q.markTapTime({release:true});});
  assert.ok(await evaluate(()=>__qa.tapping.take.holds.some(h=>h.phraseId==='phrase-1')),'new capture is accepted for the completed phrase instead of being filtered out');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0])),await evaluate(()=>__previousTiming),'retake timing is staged in the take until its normal save path');
  await evaluate(()=>{
    const q=__qa,s=q.timing.draft.score,v=document.querySelector('video'),previous=s.phrases.find(p=>p.id==='phrase-1'),current=s.phrases.find(p=>p.id==='phrase-3');
    previous.words[0].text='H-Town';window.__hyphenScoreBefore=JSON.stringify(previous);
    const currentUnits=q.wordTimingUnits(current.words).map(u=>({...u,phraseId:current.id}));
    let take=LvTapTiming.begin(currentUnits,{mode:'word',cadence:'pairs'});take=LvTapTiming.mark(take,10500);take=LvTapTiming.mark(take,10600);
    q.timing.phraseIndex=s.phrases.indexOf(current);q.tapping.wordId=current.words[0].id;q.tapping.take=take;q.tapping.binding=q.tapBinding();
    document.querySelector('[data-sync=record-other-parts]').checked=true;document.querySelector('[data-sync=record-repeat]').checked=true;document.querySelector('[data-sync=tap-mode]').value='word';
    window.__wordBefore=JSON.stringify(take);window.__hyphenExpected=JSON.stringify(q.wordTimingUnits(previous.words.slice(0,1)));v.currentTime=10.5;v.paused=false;q.refreshTimingPanel();
  });
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.draft.score.phrases.findIndex(p=>p.id==='phrase-1')].id),'phrase-1','ordinary word take reaches the prior completed phrase');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.tapping.take.units.filter(u=>u.wordId===__qa.timing.draft.score.phrases[0].words[0].id))),await evaluate(()=>__hyphenExpected),'hyphenated retake keeps word subpart ids, spelling and estimated timing fields');
  assert.ok(await evaluate(()=>__qa.tapping.take.units[__qa.tapping.take.index]?.id===JSON.parse(__hyphenExpected)[0].id),'inserting earlier units keeps the active cursor on the retake target');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.tapping.take.marks)),await evaluate(()=>JSON.stringify(JSON.parse(__wordBefore).marks)),'existing future marks remain attached to their original unit ids');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0])),await evaluate(()=>__hyphenScoreBefore),'adding hyphenated retake units does not change score timing');
  await evaluate(()=>{const q=__qa,v=document.querySelector('video');v.currentTime=1.2;v.paused=false;q.markTapTime();v.currentTime=1.5;q.markTapTime({release:true});});
  assert.ok(await evaluate(()=>__qa.tapping.take.marks.some(m=>m.id===JSON.parse(__hyphenExpected)[0].id)),'the retake accepts a new boundary through the normal word-timing path');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases[0])),await evaluate(()=>__hyphenScoreBefore),'captured retake marks stay out of score timing until the existing Apply/Save path');
  await evaluate(()=>{const q=__qa,score=q.timing.draft.score;score.lyrics.timingBasis='caption-segments';score.lyrics.captionSource={kind:'automatic',language:'en'};q.refreshTimingPanel();});
  assert.equal(await evaluate(()=>__qa.plainTimingNotice.textContent),'YouTube captions (automatic, en) · Imported segment times; review words.');
  assert.equal(await evaluate(()=>__qa.plainTimingNotice.hidden),false,'caption provenance remains visible after word timing is recorded');
  const checks=['Completed Main and backing phrases skipped; unfinished backing remains reachable through a completed Main anchor','Next unfinished Main phrase selected and run ends paused','Completed phrase bytes and saved score unchanged','No remaining targets does not arm or play; switch off allows rerecording','Partial word pass keeps completed word bytes unchanged','New preference persists independently of legacy tour preference','Backspace removes unfinished phrase without appending or changing completed phrases','Syllable practice skips complete Main before spelling preparation, keeps its review step and ends even with Repeat enabled','Finish missing parts enables looping and unrecorded-only','unfinished phrase repeats','Next lead-in button and Shift+Right remain forward-only in missing-only mode without changing capture state','second Back exposes a completed phrase for retake without changing score until new inputs','hyphenated word retake preserves the existing subpart unit schema and future mark ids','caption origin remains visible with imported segment times after recording'];
  fs.writeFileSync(path.join(root,'docs/unrecorded-parts-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Actual Chrome content UI and score host with synthetic media/storage; no human song edits.',checks},null,2)+'\n');
  console.log(JSON.stringify({checks}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
