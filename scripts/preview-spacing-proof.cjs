// Actual content handlers in a Chrome isolated world. No human browser/tab access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),sourceRef=process.argv.find(a=>a.startsWith('--source-ref='))?.slice(13),read=name=>sourceRef?require('node:child_process').execFileSync('git',['show',sourceRef+':extension/'+name],{cwd:root,encoding:'utf8',windowsHide:true}):fs.readFileSync(path.join(root,'extension',name),'utf8'),source='https://www.youtube.com/watch?v=TESTVIDEO01',next='https://www.youtube.com/watch?v=TESTVIDEO02';
let server,browser,browserPid;
const probe=state=>{if(process.env.LV_PROBE_LEDGER)fs.appendFileSync(process.env.LV_PROBE_LEDGER,`\n- ${new Date().toISOString()} ${state} LyricVibe studio proof Chrome PID${browserPid}; finite UI proof, finally-close.\n`);};
(async()=>{
  server=await chromium.launchServer({channel:'chrome',headless:true});browserPid=server.process().pid;probe('START');console.log(JSON.stringify({browserPid}));
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="activate">Activate</button><a id="next" href="'+next+'">Next</a><video></video>'}));
  await page.goto(source);await page.addStyleTag({content:read('content.css')});await page.locator('#activate').click();
  const session=await page.context().newCDPSession(page),tree=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'lyricvibe-capture-proof'});
  const evaluate=async value=>{const expression=typeof value==='function'?'('+value.toString()+')()':value;const r=await session.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(()=>{window.__messageListeners=[];window.__store={};window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){__messageListeners.push(fn)}},sendMessage:async()=>({ok:true})},storage:{local:{get:async(keys,cb)=>{cb?.(__store);return __store},set:async data=>Object.assign(__store,data)}}};const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{value:2,writable:true},duration:{value:30},paused:{value:true,writable:true},playbackRate:{value:1,writable:true}});v.pause=()=>{v.paused=true};v.play=async()=>{v.paused=false};});
  for(const name of ['score-core','tap-timing','beat-track','emoji-keywords-data','emoji-tags','choreography','transcript-text','timing-variant'])await evaluate(fs.readFileSync(path.join(root,'extension',name+'.js'),'utf8'));
  await evaluate(read('content.js').replace(/\}\)\(\);\s*$/,'window.__qa={renderStylePreview,setWordRuleSets,setPreviewTime:value=>{previewTime=value;},state,syncPanel,root,themePicker,toggleThemePicker,buildThemePicker,setChoreography};})();'));

  await page.addStyleTag({content:'body{margin:0;background:#060c10}#activate,#next,video{display:none}'});
  await evaluate(()=>{const q=__qa;q.state.score=LvScore.createScore({platform:'youtube',videoId:'TESTVIDEO01',durationMs:30000},'[00:01.00]MOON GLOW AIR LIGHT\n[00:20.00]',{provider:'fixture',entryId:'preview',contentHash:'b'.repeat(64)});q.root.classList.add('lvx-active');q.state.active=true;q.syncPanel.hidden=true;});
  const checks=[];
  for(const emoji of ['', '🌙','🌙✨'])for(const mode of ['classic','fall','puzzle'])for(const theme of ['samay','elegant','clean']){
    const settings={version:1,activeId:'default',sets:[{id:'default',name:'Default',rules:[],emojiTags:true,emojiDictionary:false,emojiMap:emoji?[{emoji,terms:['moon','glow','air','light']}]:[]}]};
    await evaluate(`(()=>{const q=__qa;q.setChoreography({mode:${JSON.stringify(mode)},automatic:false,dance:'flex'});q.setWordRuleSets(${JSON.stringify(settings)});q.toggleThemePicker(true);})()`);
    await page.locator('.lvx-theme-grid [data-theme='+theme+']').click();
    const geometry=await evaluate(()=>{const q=__qa;q.setPreviewTime(2800);q.renderStylePreview();return [...q.themePicker.querySelectorAll('.lvx-motion-sample .lvx-tile-word')].filter(n=>!n.hidden).map(n=>({text:n.textContent,width:n.clientWidth,padding:parseFloat(getComputedStyle(n).paddingRight),letters:[...n.querySelectorAll('.lvx-dance-letter')].map(l=>({left:l.offsetLeft,top:l.offsetTop,right:l.offsetLeft+l.offsetWidth}))}));});
    for(const word of geometry){assert.ok(word.letters.length>0,'Animated letters must be exercised');assert.ok(word.letters.every(l=>l.top===word.letters[0].top),JSON.stringify({emoji,mode,theme,word}));for(let i=1;i<word.letters.length;i++)assert.ok(word.letters[i].left>=word.letters[i-1].right-1,JSON.stringify({emoji,mode,theme,word}));assert.ok(word.letters.at(-1).right<=word.width-word.padding+3,JSON.stringify({emoji,mode,theme,word}));}
    checks.push({emoji,mode,theme,words:geometry.length});
  }
  await evaluate(()=>{__qa.setChoreography({mode:'classic',automatic:false,dance:'flex'});__qa.buildThemePicker();__qa.setPreviewTime(2100);__qa.renderStylePreview();});
  await page.locator('.lvx-theme-picker').screenshot({path:path.join(root,'docs/preview-spacing-verified.png')});
  fs.writeFileSync(path.join(root,'docs/preview-spacing-proof.json'),JSON.stringify({observedAt:new Date().toISOString(),basis:'Actual Chrome isolated world, synthetic media/storage, production preview and pointer theme selection',checks},null,2)+'\n');console.log(JSON.stringify({cases:checks.length}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await server?.close();probe('END');});
