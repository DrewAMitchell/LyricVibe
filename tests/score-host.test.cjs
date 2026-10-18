const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const scoreCore = require('../extension/score-core.js');

const root = path.resolve(__dirname, '..');
const scoreSource = fs.readFileSync(path.join(root, 'extension/score-core.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'extension/score-host.js'), 'utf8');
const HASH = 'a'.repeat(64);
const ID_A = 'FIXTURE0001';
const ID_B = 'FIXTURE0003';

function makeHarness() {
  const values = Object.create(null);
  const sessionValues = Object.create(null);
  const tabs = new Map([[1, { url: `https://www.youtube.com/watch?v=${ID_A}`, duration: 10, mediaReady: true, isAd: false }], [2, { url: `https://music.youtube.com/watch?v=${ID_B}`, duration: 20, mediaReady: true, isAd: false }]]);
  const tabMessages = [];
  const runtimeMessages = [];
  const popupWindows = [];
  let listener;
  let copyBlocked = false;
  const analysisCalls = [];
  let analysisStatus = { state: 'capturing', tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1' };
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { runtimeMessages.push(structuredClone(message)); return message; },
      getURL(file) { return `chrome-extension://test/${file}`; },
    },
    storage: { local: {
      async get(key) { return key == null ? structuredClone({ ...values }) : { [key]: structuredClone(values[key]) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) values[key] = structuredClone(value); },
      async remove(key) { for (const k of [].concat(key)) delete values[k]; },
    }, session: {
      async get(key) { return key == null ? structuredClone({ ...sessionValues }) : { [key]: structuredClone(sessionValues[key]) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) sessionValues[key] = structuredClone(value); },
      async remove(key) { for (const k of [].concat(key)) delete sessionValues[k]; },
    } },
    tabs: {
      async sendMessage(tabId, message) {
        if (message.type === 'LV_GET_HINTS') return { ...tabs.get(tabId) };
        if (message.type === 'LV_TIMING_EDIT_CHECK') return {ok:true,mediaKey:message.mediaKey,canEdit:!copyBlocked};
        if (message.type === 'LV_TIMING_COPY_CHECK') return {ok:true,mediaKey:message.mediaKey,canCopy:!copyBlocked};
        tabMessages.push({ tabId, message: structuredClone(message) });
        return { ok: true };
      },
      async create() { return {}; },
    },
    windows: { async create(options) { popupWindows.push(structuredClone(options)); return { id: popupWindows.length }; } },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, URL, AbortSignal, setTimeout, clearTimeout, console,
    LvAnalysis: { async analysisStatus() { return analysisStatus; }, async startAnalysis(args) { analysisCalls.push(args); return { state: 'capturing', engine: args.engine }; }, async stopAnalysis(scope) { analysisCalls.push({ stopScope: scope }); return { state: 'stopped' }; } },
  });
  vm.runInContext(scoreSource, context, { filename: 'score-core.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/timing-variant.js'), 'utf8'), context, { filename: 'timing-variant.js' });
  vm.runInContext(hostSource, context, { filename: 'score-host.js' });

  function dispatch(message, sender = { id: chrome.runtime.id, tab: { id: 1 } }) {
    if (message.type === 'LV_ALIGNMENT_PROPOSALS') {
      message = { tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1', ...message };
      if (sender.url === undefined && sender.tab) sender = { ...sender, url: chrome.runtime.getURL('analysis/offscreen.html') };
    }
    if (['LV_SCORE_REVIEW_APPLY', 'LV_NATIVE_ALIGNMENT_IMPORT', 'LV_NATIVE_ANALYSIS_START', 'LV_NATIVE_ANALYSIS_STOP', 'LV_NATIVE_ANALYSIS_STATUS'].includes(message.type) && sender.url === undefined) {
      const tabId = message.tabId ?? sender.tab?.id ?? 1;
      const mediaKey = message.mediaKey || `youtube:${ID_A}`;
      message = { tabId, ...message };
      sender = { id: chrome.runtime.id, url: chrome.runtime.getURL(`editor.html?sourceTab=${tabId}&mediaKey=${encodeURIComponent(mediaKey)}`) };
    }
    return new Promise((resolve, reject) => {
      if (!listener) return reject(new Error('score host listener was not registered'));
      const keptOpen = listener(message, sender, resolve);
      if (keptOpen !== true) reject(new Error('score host did not keep its response channel open'));
    });
  }
  async function ensure(tabId = 1, videoId = tabId === 1 ? ID_A : ID_B, overrides = {}) {
    return context.LvScoreHost.ensure(tabId, {
      hints: { videoId },
      lyrics: { synced: '[00:01.00]hello world\n[00:03.00]' , provider: 'test' },
      track: { title: 'Same song', artist: 'Same artist' },
      match: { id: 'entry-1' },
      ...overrides,
    });
  }
  return { context, values, sessionValues, tabs, tabMessages, runtimeMessages, popupWindows, analysisCalls, dispatch, ensure,
    setCopyBlocked(value) { copyBlocked=value; },
    restartWorker() { vm.runInContext(hostSource, context, { filename: 'score-host.js' }); },
    setAnalysisStatus(value) { analysisStatus = value; } };
}

function recordFor(h, id = ID_A) { return h.values[`lvScore:youtube:${id}`]; }

test('plain lyrics explicitly open an editable source-bound score without a timed provider', async()=>{
  const h=makeHarness(),sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  h.context.recognize=async()=>{throw Error('Manual authoring must not need the provider');};
  const authored=await h.dispatch({type:'LV_SCORE_AUTHOR',mediaKey:`youtube:${ID_A}`,text:'Hello again\nMorning light',title:'Plain song',artist:'Singer',provider:'local text'},sender);
  assert.equal(authored.ok,true);assert.equal(authored.created,true);assert.equal(authored.score.lyrics.timingBasis,'plain-text');
  assert.equal(authored.score.source.videoId,ID_A);assert.equal(authored.score.offsetMs,0);
  assert.deepEqual(Array.from(authored.score.phrases,p=>p.words.map(w=>w.text).join(' ')),['Hello again','Morning light']);
  assert.ok(authored.score.phrases.every(p=>p.endEstimated&&p.words.every(w=>w.provenance==='estimated'&&!w.locked)));
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:0,lyricsHash:authored.score.lyrics.contentHash};
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,fromSaved:true},sender);assert.equal(prepared.ok,true);
  const before=JSON.stringify(recordFor(h));
  const first=authored.score.phrases[0].words[0];
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,changes:[{wordId:first.id,startMs:8000,endMs:8500}]},sender);
  assert.equal(tuned.ok,true,tuned.error?.message);assert.equal(tuned.preview.score.phrases[0].words[0].startMs,8000);
  assert.equal(tuned.preview.score.phrases[0].words[0].provenance,'manual');assert.equal(JSON.stringify(recordFor(h)),before,'recording updates preview, not saved score');
  const again=await h.dispatch({type:'LV_SCORE_AUTHOR',mediaKey:`youtube:${ID_A}`,text:'Replacement must not win'},sender);
  assert.equal(again.created,false);assert.equal(JSON.stringify(recordFor(h)),before);
  h.restartWorker();assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...envelope},sender)).preview.previewRevision,1);
});

