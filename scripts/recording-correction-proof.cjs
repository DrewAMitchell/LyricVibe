// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
const ledger=process.env.LV_PROBE_LEDGER;
const log=(state,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe recording correction PID${pid}; finite Chrome proof; release verification.\n`);};
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
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,applyTranscript,finishStoppedTake,tapBinding,captureTracks,markTapTime,phraseCorrection,partRun,countIn,tempo,armTapTake,discardTapTake,openPhraseCorrection,closePhraseCorrection,stopTapTake,disableWatch:()=>{trackWatch=null;}};})();'));
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:60000},'[00:20.00]ONE TWO\n[00:30.00]THREE FOUR\n[00:40.00]FIVE SIX\n[00:50.00]',{provider:'fixture',entryId:'nav',contentHash:'a'.repeat(64)});window.__fresh=()=>({...LvTimingVariant.merge(q.state.score,q.state.score),token:'test',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]});q.timing.draft=__fresh();q.disableWatch();q.state.active=true;q.tempo.mediaKey='youtube:TESTVIDEO01';q.tempo.map={version:1,anchorMs:0,segments:[{startMs:0,bpm:120,transition:'step',provenance:'manual'}]};q.syncPanel.hidden=false;q.refreshTimingPanel();});
  await evaluate(()=>{window.__saves=0;chrome.runtime.sendMessage=async m=>{
    const q=__qa,d=q.timing.draft;
    if(m.type==='LV_TIMING_TUNE')return {ok:true,preview:{...(m.changes?LvTimingVariant.tune(d,m.changes,true):LvTimingVariant.operate(d,m.operations||m.operation,true)),previewRevision:d.previewRevision+1}};
    if(m.type==='LV_TIMING_UNDO')return {ok:true,preview:{...d,score:d.undoScores.at(-1),undoScores:d.undoScores.slice(0,-1),previewRevision:d.previewRevision+1}};if(m.type==='LV_TIMING_APPLY'){LvScore.requireTimingResolved(d.score);__saves++;return {ok:true,score:{...d.score,revision:q.state.score.revision+1}};}
    if(m.type==='LV_TIMING_PREPARE')return {ok:true,preview:__fresh()};
    return {ok:true};
  };});

  const idle=async()=>{await evaluate(async()=>{for(let i=0;i<100&&__qa.timing.busy;i++)await new Promise(r=>setTimeout(r,10));});};
  await page.getByRole('tab',{name:'Record',exact:true}).click();
  await evaluate(()=>{document.querySelector('[data-sync=tap-mode]').value='phrase';document.querySelector('[data-sync=tap-cadence]').value='hold';document.querySelector('[data-sync=record-repeat]').checked=false;document.querySelector('video').paused=false;__qa.refreshTimingPanel();});
  await page.locator('[data-record-toggle]').click();await idle();
  assert.deepEqual(await evaluate(()=>[__qa.tapping.take.status,__qa.tapping.take.units[0].id,document.querySelector('video').currentTime]),['armed','phrase-1',2]);
  const time=async t=>evaluate(`document.querySelector('video').currentTime=${t}`);
  await page.locator('[data-record-toggle]').blur();await time(3);await page.keyboard.down('Space');await time(4);await page.keyboard.up('Space');await idle();
  await page.locator('[data-record-correct]').click();await idle();
  assert.equal(await evaluate(()=>__qa.phraseCorrection.panel.hidden),false);
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[0];return [p.startMs,p.endMs]}),[3000,4000]);
  const action=async value=>page.locator('[data-correction=action]').selectOption(value);
  const apply=async()=>{await page.locator('[data-correction=apply]').click();await idle();};
  await page.locator('[data-correction=text]').fill('ONE REPLACED');await apply();
  assert.equal(await evaluate(()=>LvScore.pendingTimingReviews(__qa.timing.draft.score).length),1);
  assert.equal(await page.locator('[data-sync=apply]').isDisabled(),true);
  let prompts=0;page.on('dialog',async d=>{prompts++;await d.dismiss()});
  await evaluate(()=>document.querySelector('#next').click());assert.equal(page.url(),source);assert.equal(prompts,0,'required repairs block same-site navigation');
  await action('resolve');await apply();
  await action('move');await page.locator('[data-correction=lane]').selectOption('backing');await apply();
  assert.deepEqual(await evaluate(()=>{const p=__qa.timing.draft.score.phrases[0];return [p.laneId,p.startMs,p.endMs]}),['backing',3000,4000]);
  await action('remove');await apply();
  assert.equal(await evaluate(()=>__qa.timing.draft.score.phrases[0].words.every(w=>w.excluded)),true);
  await action('restore');await apply();await action('resolve');await apply();
  await action('move');await page.locator('[data-correction=lane]').selectOption('lead');await apply();
  await page.locator('[data-correction=phrase]').selectOption('phrase-2');await action('insert-before');await page.locator('[data-correction=text]').fill('NEW PHRASE');await time(25);await apply();
  const inserted=await evaluate(()=>__qa.phraseCorrection.phraseId);
  assert.equal(await evaluate(()=>LvScore.pendingTimingReviews(__qa.timing.draft.score).length),3);
  const untouched=await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases.at(-1)));
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:path.join(root,'docs/recording-correction-wide.png')});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(root,'docs/recording-correction-narrow.png')});
  const dock=await page.locator('.lvx-recording-playback').boundingBox();assert.ok(dock.x>=0&&dock.x+dock.width<=391&&dock.y+dock.height<=845,'dock fits narrow viewport');
  await page.setViewportSize({width:1280,height:800});
  await page.locator('[data-correction=repair]').click();await idle();
  // The real count-in runs; advance its synthetic media clock to the target.
  await evaluate(async()=>{for(let i=0;i<240&&(__qa.countIn.active||__qa.countIn.preparing);i++)await new Promise(r=>setTimeout(r,25));});
  assert.equal(await evaluate(()=>__qa.tapping.take?.status),'armed');
  assert.deepEqual(await evaluate(()=>__qa.tapping.take.units.map(u=>u.id)),['phrase-1',inserted,'phrase-2']);
  await page.locator('[data-record-toggle]').blur();
  for(const [a,b] of [[3,5],[6,8],[9,11]]){await time(a);await page.keyboard.down('Space');await time(b);await page.keyboard.up('Space');await idle();}
  assert.equal(await evaluate(()=>LvScore.pendingTimingReviews(__qa.timing.draft.score).length),0);
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score.phrases.at(-1))),untouched);
  assert.equal(await evaluate(()=>document.querySelector('video').paused),true);
  await page.locator('[data-sync=apply]').click();await idle();assert.equal(await evaluate(()=>__saves),1);assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false);
  const proof={observedAt:new Date().toISOString(),basis:'Production injection list, content keyboard/correction/navigation handlers and score core in isolated Chrome; synthetic media clock and worker transport.',checks:['arm before first estimated cue','Space records early phrase','correction retains completed input','replace review blocks save and navigation','explicit timing resolution','move preserves exact timing','ignore and restore','insert requires three phrase repairs','bounded rewind retimes three phrases only','completed repair pauses and saves cleanly','desktop and narrow recording controls']};
  fs.writeFileSync(path.join(root,'docs/recording-correction-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();const pid=server?.process().pid;await server?.close();if(pid)log('END',pid);log('END',process.pid)});
