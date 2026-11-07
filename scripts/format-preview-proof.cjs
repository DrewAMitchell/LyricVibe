// Production lyric dialog with a mocked local model transport; synthetic score only.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');let server,browser,pid;
const ledger=process.env.LV_PROBE_LEDGER;function mark(state){if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe formatting preview proof Node PID${process.pid}, Chrome PID${pid}; synthetic fixture.\n`);}
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});pid=server.process().pid;mark('START');browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><video></video>'}));
  await page.goto('https://www.youtube.com/watch?v=TESTVIDEO01');await page.addStyleTag({path:path.join(root,'extension/content.css')});await page.locator('#activate').click();
  const cdp=await page.context().newCDPSession(page),tree=await cdp.send('Page.getFrameTree');
  const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'format-preview-fixture'});
  async function evaluate(value){const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await cdp.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  await evaluate(()=>{window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:async m=>m.type==='LV_FORMAT_PREVIEW'?{ok:true,result:m.words.map((word,i)=>({word:word.toLowerCase(),entity:i===0?'0|Cap':i===m.words.length-1?'.|lower':'0|lower'}))}:{ok:true}},storage:{local:{get:async(_k,cb)=>{cb?.(__store);return __store},set:async v=>Object.assign(__store,v)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:1,writable:true},duration:{value:10},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8').replace(/\}\)\(\);\s*$/,'window.__qa={state,timing,tapping,syncPanel,root,openTranscriptEditor,disableWatch:()=>{trackWatch=null;}};})();'));
  await evaluate(async()=>{const q=__qa;q.disableWatch();const score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:10000},'[00:01]HELLO WORLD\n[00:06]',{contentHash:'a'.repeat(64)});q.state.score=score;q.state.active=true;q.root.classList.add('lvx-active');q.syncPanel.hidden=false;q.timing.draft={...LvTimingVariant.merge(score,score),token:'fixture',previewRevision:0,baseRevision:score.revision,baseHash:score.lyrics.contentHash,undoScores:[]};q.timing.phraseIndex=0;window.__before=JSON.stringify(q.timing.draft.score);await q.openTranscriptEditor();});
  await page.getByRole('button',{name:'Suggest case & punctuation'}).click();
  const result=page.getByLabel('Suggested lyric formatting');await result.waitFor();assert.equal(await result.inputValue(),'Hello world.');
  assert.equal(await page.locator('[data-sync=transcript-text]').inputValue(),'HELLO WORLD');
  assert.equal(await evaluate(()=>JSON.stringify(__qa.timing.draft.score)),await evaluate(()=>__before));
  assert.match(await page.locator('[data-format=status]').innerText(),/original lyrics and timings have not changed/);
  if(process.env.LV_FORMAT_PREVIEW_SCREENSHOT)await page.screenshot({path:process.env.LV_FORMAT_PREVIEW_SCREENSHOT});
  console.log(JSON.stringify({ok:true,previewSeparate:true,sourceScoreAndTimingUnchanged:true,mockModel:true}));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();mark('END');});
