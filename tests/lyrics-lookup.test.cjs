const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../extension/score-core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/service-worker.js'), 'utf8');
const MUSIC = { videoId: 'FIXTURE0002', host: 'www.youtube.com', duration: 134.901, track: 'Sample Track', artist: 'Tëst Artist' };
const VIDEO = { ...MUSIC, videoId: 'FIXTURE0001', duration: 166.321 };
const entry = (id, duration, start) => ({ id, duration, trackName: 'Sample Track', artistName: 'Tëst Artist', syncedLyrics: `[00:${start}] First phrase\n[00:28.00] Second phrase`, plainLyrics: 'First phrase\nSecond phrase' });
function harness() {
  const data = {}, sessionData = {}, calls = [];
  const store = data => ({ get: async key => key == null ? structuredClone(data) : { [key]: structuredClone(data[key]) }, set: async value => Object.assign(data, structuredClone(value)), remove: async () => {} });
  const event = { addListener() {} };
  const context = vm.createContext({ console, URL, URLSearchParams, AbortSignal, AbortController, setTimeout, clearTimeout, LvLookupPolicy:require('../extension/lookup-policy.js'), LvYoutubeCaptions:require('../extension/youtube-captions.js'), LvScore: core, importScripts() {}, chrome: { storage: { local: store(data), session: store(sessionData) }, action: { onClicked: event }, runtime: { onMessage: event }, tabs: { onRemoved: event, sendMessage: async()=>({ok:true,version:1,enabled:true,active:true}) } }, fetch: async url => {
    calls.push(url);
    const u = new URL(url);
    const result = u.pathname.endsWith('/get-cached') ? entry(111, 166, '00.26') : entry(222, 166, '23.19');
    return { ok: true, status: 200, json: async () => result };
  } });
  vm.runInContext(source, context);
  const run = expression => vm.runInContext(expression, context);
  const payload = { ok: true, track: { title: MUSIC.track, artist: MUSIC.artist, durationMs: 134901 }, lyrics: { synced: entry(1, 135, '00.26').syncedLyrics, plain: '' }, match: entry(1, 135, '00.26'), hints: MUSIC };
  return { data, sessionData, calls, context, run, payload };
}

test('text cache normalizes accents and title decorations across recordings without transferring timestamps', async () => {
  const h=harness();h.context.seed={...h.payload,track:{title:'TOKENS ON THE DESK (Official Audio)',artist:'Sample Café'},lyrics:{synced:'[00:01.00] Original words\n[00:04.00] Next line',plain:''}};
  h.run("setCachedLyrics('TOKENS ON THE DESK','Sample Café',seed)");
  await new Promise(resolve=>setImmediate(resolve));
  const result=await h.run("getCachedLyricText('Tokens on the desk','Sample Cafe')");
  assert.equal(result.lyrics.plain,'Original words\nNext line');assert.equal(result.lyrics.synced,'');
  assert.equal(result.textCache.timingReused,false);assert.equal(result.textCache.sourceMediaKey,core.mediaKey(MUSIC));
  assert.equal(h.calls.length,0);
});

test('text cache refuses different artists and equally plausible conflicting transcripts', async () => {
  const h=harness();h.context.seed=h.payload;h.run("setCachedLyrics('Sample Track','Tëst Artist',seed)");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.run("getCachedLyricText('Sample Track','Someone Else')"),null);
  h.context.second={...h.payload,hints:VIDEO,lyrics:{plain:'Different recording lyrics',synced:''}};
  h.run("setCachedLyrics('Sample Track','Tëst Artist',second)");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.run("getCachedLyricText('Sample Track','Test Artist')"),null);
});

