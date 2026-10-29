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
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant','pronunciation'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,tempo,syncPanel,tapBinding,eventEnvelope,archiveEvents,useEventAssignments,discardTapTake,restoreLastSyllablePass,renderEventReview,refreshTimingPanel,disableWatch:()=>{trackWatch=null;}};})();'));


  await evaluate(()=>{
    const q=__qa;q.disableWatch();q.state.active=true;q.tempo.mediaKey='youtube:TESTVIDEO01';q.tempo.map={version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]};
    q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:12000},'[00:01.00]hello\n[00:04.00]',{provider:'fixture',entryId:'capture',contentHash:'a'.repeat(64)});
    const p=q.state.score.phrases[0];p.startMs=1000;p.endMs=4000;p.words[0].startMs=1500;p.words[0].endMs=2800;
    q.timing.draft={...LvTimingVariant.merge(q.state.score,q.state.score),token:'capture',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]};q.timing.phraseIndex=0;
    window.__saved=JSON.stringify(q.state.score);window.__initial=JSON.stringify(q.timing.draft.score);
    const units=p.words.map(w=>({id:w.id,wordId:w.id,phraseId:p.id,text:w.text,minMs:p.startMs,maxMs:p.endMs,expectedCount:1,referenceStartMs:w.startMs,referenceEndMs:w.endMs,referenceManual:true}));
    q.tapping.take=LvTapTiming.beginEvents(units,{inputMode:'hold',captureId:'capture-browser-proof'});q.tapping.binding=q.tapBinding();q.tapping.rate=.5;q.tapping.listening=false;
    q.syncPanel.hidden=false;q.syncPanel.querySelector('.lvx-tap-panel').open=true;q.syncPanel.querySelector('[data-sync="tap-mode"]').value='syllable';q.syncPanel.querySelector('[data-sync="tap-syllable-flow"]').value='holds';
    const v=document.querySelector('video');v.paused=false;v.playbackRate=.5;v.currentTime=1.1;
    chrome.runtime.sendMessage=async m=>{
      if(m.type==='LV_PRONUNCIATION_SUGGEST')return {ok:true,suggestion:LvPronunciation.suggest(m.text,{hello:[1]})};
      if(m.type==='LV_PRONUNCIATION_COUNT')return {ok:true,countSuggestion:LvPronunciation.partsForCount(m.text,m.count,{existingParts:m.existingParts,countsIndex:{hello:[1]}})};
      if(m.type==='LV_TIMING_TUNE'){let score=q.timing.draft.score;const before=score;for(const op of m.operations)score=LvScore.applyOperation(score,op,score.revision);return {ok:true,preview:{...q.timing.draft,score,previewRevision:q.timing.draft.previewRevision+1,undoScores:[before]}};}
      return {ok:true};
    };q.refreshTimingPanel();
  });
  const time=async seconds=>evaluate(`document.querySelector('video').currentTime=${seconds}`);
  await page.keyboard.down('Space');
  for(const at of [1.3,1.4,1.5]){await time(at);await page.keyboard.press('n');}
  await time(1.8);await page.keyboard.up('Space');
  await time(2.2);await page.keyboard.down('Space');
  for(const at of [2.3,2.4,2.5]){await time(at);await page.keyboard.press('n');}
  await time(3.2);await page.keyboard.up('Space');
  const captured=await evaluate(()=>({events:__qa.tapping.take.events,raw:__qa.tapping.take.rawInputs}));
  assert.equal(captured.events.length,8);assert.equal(captured.raw.length,10);
  assert.deepEqual(captured.events.filter(e=>e.kind==='syllable-entrance').map(e=>[e.sourceMs,e.releaseMs,e.playbackRate]),[[1100,1800,.5],[2200,3200,.5]]);
  await evaluate(()=>{__qa.tapping.take={...LvTapTiming.stopEvents(__qa.tapping.take),stoppedScoreMs:5000};document.querySelector('video').paused=true;__qa.refreshTimingPanel();});
  await evaluate(()=>__qa.useEventAssignments());
  const result=await evaluate(()=>{
    const q=__qa,w=q.timing.draft.score.phrases[0].words[0];
    return {bounds:[w.startMs,w.endMs],parts:w.syllables.map(s=>({text:s.text,startMs:s.startMs,endMs:s.endMs,evidence:s.captureEvidence})),rawKept:JSON.stringify(q.tapping.take.rawInputs),savedUnchanged:JSON.stringify(q.state.score)===__saved,undoUnchanged:JSON.stringify(q.timing.draft.undoScores[0])===__initial,notice:q.syncPanel.querySelector('.lvx-sync-notice').textContent,archives:Object.values(__store).filter(x=>x?.schema==='lyricvibe-performance-events-v1').length};
  });
  assert.deepEqual(result.bounds,[1100,3200]);assert.equal(result.parts.length,2);assert.equal(result.parts.map(p=>p.text).join(''),'hello');
  assert.deepEqual(result.parts.map(p=>p.evidence.noteEvents.length),[3,3]);assert.ok(result.savedUnchanged&&result.undoUnchanged);assert.equal(result.rawKept,JSON.stringify(captured.raw));assert.ok(result.archives>=1);
  assert.match(await evaluate(()=>__qa.syncPanel.querySelector('.lvx-event-phrases').textContent),/4.00× timing weight/);
  await evaluate(async()=>{await __qa.archiveEvents();__qa.discardTapTake();await __qa.restoreLastSyllablePass();});
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.rawInputs),captured.raw);
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.events),captured.events);
  await page.setViewportSize({width:1100,height:850});
  await evaluate(()=>{__qa.syncPanel.querySelector('.lvx-tap-panel').open=true;__qa.refreshTimingPanel();});
  await page.getByRole('tab',{name:'Refine',exact:true}).click();
  await page.locator('.lvx-event-phrase summary').click();
  await page.locator('.lvx-event-review').screenshot({path:path.join(root,'docs/performance-capture-verified.png')});
  const proof={observedAt:new Date().toISOString(),basis:'Production Chrome keyboard handlers, capture/grouping/score core and archive UI; synthetic media and worker transport, no live user song.',checks:['Space holds and N note changes','two syllables plus six note events','exact raw presses/releases and speed','recorded count overrides dictionary','word bounds expand to captured syllables','capture evidence and pitch events reach score export','saved score unchanged until Save','Undo preserves prior preview','raw archive reopen exact'],result};
  fs.writeFileSync(path.join(root,'docs/performance-capture-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();const pid=server?.process().pid;await server?.close();if(pid)log('END',pid);log('END',process.pid)});
