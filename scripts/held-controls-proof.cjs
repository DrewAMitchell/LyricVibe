// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe lyric rail proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close; owner release verification.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={timing,openLiveStage,liveStage,liveDock,liveControl,commitLiveStage,renderScore,stage,railState,lyricRail,pathControls,refreshLiveStage,performanceTake,syncSidebarState,renderStylePreview,setPreviewTime:value=>{previewTime=value;},state,syncPanel,root,themePicker,toggleThemePicker,setChoreography,placement,heldSettings,expressionCues};})();'));

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



  await evaluate(()=>{const q=__qa,w=q.state.score.phrases[0].words[0];w.text='MOON';w.effects=[];q.state.score.phrases[0].words[1].text='SKY';__store['lvScore:youtube:TESTVIDEO01'].score=structuredClone(q.state.score);});
  await evaluate(()=>__qa.openLiveStage());
  await page.getByRole('button',{name:'Select MOON',exact:true}).click();
  await page.locator('[data-live-pop=held] summary').click();
  await page.locator('[data-live-held-auto]').check();
  await page.getByRole('combobox',{name:'Held note rule',exact:true}).selectOption('duration');
  await page.getByRole('spinbutton',{name:'Held note minimum milliseconds'}).fill('2000');
  await page.getByRole('spinbutton',{name:'Held note minimum milliseconds'}).press('Tab');
  await page.getByRole('button',{name:'Glow held effect',exact:true}).click();
  assert.equal(await evaluate(()=>__store.lvxChoreography.heldMinMs),2000);
  assert.equal(await evaluate(()=>__qa.expressionCues(__qa.state.score)['phrase-1-word-1'].sustained.length),0);
  await page.getByRole('combobox',{name:'Selected word held effect',exact:true}).selectOption('always');
  assert.equal(await evaluate(()=>__qa.expressionCues(__qa.liveStage.preview)['phrase-1-word-1'].sustained.length),1);
  await page.locator('[data-live-save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-live-status]').textContent.includes('saved for this song'));
  assert.equal(await evaluate(()=>__store['lvScore:youtube:TESTVIDEO01'].score.phrases[0].words[0].appearance.held),'always');
  await page.getByRole('combobox',{name:'Selected word held effect',exact:true}).selectOption('never');
  assert.equal(await evaluate(()=>__qa.expressionCues(__qa.liveStage.preview)['phrase-1-word-1'].sustained.length),0);
  await page.locator('[data-live-undo]').click();
  assert.equal(await page.getByRole('combobox',{name:'Selected word held effect',exact:true}).inputValue(),'always');
  await page.locator('[data-live-close]').click();await evaluate(()=>__qa.openLiveStage());
  await page.getByRole('button',{name:'Select MOON',exact:true}).click();
  assert.equal(await page.getByRole('combobox',{name:'Selected word held effect',exact:true}).inputValue(),'always');
  await page.locator('[data-live-pop=held]').evaluate(n=>n.open=true);
  assert.equal(await page.getByRole('button',{name:'Glow held effect',exact:true}).getAttribute('aria-pressed'),'true');
  const wave=page.getByRole('button',{name:'Wave held effect',exact:true});await wave.focus();
  const before=await wave.locator('.lvx-dance-letter').first().getAttribute('style');
  await page.waitForTimeout(180);assert.notEqual(await wave.locator('.lvx-dance-letter').first().getAttribute('style'),before);
  assert.equal(await evaluate(()=>__store.lvxChoreography.heldEffect),'glow');
  await page.emulateMedia({reducedMotion:'reduce'});await wave.blur();await wave.focus();
  const reduced=await wave.locator('.lvx-word').getAttribute('style');await page.waitForTimeout(120);assert.equal(await wave.locator('.lvx-word').getAttribute('style'),reduced);
  await page.emulateMedia({reducedMotion:'no-preference'});await wave.blur();
  await page.waitForTimeout(200);
  for(const sample of await page.locator('.lvx-held-sample .lvx-word').all())assert.equal(await sample.evaluate(n=>getComputedStyle(n).opacity),'1');
  await page.locator('[data-live-pop=held] .lvx-live-pop').evaluate(n=>n.scrollTop=n.scrollHeight);
  await page.screenshot({path:path.join(root,'docs/held-effect-samples.png')});
  await page.locator('[data-live-pop=held] .lvx-live-pop').evaluate(n=>n.style.width='280px');
  assert.equal(await page.locator('.lvx-held-settings').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  fs.writeFileSync(path.join(root,'docs/held-controls-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Isolated Chrome production handlers and score host, synthetic song only',checks:['global qualification updates cached cues','global effect and threshold persist','Always and Never overrides','Save and reopen','Undo restores override','280px controls without horizontal overflow','visible real-renderer samples','focus preview does not change choice','reduced-motion preview is static']},null,2)+'\n');
  console.log('Held controls proof passed');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
