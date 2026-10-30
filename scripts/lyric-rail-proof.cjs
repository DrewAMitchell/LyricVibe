// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe lyric rail proof Node PID${process.pid}, Chrome PID${browserPid}; finite production UI verification, finally-close.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={timing,openLiveStage,liveStage,liveDock,liveControl,commitLiveStage,renderScore,stage,railState,lyricRail,pathControls,refreshLiveStage,performanceTake,syncSidebarState,renderStylePreview,setPreviewTime:value=>{previewTime=value;},state,syncPanel,root,themePicker,toggleThemePicker,setChoreography,placement};})();'));

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



  await evaluate(()=>{
    let s=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]HELLO MOON\n[00:06.00]WATCH THE COLORS MOVE\n[00:12.00]ONE TWO THREE FOUR FIVE SIX\n[00:20.00]',{provider:'fixture',entryId:'rail',contentHash:'c'.repeat(64)});
    const p=s.phrases[0];p.startMs=1000;p.endMs=5000;p.words[0].startMs=1000;p.words[0].endMs=3000;p.words[1].startMs=3000;p.words[1].endMs=5000;p.words[0].effects=[{type:'glow',strength:.4}];
    s=LvScore.applyOperation(s,{type:'setWordSyllables',wordId:p.words[0].id,syllables:[{id:'hello-1',text:'HEL',startMs:1000,endMs:2000},{id:'hello-2',text:'LO',startMs:2000,endMs:3000}]},s.revision);
    __qa.state.score=s;__store['lvScore:youtube:TESTVIDEO01']={score:structuredClone(s),history:[],review:[]};window.__timings=JSON.stringify(s.phrases);document.querySelector('video').currentTime=1.2;
  });
  await evaluate(()=>__qa.openLiveStage());
  assert.equal(await page.getByRole('complementary',{name:'Timed lyric rail'}).isVisible(),true);
  await page.getByRole('button',{name:'Select HELLO',exact:true}).click();
  assert.notEqual(await page.locator('[data-word=phrase-1-word-2]').evaluate(n=>n.style.translate),'none','ordinary landing is preserved without a path');
  assert.equal(await evaluate(()=>__qa.liveStage.pinned.id), 'phrase-1-word-1');
  const stage=await page.locator('.lvx-stage').boundingBox(),pt=(x,y)=>({x:stage.x+stage.width*x,y:stage.y+stage.height*y});
  const drag=async(selector,x,y)=>{const b=await page.locator(selector).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();const p=pt(x,y);await page.mouse.move(p.x,p.y,{steps:5});await page.mouse.up();};
  await drag('[aria-label="Drag HELLO to stage"]',.72,.62);
  assert.equal(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.length),1);
  const initial=await evaluate(()=>structuredClone(__qa.liveStage.preview.choreographyLayers[0]));assert.ok(Math.abs(initial.position.x-.72)<.002);assert.ok(Math.abs(initial.position.y-.62)<.002);
  await drag('[data-path-handle=start]',.4,.3);await drag('[data-path-handle=control]',.65,.18);await drag('[data-path-handle=end]',.82,.66);
  const curve=await evaluate(()=>__qa.liveStage.preview.choreographyLayers[0]);assert.equal(curve.id,initial.id);assert.equal(curve.path.kind,'quadratic');assert.ok(Math.abs(curve.path.control.y-.18)<.002);assert.equal(await evaluate(()=>JSON.stringify(__qa.liveStage.preview.phrases)===__timings),true);
  await page.locator('[data-path-handle=end]').focus();await page.keyboard.press('ArrowLeft');assert.ok(Math.abs(await evaluate(()=>__qa.liveStage.preview.choreographyLayers[0].position.x)-.81)<.002);
  const beforeCancel=await evaluate(()=>JSON.stringify(__qa.liveStage.preview.choreographyLayers));
  const bend=await page.locator('[data-path-handle=control]').boundingBox();await page.mouse.move(bend.x+bend.width/2,bend.y+bend.height/2);await page.mouse.down();await page.mouse.move(pt(.7,.3).x,pt(.7,.3).y);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await evaluate(()=>JSON.stringify(__qa.liveStage.preview.choreographyLayers)),beforeCancel);
  await page.getByRole('button',{name:'Collapse lyrics',exact:true}).click();assert.equal(await page.locator('[data-rail-words]').isVisible(),false);await page.getByRole('button',{name:'Expand lyrics',exact:true}).click();assert.equal(await evaluate(()=>__qa.liveStage.pinned.id),'phrase-1-word-1');
  await evaluate(()=>__qa.renderScore(2000));await page.screenshot({path:path.join(root,'docs/lyric-rail-path.png')});
  await page.getByRole('checkbox',{name:'Syllables',exact:true}).check();await page.getByRole('button',{name:'Select HEL',exact:true}).click();await drag('[aria-label="Drag HEL to stage"]',.58,.55);
  assert.equal(await evaluate(()=>__qa.liveStage.preview.choreographyLayers.at(-1).target.kind),'syllable');
  await page.emulateMedia({reducedMotion:'reduce'});await evaluate(()=>__qa.renderScore(1600));
  const bounds=await page.locator('[data-syllable=hello-1]').boundingBox();assert.ok(Math.abs(bounds.x+bounds.width/2-pt(.58,.55).x)<4,'syllable X is independent of parent placement');assert.ok(Math.abs(bounds.y+bounds.height/2-pt(.58,.55).y)<4,'syllable Y is independent of parent placement');
  await page.screenshot({path:path.join(root,'docs/lyric-rail-syllables.png')});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('checkbox',{name:'Syllables',exact:true}).uncheck();await page.getByRole('button',{name:'Select MOON',exact:true}).click();await page.getByRole('button',{name:'Record motion',exact:true}).click();
  const end=await page.locator('[data-path-handle=end]').boundingBox(),ops=await evaluate(()=>__qa.liveStage.ops.length);await page.mouse.move(end.x+end.width/2,end.y+end.height/2);await page.mouse.down();
  for(const [time,x,y]of [[3.3,.5,.42],[3.8,.62,.2],[4.4,.77,.32],[4.9,.8,.55]]){await evaluate(`document.querySelector('video').currentTime=${time}`);const p=pt(x,y);await page.mouse.move(p.x,p.y);if(time===3.8){await evaluate(()=>{document.querySelector('video').currentTime=4;__qa.renderScore(4000);});}}
  await page.mouse.up();const recorded=await evaluate(()=>__qa.liveStage.preview.choreographyLayers.at(-1));assert.equal(recorded.path.kind,'recorded');assert.ok(recorded.path.points.length>=6);assert.ok(recorded.path.points.some(p=>Math.abs(p.t-.5)<.001&&Math.abs(p.x-.62)<.002),'stationary hold sampled from source clock');assert.equal(await evaluate(()=>__qa.liveStage.ops.length),ops+1);assert.equal(await evaluate(()=>document.querySelector('video').paused),true);
  await page.screenshot({path:path.join(root,'docs/lyric-rail-recorded-motion.png')});
  await page.locator('[data-live-save]').click();await page.waitForFunction(()=>document.querySelector('[data-live-status]').textContent.includes('saved for this song'));
  assert.equal(await evaluate(()=>JSON.stringify(__store['lvScore:youtube:TESTVIDEO01'].score.phrases)===__timings),true);assert.equal(await evaluate(()=>__store['lvScore:youtube:TESTVIDEO01'].score.choreographyLayers.length),3);
  await page.locator('[data-live-close]').click();await page.locator('[data-sidebar-view=live-stage]').click();await page.getByRole('button',{name:'Select MOON',exact:true}).click();assert.equal(await evaluate(()=>__qa.liveStage.preview?.choreographyLayers.length??__store['lvScore:youtube:TESTVIDEO01'].score.choreographyLayers.length),3);
  // One complete motion capture is one local Undo, including all sampled points.
  await page.getByRole('button',{name:'Record motion',exact:true}).click();const again=await page.locator('[data-path-handle=end]').boundingBox();await page.mouse.move(again.x+again.width/2,again.y+again.height/2);await page.mouse.down();await evaluate(()=>document.querySelector('video').currentTime=3.8);await page.mouse.move(pt(.6,.6).x,pt(.6,.6).y);await page.mouse.up();await page.locator('[data-live-undo]').click();assert.equal(await evaluate(()=>__qa.liveStage.preview),null);
  // Source-clock cancellation restores the selected pause position and adds no operation.
  const cancelClock=await evaluate(()=>document.querySelector('video').currentTime);await page.getByRole('button',{name:'Record motion',exact:true}).click();const cancelHandle=await page.locator('[data-path-handle=end]').boundingBox();await page.mouse.move(cancelHandle.x+cancelHandle.width/2,cancelHandle.y+cancelHandle.height/2);await page.mouse.down();await evaluate(()=>document.querySelector('video').currentTime=3.5);await page.mouse.move(pt(.6,.5).x,pt(.6,.5).y);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await evaluate(()=>__qa.liveStage.ops.length),0);assert.equal(await evaluate(()=>document.querySelector('video').currentTime),cancelClock);
  // A concurrent preview revision must reject the whole gesture.
  const conflict=await page.locator('[data-path-handle=end]').boundingBox();await page.mouse.move(conflict.x+conflict.width/2,conflict.y+conflict.height/2);await page.mouse.down();await page.mouse.move(pt(.7,.6).x,pt(.7,.6).y);await evaluate(()=>__qa.timing.draft.previewRevision++);await page.mouse.up();assert.equal(await evaluate(()=>__qa.liveStage.ops.length),0);assert.ok(await page.locator('[data-live-status]').textContent().then(s=>s.includes('preview changed')));await evaluate(()=>__qa.timing.draft.previewRevision--);
  await evaluate(()=>{__qa.lyricRail.style.width='190px';});assert.equal(await page.locator('.lvx-lyric-rail').evaluate(n=>n.scrollWidth<=n.clientWidth),true);await evaluate(()=>__qa.lyricRail.style.width='');
  await page.getByRole('button',{name:'Next lyric page',exact:true}).click();assert.equal(await evaluate(()=>__qa.railState.follow),false);
  fs.writeFileSync(path.join(root,'docs/lyric-rail-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Production Chrome handlers and score host; synthetic media/storage. No user song edited.',wordDestination:true,draggableStartBendDestination:true,keyboardNudge:true,escapeCancels:true,syllablePlacement:true,sourceClockMotionCapture:true,stationaryHolds:true,recordCancelRestoresTransport:true,syllableIndependentOfParent:true,oneGestureOneUndo:true,timingUnchanged:true,saveAndReopen:true,pagination:true,narrowRailNoOverflow:true,concurrentRevisionRejected:true,ordinaryLandingsPreserved:true},null,2)+'\n');console.log('Lyric rail / path / recorded motion / save proof passed');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
