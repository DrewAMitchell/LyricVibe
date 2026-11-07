// Isolated synthetic recording cues; no user browser, score or audio.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');let server,browser,pid;
const ledger=process.env.LV_PROBE_LEDGER;
function mark(state){if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe recording-cue proof Node PID${process.pid}, Chrome PID${pid}; isolated fixture.\n`);}
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});pid=server.process().pid;mark('START');browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><video></video>'}));
  await page.goto('https://www.youtube.com/watch?v=TESTVIDEO01');await page.addStyleTag({path:path.join(root,'extension/content.css')});await page.locator('#activate').click();
  const cdp=await page.context().newCDPSession(page),tree=await cdp.send('Page.getFrameTree');
  const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'recording-cue-fixture'});
  async function evaluate(value){const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await cdp.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
  await evaluate(()=>{window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(_k,cb)=>{cb?.(__store);return __store},set:async v=>Object.assign(__store,v)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:1,writable:true},duration:{value:10},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,syncPanel,root,stage,renderPerformPhrase,renderCaptureScore,wordTimingUnits,tapBinding,disableWatch:()=>{trackWatch=null;}};})();'));
  await evaluate(()=>{
    const q=__qa;q.disableWatch();let s=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01.00]take human auto suggested needs\n[00:06.00]',{contentHash:'a'.repeat(64)});
    let p=s.phrases[0],w=p.words;
    s=LvScore.applyOperation(s,{type:'setWordTiming',wordId:w[1].id,startMs:w[1].startMs+10,endMs:w[1].endMs},s.revision);p=s.phrases[0];w=p.words;
    const proposals=[w[2],w[3]].map(x=>({wordId:x.id,startMs:x.startMs+10,endMs:x.endMs,accepted:false,evidenceId:'fixture-'+x.id}));
    s=LvScore.setAlignmentTiming(s,proposals,{mode:'auto',includeProposals:true},s.revision);p=s.phrases[0];w=p.words;
    s=LvScore.setAlignmentTiming(s,[],{wordId:w[3].id,choice:'manual'},s.revision);p=s.phrases[0];w=p.words;
    q.timing.draft={...LvTimingVariant.merge(s,s),token:'fixture',previewRevision:0,baseRevision:s.revision,baseHash:s.lyrics.contentHash,undoScores:[]};q.timing.phraseIndex=0;
    q.syncPanel.querySelector('[data-sync="tap-mode"]').value='word';q.syncPanel.hidden=false;q.root.classList.add('lvx-active','lvx-sync-open');
    const units=q.wordTimingUnits(q.timing.draft.score.phrases[0].words);let take=LvTapTiming.begin(units,{mode:'word'});take=LvTapTiming.mark(take,1100);take=LvTapTiming.mark(take,1400);q.tapping.take=take;
    q.renderPerformPhrase();
  });
  const panel=await evaluate(()=>[...__qa.syncPanel.querySelectorAll('.lvx-perform-phrase [data-timing-kind]')].map(x=>({kind:x.dataset.timingKind,label:x.title})));
  assert.deepEqual(panel.map(x=>x.kind),['take','manual','auto','suggestion','needs']);
  assert.match(panel[1].label,/correction/);assert.match(panel[3].label,/not in use/);
  await evaluate(()=>{const q=__qa;q.state.score=q.timing.draft.score;q.state.active=true;q.tapping.binding=q.tapBinding();q.tapping.rate=1;q.tapping.listening=false;q.renderCaptureScore();});
  const stage=await evaluate(()=>[...__qa.stage.querySelectorAll('.lvx-capture-transcript [data-timing-kind]')].map(x=>x.dataset.timingKind));
  assert.deepEqual(stage,['take','manual','auto','suggestion','needs']);
  if(process.env.LV_RECORDING_CUE_SCREENSHOT)await page.screenshot({path:process.env.LV_RECORDING_CUE_SCREENSHOT});
  console.log(JSON.stringify({ok:true,panelKinds:panel.map(x=>x.kind),stageKinds:stage}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();mark('END');});