test('production lookup recovers cross-video words after provider miss while keeping timing unavailable', async () => {
  const h=harness();h.context.seed=h.payload;h.context.want=VIDEO;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed);findLyrics=async()=>null");await new Promise(resolve=>setImmediate(resolve));
  const result=await h.run('recognize({hints:want})');
  assert.equal(result.ok,true);assert.equal(result.lyrics.synced,'');assert.match(result.lyrics.plain,/First phrase/);
  assert.equal(result.textCache.timingReused,false);assert.equal(core.mediaKey(result.hints),core.mediaKey(VIDEO));
});
test('production recognize never reuses another video timing cache', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = VIDEO;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed)");
  const result = await h.run('recognize({hints:want})');
  assert.equal(result.match.id, 222); assert.ok(h.calls.length > 0);
});
test('exact video and duration cache survives worker suspension without network', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = MUSIC;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed); lyricsCache.clear()");
  const result = await h.run('recognize({hints:want})');
  assert.equal(result.match.id, 1); assert.equal(h.calls.length, 0);
});
test('persistent cache survives session loss and remains isolated by exact video', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = MUSIC;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed); lyricsCache.clear()");
  for (const key of Object.keys(h.sessionData)) delete h.sessionData[key];
  const hit = await h.run('recognize({hints:want})');
  assert.equal(hit.match.id, 1); assert.equal(h.calls.length, 0);
  h.context.want = VIDEO;
  assert.equal((await h.run('recognize({hints:want})')).match.id, 222);
});
test('duration-mismatched catalog fallback retains words but removes timed cues', async () => {
  const h = harness(); h.context.want = VIDEO;
  h.context.fallback = { lyrics: { synced: entry(333, 135, '00.26').syncedLyrics, plain: '', provider: 'test' }, match: entry(333, 135, '00.26') };
  h.run('findLyrics = async () => fallback');
  const result = await h.run('recognize({hints:want})');
  assert.equal(result.lyrics.synced, ''); assert.equal(result.lyrics.plain, 'First phrase\nSecond phrase');
});
test('legacy title-only and same-video different-duration entries cannot supply timings', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = { ...MUSIC, duration: 166.321 };
  h.data['lvxP:tëst artist|sample track'] = h.payload;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed)");
  const result = await h.run('recognize({hints:want})');
  assert.equal(result.match.id, 222); assert.ok(h.calls.length > 0);
});
test('outage fuzzy rescue cannot cross recording scopes', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = VIDEO;
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed)");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await h.run("getFuzzyCachedLyrics('Sample Track','Tëst Artist',want)"), null);
  h.context.want = MUSIC;
  assert.equal((await h.run("getFuzzyCachedLyrics('Sample Track','Tëst Artist',want)")).match.id, 1);
});
test('actual outage rescue forwards source scope and only publishes a same-recording hit', async () => {
  const h = harness(); h.context.seed = h.payload; h.context.want = VIDEO;
  h.context.published = [];
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed); getPageHints=async()=>want; sendToTab=()=>{}; handleRecognitionResult=async(tab,result)=>published.push(result)");
  assert.equal(await h.run('_tryOfflineRescue(1)'), false);
  assert.equal(h.context.published.length, 0);
  h.context.want = MUSIC;
  assert.equal(await h.run('_tryOfflineRescue(1)'), true);
  assert.equal(h.context.published[0].match.id, 1);
});
test('negative lookup cache is scoped to video and duration', () => {
  const h = harness(); h.context.music = MUSIC; h.context.video = VIDEO;
  h.run("markMiss('Sample Track','Tëst Artist',music)");
  assert.equal(h.run("isKnownMiss('Sample Track','Tëst Artist',video)"), false);
  assert.equal(h.run("isKnownMiss('Sample Track','Tëst Artist',music)"), true);
});
test('production recognize does not inherit a different video known-miss', async () => {
  const h = harness(); h.context.want = MUSIC;
  h.run('const originalFindLyrics=findLyrics; findLyrics=async()=>null');
  assert.equal((await h.run('recognize({hints:want})')).ok, false);
  h.run('findLyrics=originalFindLyrics'); h.context.want = VIDEO;
  assert.equal((await h.run('recognize({hints:want})')).match.id, 222);
});
test('YouTube full video title is cleaned without stripping a different artist prefix', () => {
  const h = harness(); h.context.want = { ...VIDEO, track: 'Tëst Artist - Sample Track (Official Music Video)' };
  const track = h.run('trackFromHints(normalizeHints(want))');
  assert.equal(track.title, 'Sample Track'); assert.equal(track.artist, 'Tëst Artist');
  h.context.want = { ...VIDEO, track: 'Other - Sample Track (Official Video)' };
  assert.equal(h.run('trackFromHints(normalizeHints(want)).title'), 'Other - Sample Track');
});

test('normal watch-page hints without an artist field use the title artist for exact lookup', async () => {
  const h=harness();
  h.context.want={url:'https://www.youtube.com/watch?v=FIXTURE0001',host:'www.youtube.com',duration:166.321,track:'Tëst Artist - Sample Track (Official Music Video)'};
  const track=h.run('trackFromHints(normalizeHints(want))');
  assert.equal(track.title,'Sample Track');assert.equal(track.artist,'Tëst Artist');
  const result=await h.run('recognize({hints:want})');assert.equal(result.match.id,222);
  assert.ok(h.calls.some(url=>new URL(url).searchParams.get('artist_name')==='Tëst Artist'&&new URL(url).searchParams.get('duration')==='166'));
});
test('healthy duration-specific metadata lookup wins over conflicting fast cache', async () => {
  const h = harness(); h.context.want = VIDEO;
  const result = await h.run('recognize({hints:want})');
  assert.equal(result.match.id, 222); assert.match(result.lyrics.synced, /^\[00:23.19\]/);
});

