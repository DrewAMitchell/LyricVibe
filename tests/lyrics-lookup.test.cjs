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
  const context = vm.createContext({ console, URL, URLSearchParams, AbortSignal, AbortController, setTimeout, clearTimeout, LvScore: core, importScripts() {}, chrome: { storage: { local: store(data), session: store(sessionData) }, action: { onClicked: event }, runtime: { onMessage: event }, tabs: { onRemoved: event } }, fetch: async url => {
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
