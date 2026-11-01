// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe rotor proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close; isolated fixture.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={trackWatch,state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport,startEffects,markEffect,stopEffects,useEffects,discardEffects,refreshEffectPanel,renderBeatEffects,effectPreview,effectGesture,beginEffectGesture,finishEffectGesture,sampleEffectGesture,clearEffectsTrack,effectClearOperations,applyTheme,setChoreography,placeControls};})();'));

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

  await evaluate(async()=>{const q=__qa,w=q.timing.draft.score.phrases[0].words[0];const r=await q.timingRequest('LV_TIMING_TUNE',{operations:[{type:'setWordSyllables',wordId:w.id,syllables:[{id:'main-s1',text:'MA',startMs:1000,endMs:1500,effects:[],locked:false,provenance:'estimated'},{id:'main-s2',text:'IN',startMs:1500,endMs:2000,effects:[],locked:false,provenance:'estimated'}]}]});q.timing.draft=r.preview;q.setTimingWorkspace('effects');q.refreshTimingPanel();window.__timingShape=()=>{const score=structuredClone(q.timing.draft.score);for(const p of score.phrases)for(const w of p.words){delete w.effects;for(const part of w.syllables||[])delete part.effects;}return JSON.stringify(score.phrases);};window.__beforeEffects=__timingShape();});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await evaluate(()=>{__qa.trackWatch.accept(LvScore.mediaKey(__qa.state.score.source));__qa.startLoop();});
  const before=await evaluate(()=>JSON.stringify({draft:__qa.timing.draft,store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused}));
  await page.locator('[data-effect=rotor]').click();
  assert.equal(await evaluate(()=>__qa.effectPreview.type),'rotor');
  assert.match(await page.locator('.lvx-effect-preview .lvx-score-word').first().getAttribute('style'),/rotate\(calc/);
  await page.getByRole('button',{name:'Pause effect preview',exact:true}).click();
  assert.equal(await evaluate(()=>JSON.stringify({draft:__qa.timing.draft,store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused})),before);
  const focus=()=>page.locator('body').click({position:{x:1270,y:790}});
  const enter=async()=>{await focus();await page.keyboard.press('Enter');};
  const settle=()=>waitFor(()=>!__qa.performanceTake.armed&&!__qa.timing.busy&&!__qa.performanceTake.marks.length);
  await page.locator('[data-effect-target=word]').click();await enter();await waitFor(()=>__qa.performanceTake.armed);
  await evaluate(()=>document.querySelector('video').currentTime=1.25);
  await page.keyboard.press('0');assert.equal(await evaluate(()=>__qa.performanceTake.marks.length),0);
  await page.keyboard.down('Space');await page.keyboard.press('0');await page.keyboard.up('Space');
  assert.equal(await evaluate(()=>__qa.performanceTake.marks[0].operation.effect.type),'rotor');
  await page.locator('[data-sync=effect-undo]').click();assert.equal(await evaluate(()=>__qa.performanceTake.marks.length),0);
  await focus();await page.keyboard.down('Space');await page.keyboard.press('0');await page.keyboard.up('Space');await enter();await settle();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[0].words[0].effects[0].type),'rotor');
  const renderer=await evaluate(()=>{const q=__qa;q.renderScore(1250);const n=()=>q.stage.querySelector('[data-word="'+q.timing.draft.score.phrases[0].words[0].id+'"]');const a=n().style.transform;q.renderScore(1750);const b=n().style.transform;q.renderScore(1250);return {a,b,replay:n().style.transform===a};});assert.notEqual(renderer.a,renderer.b);assert.equal(renderer.replay,true);
  await page.locator('.lvx-effects-clock summary').click();await page.locator('[data-sync=effect-clock]').selectOption('beat');await page.locator('[data-effect-target=phrase]').click();await enter();await waitFor(()=>__qa.performanceTake.armed);await evaluate(()=>document.querySelector('video').currentTime=1.25);
  await focus();await page.keyboard.down('Space');await page.keyboard.press('0');await page.keyboard.up('Space');await enter();await settle();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.beatCues.at(-1).effect),'rotor');
  assert.ok(await evaluate(()=>{__qa.renderScore(2000);return [...__qa.stage.querySelectorAll('[data-word]')].some(n=>parseFloat(n.style.getPropertyValue('--lvx-beat-rotor'))>0);}));
  assert.equal(await evaluate(()=>getComputedStyle(__qa.stage.querySelector('[data-syllable]')).getPropertyValue('--lvx-beat-rotor').trim()),'0deg','Parent word rotor is not applied again to nested syllables');
  assert.ok(await evaluate(()=>{__qa.renderScore(6000);return [...__qa.stage.querySelectorAll('[data-word]')].every(n=>!parseFloat(n.style.getPropertyValue('--lvx-beat-rotor')));}));
  await page.emulateMedia({reducedMotion:'reduce'});assert.ok(await evaluate(()=>{__qa.renderScore(1500);return [...__qa.stage.querySelectorAll('[data-word]')].every(n=>!parseFloat(n.style.getPropertyValue('--lvx-beat-rotor')));}));await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-sync=effect-clock]').selectOption('interval');await page.locator('[data-effect-target=syllable]').click();await enter();await waitFor(()=>__qa.performanceTake.armed);await evaluate(()=>document.querySelector('video').currentTime=1.25);await focus();await page.keyboard.down('Space');await page.keyboard.press('0');await page.keyboard.up('Space');await enter();await settle();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[0].words[0].syllables[0].effects[0].type),'rotor');
  const saved=await evaluate(async()=>{const q=__qa,r=await q.timingRequest('LV_TIMING_APPLY',{});if(!r.ok)throw Error(JSON.stringify(r));const score=__store['lvScore:youtube:TESTVIDEO01'].score;LvScore.validateScore(JSON.parse(JSON.stringify(score)));return {word:score.phrases[0].words[0].effects[0].type,syllable:score.phrases[0].words[0].syllables[0].effects[0].type,beat:score.beatCues.at(-1).effect};});assert.deepEqual(saved,{word:'rotor',syllable:'rotor',beat:'rotor'});
  await evaluate(()=>{const q=__qa;q.syncPanel.hidden=true;q.toggleThemePicker(true);});await page.locator('[data-studio-tab=words]').click();await page.locator('.lvx-word-rules summary').click();
  await page.getByLabel('Rotor · flat 360°',{exact:true}).check();await page.getByRole('button',{name:'Save rule',exact:true}).click();assert.ok(await evaluate(()=>window.__lyricVibeOverlay.wordRuleSets.getState().sets.some(s=>s.rules.some(r=>r.effects.includes('rotor')))));
  assert.deepEqual(errors,[]);const proof={observedAt:new Date().toISOString(),basis:'Production content and score-host in isolated Chrome, fixture media clock and storage; real keyboard and pointer',previewPure:true,spaceZero:true,undo:true,wordSyllableBeatSaved:saved,sourceReplay:renderer.replay,reducedMotion:true,nestedSyllablesDoNotDoubleSpin:true,beatExitClears:true,wordRules:true,errors};console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END')});