test('an untimed fallback is rechecked after cooldown and upgrades after worker suspension', async () => {
  const h=harness();h.context.want=VIDEO;
  h.context.seed={...h.payload,hints:VIDEO,lyrics:{synced:'',plain:'First phrase\nSecond phrase',provider:'lyrics.ovh'}};
  h.run("setCachedLyrics('Sample Track','Tëst Artist',seed); lyricsCache.clear()");
  assert.equal((await h.run('recognize({hints:want})')).lyrics.synced,'');
  assert.equal(h.calls.length,0);
  h.run('Date.now=()=>'+(Date.now()+61000));
  const result=await h.run('recognize({hints:want})');
  assert.equal(result.match.id,222);assert.ok(result.lyrics.synced);
});

test('track detection does not bypass plain-cache recovery when artist metadata is present', async () => {
  const h=harness();h.context.want=VIDEO;
  h.context.seed={...h.payload,hints:VIDEO,lyrics:{synced:'',plain:'Cached offline words'}};
  h.run("lyricsCache.set(cacheKey('Sample Track','Tëst Artist',want),seed);getPageHints=async()=>want;sendToTab=()=>{};globalThis.published=[];handleRecognitionResult=async(tab,payload)=>published.push(payload)");
  await h.run('_detectAndSyncInner(1,null,Date.now())');
  assert.equal(h.context.published[0].match.id,222);
  assert.ok(h.context.published[0].lyrics.synced);
});

test('legacy plain cache retries once, survives provider failure and cools down without losing words', async () => {
  const h=harness();h.context.want=VIDEO;
  const fallback={...h.payload,hints:VIDEO,lyrics:{synced:'',plain:'Offline words remain available'}};
  h.context.seed=fallback;
  h.run("lyricsCache.set(cacheKey('Sample Track','Tëst Artist',want),seed); let attempts=0;findLyrics=async()=>{attempts++;return null}");
  assert.equal((await h.run('recognize({hints:want})')).lyrics.plain,fallback.lyrics.plain);
  assert.equal((await h.run('recognize({hints:want})')).lyrics.plain,fallback.lyrics.plain);
  assert.equal(h.run('attempts'),1);
  h.run('lyricsCache.clear()');
  assert.equal((await h.run('recognize({hints:want})')).lyrics.plain,fallback.lyrics.plain);
  assert.equal(h.run('attempts'),1);
});

test('a successful exact-duration lookup needs one provider request, not three parallel calls', async () => {
  const h=harness();h.context.want=VIDEO;
  assert.equal((await h.run('recognize({hints:want})')).match.id,222);
  assert.equal(h.calls.length,1);
  assert.equal(new URL(h.calls[0]).searchParams.get('duration'),'166');
});

test('rate-limited primary lookup does not immediately hit more LRCLIB endpoints', async () => {
  const h=harness();h.context.want=VIDEO;
  h.context.fetch=async url=>{h.calls.push(url);return url.includes('lrclib.net')?{ok:false,status:429}:{ok:true,status:200,json:async()=>({lyrics:'First phrase with enough words\nSecond phrase with enough words'})}};
  const result=await h.run('recognize({hints:want})');
  assert.equal(result.lyrics.provider,'lyrics.ovh');
  assert.equal(h.calls.filter(url=>url.includes('lrclib.net')).length,1);
});
test('YouTube video-format suffixes and notification counters do not reach the lyrics query', () => {
  const h = harness();
  h.context.want = { host: 'www.youtube.com', track: 'Sample Cafe - TOKENS ON THE DESK | Animated Video', pageTitle: '(32) Sample Cafe - TOKENS ON THE DESK | Animated Video - YouTube', duration: 135 };
  const track = h.run('trackFromHints(want)');
  assert.equal(track.artist, 'Sample Cafe'); assert.equal(track.title, 'TOKENS ON THE DESK');
  const queries = h.run('buildLyricQueries(trackFromHints(want), want)');
  assert.ok(queries.includes('Sample Cafe TOKENS ON THE DESK'), JSON.stringify(queries));
  assert.ok(queries.every(q => !/animated|\(32\)|\|/i.test(q)), JSON.stringify(queries));
  // Ordinary titles and song names containing format words mid-title are untouched.
  assert.equal(h.run("cleanPageTitle('Tëst Artist - Sample Track (Official Music Video) - YouTube')"), 'Tëst Artist - Sample Track');
  assert.equal(h.run("cleanPageTitle('Video Found a Sample Track - The Fixtures')"), 'Video Found a Sample Track - The Fixtures');
  assert.equal(h.run("cleanPageTitle('Artist - Song - Official Lyric Video')"), 'Artist - Song');
  assert.equal(h.run("cleanPageTitle('Madonna - Music')"), 'Madonna - Music');
  assert.equal(h.run("cleanPageTitle('Band - Live')"), 'Band - Live');
});

