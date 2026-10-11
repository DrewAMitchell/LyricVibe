const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto').webcrypto;
const scoreCore = require('../extension/score-core.js');
const anchors = require('../extension/analysis/anchors.js');
const native = require('../extension/analysis/native-live.js');

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => { for (const fn of listeners) fn(value); } };
}

function setup() {
  const outgoing = [], intervals = new Set();
  const clock = { mediaKey: 'youtube:FIXTURE0001', currentTimeMs: 10250, paused: false, seeking: false, playbackRate: 1 };
  let listener, port, worklet, context, workerCreated = false, stopped = 0;
  class AudioContext {
    constructor() { context = this; this.currentTime = 0; this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  class AudioWorkletNode {
    constructor() { worklet = this; this.port = { close() {}, postMessage() {} }; }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class Worker { constructor() { workerCreated = true; } }
  const sandbox = {
    LvScore: scoreCore, LvAnchors: anchors, LvNativeLive: native, AudioContext, AudioWorkletNode, Worker, Float32Array, Date, crypto, btoa,
    performance: { now: () => 0 }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++, addEventListener() {} }] }) } },
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn), setTimeout, clearTimeout,
    chrome: { runtime: {
      id: 'fixture-extension', getURL: file => `chrome-extension://fixture-extension/${file}`,
      sendMessage: async message => { if (message.type === 'LV_ANALYSIS_CLOCK_REQUEST') return { ...clock }; outgoing.push(message); if (message.type === 'LV_ALIGNMENT_PROPOSALS') return { ok: true, score: { ...scoreValue } }; },
      connect: () => {
        const onMessage = event(), onDisconnect = event();
        port = { onMessage, onDisconnect, posts: [], postMessage(message) { this.posts.push(message); if (message.type === 'hello') setImmediate(() => onMessage.emit({ version: native.VERSION, type: 'hello', hostName: native.HOST_NAME, hostVersion: 'fixture-1', state: 'ready', modelReady: true, alignmentReady: true, limits: { maxAudioMs: 12000, sampleRateHz: 16000, channels: 1, encoding: 'pcm_s16le', maxPcmBytes: 384000 } })); else if (message.type === 'analyze') setImmediate(() => onMessage.emit({ version: native.VERSION, type: 'status', state: 'accepted', requestId: message.requestId, sessionId: message.sessionId, source: { ...message.source }, audio: { audioStartMs: message.audio.audioStartMs, sha256: message.audio.sha256 } })); }, disconnect() { this.disconnected = true; onDisconnect.emit(); } };
        return port;
      },
      onMessage: { addListener: fn => { listener = fn; } },
    } },
  };
  const scoreValue = scoreCore.createScore({ videoId: 'FIXTURE0001', durationMs: 30000 }, '[00:20]wake me up', { contentHash: 'a'.repeat(64) });
  scoreValue.revision = 4; scoreValue.offsetMs = 250;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/analysis/offscreen.js'), 'utf8'), sandbox);
  const sender = { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/service-worker.js' };
  const request = message => new Promise(resolve => listener({ target: 'lv-offscreen', ...message }, sender, resolve));
  return { request, clock, outgoing, intervals, score: scoreValue, emitPcm: (pcm, startFrame) => worklet.port.onmessage({ data: { pcm, startFrame, sampleRate: 16000 } }), get worklet() { return worklet; }, get port() { return port; }, get context() { return context; }, get workerCreated() { return workerCreated; }, get stopped() { return stopped; } };
}

