const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const scoreCore = require('../extension/score-core.js');

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}

test('whole-song start accepts a paused source at a nonstandard speed and requests managed capture', async () => {
  const onMessage=event(), onConnect=event(); let startedConfig, open=false;
  const score=scoreCore.createScore({videoId:'FIXTURE0001',durationMs:30000},'[00:20]wake me up',{contentHash:'a'.repeat(64)});
  const chrome={runtime:{id:'fixture-extension',getURL:file=>`chrome-extension://fixture-extension/${file}`,onMessage,onConnect,getContexts:async()=>open?[{}]:[],sendMessage:async message=>{if(message.type==='LV_ANALYSIS_OFFSCREEN_START'){startedConfig=message.config;return {analysis:{state:'starting'}};}return {};}},offscreen:{createDocument:async()=>{open=true},closeDocument:async()=>{open=false}},tabs:{sendMessage:async()=>({mediaKey:'youtube:FIXTURE0001',paused:true,seeking:false,playbackRate:.5})},tabCapture:{getMediaStreamId:async()=> 'test-stream'}};
  const sandbox={chrome,LvScore:scoreCore,crypto:require('node:crypto').webcrypto};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/analysis/controller.js'),'utf8'),sandbox);
  await sandbox.LvAnalysis.startAnalysis({tabId:7,score,engine:'native',wholeSong:true});
  assert.equal(startedConfig.wholeSong,true);assert.equal(startedConfig.engine,'native');
});