test('automatic detection sleeps while its source tab is unfocused and resumes without changing saved timing bytes',async()=>{
 const h=harness(),messages=[];h.data.savedTiming={locked:true,startMs:1234};const original=JSON.stringify(h.data);
 h.context.chrome.tabs.sendMessage=async(_id,m)=>{messages.push(m);return m.type==='LV_WATCH_STATUS'?{ok:true,version:1,enabled:true,active:false}:{}};
 h.run('sessions.set(7,{active:true})');await h.run('_detectAndSyncLocked(7)');
 assert.equal(h.calls.length,0);assert.equal(messages.length,1);assert.equal(h.run('deferredDetections.has(7)'),true);assert.equal(JSON.stringify(h.data),original);
 h.context.chrome.tabs.sendMessage=async(_id,m)=>m.type==='LV_WATCH_STATUS'?{ok:true,version:1,enabled:true,active:true}:{};
 assert.equal(await h.run('automaticDetectionAllowed(7)'),true);assert.equal(h.run('pausedTabs.has(7)'),false);
});
test('a healthy overlay resumes without reinserting CSS or executing its scripts',async()=>{
 const h=harness();let css=0,scripts=0;
 h.context.chrome.tabs.sendMessage=async()=>({ok:true,version:1});
 h.context.chrome.scripting={insertCSS:async()=>css++,executeScript:async()=>scripts++};
 assert.equal(await h.run('injectOverlay(7)'),true);assert.equal(css,0);assert.equal(scripts,0);
 h.context.chrome.tabs.sendMessage=async()=>{throw Error('No receiver')};
 assert.equal(await h.run('injectOverlay(7)'),true);assert.equal(css,1);assert.equal(scripts,1);
});

test('stopping an active overlay delivers LV_STOP even after marking the tab paused',async()=>{
 const h=harness(),messages=[];h.context.chrome.tabs.sendMessage=async(_id,m)=>{messages.push(m);return {}};
 h.run('sessions.set(7,{active:true})');await h.run('stopSession(7)');
 assert.equal(messages.filter(m=>m.type==='LV_STOP').length,1);assert.equal(h.run('pausedTabs.has(7)'),true);
});

test('Spotify automatic retries never reinject or reopen the overlay',async()=>{
 const h=harness();h.context.setTimeout=f=>setImmediate(f);h.context.seed={host:'open.spotify.com',track:'Fixture title',artist:'Fixture artist'};
 h.run('var injected=0;getPageHints=async()=>seed;recognize=async()=>null;injectOverlay=async()=>injected++;sendToTab=()=>{};_sendSmartError=()=>{}');
 await h.run('_detectAndSyncInner(7,null,Date.now())');assert.equal(h.run('injected'),0);
});


test('navigation aborts the old lookup and only the latest settled source may publish',async()=>{
 const h=harness(),messages=[];h.context.want=MUSIC;h.context.LvScoreHost={packageFor:async()=>null,ensure:async()=>null};
 h.context.chrome.tabs.sendMessage=async(id,m)=>{messages.push(m);return m.type==='LV_WATCH_STATUS'?{ok:true,version:1,active:true,enabled:true}:{};};
 h.run('getPageHints=async()=>({...want,navigationToken:want.videoId});sessions.set(7,{active:true})');
 let started;const began=new Promise(r=>started=r);
 h.context.fetch=async(url,{signal})=>{h.calls.push(url);if(h.calls.length===1){started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));}return {ok:true,status:200,json:async()=>entry(222,166,'23.19')};};
 const old=h.run('detectAndSync(7)');await began;
 h.run('invalidateDetection(7)');h.context.want=VIDEO;await h.run('detectAndSync(7)');await old;
 for(let i=0;i<100&&h.run('detectionLocks.has(7)');i++)await new Promise(r=>setTimeout(r,40));
 assert.equal(h.run('detectionLocks.has(7)'),false);assert.equal(h.calls.length,2);
 const tracks=messages.filter(m=>m.type==='LV_TRACK');assert.equal(tracks.length,1);assert.equal(tracks[0].mediaKey,core.mediaKey(VIDEO));assert.equal(tracks[0].navigationToken,VIDEO.videoId);
 assert.equal(h.run('negativeCache.size'),0);assert.equal(h.run('apiHealth.lrclib.failures'),0);
});