test('plain authoring refuses wrong-video and unbound callers without creating scores',async()=>{
  const h=makeHarness(),message={type:'LV_SCORE_AUTHOR',mediaKey:`youtube:${ID_B}`,text:'My lyrics'};
  const wrong=await h.dispatch(message,{id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`});
  assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'SOURCE_CHANGED');
  const unbound=await h.dispatch({...message,tabId:2},{id:'test-extension',url:'https://unrelated.example/'});
  assert.equal(unbound.ok,false);assert.equal(unbound.error.code,'SOURCE_REQUIRED');assert.equal(Object.keys(h.values).length,0);
});

test('opening overlay Sync after saved text replacement preserves edits and resumes its preview without catalog lookup', async () => {
  const h=makeHarness(), initial=await h.ensure(), phrase=initial.phrases[0];
  const edited=await h.dispatch({type:'LV_SCORE_OPERATION',mediaKey:`youtube:${ID_A}`,expectedRevision:0,
    operation:{type:'replaceWords',phraseId:phrase.id,wordIds:phrase.words.map(w=>w.id),text:'get down now'}});
  assert.equal(edited.ok,true);
  const before=JSON.stringify(recordFor(h));
  let lookups=0;
  h.context.recognize=async()=>{lookups++;return {ok:true,lyrics:{synced:'[00:01.00]hello world\n[00:03.00]',provider:'test'}};};
  const source=fs.readFileSync(path.join(root,'extension/content.js'),'utf8');
  const opener=source.slice(source.indexOf('  async function openTimingReview()'),source.indexOf('  function discardTimingLocal()'));
  const timing={busy:false,draft:null}, panel={hidden:true,focus(){}}, notices=[];
  const context=vm.createContext({timing,timingWorkspace:null,stageEdit:{active:false},syncPanel:panel,state:{auditionLoop:null,score:edited.score},unplacedWords:()=>[],loadTempo:async()=>{},hasBaselineTempo:()=>true,refreshTimingPanel(){},setSyncNotice:text=>notices.push(text),
    async timingRequest(type,extra={}) {
      const result=await h.dispatch({type,mediaKey:`youtube:${ID_A}`,expectedRevision:edited.score.revision,lyricsHash:edited.score.lyrics.contentHash,...extra},
        {id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`});
      if(!result.ok)throw Error(result.error.message);
      return result;
    }});
  vm.runInContext(opener,context);
  await vm.runInContext('openTimingReview()',context);
  assert.ok(timing.draft,notices.at(-1));
  assert.equal(lookups,0);
  assert.deepEqual(JSON.parse(JSON.stringify({...timing.draft.score,revision:edited.score.revision})),JSON.parse(JSON.stringify(edited.score)));
  const token=timing.draft.token;
  panel.hidden=true;timing.draft=null;
  await vm.runInContext('openTimingReview()',context);
  assert.equal(timing.draft.token,token);
  assert.equal(JSON.stringify(recordFor(h)),before,'opening must preserve saved score and Undo history');
});

test('catalog preview, exact tuning, cancellation and application preserve history until commit', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]',provider:'fixture'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1,url:`https://www.youtube.com/watch?v=${ID_A}`},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const before=JSON.stringify(recordFor(h));
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  assert.equal(prepared.ok,true); assert.equal(JSON.stringify(recordFor(h)),before);
  const id=score.phrases[0].words[0].id;
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,changes:[{wordId:id,startMs:5055,endMs:5500}]},sender);
  assert.equal(tuned.ok,true);assert.equal(JSON.stringify(recordFor(h)),before);
  assert.equal((await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:0},sender)).error.code,'PREVIEW_CONFLICT');
  const applied=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:tuned.preview.previewRevision},sender);
  assert.equal(applied.ok,true);assert.equal(applied.score.revision,1);assert.equal(applied.score.phrases[0].words[0].startMs,5055);
  assert.equal(recordFor(h).history.length,1);
  const undone=await h.dispatch({type:'LV_SCORE_UNDO',mediaKey:envelope.mediaKey,expectedRevision:1},sender);
  assert.equal(undone.ok,true);assert.equal(undone.score.revision,2);
  assert.deepEqual(JSON.parse(JSON.stringify({...undone.score,revision:0})),JSON.parse(JSON.stringify(score)));
  const again=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token},sender);
  assert.equal(again.ok,false);assert.equal(again.error.code,'REVISION_CONFLICT');
});

test('timing preview recovers after worker restart and remains valid beyond thirty minutes', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  const word=score.phrases[0].words[0];
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,
    changes:[{wordId:word.id,startMs:word.startMs+55,endMs:word.endMs+55}]},sender);
  assert.ok(h.values[`lvTimingPreview:${envelope.mediaKey}`]);
  const afterThirtyOneMinutes=Date.now()+31*60*1000;
  vm.runInContext(`Date.now = () => ${afterThirtyOneMinutes}`,h.context);
  h.restartWorker();
  // Local storage survives service-worker suspension and browser restarts.
  const recovered=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,
    previewRevision:tuned.preview.previewRevision},sender);
  assert.equal(recovered.ok,true);
  assert.equal(recovered.score.phrases[0].words[0].startMs,word.startMs+55);
  assert.equal(recordFor(h).history.length,1);
  const undone=await h.dispatch({type:'LV_SCORE_UNDO',...envelope,expectedRevision:1},sender);
  assert.equal(undone.ok,true);
  assert.equal(undone.score.phrases[0].words[0].startMs,word.startMs);
  assert.equal(h.values[`lvTimingPreview:${envelope.mediaKey}`],undefined);
});

test('light editor opens only from the bound source overlay and current returns the saved draft without preparing one', async () => {
  const h=makeHarness(), score=await h.ensure();
  const overlay={id:'test-extension',tab:{id:1,url:`https://www.youtube.com/watch?v=${ID_A}`},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const opened=await h.dispatch({type:'LV_LIGHT_EDITOR_OPEN',tabId:1,mediaKey:`youtube:${ID_A}`},overlay);
  assert.equal(opened.ok,true);
  assert.deepEqual(h.popupWindows[0],{type:'popup',url:`chrome-extension://test/light-editor.html?sourceTab=1&mediaKey=youtube%3A${ID_A}`,width:1100,height:650});
  const denied=await h.dispatch({type:'LV_LIGHT_EDITOR_OPEN',tabId:1,mediaKey:`youtube:${ID_A}`},
    {id:'test-extension',tab:{id:1,url:overlay.tab.url},url:'chrome-extension://test/options.html'});
  assert.equal(denied.error.code,'SOURCE_REQUIRED');
  assert.equal(h.popupWindows.length,1);

  const lightEditor={id:'test-extension',url:`chrome-extension://test/light-editor.html?sourceTab=1&mediaKey=youtube%3A${ID_A}`};
  const request={type:'LV_TIMING_CURRENT',tabId:1,mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  h.context.recognize=async()=>{throw new Error('current must not prepare catalog timing');};
  let current=await h.dispatch(request,lightEditor);
  assert.equal(current.ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(current.score)),JSON.parse(JSON.stringify(score)));
  assert.equal(current.preview,null);
  assert.equal(h.values[`lvTimingPreview:youtube:${ID_A}`],undefined);

  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},overlay);
  const word=prepared.preview.score.phrases[0].words[0];
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,
    changes:[{wordId:word.id,startMs:word.startMs+25,endMs:word.endMs+25}]},overlay);
  assert.equal(tuned.ok,true);
  const tabEvent=h.tabMessages.findLast(item=>item.message.type==='LV_TIMING_PREVIEW_UPDATED');
  const runtimeEvent=h.runtimeMessages.findLast(item=>item.type==='LV_TIMING_PREVIEW_UPDATED');
  assert.equal(tabEvent.tabId,1);
  assert.equal(tabEvent.message.mediaKey,envelope.mediaKey);
  assert.equal(runtimeEvent.tabId,1);
  assert.equal(runtimeEvent.mediaKey,envelope.mediaKey);
  assert.equal(runtimeEvent.preview.previewRevision,1);
  current=await h.dispatch(request,lightEditor);
  assert.equal(current.preview.previewRevision,1);
  assert.equal(current.preview.token,prepared.preview.token);
});

