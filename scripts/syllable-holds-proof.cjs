// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe syllable hold proof Node PID${process.pid}, Chrome PID${browserPid}; isolated synthetic fixture; finally-close.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-capture-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  await evaluate(require('./capture-audio-fixture.cjs'));
  await evaluate(()=>{__store['lvTempo:youtube:TESTVIDEO01']={map:{version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]}}});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,armTapTake,markTapTime,stopTapTake,seekCapture,rewindCapturePhrase,refreshPerformClock,renderScore,tapBinding,useEventAssignments,listenToTake,eventEnvelope,setLyricsOnly};})();'));
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:12000},'[00:01.00]ONE TWO THREE\n[00:07.00]FOUR FIVE\n[00:12.00]',{provider:'fixture',entryId:'nav',contentHash:'a'.repeat(64)});q.state.score.phrases[0].endMs=7000;q.state.score.phrases[0].words.forEach((w,i)=>{w.startMs=1000+i*2000;w.endMs=3000+i*2000});const w=q.state.score.phrases[0].words[0];q.state.score=LvScore.applyOperation(q.state.score,{type:'setWordSyllables',wordId:w.id,syllables:[{id:'sy1',text:'O',startMs:w.startMs,endMs:w.startMs+500},{id:'sy2',text:'NE',startMs:w.startMs+500,endMs:w.endMs}]},q.state.score.revision);window.__fresh=()=>({...LvTimingVariant.merge(q.state.score,q.state.score),token:'test',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]});q.timing.draft=__fresh();q.syncPanel.hidden=false;q.refreshTimingPanel();});
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'extension/content.css'),'utf8')});
  await evaluate(()=>{const q=__qa;window.__at=(ms)=>{document.querySelector('video').currentTime=ms/1000;q.refreshPerformClock(ms);q.renderScore(ms)};q.syncPanel.querySelector('[data-sync="tap-mode"]').value='syllable';q.syncPanel.querySelector('[data-sync="tap-syllable-flow"]').value='holds';});
  const checks=[];
  assert.equal(await evaluate(()=>__qa.syncPanel.querySelector('[data-sync="tap-syllable-flow"] option:first-child').value),'holds');
  await evaluate(()=>__qa.armTapTake());
  assert.equal(await evaluate(()=>__qa.tapping.take.inputMode),'hold');
  assert.equal(await evaluate(()=>document.querySelector('video').playbackRate),.5);
  await page.locator('#activate').focus();
  for(const [start,end] of [[1100,1400],[1700,2000],[3100,3400],[5100,5500]]){
    await evaluate(`__at(${start})`);await page.keyboard.down('Space');
    assert.equal(await evaluate(()=>__qa.tapping.take.pendingStartMs),start);
    await evaluate(`__at(${end})`);await page.keyboard.up('Space');
  }
  const events=await evaluate(()=>__qa.tapping.take.events);
  assert.deepEqual(events.map(e=>[e.sourceMs,e.releaseMs]),[[1100,1400],[1700,2000],[3100,3400],[5100,5500]]);
  checks.push('default holds and half-speed start; real keyboard down/up capture exact source beginnings and ends');
  // Replay pulses fill the held interval, then end during the measured rest.
  await evaluate(()=>__at(1250));assert.equal(await evaluate(()=>__qa.syncPanel.querySelector('.lvx-recorded-event-pulse').dataset.playing),'true');
  await evaluate(()=>__at(1500));assert.equal(await evaluate(()=>__qa.syncPanel.querySelector('.lvx-recorded-event-pulse').dataset.playing),'false');
  await page.keyboard.press('ArrowLeft');assert.deepEqual(await evaluate(()=>__qa.tapping.take.events),events);
  checks.push('recorded playback follows held duration and clears during rests; Back retains both boundaries');
  // Lost input does not become an invented release.
  await evaluate(()=>__at(6000));await page.keyboard.down('Space');
  await evaluate(()=>window.dispatchEvent(new Event('blur')));await page.keyboard.up('Space');
  assert.equal(await evaluate(()=>__qa.tapping.take.pendingStartMs),null);
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.events),events);
  assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed');
  checks.push('blur cancels only the unfinished hold and keeps the take armed');
  const packet=await evaluate(()=>__qa.eventEnvelope());assert.deepEqual(packet.events,events);assert.equal(packet.inputMode,'hold');
  checks.push('export envelope retains exact raw release times');
  // Apply the capture through the real score operations, preserving the rests.
  await evaluate(()=>{const q=__qa;q.tapping.take=LvTapTiming.stopEvents(q.tapping.take);q.tapping.take.stoppedScoreMs=7000;document.querySelector('video').paused=true;chrome.runtime.sendMessage=async m=>{if(m.type==='LV_TIMING_TUNE'){let score=q.timing.draft.score;for(const op of m.operations)score=LvScore.applyOperation(score,op,score.revision);return {ok:true,preview:{...q.timing.draft,score,previewRevision:q.timing.draft.previewRevision+1}}}if(m.type==='LV_PRONUNCIATION_COUNT')return {ok:true,countSuggestion:{parts:m.count===2?['O','NE']:[m.text]}};return {ok:true}};q.tapping.eventCounts=Object.fromEntries(q.tapping.take.units.filter(u=>u.phraseId===q.tapping.take.units[0].phraseId).map((u,i)=>[u.wordId,i===0?2:1]));});
  await evaluate(()=>__qa.useEventAssignments());
  assert.deepEqual(await evaluate(()=>__qa.timing.draft.score.phrases[0].words.flatMap(w=>w.syllables.map(s=>[s.startMs,s.endMs]))),[[1100,1400],[1700,2000],[3100,3400],[5100,5500]]);
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.events),events);
  checks.push('grouping and preview operations retain every release and leave real inter-syllable rests');
  // Pointer holds use the same boundary path; click must not add a duplicate tap.
  await evaluate(()=>{const q=__qa;q.tapping.take={...q.tapping.take,status:'armed'};q.tapping.binding=q.tapBinding();q.tapping.listening=false;document.querySelector('video').paused=false;__at(7200);q.refreshTimingPanel();});
  await evaluate(()=>{__qa.setLyricsOnly(false);__qa.syncPanel.querySelector('.lvx-tap-panel').open=true;});
  const button=page.locator('[data-sync="tap-mark"]');await button.evaluate(node=>node.scrollIntoView({block:'center'}));await button.hover();const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();  await evaluate(()=>__at(7600));await page.mouse.up();
  assert.deepEqual(await evaluate(()=>{const e=__qa.tapping.take.events.at(-1);return [e.sourceMs,e.releaseMs]}),[7200,7600]);
  assert.equal(await evaluate(()=>__qa.tapping.take.events.length),5);
  checks.push('pointer hold shares source timing and its click adds no duplicate');
  await evaluate(()=>{__qa.syncPanel.querySelector('.lvx-tap-panel').open=true;__qa.syncPanel.querySelector('.lvx-perform-cue').scrollIntoView({block:'start'})});
  await page.locator('.lvx-perform-cue').screenshot({path:path.join(root,'docs/syllable-holds.png')});
  const proof={observedAt:new Date().toISOString(),basis:'Actual content.js and score operations in isolated Chrome with real keyboard/pointer input; simulated media clock, worker and storage. No acoustic accuracy claim.',checks};
  fs.writeFileSync(path.join(root,'docs/syllable-holds-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END')});