test('a delayed saved-score reply cannot publish after the video changes',async()=>{
 const h=harness(),messages=[];h.context.want=MUSIC;
 let release;h.context.LvScoreHost={packageFor:()=>new Promise(r=>release=r)};
 h.context.chrome.tabs.sendMessage=async(id,m)=>{messages.push(m);return {ok:true,version:1,active:true,enabled:true};};
 h.run('getPageHints=async()=>({...want,navigationToken:want.videoId})');
 const lookup=h.run('_detectAndSyncLocked(7)');await new Promise(r=>setImmediate(r));h.context.want=VIDEO;
 release({source:MUSIC});await lookup;
 assert.equal(messages.filter(m=>m.type==='LV_SCORE_UPDATED'||m.type==='LV_ERROR').length,0);assert.equal(h.calls.length,0);
});


test('saved scores bypass captions; new videos try captions before lyric providers',async()=>{
 const h=harness(),captions=require('../extension/youtube-captions.js'),messages=[];h.context.want=MUSIC;
 const saved=core.createScore({platform:'youtube',videoId:MUSIC.videoId,durationMs:134901},'[00:01]My corrected text',{provider:'Manual paste',contentHash:'a'.repeat(64)});
 let captionCalls=0,ensured=0;
 h.context.chrome.scripting={executeScript:async()=>{captionCalls++;return [{result:{state:'available',videoId:MUSIC.videoId,language:'en',kind:'authored',format:'json3',body:JSON.stringify({events:[{tStartMs:2500,dDurationMs:1700,segs:[{utf8:'Caption words'}]}]})}}];}};
 h.context.chrome.tabs.sendMessage=async(_id,m)=>{messages.push(m);return {ok:true,version:1,active:true,enabled:true};};
 h.context.LvScoreHost={packageFor:async()=>saved,ensure:async(_id,p)=>{ensured++;return captions.createScore(core,{videoId:MUSIC.videoId,durationMs:134901},p.caption,'b'.repeat(64));}};
 h.run('getPageHints=async()=>({...want,navigationToken:want.videoId})');
 await h.run('_detectAndSyncLocked(7)');assert.equal(captionCalls,0);assert.equal(h.calls.length,0);assert.equal(ensured,0);assert.equal(messages.find(m=>m.type==='LV_SCORE_UPDATED').score.lyrics.provider,'Manual paste');
 messages.length=0;h.context.LvScoreHost.packageFor=async()=>null;await h.run('_detectAndSyncLocked(7)');assert.equal(captionCalls,1);assert.equal(h.calls.length,0);assert.equal(ensured,1);assert.match(messages.find(m=>m.type==='LV_SCORE_UPDATED').score.lyrics.provider,/YouTube captions/);
});

test('unavailable or malformed captions fall back once; navigation while reading cannot save old captions',async()=>{
 const h=harness();h.context.want=MUSIC;let saves=0;h.context.LvScoreHost={packageFor:async()=>null,ensure:async()=>{saves++;return null;}};
 h.context.chrome.scripting={executeScript:async()=>[{result:{state:'available',videoId:MUSIC.videoId,format:'json3',body:'broken'}}]};
 h.run('getPageHints=async()=>({...want,navigationToken:want.videoId})');await h.run('_detectAndSyncLocked(7)');assert.ok(h.calls.length>0);const prior=saves;
 let release;h.context.chrome.scripting.executeScript=()=>new Promise(r=>release=r);const pending=h.run('_detectAndSyncLocked(7)');await new Promise(r=>setImmediate(r));h.context.want=VIDEO;
 release([{result:{state:'available',videoId:MUSIC.videoId,language:'en',kind:'automatic',format:'json3',body:JSON.stringify({events:[{tStartMs:1000,dDurationMs:2000,segs:[{utf8:'Stale captions'}]}]})}}]);await pending;assert.equal(saves,prior);
});
