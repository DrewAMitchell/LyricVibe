// Cold-start the complete production content script, without rewriting its source.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ledger=process.env.LV_PROBE_LEDGER;
const mark=(state,label,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe overlay startup ${label} PID${pid}; finite isolated browser regression; release verification.\n`);};
mark('START','Node',process.pid);let server,browser,browserPid;
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;mark('START','Chrome',browserPid);browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><video></video>'}));await page.goto('https://www.youtube.com/watch?v=TESTVIDEO01');
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-startup-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messages=[];window.__store={};window.__runtimeListeners=new Set();window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__runtimeListeners.add(fn)},removeListener(fn){__runtimeListeners.delete(fn)}},sendMessage:async m=>{__messages.push(m);return {ok:true};}},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store;},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});});
  const worker=fs.readFileSync(path.join(root,'extension/service-worker.js'),'utf8');
  const injectedFiles=JSON.parse(worker.slice(worker.indexOf('async function injectOverlay')).match(/executeScript\(\{ target: \{ tabId \}, files: (\[[^\]]+\])/)[1].replace(/'/g,'"'));
  for(const name of injectedFiles)await evaluate(fs.readFileSync(path.join(root,'extension',name),'utf8'));
  assert.equal(await page.locator('#lvx-root').count(),1);assert.equal(await page.locator('[data-sidebar-view=songs]').count(),1);
  const before=await evaluate(()=>JSON.stringify({store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused}));
  await evaluate(async()=>{await document.querySelector('[data-sidebar-view=songs]').onclick();});
  assert.equal(await evaluate(()=>__messages.filter(m=>m.type==='LV_SONG_LIBRARY_OPEN').length),1);
  // Re-injection must reuse the healthy overlay without duplicating its controls.
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));
  assert.equal(await page.locator('#lvx-root').count(),1);assert.equal(await page.locator('[data-sidebar-view=songs]').count(),1);
  assert.equal(await evaluate(()=>JSON.stringify({store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused})),before);
  // A dead context must retain unsaved input and dispose a clean instance's
  // global and runtime listeners before creating its replacement.
  const listeners=async name=>{const o=await session.send('Runtime.evaluate',{expression:name,contextId:executionContextId});return (await session.send('DOMDebugger.getEventListeners',{objectId:o.result.objectId})).listeners.length;};
  const baseline={document:await listeners('document'),window:await listeners('window'),navigation:await evaluate(()=>Boolean(window.navigation))?await listeners('window.navigation'):0,runtime:await evaluate(()=>__runtimeListeners.size)};
  await evaluate(()=>{window.__previous=window.__lyricVibeOverlay;const field=document.querySelector('textarea[aria-label="Exact word timings in milliseconds"]');field.value='unsaved test';field.dispatchEvent(new Event('input',{bubbles:true}));window.__previous.ping=()=>false;});
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));
  assert.equal(await evaluate(()=>window.__lyricVibeOverlay===window.__previous),true,'dirty stale overlay is not replaced');
  assert.equal(await evaluate(()=>window.__previous.sync.getState().dirty),true,'unsaved timing remains');
  assert.match(await page.locator('.lvx-sync-notice').textContent(),/unsaved work/i);
  await evaluate(()=>document.querySelector('[data-sync="reset"]').dispatchEvent(new Event('click')));
  for(let i=0;i<3;i++){
    await evaluate(()=>{window.__previous=window.__lyricVibeOverlay;window.__previous.ping=()=>false});
    await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));
    assert.equal(await evaluate(()=>window.__lyricVibeOverlay===window.__previous),false,'clean stale overlay is replaced');
    assert.equal(await page.locator('#lvx-root').count(),1);
    assert.deepEqual({document:await listeners('document'),window:await listeners('window'),navigation:await evaluate(()=>Boolean(window.navigation))?await listeners('window.navigation'):0,runtime:await evaluate(()=>__runtimeListeners.size)},baseline,'replacement must not accumulate listeners');
  }
  await evaluate(()=>{window.__previous=window.__lyricVibeOverlay;window.__previous.ping=()=>false;Object.defineProperty(chrome.storage,'onChanged',{configurable:true,get(){throw Error('Extension context invalidated')}});if(window.__previous.dispose()!==true)throw Error('Clean invalidated context did not dispose');delete chrome.storage.onChanged;});
  await evaluate(fs.readFileSync(path.join(root,'extension/content.js'),'utf8'));
  assert.deepEqual({document:await listeners('document'),window:await listeners('window'),navigation:await evaluate(()=>Boolean(window.navigation))?await listeners('window.navigation'):0,runtime:await evaluate(()=>__runtimeListeners.size)},baseline,'invalidated storage context leaves no duplicate listeners');
  await evaluate(()=>{window.__lyricVibeOverlay.hide();window.__lyricVibeOverlay.show();});
  assert.deepEqual({document:await listeners('document'),window:await listeners('window'),navigation:await evaluate(()=>Boolean(window.navigation))?await listeners('window.navigation'):0,runtime:await evaluate(()=>__runtimeListeners.size)},baseline,'normal hide/reopen retains one listener set');
  assert.equal(await evaluate(()=>JSON.stringify({store:__store,time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused})),before,'reload cleanup does not mutate storage or media');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['Complete production content script starts on a fresh page','Songs control dispatches its opener message','Re-injection reuses one overlay and Songs control','Storage and paused media clock preserved','Dirty stale overlay retained','Repeated clean reload removes global and runtime listeners','Invalidated storage context disposes safely'],browserPid}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await server?.close();if(browserPid)mark('END','Chrome closed',browserPid);mark('END','Node',process.pid);});