test('native offscreen runs without browser worker fallback, submits bounded audio, and creates review-only source-time proposals', async () => {
  const h = setup();
  const started = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  assert.equal(started.analysis.state, 'capturing', JSON.stringify(started));
  assert.equal(h.workerCreated, false);
  assert.equal(typeof h.worklet.port.onmessage, 'function');
  const first = new Float32Array(4096).fill(0.25);
  h.emitPcm(first, 16000);
  assert.equal(first.every(value => value === 0), true);
  assert.equal((await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.bufferedSeconds, 4096 / 16000);
  const pcm = new Float32Array(192000 - 4096).fill(0.25);
  h.emitPcm(pcm, 20096);
  await new Promise(resolve => setTimeout(resolve, 100));
  const analyze = h.port.posts.find(message => message.type === 'analyze');
  if (!analyze) { const state = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' }); assert.ok(analyze, `${JSON.stringify(h.port.posts)} ${JSON.stringify(state.analysis)}`); }
  assert.equal(analyze.audio.durationMs, 12000);
  assert.equal(analyze.audio.sampleRateHz, 16000);
  assert.equal(analyze.audio.channels, 1);
  assert.equal(analyze.audio.pcmBase64, ''); // Cleared immediately after native port accepted its copy.
  assert.equal(analyze.expectedWords.length, 3);
  h.port.onMessage.emit({ version: native.VERSION, type: 'result', requestId: analyze.requestId, sessionId: analyze.sessionId, source: { ...analyze.source }, audio: { audioStartMs: analyze.audio.audioStartMs, sha256: analyze.audio.sha256 }, accepted: false, alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture-model', modelRevision: 'r1', words: [{ wordId: analyze.expectedWords[0].wordId, startMs: 9000, endMs: 9300 }], warnings: [] });
  await new Promise(resolve => setImmediate(resolve));
  const proposals = h.outgoing.find(message => message.type === 'LV_ALIGNMENT_PROPOSALS');
  assert.equal(proposals.expectedRevision, 4);
  assert.equal(proposals.proposals[0].startMs, 20000);
  assert.equal(proposals.proposals[0].accepted, false);
  assert.equal(proposals.diagnostics.automaticAdmissionEnabled, false);
  const response = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' });
  assert.equal(response.analysis.engine, 'native');
  assert.equal(response.analysis.state, 'capturing');
  assert.equal(response.analysis.expectedRevision, 4);
  assert.equal(response.analysis.model, null);
  assert.deepEqual(JSON.parse(JSON.stringify(response.analysis.lastWindow)), { windowNumber: 1, captureEpoch: analyze.source.captureEpoch, expectedWordCount: 3, nativeWordCount: 1, proposalCount: 1, stage: 'result', resultReason: null, nativeReasonCode: null, capturedAudioStartMs: 11250, submittedAudioStartMs: 11250, resultAudioStartMs: 11250, nonZeroSampleCount: 192000, rms: 0.25 });
  assert.equal(h.port.posts[0].type, 'LV_NATIVE_BRIDGE_BIND');
  assert.equal(h.port.posts[1].type, 'hello');
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('native pause cancels the exact request and discards its late result', async () => {
  const h = setup();
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  h.emitPcm(new Float32Array(192000), 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const analyze = h.port.posts.find(message => message.type === 'analyze');
  assert.ok(analyze);
  h.clock.paused = true;
  h.port.onMessage.emit({ version: native.VERSION, type: 'result', requestId: analyze.requestId, sessionId: analyze.sessionId, source: { ...analyze.source }, audio: { audioStartMs: analyze.audio.audioStartMs, sha256: analyze.audio.sha256 }, accepted: false, alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture-model', modelRevision: 'r1', words: [{ wordId: analyze.expectedWords[0].wordId, startMs: 100, endMs: 300 }], warnings: [] });
  await new Promise(resolve => setImmediate(resolve));
  const cancel = h.port.posts.find(message => message.type === 'cancel');
  assert.equal(cancel.requestId, analyze.requestId);
  assert.equal(cancel.source.captureEpoch, analyze.source.captureEpoch);
  assert.equal(h.outgoing.filter(message => message.type === 'LV_ALIGNMENT_PROPOSALS').length, 0);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('a completed review-only result permits the next native window at the same score revision', async () => {
  const h = setup();
  h.score.source.durationMs = 50000;
  const later = scoreCore.createScore({ videoId: 'FIXTURE0001', durationMs: 50000 }, '[00:35]shine on', { contentHash: h.score.lyrics.contentHash }).phrases[0];
  later.id = 'later-phrase';
  later.words.forEach((word, i) => { word.id = `later-word-${i}`; });
  h.score.phrases.push(later);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  try {
    h.emitPcm(new Float32Array(192000).fill(.1), 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    const first = h.port.posts.find(message => message.type === 'analyze');
    assert.ok(first);
    h.port.onMessage.emit({ version: native.VERSION, type: 'result', requestId: first.requestId, sessionId: first.sessionId, source: { ...first.source }, audio: { audioStartMs: first.audio.audioStartMs, sha256: first.audio.sha256 }, accepted: false, alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture-model', modelRevision: 'r1', words: [{ wordId: first.expectedWords[0].wordId, startMs: 9750, endMs: 10000 }], warnings: [] });
    await new Promise(resolve => setImmediate(resolve));
    h.context.currentTime = 24;
    h.clock.currentTimeMs = 34250;
    await [...h.intervals][0]();
    h.emitPcm(new Float32Array(192000).fill(.1), 384000);
    await new Promise(resolve => setTimeout(resolve, 100));
    const windows = h.port.posts.filter(message => message.type === 'analyze');
    assert.equal(windows.length, 2);
    assert.equal(windows[0].source.expectedRevision, 4);
    assert.equal(windows[1].source.expectedRevision, 4);
    assert.deepEqual(windows[1].expectedWords.map(word => word.text), ['shine', 'on']);
    assert.equal((await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.expectedRevision, 4);
  } finally { await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' }); }
});

test('an actual score edit cancels native work instead of accepting an analysis-owned revision', async () => {
  const h = setup();
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  try {
    h.emitPcm(new Float32Array(192000).fill(.1), 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    const pending = h.port.posts.find(message => message.type === 'analyze');
    assert.ok(pending);
    h.request({ type: 'LV_SCORE_UPDATED', tabId: 7, mediaKey: h.clock.mediaKey,
      score: { ...h.score, revision: 5 }, diagnostics: { sampleWindow: { requestId: pending.requestId } } });
    await new Promise(resolve => setImmediate(resolve));
    const state = (await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis;
    assert.equal(state.state, 'error');
    assert.equal(state.error.code, 'SCORE_REVISION_CHANGED');
    assert.ok(h.port.posts.some(message => message.type === 'cancel' && message.requestId === pending.requestId));
    assert.equal(h.outgoing.filter(message => message.type === 'LV_ALIGNMENT_PROPOSALS').length, 0);
  } finally { await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' }); }
});

test('native capture clears the busy latch after unsupported and empty windows, then submits the next eligible phrase', async () => {
  const h = setup();
  h.score.source.durationMs = 50000;
  h.score.phrases[0].words[0].text = 'wake-me';
  const late = scoreCore.createScore({ videoId: 'FIXTURE0001', durationMs: 50000 }, '[00:35]shine on', { contentHash: h.score.lyrics.contentHash }).phrases[0];
  late.id = 'phrase-late';
  late.laneId = h.score.phrases[0].laneId;
  late.words.forEach((word, index) => { word.id = `late-word-${index + 1}`; });
  h.score.phrases.push(late);
  const started = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  assert.equal(started.analysis.state, 'capturing');
  h.emitPcm(new Float32Array(192000), 0); // Contains the unsupported phrase; must release the busy latch.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.port.posts.filter(message => message.type === 'analyze').length, 0);
  assert.equal((await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.progress.tokenClass, 'unsupported-or-compound-token');
  const unsupportedWindow = (await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.lastWindow;
  assert.equal(unsupportedWindow.windowNumber, 1);
  assert.equal(unsupportedWindow.resultReason, 'skipped');
  assert.equal(unsupportedWindow.expectedWordCount, 0);
  assert.equal(unsupportedWindow.nonZeroSampleCount, 0);

  h.context.currentTime = 12;
  h.clock.currentTimeMs = 22250;
  await [...h.intervals][0]();
  h.emitPcm(new Float32Array(192000), 192000); // No full phrase; must release the latch again.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.port.posts.filter(message => message.type === 'analyze').length, 0);
  const emptyStatus = (await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis;
  assert.equal(emptyStatus.progress.code, 'NO_COMPLETE_LEAD_PHRASE');
  assert.equal(emptyStatus.lastWindow.windowNumber, 2);
  assert.equal(emptyStatus.lastWindow.resultReason, 'noeligible');
  assert.equal(emptyStatus.lastWindow.capturedAudioStartMs, 22250);
  assert.equal(emptyStatus.lastWindow.nonZeroSampleCount, 0);

  h.context.currentTime = 24;
  h.clock.currentTimeMs = 34250;
  await [...h.intervals][0]();
  h.emitPcm(new Float32Array(192000), 384000);
  await new Promise(resolve => setTimeout(resolve, 100));
  const analyze = h.port.posts.find(message => message.type === 'analyze');
  assert.ok(analyze, 'an eligible later phrase is submitted after both skipped-window paths');
  assert.deepEqual(analyze.expectedWords.map(word => word.text), ['shine', 'on']);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('native aligner failures retain the native host as the error destination', async () => {
  const h = setup();
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  h.emitPcm(new Float32Array(192000), 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const analyze = h.port.posts.find(message => message.type === 'analyze');
  assert.ok(analyze);
  h.port.onMessage.emit({ version: native.VERSION, type: 'error', requestId: analyze.requestId, sessionId: analyze.sessionId, source: { ...analyze.source }, error: { code: 'ALIGNMENT_FAILED', message: 'Native supplied-text alignment failed.' } });
  await new Promise(resolve => setImmediate(resolve));
  const status = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' });
  assert.equal(status.analysis.error.code, 'ALIGNMENT_FAILED');
  assert.equal(status.analysis.error.destination, native.HOST_NAME);
  assert.equal(status.analysis.lastWindow.expectedWordCount, 3);
  assert.equal(status.analysis.lastWindow.submittedAudioStartMs, 10250);
});

test('native silent-audio result keeps only its allowlisted reason in bounded window status', async () => {
  const h = setup();
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { engine: 'native', tabId: 7, mediaKey: h.clock.mediaKey, sessionId: 'native-session', score: h.score, streamId: 'synthetic' } });
  h.emitPcm(new Float32Array(192000), 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const analyze = h.port.posts.find(message => message.type === 'analyze');
  assert.ok(analyze);
  h.port.onMessage.emit({ version: native.VERSION, type: 'result', requestId: analyze.requestId, sessionId: analyze.sessionId, source: { ...analyze.source }, audio: { audioStartMs: analyze.audio.audioStartMs, sha256: analyze.audio.sha256 }, accepted: false, alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture-model', modelRevision: 'r1', words: [], warnings: [], reasonCode: 'SILENT_AUDIO' });
  await new Promise(resolve => setImmediate(resolve));
  const status = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' });
  assert.equal(status.analysis.lastWindow.nativeWordCount, 0);
  assert.equal(status.analysis.lastWindow.resultReason, 'emptyaligned');
  assert.equal(status.analysis.lastWindow.nativeReasonCode, 'SILENT_AUDIO');
});
