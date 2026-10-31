// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe emoji version proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage({viewport:{width:process.argv.includes('--narrow')?390:1280,height:800}});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({content:fs.readFileSync(path.join(root,'extension/content.css'),'utf8')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-stage-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','emoji-keywords-data','emoji-tags','choreography','transcript-text','timing-variant','overlay-export'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate((process.argv.includes('--regression-before')?require('node:child_process').execFileSync('git',['show','61bd3e0:extension/content.js'],{cwd:root,encoding:'utf8',windowsHide:true}):fs.readFileSync(path.join(root,'extension/content.js'),'utf8')).replace(/\}\)\(\);\s*$/,'window.__qa={wordPresetStorageChanged,choreographLine,setPreviewTime:value=>{previewTime=value;renderWordRulePreview();},openTranscriptEditor,expressLine,loadTempo,refreshTempoEditor,captureTracks,switchCaptureTrack,discardTapTake,latestArchivedSyllableEvents,openTimingReview,rebindRecording,applyTranscript,armTapTake,recordingContext,tapBinding,state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport,startEffects,markEffect,stopEffects,useEffects,discardEffects,refreshEffectPanel,renderBeatEffects,effectPreview,effectGesture,beginEffectGesture,finishEffectGesture,sampleEffectGesture,clearEffectsTrack,effectClearOperations,effectTrackProjection,refreshEffectTracks,applyTheme,setChoreography,placeControls};})();'));

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
    window.__hostListeners=[];chrome.runtime.onMessage.addListener=fn=>__hostListeners.push(fn);
    window.__hostMessage=(message,sender={id:'fixture',frameId:0,url:location.href,tab:{id:1,url:location.href}})=>new Promise(resolve=>{if(!__hostListeners.some(fn=>fn(message,sender,resolve)===true))resolve({ok:true});});
    chrome.runtime.sendMessage=message=>['LV_SCORE_UPDATED','LV_TIMING_PREVIEW_UPDATED','LV_TIMING_PREVIEW_CLOSED'].includes(message.type)?Promise.resolve({ok:true}):__hostMessage(message);
    chrome.tabs={get:async()=>({url:location.href}),sendMessage:async(id,message)=>{if(message.type==='LV_GET_HINTS')return {url:location.href,duration:30,mediaReady:true,isAd:false};let answer;for(const fn of __messageListeners)fn(structuredClone(message),{},r=>answer=r);return answer||{ok:true};}};
  });
  for(const file of ['score-host','emoji-map-history','emoji-map-host'])await evaluate(fs.readFileSync(path.join(root,'extension',file+'.js'),'utf8'));

  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const waitStatus=pattern=>page.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('[data-map-status]').textContent),pattern);
  await evaluate(()=>{__lyricVibeOverlay.wordRuleSets.set({version:1,activeId:'default',sets:[{id:'default',name:'Default',rules:[],emojiMap:[{emoji:'🌊',terms:['water','flow']}]}]});__qa.toggleThemePicker(true);});
  await page.locator('[data-studio-tab=words]').click();
  const text=page.getByLabel('Emoji map text',{exact:true}),scope=page.getByLabel('Emoji map save scope',{exact:true}),save=page.locator('[data-map-save]'),status=page.locator('[data-map-status]'),versions=page.getByLabel('Saved emoji map version',{exact:true}),preview=page.getByLabel('Saved emoji map preview',{exact:true}),restore=page.locator('[data-map-restore]');
  const original=await evaluate(()=>JSON.stringify({score:__qa.state.score,draft:__qa.timing.draft,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused}));
  assert.equal(await scope.inputValue(),'song');assert.equal(await text.inputValue(),'🌊 = (water, flow)');
  // A stale worker can have no listener: no response must retain the whole draft.
  const beforeMissing=await evaluate(()=>JSON.stringify(__store));
  await evaluate(()=>{window.__normalSend=chrome.runtime.sendMessage;chrome.runtime.sendMessage=async()=>undefined;});
  await text.fill('🌊 = (water, flow)\n⭐ = (shine)');await save.click();await waitStatus('No response from the LyricVibe map service');
  assert.match(await status.textContent(),/Save not confirmed/);assert.equal(await text.inputValue(),'🌊 = (water, flow)\n⭐ = (shine)');assert.equal(await evaluate(()=>JSON.stringify(__store)),beforeMissing);assert.equal(await save.isDisabled(),false);
  await evaluate(()=>chrome.runtime.sendMessage=__normalSend);
  await text.fill('🌊 = (water, flow)\n⭐ = (shine)');await save.click();await waitStatus('Map saved');
  let library=await evaluate(()=>__lyricVibeOverlay.wordRuleSets.getState());assert.equal(library.sets.length,2);assert.equal(library.sets[0].emojiMap.length,1);assert.deepEqual(library.sets[1].emojiMapDelta,{remove:[],set:[{emoji:'⭐',terms:['shine']}]});assert.equal(library.sets[1].emojiMap,undefined);
  await page.locator('.lvx-map-versions > summary').click();await page.waitForFunction(()=>document.querySelector('[aria-label="Saved emoji map version"]').options.length===2);
  const baseline=(await versions.locator('option').all()).at(-1);const baselineId=await baseline.getAttribute('value');await versions.selectOption(baselineId);assert.equal(await preview.inputValue(),'🌊 = (water, flow)');
  await text.fill('💦 = (water)');await restore.click();await waitStatus('unsaved text');assert.equal(await text.inputValue(),'💦 = (water)');
  await page.locator('[data-map-revert]').click();await page.waitForFunction(()=>!document.querySelector('[data-map-restore]').disabled);await versions.selectOption(baselineId);await restore.click();await waitStatus('Version restored');assert.equal(await text.inputValue(),'🌊 = (water, flow)');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Saved emoji map version"]').options.length===3);
  // A rejected write is reported honestly and leaves the editor and storage intact.
  const beforeFail=await evaluate(()=>JSON.stringify(__store));await evaluate(()=>{window.__normalSet=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw Error('Fixture disk full');};});await text.fill('🔥 = (water)');await save.click();await waitStatus('Fixture disk full');assert.equal(await text.inputValue(),'🔥 = (water)');assert.equal(await evaluate(()=>JSON.stringify(__store)),beforeFail);await evaluate(()=>chrome.storage.local.set=__normalSet);
  // Input remains available during a pending write; success cannot erase newer typing.
  await evaluate(()=>{chrome.storage.local.set=async items=>{if(items.lvxWordRuleSets)await new Promise(r=>window.__releaseMapSave=r);return __normalSet(items);};});await save.click();await page.waitForFunction(()=>document.querySelector('[data-map-save]').disabled);await text.fill('💦 = (water, sweat)');await evaluate(()=>__releaseMapSave());await waitStatus('newer typing');assert.equal(await text.inputValue(),'💦 = (water, sweat)');await evaluate(()=>chrome.storage.local.set=__normalSet);
  await save.click();await waitStatus('Map saved');
  await page.getByLabel('Word-effect set',{exact:true}).selectOption('default');assert.equal(await page.locator('[data-set-delete]').isDisabled(),true,'Keep one shared default even when song copies exist');await scope.selectOption('shared');await text.fill('📏 = (water)');await save.click();await waitStatus('Map saved');assert.equal(await evaluate(()=>__lyricVibeOverlay.wordRuleSets.forSong('youtube:TESTVIDEO01').emojiMap[0].emoji),'💦');assert.equal(await evaluate(()=>__lyricVibeOverlay.wordRuleSets.forSong('youtube:TESTVIDEO02').emojiMap[0].emoji),'📏');
  await page.getByLabel('Word-effect set',{exact:true}).selectOption('song-TESTVIDEO01');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Saved emoji map version"]').options.length>=4);
  const packet=await evaluate(()=>__lyricVibeOverlay.overlayExport.create({startMs:0,endMs:5000,width:1280,height:720,fps:30}));assert.equal(packet.display.wordSet.songKey,undefined);assert.equal(packet.display.wordSet.emojiMapBaseId,undefined);assert.deepEqual(packet.display.wordSet.emojiMap,[{emoji:'💦',terms:['water','sweat']}]);
  // Fresh production content instance reads the saved song map and versions.
  assert.equal(await evaluate(()=>JSON.stringify({score:__qa.state.score,draft:__qa.timing.draft,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused})),original);
  const persisted=await evaluate(()=>__lyricVibeOverlay.wordRuleSets.getState());
  await evaluate(()=>__qa.teardown());
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={toggleThemePicker};})();'));
  assert.deepEqual(await evaluate(()=>__lyricVibeOverlay.wordRuleSets.getState()),persisted);
  await evaluate(()=>__qa.toggleThemePicker(true));await page.locator('[data-studio-tab=words]').click();await page.locator('.lvx-map-versions > summary').click();await page.waitForFunction(()=>document.querySelector('[aria-label="Saved emoji map version"]').options.length>=4);
  assert.equal(await text.inputValue(),'💦 = (water, sweat)');
  // Chrome keeps the sender document URL from before same-document navigation.
  // The shared Default map must still save for the current song.
  await page.getByLabel('Word-effect set',{exact:true}).selectOption('default');
  await scope.selectOption('shared');
  await evaluate(()=>{history.pushState({},'', '/watch?v=TESTVIDEO02');chrome.runtime.sendMessage=message=>__hostMessage(message,{id:'fixture',frameId:0,url:'https://www.youtube.com/watch?v=TESTVIDEO01',tab:{id:1,url:location.href}});});
  await text.fill('⭐ = (shine, star)');await save.click();await waitStatus('Map saved');
  assert.deepEqual((await evaluate(()=>__lyricVibeOverlay.wordRuleSets.getState())).sets.find(s=>s.id==='default').emojiMap,[{emoji:'⭐',terms:['shine','star']}]);
  if(!process.argv.includes('--no-screenshot'))await page.locator(process.argv.includes('--narrow')?'.lvx-map-versions':'.lvx-emoji-map').screenshot({path:path.join(root,process.argv.includes('--narrow')?'docs/emoji-map-versions-narrow.png':'docs/emoji-map-versions.png')});
  assert.deepEqual(errors,[]);
  const proof={observedAt:new Date().toISOString(),basis:'Production map editor and background history host in isolated Chrome; synthetic storage/media and trusted input',songDefault:true,frozenBaseDelta:true,sharedDefaultIndependent:true,previewRestore:true,restorePreservesNewerVersions:true,dirtyRestoreGuard:true,missingHostRetainsText:true,writeFailureRetainsText:true,pendingSaveRetainsNewTyping:true,reloadHistory:true,selfContainedExport:true,scoreAndPlaybackPreserved:true,errors};if(!process.argv.includes('--no-receipt'))fs.writeFileSync(path.join(root,process.argv.includes('--narrow')?'docs/emoji-map-versions-proof-narrow.json':'docs/emoji-map-versions-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END')});
