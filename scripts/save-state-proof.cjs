// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
const ledger=process.env.LV_PROBE_LEDGER;
const log=(state,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe save regression PID${pid}; finite Chrome proof; owner codex01a126ca.\n`);};
log('START',process.pid);let server,browser;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});console.log(JSON.stringify({browserPid:server.process().pid}));
  log('START',server.process().pid);browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-navigation-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,transcript,performanceTake,syncPanel,hasUnsavedWork,applyTimingReview,discardTimingLocal,closeTimingReview,refreshTimingPanel,applyTranscript,finishStoppedTake,tapBinding,captureTracks,markTapTime};})();'));
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:12000},'[00:01.00]ONE TWO THREE\n[00:07.00]FOUR FIVE\n[00:12.00]',{provider:'fixture',entryId:'nav',contentHash:'a'.repeat(64)});window.__fresh=()=>({...LvTimingVariant.merge(q.state.score,q.state.score),token:'test',previewRevision:0,baseRevision:q.state.score.revision,baseHash:q.state.score.lyrics.contentHash,undoScores:[]});q.timing.draft=__fresh();q.syncPanel.hidden=false;q.refreshTimingPanel();});
  await evaluate(()=>{window.__saves=0;chrome.runtime.sendMessage=async m=>{
    const q=__qa,d=q.timing.draft;
    if(m.type==='LV_TIMING_TUNE')return {ok:true,preview:{...(m.changes?LvTimingVariant.tune(d,m.changes,true):LvTimingVariant.operate(d,m.operations||m.operation,true)),previewRevision:d.previewRevision+1}};
    if(m.type==='LV_TIMING_APPLY'){__saves++;return {ok:true,score:{...d.score,revision:q.state.score.revision+1}};}
    if(m.type==='LV_TIMING_PREPARE')return {ok:true,preview:__fresh()};
    return {ok:true};
  };});
  assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),true,'unchanged preview disables Save');
  await evaluate(()=>__qa.applyTimingReview());assert.equal(await evaluate(()=>__saves),0,'clean save does not write');
  await evaluate(()=>{__qa.timing.draft.score.offsetMs=30;__qa.refreshTimingPanel()});
  assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),false);
  await evaluate(()=>{__qa.timing.draft=__fresh();__qa.timing.draft.previewRevision=8;__qa.refreshTimingPanel()});
  assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),true,'undo to saved data disables Save despite revision');
  let prompts=0;page.on('dialog',async d=>{prompts++;await d.dismiss()});
  for(const mode of ['word','phrase']){
    await evaluate(`(()=>{const q=__qa;q.discardTimingLocal();q.timing.draft=__fresh();q.syncPanel.hidden=false;q.timing.phraseIndex=0;
      const p=q.timing.draft.score.phrases[0],w=p.words[0],unit={id:'${mode}'==='word'?w.id:p.id,wordId:w.id,phraseId:p.id,text:'${mode}'==='word'?w.text:p.words.map(w=>w.text).join(' '),minMs:0,maxMs:12000};
      q.tapping.take=LvTapTiming.begin([unit],{mode:'${mode}',cadence:'pairs'});q.tapping.binding=q.tapBinding();q.tapping.rate=1;
      document.querySelector('[data-sync=record-repeat]').checked=false;document.querySelector('[data-sync=tap-mode]').value='${mode}';
      const v=document.querySelector('video');v.paused=false;v.currentTime=1.2;q.markTapTime();v.currentTime=2.4;q.markTapTime({release:true});
    })()`);
    await evaluate(async()=>{for(let i=0;i<50&&__qa.timing.busy;i++)await new Promise(r=>setTimeout(r,20));});
    assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),true,mode+' completion remains unsaved');
    assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),false,mode+' complete enables Save');
    const before=prompts;await page.locator('#next').click();assert.equal(page.url(),source);assert.equal(prompts,before+1,mode+' final unit protects navigation');
    await evaluate(()=>__qa.applyTimingReview());
    assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),true,mode+' save latches disabled');
    assert.equal(await evaluate(()=>__qa.hasUnsavedWork()),false);
  }
  // Starting/stopping with no marks and parking an empty track must not deadlock Lyrics.
  await evaluate(()=>{const q=__qa,p=q.timing.draft.score.phrases[0],w=p.words[0];q.tapping.take=LvTapTiming.stop(LvTapTiming.begin([{id:w.id,wordId:w.id,text:w.text,minMs:0,maxMs:12000}]));q.tapping.binding=q.tapBinding();q.captureTracks.slots.set('empty',{state:{take:null}});document.querySelector('[data-sync=transcript-text]').value=LvTranscriptText.toText(q.timing.draft.score).replace('ONE','FIRST');q.transcript.dirty=true;q.refreshTimingPanel();});
  await evaluate(()=>__qa.applyTimingReview());
  assert.equal(await evaluate(()=>__qa.state.score.phrases[0].words[0].text),'FIRST','Save includes text after an empty stopped take');
  assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),true);
  // Retained completed marks are incorporated before changing the words they reference.
  await evaluate(()=>{const q=__qa,p=q.timing.draft.score.phrases[0],w=p.words[0];let take=LvTapTiming.begin([{id:w.id,wordId:w.id,phraseId:p.id,text:w.text,minMs:0,maxMs:12000}],{mode:'word'});take=LvTapTiming.mark(take,1500);q.tapping.take=LvTapTiming.release(take,2100);q.tapping.binding=q.tapBinding();document.querySelector('[data-sync=transcript-text]').value=LvTranscriptText.toText(q.timing.draft.score).replace('FIRST','SECOND');q.transcript.dirty=true;q.refreshTimingPanel();});
  await evaluate(()=>__qa.applyTimingReview());
  assert.deepEqual(await evaluate(()=>{const w=__qa.state.score.phrases[0].words[0];return [w.text,w.startMs,w.endMs]}),['SECOND',1500,2100]);
  assert.equal(await evaluate(()=>document.querySelector('[data-sync=apply]').disabled),true);
  const proof={observedAt:new Date().toISOString(),basis:'Production content handlers and timing core in isolated Chrome; synthetic score, worker transport and media clock.',checks:['clean save disabled and writes nothing','undo to saved disables save','final word and phrase navigation guard','successful save disables until next change','lyrics after empty take and parked empty track','completed marks and lyric correction saved together']};
  fs.writeFileSync(path.join(root,'docs/save-state-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();const pid=server?.process().pid;await server?.close();if(pid)log('END',pid);log('END',process.pid)});