test('timing preview undo restores the full prior draft monotonically without touching saved score history', async () => {
  const h=makeHarness(), initial=await h.ensure(), word=firstWord(initial);
  const syllable={id:'preview-undo-syllable',text:word.text,startMs:word.startMs,endMs:word.endMs};
  const segmented=await h.dispatch({type:'LV_SCORE_OPERATION',mediaKey:`youtube:${ID_A}`,expectedRevision:0,
    operation:{type:'setWordSyllables',wordId:word.id,syllables:[syllable]}});
  const excluded=await h.dispatch({type:'LV_SCORE_OPERATION',mediaKey:`youtube:${ID_A}`,expectedRevision:1,
    operation:{type:'setWordExcluded',wordId:word.id,excluded:true}});
  assert.equal(segmented.ok,true); assert.equal(excluded.ok,true);
  const savedBefore=JSON.stringify(recordFor(h));
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:excluded.score.revision,lyricsHash:excluded.score.lyrics.contentHash};
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  const before=JSON.stringify(prepared.preview.score);
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,allowProtected:true,operations:[
    {type:'setWordExcluded',wordId:word.id,excluded:false},
    {type:'setSyllableTiming',syllableId:syllable.id,startMs:syllable.startMs+10,endMs:syllable.endMs},
  ]},sender);
  assert.equal(tuned.ok,true);
  assert.equal(tuned.preview.previewRevision,1);
  assert.notDeepEqual(JSON.parse(JSON.stringify(tuned.preview.score)),JSON.parse(before));
  assert.equal(JSON.stringify(recordFor(h)),savedBefore);
  const undone=await h.dispatch({type:'LV_TIMING_UNDO',...envelope,token:prepared.preview.token,previewRevision:1},sender);
  assert.equal(undone.ok,true);
  assert.equal(undone.preview.previewRevision,2);
  assert.deepEqual(JSON.parse(JSON.stringify(undone.preview.score)),JSON.parse(before));
  assert.equal(undone.preview.score.phrases[0].words[0].excluded,true);
  assert.deepEqual(JSON.parse(JSON.stringify(undone.preview.score.phrases[0].words[0].syllables)),[
    {...syllable,provenance:'manual',locked:true,effects:[]},
  ]);
  assert.equal(JSON.stringify(recordFor(h)),savedBefore);
  assert.equal(recordFor(h).history.length,2);
});

test('from-saved timing preview avoids catalog lookup and supports a second undoable save', async () => {
  const h=makeHarness(), initial=await h.ensure(), word=firstWord(initial);
  const timed=await h.dispatch({type:'LV_SCORE_OPERATION',mediaKey:`youtube:${ID_A}`,expectedRevision:0,
    operation:{type:'setWordTiming',wordId:word.id,startMs:word.startMs+10,endMs:word.endMs+10}});
  const excluded=await h.dispatch({type:'LV_SCORE_OPERATION',mediaKey:`youtube:${ID_A}`,expectedRevision:1,
    operation:{type:'setWordExcluded',wordId:word.id,excluded:true}});
  assert.equal(timed.ok,true); assert.equal(excluded.ok,true);
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:excluded.score.revision,lyricsHash:excluded.score.lyrics.contentHash};
  h.context.recognize=async()=>{throw new Error('from-saved prepare must not call catalog lookup');};
  const saved=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,fromSaved:true},sender);
  assert.equal(saved.ok,true);
  assert.equal(h.runtimeMessages.findLast(item=>item.type==='LV_TIMING_PREVIEW_UPDATED').preview.token,saved.preview.token);
  const savedWord=saved.preview.score.phrases[0].words.find(w=>w.id===word.id);
  assert.equal(savedWord.startMs,excluded.score.phrases[0].words[0].startMs);
  assert.equal(savedWord.endMs,excluded.score.phrases[0].words[0].endMs);
  assert.equal(savedWord.excluded,true);

  const firstTune=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:saved.preview.token,previewRevision:0,allowProtected:true,
    changes:[{wordId:word.id,startMs:savedWord.startMs+10,endMs:savedWord.endMs+10}]},sender);
  assert.equal(firstTune.ok,true);
  const firstApply=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:saved.preview.token,previewRevision:1},sender);
  assert.equal(firstApply.ok,true);
  assert.equal(firstApply.score.phrases[0].words[0].excluded,true);
  assert.equal(recordFor(h).history.length,3);

  const secondEnvelope={...envelope,expectedRevision:firstApply.score.revision};
  const second=await h.dispatch({type:'LV_TIMING_PREPARE',...secondEnvelope,fromSaved:true},sender);
  assert.equal(second.ok,true);
  const nextWord=second.preview.score.phrases[0].words[1];
  const secondTune=await h.dispatch({type:'LV_TIMING_TUNE',...secondEnvelope,token:second.preview.token,previewRevision:0,allowProtected:true,
    changes:[{wordId:nextWord.id,startMs:nextWord.startMs+10,endMs:nextWord.endMs+10}]},sender);
  assert.equal(secondTune.ok,true);
  const secondApply=await h.dispatch({type:'LV_TIMING_APPLY',...secondEnvelope,token:second.preview.token,previewRevision:1},sender);
  assert.equal(secondApply.ok,true);
  assert.equal(secondApply.score.revision,firstApply.score.revision+1);
  assert.equal(recordFor(h).history.length,4);
  assert.deepEqual(JSON.parse(JSON.stringify({...recordFor(h).history.at(-1),revision:firstApply.score.revision})),
    JSON.parse(JSON.stringify(firstApply.score)));
});

