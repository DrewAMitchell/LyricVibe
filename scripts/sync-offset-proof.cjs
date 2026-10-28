// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
const ledger=process.env.LV_PROBE_LEDGER;
const log=(state,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe save regression PID${pid}; finite Chrome proof; release verification.\n`);};
log('START',process.pid);let server,browser;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});console.log(JSON.stringify({browserPid:server.process().pid}));
  log('START',server.process().pid);browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({path:path.join(root,'extension/content.css')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-navigation-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true,configurable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,tempo,syncPanel,syncSave,hasUnsavedWork,nudgeSync,setSyncOffset,renderScore,startLoop,refreshTimingPanel,disableWatch:()=>{trackWatch=null;}};})();'));

  await evaluate(()=>{
    const q=__qa;q.disableWatch();q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:12000},'[00:01.00]ONE TWO THREE\n[00:07.00]FOUR FIVE\n[00:12.00]',{provider:'fixture',entryId:'sync',contentHash:'a'.repeat(64)});
    q.state.active=true;q.state.syncOffsetMs=0;window.__originalPhrases=JSON.stringify(q.state.score.phrases);window.__saved=structuredClone(q.state.score);window.__errors=[];window.__writes=[];
    const v=document.querySelector('video');v.paused=false;window.__start=performance.now();Object.defineProperty(v,'currentTime',{configurable:true,get:()=>2+(performance.now()-__start)/1000,set:()=>{throw Error('Sync must not seek playback');}});
    chrome.runtime.sendMessage=async message=>{
      if(message.type!=='LV_SCORE_OPERATION')return {ok:true};
      await new Promise(r=>setTimeout(r,80));
      if(window.__failNext){window.__failNext=false;return {ok:false,error:{code:'WRITE_FAILED',message:'Synthetic storage failure'}};}
      try{
        __saved=LvScore.applyOperation(__saved,message.operation,message.expectedRevision);__writes.push(__saved.offsetMs);
        const update={type:'LV_SCORE_UPDATED',score:structuredClone(__saved),mediaKey:'youtube:TESTVIDEO01'};
        for(const listener of __messageListeners)listener(update,{},()=>{});
        return {ok:true,score:structuredClone(__saved)};
      }catch(error){__errors.push(error.code||error.message);return {ok:false,error:{code:error.code,message:error.message}};}
    };
    q.startLoop();q.nudgeSync(-50);q.nudgeSync(-50);q.nudgeSync(-50);
  });
  await evaluate(async()=>{await new Promise(r=>setTimeout(r,550));});
  const result=await evaluate(()=>({saved:__saved.offsetMs,shown:__qa.state.syncOffsetMs,errors:__errors,writes:__writes,paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime}));
  console.log(JSON.stringify(result));
  assert.equal(result.saved,-150,'three rapid earlier nudges must accumulate while playback continues');
  assert.equal(result.shown,-150);assert.deepEqual(result.errors,[]);assert.equal(result.paused,false);assert(result.time>2);

  await page.locator('.lvx-offset-input').fill('-170');await page.locator('.lvx-offset-input').press('Enter');
  await evaluate(async()=>{await new Promise(r=>setTimeout(r,180));});
  assert.equal(await evaluate(()=>__saved.offsetMs),-170,'exact per-song amount saves');
  assert.equal(await evaluate(()=>JSON.stringify(__saved.phrases)),await evaluate(()=>__originalPhrases),'word and phrase times do not move');
  await evaluate(()=>{window.__failNext=true;});
  await page.locator('.lvx-offset-input').fill('-190');await page.locator('.lvx-offset-input').press('Enter');
  await evaluate(async()=>{await new Promise(r=>setTimeout(r,180));});
  assert.deepEqual(await evaluate(()=>[__saved.offsetMs,__qa.state.syncOffsetMs,__qa.syncSave.pending.offsetMs]),[-170,-190,-190]);
  assert.equal(await page.locator('.lvx-sync-retry').isVisible(),true,'failed save exposes retry');
  assert.match(await page.locator('.lvx-sync-save-note').textContent(),/Not saved/);
  assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true,'unconfirmed offset remains protected as unsaved work');
  await page.locator('.lvx-sync-retry').click();
  await evaluate(async()=>{await new Promise(r=>setTimeout(r,180));});
  assert.equal(await evaluate(()=>__saved.offsetMs),-190);
  assert.equal(await page.locator('.lvx-sync-retry').isVisible(),false);
  // Keyboard/programmatic nudges cannot silently invalidate an unsaved timing preview.
  await evaluate(()=>{__qa.timing.draft={...LvTimingVariant.merge(__saved,__saved),token:'fixture',previewRevision:0,baseRevision:__saved.revision,baseHash:__saved.lyrics.contentHash};__qa.nudgeSync(-50);});
  assert.equal(await evaluate(()=>__saved.offsetMs),-190);
  assert.equal(await evaluate(()=>__qa.timing.draft.score.offsetMs),-190);
  await evaluate(()=>{__qa.timing.draft=null;__qa.setSyncOffset(-170);});
  await evaluate(async()=>{await new Promise(r=>setTimeout(r,180));});
  assert.equal(await evaluate(()=>__saved.offsetMs),-170);
  assert.equal(await evaluate(()=>document.querySelector('video').paused),false);
  assert.match(await page.locator('.lvx-sync-save-note').textContent(),/Saved for this video/);
  assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false);
  if(await page.locator('[data-error=close]').isVisible())await page.locator('[data-error=close]').click();
  await page.locator('.lvx-sidebar').hover();
  await page.locator('.lvx-hud-offset').screenshot({path:path.join(root,'docs/sync-offset-controls-verified.png')});
  const proof={observedAt:new Date().toISOString(),basis:'Production overlay and score core in isolated Chrome with a delayed simulated worker and running synthetic media clock.',checks:['rapid offset accumulation','no revision conflict','no seek or pause','exact per-song value','word timestamps preserved','failed save retains requested offset and retries','unsaved preview protected'],result};
  fs.writeFileSync(path.join(root,'docs/sync-offset-proof.json'),JSON.stringify(proof,null,2)+'\n');
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();const pid=server?.process().pid;await server?.close();if(pid)log('END',pid);log('END',process.pid)});
