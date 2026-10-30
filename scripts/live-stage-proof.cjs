// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe live stage proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({content:fs.readFileSync(path.join(root,'extension/content.css'),'utf8')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-stage-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','emoji-keywords-data','emoji-tags','choreography','transcript-text','timing-variant','overlay-export'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={openLiveStage,liveStage,liveDock,liveControl,commitLiveStage,renderScore,stage,performanceTake,syncSidebarState,renderStylePreview,setPreviewTime:value=>{previewTime=value;},state,syncPanel,root,themePicker,toggleThemePicker,setChoreography,placement};})();'));

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


  await evaluate(()=>{const q=__qa,s=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]HELLO MOON\n[00:05.00]',{provider:'fixture',entryId:'stage-live',contentHash:'b'.repeat(64)});s.phrases[0].words[0].effects=[{type:'glow',strength:.4}];q.state.score=s;__store['lvScore:youtube:TESTVIDEO01']={score:structuredClone(s),history:[],review:[]};window.__initialPhrases=JSON.stringify(s.phrases);document.querySelector('video').currentTime=1.2;});
  await evaluate(()=>__qa.openLiveStage());
  assert.equal(await page.locator('.lvx-live-dock').isVisible(),true);assert.equal(await page.locator('.lvx-sync-panel').isVisible(),false);assert.equal(await page.locator('.lvx-theme-picker').isVisible(),false);
  await page.mouse.click(5,5);await page.keyboard.press('Enter');assert.equal(await evaluate(()=>__qa.liveStage.armed),true);
  await page.keyboard.press('1');await page.keyboard.press('3');
  assert.deepEqual(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.map(l=>l.effect.type)),['pulse','shake']);assert.equal(await evaluate(()=>JSON.stringify(__qa.liveStage.preview.phrases)===__initialPhrases),true);
  await page.keyboard.press('Backspace');assert.deepEqual(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.map(l=>l.effect.type)),['pulse']);await page.keyboard.press('Control+z');assert.equal(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.length),2);
  await page.getByLabel('Live choreography mode',{exact:true}).selectOption('placement');await evaluate(()=>document.activeElement.blur());
  const box=await page.locator('.lvx-stage').boundingBox();await page.mouse.click(box.x+box.width*.25,box.y+box.height*.4);assert.equal(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.at(-1).kind),'placement');
  await page.emulateMedia({reducedMotion:'reduce'});await evaluate(()=>__qa.renderScore(1200));
  await page.screenshot({path:path.join(root,'docs/live-stage-performing.png')});
  await page.keyboard.press('Enter');assert.equal(await evaluate(()=>__qa.liveStage.armed),false);await page.waitForFunction(()=>document.querySelector('[data-live-save]')?.disabled===false);
  await page.locator('[data-live-save]').click();await page.waitForFunction(()=>document.querySelector('[data-live-status]').textContent.includes('saved for this song'));
  const result=await evaluate(()=>({layers:__store['lvScore:youtube:TESTVIDEO01'].score.choreographyLayers.length,phrasesUnchanged:JSON.stringify(__store['lvScore:youtube:TESTVIDEO01'].score.phrases)===__initialPhrases,ops:__qa.liveStage.ops.length}));assert.equal(result.layers,3);assert.equal(result.phrasesUnchanged,true);assert.equal(result.ops,0);
  await page.locator('[data-live-pop=layers]>summary').click();await page.screenshot({path:path.join(root,'docs/live-stage-layers.png')});
  await page.getByRole('button',{name:'Remove pulse · HELLO',exact:true}).click();await page.locator('[data-live-undo]').click();assert.equal(await evaluate(()=>__qa.liveStage.preview),null);
  await page.locator('[data-live-pop=layers]>summary').click();
  await evaluate(()=>{__qa.liveDock.style.maxWidth='390px';});
  await page.screenshot({path:path.join(root,'docs/live-stage-narrow.png')});
  assert.equal(await page.locator('.lvx-live-dock').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  await evaluate(()=>{__qa.liveDock.style.maxWidth='';});
  const originalSend=await evaluate(()=>{window.__originalSend=chrome.runtime.sendMessage;chrome.runtime.sendMessage=m=>m.type==='LV_TIMING_TUNE'?Promise.resolve({ok:false,error:{message:'fixture write failure'}}):__originalSend(m);__qa.liveStage.armed=true;});
  await page.mouse.click(5,5);await evaluate(()=>__qa.liveStage.armed=false);
  const pending=await evaluate(()=>__qa.liveStage.ops.length);assert.ok(pending>0);
  await page.locator('[data-live-save]').click();await page.waitForFunction(()=>document.querySelector('[data-live-status]').textContent.includes('fixture write failure'));
  assert.equal(await evaluate(()=>__qa.liveStage.ops.length),pending);assert.equal(await evaluate(()=>__store['lvScore:youtube:TESTVIDEO01'].score.choreographyLayers.length),3);
  await evaluate(()=>{chrome.runtime.sendMessage=__originalSend;});
  await page.locator('[data-live-save]').click();await page.waitForFunction(()=>document.querySelector('[data-live-status]').textContent.includes('saved for this song'));
  assert.equal(await evaluate(()=>__qa.liveStage.ops.length),0);
  await page.locator('[data-live-close]').click();await page.locator('[data-sidebar-view=live-stage]').click();assert.equal(await page.locator('.lvx-live-dock').isVisible(),true);
  fs.writeFileSync(path.join(root,'docs/live-stage-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Production Chrome, real score host, synthetic source/storage; no user song touched',result,keyboardLayerAddRemoveUndo:true,placementLayer:true,liveStageOnly:true,saveFailureRetainsTake:true,closeReopen:true,narrowDockNoOverflow:true},null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