test('partial timing preview changes preserve unmarked words and stale source revisions invalidate previews', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const before=JSON.stringify(recordFor(h));
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  const [hello,world]=prepared.preview.score.phrases[0].words;
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,
    changes:[{wordId:hello.id,startMs:hello.startMs+100,endMs:hello.endMs+100}]},sender);
  assert.equal(tuned.ok,true);
  assert.deepEqual([tuned.preview.score.phrases[0].words[1].startMs,tuned.preview.score.phrases[0].words[1].endMs],[world.startMs,world.endMs]);
  assert.equal(JSON.stringify(recordFor(h)),before);
  const edited=await h.dispatch({type:'LV_SCORE_OPERATION',...envelope,operation:{type:'setOffset',offsetMs:25}},sender);
  assert.equal(edited.ok,true);
  const stale=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:1},sender);
  assert.equal(stale.error.code,'REVISION_CONFLICT');
  // With the current score envelope, the old preview is rejected by its bound revision.
  const currentEnvelope={...envelope,expectedRevision:edited.score.revision};
  const staleBound=await h.dispatch({type:'LV_TIMING_APPLY',...currentEnvelope,token:prepared.preview.token,previewRevision:1},sender);
  assert.equal(staleBound.error.code,'PREVIEW_EXPIRED');
  assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...currentEnvelope,lyricsHash:'f'.repeat(64)},sender)).error.code,'LYRIC_REVISION_MISMATCH');
});

test('hyphen word capture stages atomically and saved application can undo the structural split', async () => {
  const h=makeHarness(), score=await h.ensure(1,ID_A,{lyrics:{synced:'[00:01.00]ice-breaker now\n[00:03.00]',provider:'fixture'}});
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]ice-breaker now\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:0,lyricsHash:score.lyrics.contentHash};
  const before=JSON.stringify(recordFor(h));
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  assert.equal(prepared.ok,true);
  const wordId=score.phrases[0].words[0].id;
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,changes:[{
    wordId,startMs:5050,endMs:5600,hyphenParts:[{text:'ice-',startMs:5050,endMs:5200},{text:'breaker',startMs:5250,endMs:5600}],
  }]},sender);
  assert.equal(tuned.ok,true);assert.equal(JSON.stringify(recordFor(h)),before);
  const applied=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:tuned.preview.previewRevision},sender);
  assert.equal(applied.ok,true);
  assert.deepEqual(Array.from(applied.score.phrases[0].words,w=>w.text),['ice-','breaker','now']);
  assert.equal(recordFor(h).history.length,1);
  const undone=await h.dispatch({type:'LV_SCORE_UNDO',mediaKey:envelope.mediaKey,expectedRevision:1},sender);
  assert.equal(undone.ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify({...undone.score,revision:0})),JSON.parse(JSON.stringify(score)));
});

test('catalog preview rejects wrong sender, hash, source changes and stale tokens without saved writes', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:0,lyricsHash:score.lyrics.contentHash};
  const before=JSON.stringify(recordFor(h));
  assert.equal((await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},{id:'test-extension',tab:{id:2},url:sender.url})).ok,false);
  assert.equal((await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,lyricsHash:'b'.repeat(64)},sender)).ok,false);
  const preview=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);assert.equal(preview.ok,true);
  assert.equal((await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:'forged'},sender)).ok,false);
  h.tabs.get(1).url=`https://www.youtube.com/watch?v=${ID_B}`;
  assert.equal((await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:preview.preview.token,previewRevision:0},sender)).ok,false);
  h.tabs.get(1).url=sender.url;
  assert.equal((await h.dispatch({type:'LV_TIMING_CANCEL',...envelope,token:preview.preview.token,previewRevision:0},sender)).ok,true);
  assert.equal(h.values[`lvTimingPreview:${envelope.mediaKey}`],undefined);
  assert.ok(h.tabMessages.some(item=>item.message.type==='LV_TIMING_PREVIEW_CLOSED'&&item.message.mediaKey===envelope.mediaKey));
  assert.ok(h.runtimeMessages.some(item=>item.type==='LV_TIMING_PREVIEW_CLOSED'&&item.mediaKey===envelope.mediaKey));
  assert.equal((await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:preview.preview.token},sender)).error.code,'PREVIEW_EXPIRED');
  assert.equal(JSON.stringify(recordFor(h)),before);
});

test('timing preview accepts a syllable operation batch as one isolated revision', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const saved=JSON.stringify(recordFor(h));
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  const [hello,world]=prepared.preview.score.phrases[0].words;
  const syllables=(word, firstText, secondText, prefix)=>{
    const split=word.startMs+Math.floor((word.endMs-word.startMs)/2);
    return [{id:`${prefix}-a`,text:firstText,startMs:word.startMs,endMs:split},{id:`${prefix}-b`,text:secondText,startMs:split,endMs:word.endMs}];
  };
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,operations:[
    {type:'setWordSyllables',wordId:hello.id,startTapping:true,syllables:syllables(hello,'hel','lo','hello')},
    {type:'setWordSyllables',wordId:world.id,startTapping:true,syllables:syllables(world,'wor','ld','world')},
  ]},sender);
  assert.equal(tuned.ok,true);
  assert.equal(tuned.preview.previewRevision,1);
  assert.equal(tuned.preview.score.revision,prepared.preview.score.revision);
  assert.ok(tuned.preview.score.phrases[0].words.every(w=>w.syllables.every(s=>s.provenance==='estimated'&&!s.locked)));
  assert.equal(tuned.preview.score.source.videoId,score.source.videoId);
  assert.equal(tuned.preview.score.lyrics.contentHash,prepared.preview.score.lyrics.contentHash);
  assert.equal(JSON.stringify(recordFor(h)),saved);
  const stale=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,operation:{type:'setSyllableTiming',syllableId:'hello-a',startMs:5010,endMs:5210}},sender);
  assert.equal(stale.error.code,'PREVIEW_CONFLICT');
  assert.equal(JSON.stringify(recordFor(h)),saved);
  const both=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:1,operation:{type:'setSyllableTiming',syllableId:'hello-a',startMs:5010,endMs:5210},changes:[]},sender);
  assert.equal(both.error.code,'INVALID_TIMING');
});

