// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});console.log(JSON.stringify({browserPid:server.process().pid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-navigation-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel};})();'));
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:12000},'[00:01.00]ONE TWO THREE\n[00:07.00]FOUR FIVE\n[00:12.00]',{provider:'fixture',entryId:'nav',contentHash:'a'.repeat(64)});window.__fresh=()=>({...LvTimingVariant.merge(q.state.score,q.state.score),token:'test',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]});q.timing.draft=__fresh();q.syncPanel.hidden=false;q.refreshTimingPanel();});
  let accept=false;const dialogs=[];page.on('dialog',async d=>{dialogs.push(d.type());await(accept?d.accept():d.dismiss());});
  assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false,'fresh preview is clean');
  await page.evaluate(()=>history.pushState({},'','/watch?v=TESTVIDEO01&t=2'));assert.equal(dialogs.length,0,'same-video params remain free');
  const modes=[['armed',"q.tapping.take={status:'armed',cadence:'performance-events',events:[]}"],['raw-stopped',"q.tapping.take={status:'stopped',cadence:'performance-events',events:[{sourceMs:1234}]}"],['preview',"q.timing.draft.previewRevision=1"],['typed',"q.timing.dirty=true"],['lyrics',"q.transcript.dirty=true"],['effects',"q.performanceTake.marks=[{sourceMs:1234}]"],['syllables',"q.tapping.splitDirty=true"]];
  for(const [name,change]of modes){
    await evaluate(`(()=>{const q=__qa;q.discardTimingLocal();q.transcript.dirty=false;q.timing.draft=__fresh();${change};})()`);
    assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true,name);
    const count=dialogs.length;await page.evaluate(url=>history.pushState({},'',url),next);
    assert.equal(page.url(),source+'&t=2',name+' stays');assert.equal(dialogs.length,count+1,name+' prompts');
    assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true,name+' retained');
  }
  // Cancel link before the host SPA receives it, not just after its DOM changes.
  await page.evaluate(()=>{window.hostClicks=0;document.querySelector('#next').addEventListener('click',e=>{window.hostClicks++;e.preventDefault();history.pushState({},'',e.currentTarget.href)});});
  await page.locator('#next').click();assert.equal(await page.evaluate(()=>hostClicks),0);
  // End-of-track capture prevents the host's automatic Next handler.
  await page.evaluate(()=>{window.autoNext=0;document.querySelector('video').addEventListener('ended',()=>{window.autoNext++;history.pushState({},'','/watch?v=TESTVIDEO02')});document.querySelector('video').dispatchEvent(new Event('ended'));});
  assert.equal(await page.evaluate(()=>autoNext),0);assert.match(await evaluate(()=>__qa.syncPanel.querySelector('.lvx-sync-notice').textContent),/Auto-next/);
  // Native document exit has a browser beforeunload dialog and Cancel retains data.
  const before=dialogs.length;await page.evaluate(()=>{location.href='https://www.youtube.com/feed/library'});await page.waitForTimeout(100);
  assert.equal(dialogs.at(-1),'beforeunload');assert.equal(dialogs.length,before+1);assert.equal(page.url(),source+'&t=2');
  // Explicit save failure leaves the protection active; success starts a clean preview.
  await evaluate(()=>{const q=__qa;q.discardTimingLocal();q.transcript.dirty=false;q.timing.draft=__fresh();q.timing.draft.previewRevision=1;chrome.runtime.sendMessage=async m=>m.type==='LV_TIMING_APPLY'?{ok:false,error:{message:'fixture save failed'}}:{ok:true};});
  await evaluate(()=>__qa.applyTimingReview());assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true);
  await evaluate(()=>{chrome.runtime.sendMessage=async m=>m.type==='LV_TIMING_APPLY'?{ok:true,score:{...__qa.timing.draft.score,revision:1}}:m.type==='LV_TIMING_PREPARE'?{ok:true,preview:__fresh()}:{ok:true};});
  await evaluate(()=>__qa.applyTimingReview());assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false);
  const savedDialogs=dialogs.length;await page.locator('#next').click();assert.equal(page.url(),next);assert.equal(dialogs.length,savedDialogs,'saved navigation is quiet');
  await page.evaluate(url=>history.pushState({},'',url),source);
  await evaluate(()=>{__qa.timing.draft.previewRevision=1});
  const backDialogs=dialogs.length;await page.evaluate(()=>history.back());await page.waitForTimeout(100);
  assert.equal(page.url(),source,'Back can be cancelled in current Chrome');assert.equal(dialogs.length,backDialogs+1);
  await evaluate(()=>__qa.closeTimingReview());assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true,'closing Sync can be cancelled');
  // If a host bypasses cancellation, the new score must not wipe the old draft.
  await evaluate(()=>{__qa.timing.draft.previewRevision=0});
  await page.evaluate(url=>history.replaceState({},'',url),next);
  const retained=await evaluate(()=>{const q=__qa;q.timing.draft.previewRevision=1;const before=JSON.stringify(q.timing.draft);const score=structuredClone(q.state.score);score.source.videoId='TESTVIDEO02';let reply;for(const fn of __messageListeners)fn({type:'LV_SCORE_UPDATED',mediaKey:'youtube:TESTVIDEO02',score},{},r=>reply=r);return {unchanged:before===JSON.stringify(q.timing.draft),code:reply?.error?.code};});
  assert.deepEqual(retained,{unchanged:true,code:'UNSAVED_SOURCE'});
  assert.equal(await evaluate(()=>{const q=__qa,before=JSON.stringify(q.timing.draft);for(const fn of __messageListeners)fn({type:'LV_TIMING_PREVIEW_CLOSED',mediaKey:'youtube:TESTVIDEO02'},{},()=>{});return before===JSON.stringify(q.timing.draft)}),true,'another video cannot close retained preview');
  await page.evaluate(url=>history.replaceState({},'',url),source);
  accept=true;await evaluate(()=>{__qa.transcript.dirty=true;return __qa.closeTimingReview()});
  assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false,'explicit discard clears typed lyrics too');
  // Explicit Leave is honored once, without a second prompt from the SPA navigate event.
  await evaluate(()=>{__qa.timing.draft=__fresh();__qa.timing.draft.previewRevision=1});accept=true;
  const leaveDialogs=dialogs.length;await page.locator('#next').click();assert.equal(page.url(),next);assert.equal(dialogs.length,leaveDialogs+1);
  const proof={observedAt:new Date().toISOString(),basis:'Actual content.js in Chrome isolated world; mocked source media/worker/storage; real navigation and native dialogs.',checks:['clean preview','same-video params','armed take','raw stopped take','used preview','typed times','lyrics','effects','syllable spelling','link blocked before host','ended auto-next blocked','native beforeunload cancel','failed save retained','successful save clean','Back cancelled','close Sync cancelled','unavoidable switch retains draft','other-video close ignored','explicit discard clears typed lyrics','explicit leave single prompt'],dialogs};
  fs.writeFileSync(path.join(root,'docs/unsaved-navigation-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close()});
