// Cold-start the complete production content script, without rewriting its source.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ledger=process.env.LV_PROBE_LEDGER;
const mark=(state,label,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe overlay startup ${label} PID${pid}; finite isolated browser regression; owner codex01a126ca.\n`);};
mark('START','Node',process.pid);let server,browser,browserPid;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;mark('START','Chrome',browserPid);browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><video></video>'}));await page.goto('https://www.youtube.com/watch?v=TESTVIDEO01');
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-startup-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messages=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:async m=>{__messages.push(m);return {ok:true};}},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store;},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});});
  for(const name of ['score-core','tap-timing','beat-track','choreography','transcript-text','timing-variant','content'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  assert.equal(await page.locator('#lvx-root').count(),1);assert.equal(await page.locator('[data-sidebar-view=songs]').count(),1);
  const before=await evaluate(()=>JSON.stringify({store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused}));
  await evaluate(async()=>{await document.querySelector('[data-sidebar-view=songs]').onclick();});
  assert.equal(await evaluate(()=>__messages.filter(m=>m.type==='LV_SONG_LIBRARY_OPEN').length),1);
  // Re-injection must reuse the healthy overlay without duplicating its controls.
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));
  assert.equal(await page.locator('#lvx-root').count(),1);assert.equal(await page.locator('[data-sidebar-view=songs]').count(),1);
  assert.equal(await evaluate(()=>JSON.stringify({store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused})),before);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['Complete production content script starts on a fresh page','Songs control dispatches its opener message','Re-injection reuses one overlay and Songs control','Storage and paused media clock preserved'],browserPid}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await server?.close();if(browserPid)mark('END','Chrome closed',browserPid);mark('END','Node',process.pid);});