test('timing preview buffers appearance effects on protected manual timing until apply', async () => {
  const h=makeHarness(), initial=await h.ensure();
  const word=firstWord(initial);
  const segmented=await h.dispatch({type:'LV_SCORE_OPERATION',expectedRevision:initial.revision,operation:{
    type:'setWordSyllables',wordId:word.id,syllables:[{id:'saved-first-syllable',text:word.text,startMs:word.startMs,endMs:word.endMs}],
  }});
  assert.equal(segmented.ok,true);
  const savedBefore=JSON.stringify(recordFor(h));
  const sender={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:segmented.score.revision,lyricsHash:segmented.score.lyrics.contentHash};
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope},sender);
  const protectedWord=prepared.preview.score.phrases[0].words[0];
  const originalTiming=[protectedWord.startMs,protectedWord.endMs,protectedWord.syllables[0].startMs,protectedWord.syllables[0].endMs];
  const tuned=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,operations:[
    {type:'setWordEffect',wordId:protectedWord.id,effect:{type:'tilt',strength:0.4}},
    {type:'setSyllableEffect',syllableId:'saved-first-syllable',effect:{type:'pulse',strength:0.7}},
  ]},sender);
  assert.equal(tuned.ok,true);
  assert.equal(tuned.preview.score.revision,prepared.preview.score.revision);
  assert.deepEqual(JSON.parse(JSON.stringify(recordFor(h))),JSON.parse(savedBefore));
  assert.deepEqual([tuned.preview.score.phrases[0].words[0].startMs,tuned.preview.score.phrases[0].words[0].endMs,
    tuned.preview.score.phrases[0].words[0].syllables[0].startMs,tuned.preview.score.phrases[0].words[0].syllables[0].endMs],originalTiming);
  const applied=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:tuned.preview.previewRevision},sender);
  assert.equal(applied.ok,true);
  assert.deepEqual([firstWord(applied.score).startMs,firstWord(applied.score).endMs,
    firstWord(applied.score).syllables[0].startMs,firstWord(applied.score).syllables[0].endMs],originalTiming);
  assert.deepEqual(JSON.parse(JSON.stringify(firstWord(applied.score).effects)),[{type:'tilt',strength:0.4}]);
  assert.deepEqual(JSON.parse(JSON.stringify(firstWord(applied.score).syllables[0].effects)),[{type:'pulse',strength:0.7}]);
  assert.equal(applied.score.revision,segmented.score.revision+1);
});
function firstWord(score) { return score.phrases.flatMap(p => p.words)[0]; }

function nativeReceipt(score) {
  const word = firstWord(score);
  return { version: 'lyricvibe.alignment.v1', mediaKey: scoreCore.mediaKey(score.source), lyricsHash: score.lyrics.contentHash, expectedRevision: score.revision, adapter: 'test-forced-alignment', model: 'explicit-fixture', automaticAdmissionEnabled: false, proposals: [{ wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs + 100, accepted: false, evidenceId: 'native-fixture' }] };
}

test('native analysis controls require the source-bound editor and exact score revision/lyrics', async () => {
  const h = makeHarness(), score = await h.ensure();
  const base = { type: 'LV_NATIVE_ANALYSIS_START', tabId: 1, mediaKey: `youtube:${ID_A}`, expectedRevision: score.revision, lyricsHash: score.lyrics.contentHash };
  const wrongEditor = await h.dispatch(base, { id: 'test-extension', url: 'chrome-extension://test/editor.html?sourceTab=2' });
  assert.equal(wrongEditor.error.code, 'EDITOR_REQUIRED');
  const stale = await h.dispatch({ ...base, expectedRevision: score.revision + 1 });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  const wrongLyrics = await h.dispatch({ ...base, lyricsHash: 'f'.repeat(64) });
  assert.equal(wrongLyrics.error.code, 'LYRIC_REVISION_MISMATCH');
  assert.equal(h.analysisCalls.length, 0);
  const started = await h.dispatch(base);
  assert.equal(started.analysis.engine, 'native');
  assert.equal(h.analysisCalls[0].tabId, 1);
  assert.equal(h.analysisCalls[0].score.revision, score.revision);
  assert.equal(h.analysisCalls[0].engine, 'native');
  assert.equal(h.analysisCalls[0].expectedRevision, score.revision);
  assert.equal(h.analysisCalls[0].lyricsHash, score.lyrics.contentHash);
  h.tabs.get(1).isAd = true;
  const stopped = await h.dispatch({ ...base, type: 'LV_NATIVE_ANALYSIS_STOP' });
  assert.equal(stopped.analysis.state, 'stopped');
  assert.deepEqual({ ...h.analysisCalls.at(-1).stopScope }, { tabId: 1, mediaKey: `youtube:${ID_A}` });
});

test('native receipt import queues source-bound review without changing timing; accept and undo work', async () => {
  const h = makeHarness(), score = await h.ensure(), receipt = nativeReceipt(score);
  const result = await h.dispatch({ type: 'LV_NATIVE_ALIGNMENT_IMPORT', tabId: 1, mediaKey: receipt.mediaKey, expectedRevision: score.revision, receipt });
  assert.equal(result.ok, true);
  assert.equal(result.score.revision, score.revision);
  assert.equal(firstWord(result.score).startMs, firstWord(score).startMs);
  assert.equal(result.review.length, 1);
  assert.equal(recordFor(h).history.length, 0);
  const accepted = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', tabId: 1, mediaKey: receipt.mediaKey, expectedRevision: score.revision, wordIds: [firstWord(score).id] });
  assert.equal(accepted.ok, true);
  assert.equal(firstWord(accepted.score).startMs, receipt.proposals[0].startMs);
  const undone = await h.dispatch({ type: 'LV_SCORE_UNDO', expectedRevision: accepted.score.revision });
  assert.equal(undone.ok, true);
  assert.equal(firstWord(undone.score).startMs, firstWord(score).startMs);
});

