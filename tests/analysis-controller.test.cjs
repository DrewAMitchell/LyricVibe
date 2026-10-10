const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}

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
