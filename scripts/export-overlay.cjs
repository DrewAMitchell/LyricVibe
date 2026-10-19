#!/usr/bin/env node
// Offline export uses the production browser renderer, never a live music tab.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os'),{spawn}=require('node:child_process');
const {chromium}=require('playwright'),contract=require('../extension/overlay-export.js');
const root=path.resolve(__dirname,'..'),assets=['score-core.js','tap-timing.js','beat-track.js','transcript-text.js','emoji-keywords-data.js','emoji-tags.js','choreography.js','overlay-export.js','content.js'];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function options(args){const out={ffmpeg:'ffmpeg',ffprobe:'ffprobe'};for(let i=0;i<args.length;i++){const name=args[i].replace(/^--/,'');if(name==='help'){out.help=true;continue;}if(!['input','output','ffmpeg','ffprobe'].includes(name)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Use --input package.json --output NEW_FOLDER [--ffmpeg path] [--ffprobe path]');out[name]=args[++i];}if(!out.help&&(!out.input||!out.output))throw Error('Use --input package.json --output NEW_FOLDER');return out;}
async function renderExport(config){
  const started=Date.now(),inputPath=path.resolve(config.input),out=path.resolve(config.output),bytes=fs.readFileSync(inputPath),packet=contract.validate(JSON.parse(bytes)),{clip}=packet,total=contract.frameCount(packet);
  if(fs.existsSync(out))throw Error('Output folder already exists. Choose a new folder; existing files are preserved.');
  const processes=[],errors=[];let server,browser,child,ownsOutput=false,cancelled=false,receipt={format:'lyricvibe-overlay-render',version:1,status:'running',startedAt:new Date().toISOString(),inputSha256:hash(bytes),mediaKey:packet.mediaKey,lyricsHash:packet.lyricsHash,scoreRevision:packet.score.revision,view:packet.view,clip,frameCount:total,outputDurationMs:total*1000/clip.fps,alpha:'straight',audio:false,platform:process.platform,processes};
  const ledger=process.env.LV_PROBE_LEDGER,mark=(state,kind,pid)=>{if(ledger)fs.appendFileSync(ledger,`\n- ${new Date().toISOString()} ${state} LyricVibe alpha export ${kind} PID${pid}; finite clip, owned cleanup; owner codex01a126ca.\n`);};
  const processStart=(kind,pid)=>{const entry={kind,pid,startedAt:new Date().toISOString()};processes.push(entry);mark('START',kind,pid);return entry;};
  const processEnd=entry=>{entry.endedAt=new Date().toISOString();mark('END',entry.kind,entry.pid);};
  const checkCancelled=()=>{if(cancelled)throw Error('Export cancelled. Partial output is retained.');};
  const run=(exe,args,kind)=>new Promise((resolve,reject)=>{checkCancelled();const p=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});child=p;let stdout='',stderr='';const entry=p.pid?processStart(kind,p.pid):null;p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr=(stderr+d).slice(-12000));p.on('error',reject);p.on('close',code=>{child=null;if(entry)processEnd(entry);code===0?resolve(stdout):reject(Error(kind+' failed ('+code+'): '+stderr));});});
  const abort=()=>{cancelled=true;child?.kill();void browser?.close().catch(()=>{});};process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const nodeEntry=processStart('Node',process.pid);
  try{
    // Check installed tools before creating outputs or starting the browser.
    receipt.ffmpegVersion=(await run(config.ffmpeg||'ffmpeg',['-version'],'FFmpeg preflight')).split('\n')[0];
    await run(config.ffprobe||'ffprobe',['-version'],'FFprobe preflight');
    checkCancelled();fs.mkdirSync(out,{recursive:false});ownsOutput=true;fs.mkdirSync(path.join(out,'frames'));fs.writeFileSync(path.join(out,'overlay-project.json'),bytes,{flag:'wx'});
    const loaded=Object.fromEntries([...assets,'content.css','overlay-export.css'].map(name=>[name,fs.readFileSync(path.join(root,'extension',name),'utf8')]));receipt.rendererSha256=hash(JSON.stringify(loaded));
    // Software raster avoids history-dependent GPU rounding at transparent text edges.
    server=await chromium.launchServer({channel:'chrome',headless:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args:['--disable-gpu','--disable-lcd-text']});const chromeEntry=processStart('Chrome',server.process().pid);
    checkCancelled();browser=await chromium.connect(server.wsEndpoint());receipt.browserVersion=browser.version();
    const page=await browser.newPage({viewport:{width:clip.width,height:clip.height},deviceScaleFactor:1,reducedMotion:'no-preference'});page.on('pageerror',e=>errors.push(e.message));
    // This page has no extension privileges, network or persistent browser profile.
    await page.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><video></video></body></html>'}):route.abort());
    await page.goto('https://www.youtube.com/watch?v='+(packet.score.source.videoId||'EXPORT00001'));
    await page.evaluate(packet=>{
      const host=globalThis.__lyricVibeExportHost={version:1,packet,sourceMs:packet.clip.startMs},noop=()=>{},event={addListener:noop,removeListener:noop};
      const store={get:async(keys,cb)=>{cb?.({});return{};},set:async()=>{},remove:async()=>{}};
      globalThis.chrome={runtime:{id:'lyricvibe-offline-export',getManifest:()=>({version:'offline-export'}),getURL:p=>p,onMessage:event,sendMessage:async()=>({ok:true})},storage:{local:store,session:store,onChanged:event}};
      const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{get:()=>host.sourceMs/1000,set:value=>{host.sourceMs=value*1000;}},duration:{get:()=>(packet.score.source.durationMs||packet.clip.endMs)/1000},paused:{get:()=>false},seeking:{get:()=>false},playbackRate:{value:1,writable:true},readyState:{get:()=>4}});v.play=async()=>{};v.pause=noop;
    },packet);
    await page.addStyleTag({content:loaded['content.css']});await page.addStyleTag({content:loaded['overlay-export.css']});
    for(const name of assets)await page.addScriptTag({content:loaded[name]});
    await page.waitForFunction(()=>__lyricVibeExportHost.ready);await page.evaluate(()=>document.fonts.ready);
    const capture=async at=>{checkCancelled();await page.evaluate(ms=>__lyricVibeExportHost.renderAt(ms),at);if(errors.length)throw Error('Renderer error: '+errors.join('; '));return page.screenshot({type:'png',omitBackground:true});};
    // A source-clock seek must reproduce the same pixels before encoding starts.
    const first=await capture(clip.startMs),middle=clip.startMs+(clip.endMs-clip.startMs)/2;await capture(middle);const replay=await capture(clip.startMs);receipt.seekReplayExact=hash(first)===hash(replay);if(!receipt.seekReplayExact){fs.writeFileSync(path.join(out,'failed-first.png'),first,{flag:'wx'});fs.writeFileSync(path.join(out,'failed-replay.png'),replay,{flag:'wx'});throw Error('Export frame changed after seeking; a wall-clock dependency remains.');}
    for(let i=0;i<total;i++){const png=i===0?first:await capture(clip.startMs+i*1000/clip.fps);fs.writeFileSync(path.join(out,'frames',`frame-${String(i).padStart(6,'0')}.png`),png,{flag:'wx'});if(i===0||i===total-1||i%clip.fps===0)console.log(JSON.stringify({phase:'render',frame:i+1,total,sourceMs:clip.startMs+i*1000/clip.fps}));}
    receipt.firstFrameSha256=hash(first);receipt.sourceScoreUnchanged=hash(JSON.stringify(await page.evaluate(()=>__lyricVibeExportHost.packet.score)))===hash(JSON.stringify(packet.score));if(!receipt.sourceScoreUnchanged)throw Error('Renderer mutated the input score.');
    await browser.close();browser=null;await server.close();server=null;processEnd(chromeEntry);
    const movie=path.join(out,'overlay.mov');
    await run(config.ffmpeg||'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-n','-framerate',String(clip.fps),'-i',path.join(out,'frames','frame-%06d.png'),'-an','-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le','-alpha_bits','16','-threads',String(Math.min(4,os.cpus().length)),'-metadata','comment=LyricVibe transparent overlay; source start '+clip.startMs+'ms',movie],'ProRes encoder');
    const probe=JSON.parse(await run(config.ffprobe||'ffprobe',['-v','error','-show_entries','stream=codec_name,pix_fmt,width,height,nb_frames,r_frame_rate:format=duration','-of','json',movie],'Output probe'));
    const stream=probe.streams?.[0];if(stream?.codec_name!=='prores'||!stream.pix_fmt?.startsWith('yuva')||stream.width!==clip.width||stream.height!==clip.height||Number(stream.nb_frames)!==total)throw Error('Encoded movie does not preserve the expected alpha stream, dimensions and frame count.');
    receipt.video=probe;receipt.movieSha256=hash(fs.readFileSync(movie));receipt.status='complete';receipt.elapsedMs=Date.now()-started;receipt.outputs={movie:'overlay.mov',frames:'frames/frame-%06d.png',project:'overlay-project.json'};
    console.log(JSON.stringify({phase:'complete',output:out,frames:total,elapsedMs:receipt.elapsedMs}));return receipt;
  }catch(error){receipt.status='failed';receipt.error=error.message;throw error;}
  finally{child?.kill();await browser?.close().catch(()=>{});await server?.close().catch(()=>{});for(const entry of processes)if(!entry.endedAt)processEnd(entry);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);receipt.finishedAt=new Date().toISOString();if(ownsOutput)fs.writeFileSync(path.join(out,'render-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
}
if(require.main===module){try{const config=options(process.argv.slice(2));if(config.help)console.log('Render a LyricVibe overlay package into transparent PNG frames and a ProRes 4444 MOV.\nnode scripts/export-overlay.cjs --input PACKAGE.json --output NEW_FOLDER\nOptional: --ffmpeg PATH --ffprobe PATH. Existing output folders are never overwritten.');else renderExport(config).catch(error=>{console.error(error.code||'EXPORT_FAILED',error.message);process.exitCode=1;});}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={options,renderExport};