test('native receipt rejects a mismatched editor, video, lyric hash, revision, or automatic admission', async () => {
  const h = makeHarness(), score = await h.ensure(), receipt = nativeReceipt(score);
  const message = { type: 'LV_NATIVE_ALIGNMENT_IMPORT', tabId: 1, mediaKey: receipt.mediaKey, expectedRevision: score.revision, receipt };
  const unbound = await h.dispatch(message, { id: 'test-extension', url: 'chrome-extension://test/editor.html?sourceTab=2' });
  assert.equal(unbound.error.code, 'EDITOR_REQUIRED');
  for (const [patch, code] of [
    [{ mediaKey: `youtube:${ID_B}` }, 'SOURCE_MISMATCH'],
    [{ lyricsHash: HASH }, 'LYRIC_REVISION_MISMATCH'],
    [{ expectedRevision: 1 }, 'REVISION_CONFLICT'],
    [{ automaticAdmissionEnabled: true }, 'INVALID_ALIGNMENT_RECEIPT'],
    [{ proposals: [{ ...receipt.proposals[0], accepted: true }] }, 'INVALID_ALIGNMENT_RECEIPT'],
    [{ proposals: [{ ...receipt.proposals[0], endMs: Infinity }] }, 'INVALID_ALIGNMENT_RECEIPT'],
    [{ proposals: [receipt.proposals[0], receipt.proposals[0]] }, 'INVALID_ALIGNMENT_RECEIPT'],
  ]) {
    const result = await h.dispatch({ ...message, receipt: { ...receipt, ...patch } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
  assert.equal(recordFor(h).review.length, 0);
});

test('an offset edit invalidates pending native evidence instead of rebinding stale anchors', async () => {
  const h = makeHarness(), score = await h.ensure(), receipt = nativeReceipt(score);
  await h.dispatch({ type: 'LV_NATIVE_ALIGNMENT_IMPORT', tabId: 1, mediaKey: receipt.mediaKey, expectedRevision: score.revision, receipt });
  const changed = await h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setOffset', offsetMs: 1000 }, expectedRevision: score.revision });
  assert.equal(changed.ok, true);
  assert.equal(changed.review.length, 0);
  assert.equal(firstWord(changed.score).startMs, firstWord(score).startMs);
  const stale = await h.dispatch({ type: 'LV_NATIVE_ALIGNMENT_IMPORT', tabId: 1, mediaKey: receipt.mediaKey, expectedRevision: changed.score.revision, receipt });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
});

test('host persists separate exact-video scores even when lookup metadata matches', async () => {
  const h = makeHarness();
  await h.ensure(1, ID_A);
  await h.ensure(2, ID_B);
  assert.ok(recordFor(h, ID_A));
  assert.ok(recordFor(h, ID_B));
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lvScore:')).length, 2);
  assert.equal(recordFor(h, ID_A).score.source.videoId, ID_A);
  assert.equal(recordFor(h, ID_B).score.source.videoId, ID_B);
  assert.equal(recordFor(h, ID_A).score.lyrics.contentHash, recordFor(h, ID_B).score.lyrics.contentHash);
});

test('host rejects an imported score whose exact video differs from the active tab', async () => {
  const h = makeHarness();
  const scoreA = await h.ensure(1, ID_A);
  const scoreB = await h.ensure(2, ID_B);
  const response = await h.dispatch({ type: 'LV_SCORE_IMPORT', tabId: 1, mediaKey: `youtube:${ID_A}`, score: scoreB, expectedRevision: 0 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SOURCE_MISMATCH');
  assert.equal(recordFor(h, ID_A).score?.source?.videoId, scoreA.source.videoId);
  assert.equal(recordFor(h, ID_A).score.revision, 0);
});

test('same-revision concurrent writes serialize so only one commits', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const [one, two] = await Promise.all([
    h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordText', wordId: word.id, text: 'first' }, expectedRevision: 0 }),
    h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordText', wordId: word.id, text: 'second' }, expectedRevision: 0 }),
  ]);
  assert.equal([one, two].filter(x => x.ok).length, 1);
  assert.equal([one, two].filter(x => !x.ok && x.error.code === 'REVISION_CONFLICT').length, 1);
  assert.equal(recordFor(h).score.revision, 1);
  assert.ok(['first', 'second'].includes(firstWord(recordFor(h).score).text));
});

test('manual word locks survive alignment proposals and explicit review', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const timing = { startMs: word.startMs + 100, endMs: word.startMs + 300 };
  const manual = await h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordTiming', wordId: word.id, ...timing }, expectedRevision: 0 });
  assert.equal(manual.ok, true);
  const aligned = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 1,
    diagnostics: { validatedForSinging: true },
    proposals: [{ wordId: word.id, startMs: word.startMs, endMs: word.endMs, accepted: true, evidenceId: 'audio-1', confidence: 0.999 }],
  });
  assert.equal(aligned.ok, true);
  const lockedWord = firstWord(aligned.score);
  assert.equal(lockedWord.locked, true);
  assert.deepEqual([lockedWord.startMs, lockedWord.endMs], [timing.startMs, timing.endMs]);
  const reviewed = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', wordIds: [word.id], expectedRevision: aligned.score.revision });
  assert.equal(reviewed.ok, true);
  assert.deepEqual([firstWord(reviewed.score).startMs, firstWord(reviewed.score).endMs], [timing.startMs, timing.endMs]);
});

test('sender confidence and validation flags cannot enable automatic admission', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const result = await h.dispatch({ type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: score.revision,
    diagnostics: { validatedForSinging: true },
    proposals: [{ wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs + 100, accepted: true, evidenceId: 'untrusted-flag', confidence: 1 }] });
  assert.equal(result.ok, true);
  assert.equal(firstWord(result.score).startMs, word.startMs);
  assert.equal(result.review[0].accepted, false);
  const reviewed = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', wordIds: [word.id], expectedRevision: result.score.revision });
  assert.equal(reviewed.ok, true);
  assert.equal(firstWord(reviewed.score).startMs, word.startMs + 100);
});

test('undo restores prior timing and advances revision monotonically', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const original = [word.startMs, word.endMs];
  const edited = await h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs + 100 }, expectedRevision: 0 });
  assert.equal(edited.score.revision, 1);
  const undone = await h.dispatch({ type: 'LV_SCORE_UNDO', expectedRevision: 1 });
  assert.equal(undone.ok, true);
  assert.equal(undone.score.revision, 2);
  assert.deepEqual([firstWord(undone.score).startMs, firstWord(undone.score).endMs], original);
});

test('uncertain proposals are returned for review and do not alter word timing', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const original = [word.startMs, word.endMs];
  const result = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0,
    diagnostics: { validatedForSinging: false },
    proposals: [{ wordId: word.id, startMs: word.startMs + 200, endMs: word.endMs + 200, accepted: true, evidenceId: 'uncertain-audio', confidence: 0.7 }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual([firstWord(result.score).startMs, firstWord(result.score).endMs], original);
  assert.equal(result.review.length, 1);
  assert.equal(result.review[0].accepted, false);
  assert.equal(recordFor(h).review.length, 1);
  assert.equal(result.score.revision, score.revision);
  assert.equal(recordFor(h).history.length, 0);
});

test('host rejects score requests while an advertisement is active or the media is unready', async () => {
  const h = makeHarness();
  await h.ensure();
  h.tabs.get(1).isAd = true;
  let response = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ADVERTISEMENT_ACTIVE');
  h.tabs.get(1).isAd = false;
  h.tabs.get(1).mediaReady = false;
  response = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SOURCE_UNREADY');
});

test('analysis review and empty windows preserve the real edit as the next undo', async () => {
  const h = makeHarness(), initial = await h.ensure(), word = firstWord(initial);
  const manual = await h.dispatch({ type: 'LV_SCORE_OPERATION', expectedRevision: 0,
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 50, endMs: word.endMs + 50 } });
  for (const proposals of [[], [{ wordId: word.id, startMs: word.startMs, endMs: word.endMs,
    accepted: true, confidence: 1, evidenceId: 'review-only' }]]) {
    const queued = await h.dispatch({ type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: manual.score.revision, proposals });
    assert.equal(queued.ok, true);
    assert.equal(queued.score.revision, manual.score.revision);
    assert.equal(recordFor(h).history.length, 1);
  }
  const undone = await h.dispatch({ type: 'LV_SCORE_UNDO', expectedRevision: manual.score.revision });
  assert.equal(undone.ok, true);
  assert.equal(firstWord(undone.score).startMs, word.startMs);
  assert.equal(recordFor(h).history.length, 0);
  const again = await h.dispatch({ type: 'LV_SCORE_UNDO', expectedRevision: undone.score.revision });
  assert.equal(again.error.code, 'UNDO_EMPTY');
});

test('cached score refreshes duration while retaining valid source title and artist', async () => {
  const h = makeHarness();
  const initial = await h.ensure();
  h.tabs.get(1).duration = 25;
  const refreshed = await h.ensure(1, ID_A, { track: { title: 'Transient title', artist: 'Transient artist' } });
  assert.equal(refreshed.revision, initial.revision + 1);
  assert.equal(refreshed.source.durationMs, 25000);
  assert.equal(refreshed.source.title, initial.source.title);
  assert.equal(refreshed.source.artist, initial.source.artist);
  assert.equal(recordFor(h).history.length, 1);
});

