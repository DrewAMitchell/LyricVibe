// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe other-parts proof Chrome PID${browserPid}; finite production UI verification, finally-close; owner codex01a126ca.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({content:fs.readFileSync(path.join(root,'extension/content.css'),'utf8')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-stage-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={lvxControlPlacement:{x:.8,y:.3,orientation:'horizontal'}};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,openTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,root,stage,bounds,tempo,themePicker,toggleThemePicker,setLinger,buildThemePicker,setTimingWorkspace,timingWorkspace,refreshTempoGate,controlsNotice,teardown,stageEdit,stagePanel,stageSurface,openStageEdit,refreshStageEdit,closeStageEdit,timingRequest,placement,refreshBeatPulse,tempoButton,sidebarDownbeat,beatClick,tapTempo,refreshCompletion,jumpUnfinished,phraseAuthoring,authoringProgress,startLoop,cancelLoop,repeatCapture,getPartRun:()=>partRun,countIn,useTapTake,keepSyllableAndNext,setLyricsOnly,refreshRecordingTransport,startEffects,markEffect,stopEffects,useEffects,discardEffects,refreshEffectPanel,renderBeatEffects,effectPreview,applyTheme,setChoreography,placeControls};})();'));

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
  await evaluate(async()=>{const q=__qa;q.tempo.mediaKey=LvScore.mediaKey(q.state.score.source);q.tempo.map=null;await q.openTimingReview();});
  assert.equal(await evaluate(()=>Boolean(__qa.timing.draft&&!__qa.syncPanel.hidden&&!__qa.root.classList.contains('lvx-tempo-required'))),true,'timing opens with no BPM setup gate');
  await evaluate(async()=>{const q=__qa;q.setTimingWorkspace('record');q.timing.phraseIndex=0;q.tapping.wordId=q.timing.draft.score.phrases[0].words[0].id;document.querySelector('video').currentTime=1;document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-scope]').value='lane';q.refreshTimingPanel();window.__before=JSON.stringify(q.timing.draft.score);});
  await page.setViewportSize({width:1920,height:1080});await evaluate(()=>{__qa.syncPanel.hidden=true;__qa.root.classList.add('lvx-active');});await page.getByRole('button',{name:'Reset controls position',exact:true}).click();
  const bar=page.locator('.lvx-control-header'),hud=page.locator('.lvx-sidebar .lvx-hud'),button=page.getByRole('button',{name:'Open LyricVibe controls',exact:true}),menu=page.locator('.lvx-workspace-menu');
  const before=await hud.boundingBox();const colors=await button.evaluate(n=>[getComputedStyle(n).backgroundColor,getComputedStyle(n.nextElementSibling).backgroundColor]);assert.notEqual(colors[0],colors[1],'menu button is visually distinct');await button.click();await page.waitForFunction(()=>{const n=document.querySelector('.lvx-workspace-menu'),b=document.querySelector('.lvx-control-menu');return !n.hidden&&Math.abs(n.getBoundingClientRect().left-b.getBoundingClientRect().left)<2;});const after=await hud.boundingBox(),p=await menu.boundingBox(),a=await bar.boundingBox();assert.ok(p.width<=250&&p.y>=a.y+a.height-1&&p.y>=after.y+after.height-1,'menu is compact and does not cover quick controls');assert.ok(Math.abs(before.y-after.y)<1&&Math.abs(before.width-after.width)<1,'menu does not move quick controls');
  
  await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Reset controls position',exact:true}).click();await button.click();await page.waitForFunction(()=>{const n=document.querySelector('.lvx-workspace-menu');if(n.hidden)return false;const r=n.getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth&&r.bottom<=window.innerHeight});
  console.log('Separate menu and compact controls proof passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END')});
