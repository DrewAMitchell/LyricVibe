// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),outputDir=process.env.LV_PROOF_OUTPUT_DIR||path.join(root,'docs'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe vocal track keyboard switch proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close; owner codex01a126ca.\n`);};
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
  await evaluate((process.argv.includes('--regression-before')?require('node:child_process').execFileSync('git',['show','61bd3e0:extension/content.js'],{cwd:root,encoding:'utf8',windowsHide:true}):fs.readFileSync(path.join(root,'extension/content.js'),'utf8')).replace(/\}\)\(\);\s*$/,'window.__qa={captureTracks,switchCaptureTrack,discardTapTake,latestArchivedSyllableEvents,openTimingReview,rebindRecording,applyTranscript,armTapTake,recordingContext,tapBinding,state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport,startEffects,markEffect,stopEffects,useEffects,discardEffects,refreshEffectPanel,renderBeatEffects,effectPreview,effectGesture,beginEffectGesture,finishEffectGesture,sampleEffectGesture,clearEffectsTrack,effectClearOperations,effectTrackProjection,refreshEffectTracks,applyTheme,setChoreography,placeControls};})();'));

  page.setDefaultTimeout(5000);
  await page.addStyleTag({content:'body{margin:0;min-height:100vh;background:#060c10}#activate,#next{position:fixed;left:-999px}video{display:none}'});
  await evaluate(()=>{
    const q=__qa;const s=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]MAIN ONE\n[00:02.00]MAIN TWO\n[00:03.00]MAIN THREE\n[00:04.00]ECHO\n[00:05.00]HARMONY\n[00:06.00]ECHO LATER\n[00:20.00]',{provider:'fixture',entryId:'parts',contentHash:'a'.repeat(64)});
    s.lanes.find(l=>l.role==='lead').label='Solo';const backing=s.lanes.find(l=>l.role==='backing');backing.label='Crowd';s.lanes.push({id:'harmony',role:'backing',label:'High harmony'});
    s.phrases.forEach((p,i)=>{p.startMs=[1000,5000,10000,3000,2000,15000][i];p.endMs=[3000,7000,12000,4000,3500,17000][i];p.words.forEach((w,j)=>{w.startMs=p.startMs+Math.floor((p.endMs-p.startMs)*j/p.words.length);w.endMs=p.startMs+Math.floor((p.endMs-p.startMs)*(j+1)/p.words.length);});});s.phrases[3].laneId=backing.id;s.phrases[4].laneId='harmony';s.phrases[5].laneId=backing.id;LvScore.validateScore(s);q.state.score=s;window.__originalPhrases=JSON.stringify(s.phrases);window.__originalPlacement=JSON.stringify(q.placement);q.root.classList.add('lvx-active');q.state.active=true;document.querySelector('video').currentTime=3;
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


  await evaluate(()=>chrome.tabs.sendMessage(1,{type:'LV_SCORE_UPDATED',score:__qa.state.score,mediaKey:'youtube:TESTVIDEO01'}));

  const lane=()=>evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].laneId);
  const switchKey=async key=>{await page.keyboard.press(key);await waitFor(()=>!__qa.captureTracks.switching&&!__qa.timing.busy);};
  await evaluate(()=>{const q=__qa;document.querySelector('video').currentTime=1;document.querySelector('video').paused=false;document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-cadence]').value='hold';return q.armTapTake();});
  assert.equal(await evaluate(()=>__qa.root.classList.contains('lvx-lyrics-only')),true,'Starting a take opens the on-video view');
  await page.keyboard.press('q');assert.equal(await evaluate(()=>document.querySelector('video').paused),true);assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed');
  if(process.env.LV_QUICK_FIX_SCREENSHOT)await page.screenshot({path:process.env.LV_QUICK_FIX_SCREENSHOT});
  await page.getByRole('button',{name:'Resume take'}).click();assert.equal(await evaluate(()=>document.querySelector('video').paused),false);assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed');
  await page.keyboard.press('q');await page.getByRole('button',{name:'Missing backing'}).click();
  await waitFor(()=>document.querySelector('.lvx-transcript-editor').open);assert.equal(await evaluate(()=>document.querySelector('video').paused),true);
  assert.match(await evaluate(()=>{const a=document.querySelector('[data-sync=transcript-text]');return a.value.slice(a.selectionStart,a.selectionEnd)}),/MAIN ONE/,'Correction selects the current phrase');
  await evaluate(()=>{document.querySelector('[data-sync=transcript-close]').click();document.querySelector('video').paused=false;return __qa.armTapTake();});
  await page.keyboard.down('Space');await evaluate(()=>document.querySelector('video').currentTime=2);await page.keyboard.up('Space');
  await page.keyboard.press('q');assert.equal(await evaluate(()=>__qa.tapping.take.marks.length),1,'Quick correction keeps completed input while deciding');
  await page.getByRole('button',{name:'Lyrics or typo'}).click();await waitFor(()=>document.querySelector('.lvx-transcript-editor').open);
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[0];return [p.startMs,p.endMs]}),[1000,2000],'Completed phrase survives opening lyrics');
  await evaluate(()=>{document.querySelector('[data-sync=transcript-close]').click();document.querySelector('video').paused=false;return __qa.armTapTake();});
  await switchKey('ArrowDown');assert.equal(await lane(),'backing');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),2,'Track switch must not seek');
  assert.equal(await evaluate(()=>document.querySelector('video').paused),false);
  assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed');
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[0];return [p.startMs,p.endMs]}),[1000,2000]);
  await switchKey('ArrowDown');assert.equal(await lane(),'harmony');
  await switchKey('ArrowUp');assert.equal(await lane(),'backing');
  await switchKey('ArrowUp');assert.equal(await lane(),'lead');
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[0];return [p.startMs,p.endMs]}),[1000,2000],'Returning retains main preview timing');
  await evaluate(()=>{document.querySelector('video').currentTime=8;__qa.refreshPerformClock(8000)});
  await switchKey('ArrowDown');assert.equal(await lane(),'backing');assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[__qa.timing.phraseIndex].startMs),15000,'A gap selects the upcoming phrase, not an old phrase '+await evaluate(()=>JSON.stringify({take:__qa.tapping.take,index:__qa.timing.phraseIndex,notice:document.querySelector('.lvx-sync-notice').textContent,slots:[...__qa.captureTracks.slots.keys()]})));
  assert.equal(await evaluate(()=>__qa.tapping.take?.status),'armed');await switchKey('ArrowUp');
  await evaluate(()=>{document.querySelector('video').currentTime=20;__qa.refreshPerformClock(20000)});
  await switchKey('ArrowDown');await switchKey('ArrowDown');assert.equal(await lane(),'harmony');assert.equal(await evaluate(()=>__qa.tapping.take?.status),'armed','Sparse track remains armed after its only phrase');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),20,'Sparse track switch does not seek');
  await switchKey('ArrowUp');await switchKey('ArrowUp');assert.equal(await lane(),'lead');assert.equal(await evaluate(()=>__qa.tapping.take?.status),'armed');

  // Untimed free syllables remain separate per track, including incomplete grouping.
  await evaluate(async()=>{
    const q=__qa;q.discardTapTake();q.captureTracks.slots.clear();await q.timingRequest('LV_TIMING_CANCEL');
    const s=LvScore.createPlainScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'MAIN WORDS\n(BACKING WORDS)\nMAIN AGAIN\n(BACKING AGAIN)',{provider:'Manual paste',entryId:'switch',contentHash:'b'.repeat(64)});
    q.state.score=s;__store['lvScore:youtube:TESTVIDEO01']={score:structuredClone(s),history:[],review:[]};q.timing.draft=null;q.syncPanel.hidden=true;await q.openTimingReview();
    document.querySelector('[data-sync=tap-mode]').value='syllable';document.querySelector('[data-sync=tap-syllable-flow]').value='holds';document.querySelector('video').currentTime=17;document.querySelector('video').paused=false;
    q.tapping.syllableStartKey='youtube:TESTVIDEO01';await q.armTapTake();
  });
  assert.equal(await lane(),'lead');
  await page.keyboard.down('Space');await evaluate(()=>document.querySelector('video').currentTime=17.4);await page.keyboard.up('Space');
  const mainEvents=await evaluate(()=>JSON.stringify(__qa.tapping.take.events));
  await switchKey('ArrowDown');assert.equal(await lane(),'backing');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),17.4);
  assert.equal(await evaluate(()=>__qa.tapping.take.events.length),0);
  await page.keyboard.down('Space');await switchKey('ArrowUp');assert.equal(await lane(),'backing','Held Space cannot move to another track');
  await evaluate(()=>document.querySelector('video').currentTime=18.1);await page.keyboard.up('Space');
  const backingEvents=await evaluate(()=>JSON.stringify(__qa.tapping.take.events));
  await switchKey('ArrowUp');assert.equal(await lane(),'lead');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.tapping.take.events)),mainEvents,'Main events resume exactly');
  assert.equal(await evaluate(()=>document.querySelector('video').currentTime),18.1);
  assert.equal(await evaluate(()=>JSON.stringify(__qa.captureTracks.slots.get('backing').state.take.events)),backingEvents);
  await evaluate(()=>{document.querySelector('video').paused=true;document.querySelector('video').playbackRate=.75;});
  await switchKey('ArrowDown');assert.equal(await evaluate(()=>document.querySelector('video').paused),true);assert.equal(await evaluate(()=>document.querySelector('video').currentTime),18.1);assert.equal(await evaluate(()=>document.querySelector('video').playbackRate),.75);assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed');
  await switchKey('ArrowUp');assert.equal(await lane(),'lead');await evaluate(()=>{document.querySelector('video').paused=false;});
  const archived=await evaluate(()=>__qa.latestArchivedSyllableEvents());assert.equal(JSON.stringify(archived),mainEvents,'Main word pass only receives main syllables');
  await page.evaluate(()=>{const input=document.createElement('input');input.id='fixture-input';input.value='123';input.style.cssText='position:fixed;top:0;left:0;z-index:2147483647';document.body.append(input);input.focus();});await page.keyboard.press('ArrowDown');assert.equal(await lane(),'lead','Native input arrows do not switch capture');
  await page.locator('#fixture-input').evaluate(e=>e.remove());await page.locator('[data-sync=tap-mark]').focus();
  await evaluate(()=>__qa.stopTapTake());
  await evaluate(()=>__qa.setLyricsOnly(false));
  await page.getByRole('combobox',{name:'Vocal track to record'}).selectOption('backing');await waitFor(()=>!__qa.captureTracks.switching);
  assert.equal(await lane(),'backing');assert.equal(await evaluate(()=>JSON.stringify(__qa.tapping.take.events)),backingEvents);
  assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true);
  // Saving must back up parked incomplete captures and retain them if storage fails.
  await evaluate(()=>{window.__storageSet=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw Error('fixture disk unavailable')};});
  await evaluate(()=>__qa.applyTimingReview());assert.equal(await evaluate(()=>__qa.captureTracks.slots.has('lead')),true);assert.match(await evaluate(()=>__qa.timing.saveError),/fixture disk/);
  await evaluate(()=>{chrome.storage.local.set=__storageSet;return __qa.applyTimingReview();});
  assert.equal(await evaluate(()=>__qa.timing.saveError),null);
  const saved=await evaluate(()=>Object.values(__store).filter(v=>v?.schema==='lyricvibe-performance-events-v1').map(v=>({events:v.events,phrases:v.referenceUnits.map(u=>u.phraseId)})));
  assert(saved.some(v=>JSON.stringify(v.events)===mainEvents));assert(saved.some(v=>JSON.stringify(v.events)===backingEvents));
  assert.equal(await evaluate(()=>__qa.captureTracks.slots.size),0);
  await page.getByRole('button',{name:'Close error details'}).click();await page.locator('.lvx-capture-tracks').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(outputDir,'capture-track-switch.png')});
  await page.setViewportSize({width:390,height:844});
  const picker=page.locator('.lvx-capture-tracks');await picker.scrollIntoViewIfNeeded();const bounds=await picker.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);
  await page.screenshot({path:path.join(outputDir,'capture-track-switch-narrow.png')});
  const proof={observedAt:new Date().toISOString(),basis:'Production overlay and score host in isolated Chrome; trusted keyboard and selector actions with synthetic source time',upDownSelectNamedTracks:true,playbackPositionPreserved:true,pausedTakeAndSpeedPreserved:true,recordingRemainsArmed:true,completedTimingInPreview:true,perTrackRawEventsPreserved:true,heldSpaceCannotChangeTrack:true,inputArrowKeysUnaffected:true,wordPassOnlyUsesSameTrackSyllables:true,saveFailureRetainsAllTracks:true,saveBacksUpParkedCapture:true,narrowPickerFits:true};
  fs.writeFileSync(path.join(outputDir,'capture-track-switch-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END')});