test('host rejects a same-video import bound to a different lyric hash', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const otherLyrics = '[00:01.00]different text\n[00:03.00]';
  const otherHash = await h.context.LvScoreHost.digest(otherLyrics);
  const wrongRevision = scoreCore.createScore(
    { platform: 'youtube', videoId: ID_A, title: current.source.title, artist: current.source.artist, durationMs: current.source.durationMs },
    otherLyrics,
    { provider: 'test', entryId: 'other', contentHash: otherHash },
  );
  const response = await h.dispatch({ type: 'LV_SCORE_IMPORT', mediaKey: `youtube:${ID_A}`, score: wrongRevision, expectedRevision: 0 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'LYRIC_REVISION_MISMATCH');
  assert.equal(recordFor(h).score.revision, 0);
  assert.equal(recordFor(h).score.lyrics.contentHash, current.lyrics.contentHash);
});

test('review keeps pending proposals from earlier windows and replaces each word with its latest evidence', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const [first, second] = current.phrases[0].words;
  const firstWindow = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0,
    diagnostics: { validatedForSinging: false, window: 1 },
    proposals: [
      { wordId: first.id, startMs: first.startMs + 10, endMs: first.endMs, accepted: false, evidenceId: 'window-1-a', confidence: 0.55 },
      { wordId: second.id, startMs: second.startMs + 10, endMs: second.endMs, accepted: false, evidenceId: 'window-1-b', confidence: 0.4 },
    ],
  });
  assert.equal(firstWindow.ok, true);
  const secondWindow = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0,
    diagnostics: { validatedForSinging: false, window: 2 },
    proposals: [{ wordId: first.id, startMs: first.startMs + 20, endMs: first.endMs, accepted: false, evidenceId: 'window-2-a', confidence: 0.8 }],
  });
  assert.equal(secondWindow.ok, true);
  assert.equal(secondWindow.review.length, 2);
  assert.deepEqual([...secondWindow.review].map(p => p.wordId).sort(), [first.id, second.id].sort());
  const latestFirst = secondWindow.review.find(p => p.wordId === first.id);
  assert.equal(latestFirst.evidenceId, 'window-2-a');
  assert.equal(latestFirst.confidence, 0.8);
  assert.equal(secondWindow.score.revision, 0);
  assert.equal(recordFor(h).history.length, 0);
  const inspected = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(inspected.diagnostics.window, 2);
  const edited = await h.dispatch({ type: 'LV_SCORE_OPERATION', mediaKey: `youtube:${ID_A}`, expectedRevision: 0, operation: { type: 'setOffset', offsetMs: 50 } });
  assert.equal(edited.ok, true);
  const refreshed = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(refreshed.diagnostics, null);
});

test('host review application preserves a syllable-locked word despite a late proposal', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const word = firstWord(current);
  const segmented = scoreCore.applyOperation(current, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'host-locked-syllable', text: word.text, startMs: word.startMs, endMs: word.endMs },
  ] }, current.revision);
  const imported = await h.dispatch({ type: 'LV_SCORE_IMPORT', mediaKey: `youtube:${ID_A}`, score: segmented, expectedRevision: 0 });
  assert.equal(imported.ok, true);
  const before = imported.score.phrases[0].words[0];
  const evidence = { wordId: word.id, startMs: 5000, endMs: 5300, accepted: true, evidenceId: 'late-evidence', confidence: 0.7 };
  const reviewed = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 1,
    diagnostics: { validatedForSinging: false }, proposals: [evidence],
  });
  assert.equal(reviewed.ok, true);
  const forgedApply = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', tabId: 1, expectedRevision: 1, wordIds: [word.id] }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL('analysis/offscreen.html'),
  });
  assert.equal(forgedApply.ok, false);
  assert.equal(forgedApply.error.code, 'EDITOR_REQUIRED');
  assert.equal(recordFor(h).score.revision, 1);
  const wrongEditor = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', tabId: 1, expectedRevision: 1, wordIds: [word.id] }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL(`editor.html?sourceTab=2&mediaKey=${encodeURIComponent(`youtube:${ID_A}`)}`),
  });
  assert.equal(wrongEditor.ok, false);
  assert.equal(wrongEditor.error.code, 'EDITOR_REQUIRED');
  const applied = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', expectedRevision: 1, wordIds: [word.id] });
  assert.equal(applied.ok, true);
  const after = applied.score.phrases[0].words[0];
  assert.deepEqual([after.startMs, after.endMs], [before.startMs, before.endMs]);
  assert.deepEqual(JSON.parse(JSON.stringify(after.syllables)), JSON.parse(JSON.stringify(before.syllables)));
  assert.equal(applied.review.length, 0);
});

test('proposal ingress requires the exact offscreen page and the active matching session', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const word = firstWord(current);
  const proposal = { wordId: word.id, startMs: word.startMs, endMs: word.endMs, accepted: false, evidenceId: 'evidence', confidence: 0.5 };
  const base = { type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0, proposals: [proposal] };
  const offscreenUrl = h.context.chrome.runtime.getURL('analysis/offscreen.html');

  let response = await h.dispatch({ ...base, sessionId: 'session-1' }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL(`editor.html?sourceTab=1&mediaKey=youtube%3A${ID_A}`),
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).review.length, 0);

  response = await h.dispatch({ ...base, sessionId: 'stale-session' }, { id: 'test-extension', url: offscreenUrl });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).score.revision, 0);

  h.setAnalysisStatus({ state: 'stopped', tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1' });
  response = await h.dispatch({ ...base, sessionId: 'session-1' }, { id: 'test-extension', url: offscreenUrl });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).review.length, 0);
});

