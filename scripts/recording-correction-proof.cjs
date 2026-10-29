// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
const ledger=process.env.LV_PROBE_LEDGER;
const log=(state,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe live phrase removal PID${pid}; finite Chrome proof; release verification.\n`);};
log('START',process.pid);let server,browser;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});console.log(JSON.stringify({browserPid:server.process().pid}));
  log('START',server.process().pid);browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="canonical" href="'+source+'"><meta itemprop="duration" content="PT60S"><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({path:path.join(root,'extension/content.css')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-navigation-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:60},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  const worker=fs.readFileSync(path.join(root,'extension/service-worker.js'),'utf8');
  const injectedFiles=JSON.parse(worker.slice(worker.indexOf('async function injectOverlay')).match(/executeScript\(\{ target: \{ tabId \}, files: (\[[^\]]+\])/)[1].replace(/'/g,'"'));
  for(const name of injectedFiles.filter(n=>n!=='content.js'))await evaluate(fs.readFileSync(path.join(root,'extension',name),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,applyTranscript,finishStoppedTake,tapBinding,captureTracks,markTapTime,tempo,stopTapTake,discardTapTake,armTapTake,disableWatch:()=>{trackWatch=null;}};})();'));
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:60000},'[00:20.00]ONE TWO\n[00:30.00]EXTRA PHRASE\n[00:40.00]THREE FOUR\n[00:50.00]FIVE SIX\n[01:00.00]',{provider:'fixture',entryId:'nav',contentHash:'a'.repeat(64)});window.__fresh=()=>({...LvTimingVariant.merge(q.state.score,q.state.score),token:'test',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]});q.timing.draft=__fresh();q.disableWatch();q.state.active=true;document.querySelector('#lvx-root').classList.add('lvx-active');q.tempo.mediaKey='youtube:TESTVIDEO01';q.tempo.map={version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]};q.syncPanel.hidden=false;q.refreshTimingPanel();});
  await evaluate(()=>{window.__saves=0;chrome.runtime.sendMessage=async m=>{
    const q=__qa,d=q.timing.draft;
    if(m.type==='LV_TIMING_TUNE')return {ok:true,preview:{...(m.changes?LvTimingVariant.tune(d,m.changes,true):LvTimingVariant.operate(d,m.operations||m.operation,true)),previewRevision:d.previewRevision+1}};
    if(m.type==='LV_TIMING_APPLY'){if(window.__failSave)return {ok:false,error:{code:'TEST_FAILURE',message:'Fixture save failure'}};__saves++;return {ok:true,score:{...d.score,revision:q.state.score.revision+1}};}
    if(m.type==='LV_TIMING_PREPARE')return {ok:true,preview:__fresh()};
    return {ok:true};
  };});

  const idle=async()=>{await evaluate(async()=>{for(let i=0;i<100&&__qa.timing.busy;i++)await new Promise(r=>setTimeout(r,10));});};
  await page.getByRole('tab',{name:'Record',exact:true}).click();
  await evaluate(()=>{document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-cadence]').value='hold';document.querySelector('[data-sync=tap-scope]').value='lane';document.querySelector('[data-sync=record-repeat]').checked=false;document.querySelector('video').paused=false;__qa.refreshTimingPanel();});
  await page.locator('[data-sync=tap-arm]').click();await idle();
  assert.deepEqual(await evaluate(()=>[__qa.tapping.take.status,__qa.tapping.take.units[0].id,document.querySelector('video').currentTime]),['armed','phrase-1',2]);
  const time=async t=>evaluate(`document.querySelector('video').currentTime=${t}`);
  await time(3);await page.keyboard.down('Space');await time(4);await page.keyboard.up('Space');await idle();
  const initial=await evaluate(()=>JSON.stringify(__qa.state.score));
  await time(5);await page.keyboard.down('Space');await time(5.4);await page.keyboard.press('Backspace');
  const removed=await evaluate(()=>({take:__qa.tapping.take,paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime}));
  assert.equal(removed.paused,false);assert.equal(removed.time,5.4);assert.equal(removed.take.pendingStartMs,5000);assert.equal(removed.take.units[removed.take.index].id,'phrase-3');assert.equal(removed.take.units[removed.take.index].estimatedStartMs,30000);assert.deepEqual(removed.take.removedPhraseIds,['phrase-2']);assert.equal(removed.take.marks.length,1);assert.match(await page.locator('.lvx-perform-phrase').innerText(),/THREE FOUR/);
  await page.keyboard.press('Control+z');assert.equal(await evaluate(()=>__qa.tapping.take.units[__qa.tapping.take.index].id),'phrase-2');assert.equal(await evaluate(()=>__qa.tapping.take.pendingStartMs),5000);
  await page.keyboard.press('Backspace');await time(6);await page.keyboard.up('Space');await idle();
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.marks.at(-1)),{id:'phrase-3',wordId:'phrase-3-word-1',startMs:5000,endMs:6000});
  assert.equal(await evaluate(()=>JSON.stringify(__qa.state.score)),initial,'saved song unchanged during live removal');
  assert.equal(await page.locator('.lvx-phrase-correction').count(),0);assert.equal(await page.locator('[data-record-toggle]').count(),0,'large replacement bar is gone');
  // Native typing owns Backspace and Ctrl+Z when a text field has focus.
  await evaluate(()=>{const e=document.createElement('textarea');e.id='typing-proof';e.value='AB';document.body.append(e);e.focus();e.setSelectionRange(2,2);});
  await page.keyboard.press('Backspace');assert.equal(await page.locator('#typing-proof').inputValue(),'A');assert.deepEqual(await evaluate(()=>__qa.tapping.take.removedPhraseIds),['phrase-2']);await evaluate(()=>document.querySelector('#typing-proof').remove());
  // Repeated removal and autorepeat: one key gesture removes one cue.
  await page.keyboard.down('Backspace');await page.keyboard.down('Backspace');await page.keyboard.up('Backspace');assert.deepEqual(await evaluate(()=>__qa.tapping.take.removedPhraseIds),['phrase-2','phrase-4']);
  await page.keyboard.press('Control+z');assert.deepEqual(await evaluate(()=>__qa.tapping.take.removedPhraseIds),['phrase-2']);
  assert.equal(await evaluate(()=>__qa.tapping.take.status),'armed','Undo of last deletion resumes the live cue');
  assert.match(await page.locator('.lvx-perform-phrase').innerText(),/FIVE SIX/);
  assert.doesNotMatch(await page.locator('.lvx-sync-panel .lvx-upcoming-phrases').innerText(),/EXTRA PHRASE/);
  await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(root,'docs/live-phrase-removal-wide.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'docs/live-phrase-removal-narrow.png')});await page.setViewportSize({width:1280,height:800});
  await evaluate(()=>__qa.stopTapTake());await idle();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[1].words.every(w=>w.excluded)),true);
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[2];return [p.startMs,p.endMs]}),[5000,6000]);
  let prompts=0;page.on('dialog',async d=>{prompts++;await d.dismiss()});await evaluate(()=>document.querySelector('#next').click());assert.equal(page.url(),source);assert.equal(prompts,1);
  await evaluate(()=>{window.__failSave=true});await page.locator('[data-sync=apply]').click();await idle();assert.equal(await evaluate(()=>__saves),0);assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true);
  await evaluate(()=>{window.__failSave=false});await page.locator('[data-sync=apply]').click();await idle();assert.equal(await evaluate(()=>__saves),1);assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false);
  // One-phrase/repeat scope must pull in the next same-track phrase immediately.
  await evaluate(()=>{const q=__qa;q.discardTapTake();q.timing.draft=__fresh();q.timing.phraseIndex=0;document.querySelector('[data-sync=tap-scope]').value='phrase';document.querySelector('[data-sync=record-repeat]').checked=true;document.querySelector('video').paused=false;document.querySelector('video').currentTime=2;q.refreshTimingPanel();});
  await page.locator('[data-sync=tap-arm]').click();await idle();await page.keyboard.press('Backspace');
  assert.equal(await evaluate(()=>__qa.tapping.take.units[__qa.tapping.take.index].id),'phrase-3');assert.equal(await evaluate(()=>document.querySelector('video').paused),false);
  await evaluate(()=>__qa.stopTapTake());await idle();assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[0].words.every(w=>w.excluded)),true,'removal with no new marks reaches preview');
  const proof={observedAt:new Date().toISOString(),basis:'Production injection list and real Chrome keyboard handlers; synthetic score, media clock and worker transport.',checks:['old control layout restored','early phrase arming retained','Backspace while holding preserves the entrance','next and later cues inherit timing slots','playback clock continues unchanged','Ctrl+Z restores removed cue during hold','text fields retain normal typing','autorepeat removes only once','one-phrase scope continues into next same-track phrase','deletion with no marks is applied','Stop stages deletions and captured timing together','navigation and failed-save retention','Save retains removal without a repair form']};
  fs.writeFileSync(path.join(root,'docs/live-phrase-removal-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();const pid=server?.process().pid;await server?.close();if(pid)log('END',pid);log('END',process.pid)});