test('source-scoped Stop preserves another tab analysis and closes the matching source', async () => {
  const onMessage = event();
  const active = { state: 'capturing', engine: 'native', tabId: 9, mediaKey: 'youtube:source', sessionId: 'session-a' };
  let stops = 0, closes = 0;
  const chrome = { runtime: { id: 'fixture-extension', getURL: file => `chrome-extension://fixture-extension/${file}`, onMessage, onConnect: event(), getContexts: async () => [{}], sendMessage: async message => { if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATUS') return { analysis: active }; if (message.type === 'LV_ANALYSIS_OFFSCREEN_STOP') stops++; } }, offscreen: { closeDocument: async () => { closes++; } } };
  const sandbox = { chrome, crypto: require('node:crypto').webcrypto };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/analysis/controller.js'), 'utf8'), sandbox);
  await assert.rejects(sandbox.LvAnalysis.stopAnalysis({ tabId: 10, mediaKey: 'youtube:source' }), { code: 'ANALYSIS_SOURCE_MISMATCH' });
  assert.equal(stops, 0); assert.equal(closes, 0);
  await sandbox.LvAnalysis.stopAnalysis({ tabId: 9, mediaKey: 'youtube:source' });
  assert.equal(stops, 1); assert.equal(closes, 1);
});

test('whole-song status reaches only its source tab with deduplicated bounded progress', async () => {
  const onMessage=event(),sent=[];
  const chrome={runtime:{id:'fixture-extension',getURL:file=>`chrome-extension://fixture-extension/${file}`,onMessage,onConnect:event(),getContexts:async()=>[]},tabs:{sendMessage:async(tabId,message)=>{sent.push({tabId,message});return {ok:true}}}};
  const sandbox={chrome,crypto:require('node:crypto').webcrypto};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/analysis/controller.js'),'utf8'),sandbox);
  const sender={id:'fixture-extension',url:'chrome-extension://fixture-extension/analysis/offscreen.html'};
  const analysis={state:'capturing',wholeSong:true,tabId:7,mediaKey:'youtube:FIXTURE0001',songPass:{phase:'capturing',capturedMs:1234,durationMs:30000,proposals:0},lyricsHash:'private',sessionId:'private'};
  onMessage.emit({type:'LV_ANALYSIS_OFFSCREEN_STATE',analysis},sender,()=>{});onMessage.emit({type:'LV_ANALYSIS_OFFSCREEN_STATE',analysis},sender,()=>{});
  assert.equal(sent.length,1);assert.equal(sent[0].tabId,7);assert.equal(sent[0].message.analysis.capturedMs,1000);assert.equal(sent[0].message.analysis.lyricsHash,undefined);assert.equal(sent[0].message.analysis.sessionId,undefined);
  onMessage.emit({type:'LV_ANALYSIS_OFFSCREEN_STATE',analysis:{...analysis,state:'error',error:{message:'Capture stopped.'}}},sender,()=>{});
  assert.equal(sent.length,2);assert.equal(sent[1].message.analysis.error,'Capture stopped.');
  onMessage.emit({type:'LV_ANALYSIS_OFFSCREEN_STATE',analysis:{...analysis,tabId:8}}, {id:'foreign',url:sender.url},()=>{});assert.equal(sent.length,2);
});

test('service worker native bridge binds the exact offscreen session and rejects stale or foreign source frames', () => {
  const onMessage = event(), onConnect = event(), hostMessages = event(), hostDisconnect = event();
  let connectName, bridgePort, hostPort;
  const chrome = { runtime: {
    id: 'fixture-extension', getURL: file => `chrome-extension://fixture-extension/${file}`,
    onMessage, onConnect,
    connectNative: name => {
      connectName = name;
      hostPort = { onMessage: hostMessages, onDisconnect: hostDisconnect, posts: [], postMessage(message) { this.posts.push(message); }, disconnect() { this.disconnected = true; hostDisconnect.emit(); } };
      return hostPort;
    },
    getContexts: async () => [], sendMessage: async () => {},
  }, offscreen: { createDocument: async () => {}, closeDocument: async () => {} } };
  const sandbox = { chrome, crypto: require('node:crypto').webcrypto, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/analysis/controller.js'), 'utf8'), sandbox);
  const sender = { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/analysis/offscreen.html' };
  onMessage.emit({ type: 'LV_ANALYSIS_OFFSCREEN_STATE', analysis: { state: 'connecting-native', engine: 'native', tabId: 9, mediaKey: 'youtube:FIXTURE0001', sessionId: 'session-a', lyricsHash: 'a'.repeat(64), expectedRevision: 3 } }, sender, () => {});
  const port = { name: 'lv-native-bridge', sender, onMessage: event(), onDisconnect: event(), posts: [], disconnected: false, postMessage(message) { this.posts.push(message); }, disconnect() { this.disconnected = true; } };
  bridgePort = port;
  onConnect.emit(port);
  port.onMessage.emit({ type: 'LV_NATIVE_BRIDGE_BIND', sessionId: 'session-a', tabId: 9, mediaKey: 'youtube:FIXTURE0001' });
  assert.equal(connectName, 'com.lyricvibe.native_audio');
  const hello = { version: 'lyricvibe.native-live.v1', type: 'hello' };
  port.onMessage.emit(hello);
  assert.deepEqual(hostPort.posts, [hello]);
  const reply = { version: hello.version, type: 'hello', hostName: 'com.lyricvibe.native_audio' };
  hostMessages.emit(reply);
  assert.deepEqual(port.posts, [reply]);
  port.onMessage.emit({ version: hello.version, type: 'analyze', sessionId: 'session-a', source: { tabId: 9, mediaKey: 'youtube:FIXTURE0001', lyricsHash: 'a'.repeat(64), expectedRevision: 2, captureEpoch: 4 } });
  assert.equal(port.disconnected, true);
  assert.equal(hostPort.posts.length, 1);

  const foreign = { ...port, name: 'lv-native-bridge', sender: { id: 'other-extension', url: sender.url }, disconnected: false };
  onConnect.emit(foreign);
  assert.equal(foreign.disconnected, true);
});

test('stopping during autoplay guard setup restores the original setting after setup resolves', async () => {
  const onMessage=event(), onConnect=event(), sent=[]; let resolveGuard;
  const chrome={runtime:{id:'fixture-extension',getURL:file=>`chrome-extension://fixture-extension/${file}`,onMessage,onConnect,getContexts:async()=>[],sendMessage:async()=>({})},tabs:{sendMessage:async(tabId,message)=>{sent.push(message.action);if(message.action==='start')return new Promise(resolve=>{resolveGuard=resolve});return {ok:true}}},offscreen:{closeDocument:async()=>{}}};
  const sandbox={chrome,crypto:require('node:crypto').webcrypto};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/analysis/controller.js'),'utf8'),sandbox);
  const sender={id:'fixture-extension',url:'chrome-extension://fixture-extension/analysis/offscreen.html'};
  onMessage.emit({type:'LV_ANALYSIS_OFFSCREEN_STATE',analysis:{sessionId:'pass',tabId:3,mediaKey:'youtube:FIXTURE0001',engine:'native',wholeSong:true}},sender,()=>{});
  const response=new Promise(resolve=>onMessage.emit({type:'LV_ANALYSIS_CONTROL_REQUEST',sessionId:'pass',tabId:3,action:'guard-start'},sender,resolve));
  await sandbox.LvAnalysis.stopAnalysis();resolveGuard({ok:true});await response;
  assert.deepEqual(sent.filter(Boolean),['start','release']);
});