test('an unsaved preview survives a browser restart and resumes in a different tab', async () => {
  const h=makeHarness(), score=await h.ensure();
  h.context.recognize=async()=>({ok:true,lyrics:{synced:'[00:05.00]hello world\n[00:07.00]'},match:{id:2}});
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const first={id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`};
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,fromSaved:true},first);
  const word=score.phrases[0].words[0];
  await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:0,changes:[{wordId:word.id,startMs:word.startMs+40,endMs:word.endMs+40}]},first);
  // Browser restart: session storage and the worker are gone, and the video reopens as tab 3.
  for (const key of Object.keys(h.sessionValues)) delete h.sessionValues[key];
  h.restartWorker();
  h.tabs.set(3,{...h.tabs.get(1)});
  const current=await h.dispatch({type:'LV_TIMING_CURRENT',...envelope},{id:'test-extension',tab:{id:3},url:`https://www.youtube.com/watch?v=${ID_A}`});
  assert.equal(current.ok,true);
  assert.equal(current.preview.previewRevision,1);
  assert.equal(current.preview.score.phrases[0].words[0].startMs,word.startMs+40);
});

test('a legacy tab-scoped session preview migrates to durable storage on first read', async () => {
  const h=makeHarness(), score=await h.ensure();
  const legacy={score:structuredClone(score),token:'legacy-token',previewRevision:4,undoScores:[],baseRevision:score.revision,baseHash:score.lyrics.contentHash,protectedIds:[],preservedPhraseIds:[]};
  h.sessionValues[`lvTimingPreview:7:youtube:${ID_A}`]=legacy;
  const envelope={mediaKey:`youtube:${ID_A}`,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
  const current=await h.dispatch({type:'LV_TIMING_CURRENT',...envelope},{id:'test-extension',tab:{id:1},url:`https://www.youtube.com/watch?v=${ID_A}`});
  assert.equal(current.preview.token,'legacy-token');
  assert.ok(h.values[`lvTimingPreview:youtube:${ID_A}`]);
  assert.equal(h.sessionValues[`lvTimingPreview:7:youtube:${ID_A}`],undefined);
});

test('same-document YouTube navigation can prepare and open the current video, but another frame or stale source cannot', async()=>{
 const h=makeHarness();await h.ensure();h.tabs.get(1).url='https://www.youtube.com/watch?v='+ID_B;const score=await h.ensure(1,ID_B);
 const sender={id:'test-extension',frameId:0,url:'https://www.youtube.com/watch?v='+ID_A,tab:{id:1,url:h.tabs.get(1).url}},envelope={tabId:1,mediaKey:'youtube:'+ID_B,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
 const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,fromSaved:true},sender);assert.equal(prepared.ok,true);assert.equal(prepared.preview.score.source.videoId,ID_B);
 assert.equal((await h.dispatch({type:'LV_LIGHT_EDITOR_OPEN',...envelope},sender)).ok,true);assert.equal(h.popupWindows.length,1);
 assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...envelope},{...sender,frameId:2})).error.code,'SOURCE_REQUIRED');
 assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...envelope,mediaKey:'youtube:'+ID_A},sender)).error.code,'SOURCE_CHANGED');
 assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...envelope},{...sender,url:'https://unrelated.example/'})).error.code,'SOURCE_REQUIRED');
});


test('explicit saved-sync copy is preview-only, source-bound, revision-checked and undoable across different lyric hashes',async()=>{
  const h=makeHarness(),base=await h.ensure(),source=await h.ensure(2,ID_B,{lyrics:{synced:'[00:02.00]different saved words\n[00:07.00]',provider:'saved'}});
  const sender={id:'test-extension',url:'chrome-extension://test/light-editor.html?sourceTab=1&mediaKey='+encodeURIComponent('youtube:'+ID_A)};
  const envelope={tabId:1,mediaKey:'youtube:'+ID_A,expectedRevision:base.revision,lyricsHash:base.lyrics.contentHash};
  const original=JSON.stringify(recordFor(h)),sourceBefore=JSON.stringify(recordFor(h,ID_B));
  const listed=await h.dispatch({type:'LV_TIMING_SOURCES',...envelope},sender);assert.equal(listed.ok,true);assert.equal(listed.sources.length,1);assert.equal(listed.sources[0].mediaKey,'youtube:'+ID_B);assert.equal(listed.sources[0].score,undefined);
  const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...envelope,fromSaved:true},sender);
  const copy={type:'LV_TIMING_COPY',...envelope,token:prepared.preview.token,previewRevision:0,sourceMediaKey:'youtube:'+ID_B,sourceRevision:source.revision,sourceLyricsHash:source.lyrics.contentHash,deltaMs:2200};
  assert.equal((await h.dispatch(copy,{id:'test-extension',url:'https://unrelated.example/'})).error.code,'SOURCE_REQUIRED');
  h.setCopyBlocked(true);assert.equal((await h.dispatch(copy,sender)).error.code,'CAPTURE_PENDING');h.setCopyBlocked(false);
  assert.equal((await h.dispatch({...copy,sourceRevision:999},sender)).error.code,'COPY_SOURCE_CHANGED');
  const copied=await h.dispatch(copy,sender);assert.equal(copied.ok,true);assert.equal(copied.preview.score.source.videoId,ID_A);assert.equal(copied.preview.score.offsetMs,2200);assert.equal(copied.preview.score.lyrics.contentHash,source.lyrics.contentHash);
  assert.equal(JSON.stringify(recordFor(h)),original);assert.equal(JSON.stringify(recordFor(h,ID_B)),sourceBefore);
  assert.equal((await h.dispatch(copy,sender)).error.code,'PREVIEW_CONFLICT');
  const undone=await h.dispatch({type:'LV_TIMING_UNDO',...envelope,token:prepared.preview.token,previewRevision:1},sender);assert.equal(undone.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(undone.preview.score)),JSON.parse(JSON.stringify(prepared.preview.score)));
  const again=await h.dispatch({...copy,previewRevision:2},sender);assert.equal(again.ok,true);
  const moved=await h.dispatch({type:'LV_TIMING_TUNE',...envelope,token:prepared.preview.token,previewRevision:3,allowProtected:true,operation:{type:'shiftPhrases',phraseIds:[source.phrases[0].id],deltaMs:400}},sender);assert.equal(moved.ok,true);assert.equal(moved.preview.previewRevision,4);
  const applied=await h.dispatch({type:'LV_TIMING_APPLY',...envelope,token:prepared.preview.token,previewRevision:4},sender);assert.equal(applied.ok,true);assert.equal(applied.score.source.videoId,ID_A);assert.equal(applied.score.phrases[0].startMs,source.phrases[0].startMs+400);assert.equal(JSON.stringify(recordFor(h,ID_B)),sourceBefore);
  const restored=await h.dispatch({type:'LV_SCORE_UNDO',...envelope,expectedRevision:applied.score.revision},sender);assert.equal(restored.ok,true);assert.equal(restored.score.lyrics.contentHash,base.lyrics.contentHash);
});

test('a separate editor cannot tune, undo, save or close a preview during capture or pending transcript input',async()=>{
 const h=makeHarness(),score=await h.ensure(),sender={id:'test-extension',url:'chrome-extension://test/light-editor.html?sourceTab=1&mediaKey='+encodeURIComponent('youtube:'+ID_A)};
 const base={tabId:1,mediaKey:'youtube:'+ID_A,expectedRevision:score.revision,lyricsHash:score.lyrics.contentHash};
 const prepared=await h.dispatch({type:'LV_TIMING_PREPARE',...base,fromSaved:true},sender);assert.equal(prepared.ok,true);
 const envelope={...base,token:prepared.preview.token,previewRevision:0},before=JSON.stringify(h.values);
 h.setCopyBlocked(true);
 for(const type of ['LV_TIMING_TUNE','LV_TIMING_UNDO','LV_TIMING_APPLY','LV_TIMING_CANCEL'])assert.equal((await h.dispatch({type,...envelope,operation:{type:'setOffset',offsetMs:100}},sender)).error.code,'CAPTURE_PENDING');
 assert.equal(JSON.stringify(h.values),before);
 assert.equal((await h.dispatch({type:'LV_TIMING_CURRENT',...base},sender)).ok,true);
 h.setCopyBlocked(false);
 assert.equal((await h.dispatch({type:'LV_TIMING_TUNE',...envelope,operation:{type:'setOffset',offsetMs:100}},sender)).ok,true);
});
