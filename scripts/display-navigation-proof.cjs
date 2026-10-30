// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe emoji version proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={performanceTake,syncSidebarState,renderStylePreview,setPreviewTime:value=>{previewTime=value;},state,syncPanel,root,themePicker,toggleThemePicker,setChoreography,placement};})();'));

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

  const checks=[];
  await evaluate(()=>{__qa.performanceTake.armed=true;__qa.syncSidebarState();});assert.equal(await page.locator('[data-sidebar-view=display-words]').isDisabled(),true);await evaluate(()=>{__qa.performanceTake.armed=false;__qa.syncSidebarState();});
  await evaluate(()=>{__qa.syncPanel.hidden=true;__qa.toggleThemePicker(true);window.__scoreStart=JSON.stringify(__qa.state.score);});
  for(const name of ['Look','Motion','Words','Stage']){await page.getByRole('tab',{name,exact:true}).click();assert.equal(await page.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');assert.equal(await page.locator('[data-sidebar-view="display-'+name.toLowerCase()+'"]').getAttribute('aria-current'),'page');}
  await page.getByRole('tab',{name:'Look',exact:true}).click();await page.getByRole('tab',{name:'Look',exact:true}).press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Motion',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.lvx-word-set-control').isVisible(),false);await page.locator('.lvx-word-effects>summary').click();await page.getByLabel('Word dance',{exact:true}).selectOption('flex');assert.equal(await evaluate(()=>__store.lvxChoreography.dance),'flex');
  await page.locator('.lvx-theme-picker').screenshot({path:path.join(root,'docs/display-navigation-motion.png')});
  await page.getByRole('tab',{name:'Words',exact:true}).click();const map=page.getByLabel('Emoji map text',{exact:true}),text='🌙✨ = (moon, glow, air, light)';await map.fill(text);
  await page.getByRole('tab',{name:'Stage',exact:true}).click();await page.getByRole('tab',{name:'Words',exact:true}).click();assert.equal(await map.inputValue(),text);
  await page.getByRole('button',{name:'Close display studio',exact:true}).click();await page.locator('.lvx-sidebar').hover();await page.locator('[data-sidebar-view=display-words]').click();assert.equal(await map.inputValue(),text);
  await page.getByLabel('Emoji map save scope',{exact:true}).selectOption('shared');await page.getByRole('button',{name:'Save & enable map',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-map-status]').textContent.startsWith('Map saved'));
  assert.ok(await evaluate(()=>__store.lvxWordRuleSets.sets.some(s=>s.emojiMap.some(g=>g.emoji==='🌙✨'&&g.terms.includes('moon')))));
  checks.push('Four tabs and direct sidebar routes agree; keyboard traversal; Motion dance save; map draft survives tab navigation and close/reopen, then saves through production host');
  await page.getByRole('tab',{name:'Look',exact:true}).click();await page.locator('.lvx-theme-grid [data-theme=elegant]').click();assert.equal(await page.locator('.lvx-motion-sample').getAttribute('data-theme'),'elegant');
  await evaluate(()=>{__qa.setPreviewTime(1800);__qa.renderStylePreview();});
  await page.locator('.lvx-theme-picker').screenshot({path:path.join(root,'docs/display-navigation-look.png')});
  await evaluate(()=>{__qa.themePicker.style.width='390px';__qa.themePicker.style.maxHeight='none';});
  for(const name of ['Look','Motion']){await page.getByRole('tab',{name,exact:true}).click();const size=await page.locator('.lvx-theme-picker').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify({name,...size}));}
  await page.locator('.lvx-theme-picker').screenshot({path:path.join(root,'docs/display-navigation-constrained.png')});
  checks.push('Look and Motion fit a 390px panel with no horizontal overflow; browser viewport unchanged (not a mobile viewport trial)');
  await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('tab',{name:'Look',exact:true}).click();assert.equal(await page.locator('#lvx-style-look').evaluate(n=>getComputedStyle(n).animationName),'none');assert.equal(await evaluate(()=>JSON.stringify(__qa.state.score)===__scoreStart),true);
  fs.writeFileSync(path.join(root,'docs/display-navigation-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Production Chrome isolated-world UI and score host; synthetic media/storage; no user tab changed',checks,scoreUnchanged:true,reducedMotion:true},null,2)+'\n');console.log(JSON.stringify({checks}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
