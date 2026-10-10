const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const anchors = require('../extension/analysis/anchors.js');
const scoreCore = require('../extension/score-core.js');

// Deliberately synthetic browser API doubles. These prove ownership/cleanup,
// not permission grants, audible routing in Chrome, or model quality on songs.
function harness() {
  const outgoing = [], intervals = new Set(), timeouts = new Set(), connections = [];
  const clock = { mediaKey: 'youtube:FIXTURE0001', currentTimeMs: 10000, paused: false, seeking: false, playbackRate: 1 };
  let listener, worker, worklet, context, stopped = 0;
  class AudioContext {
    constructor() { context = this; this.currentTime = 0; this.sampleRate = 16000; this.destination = {}; this.closed = false; this.audioWorklet = { addModule: async () => undefined }; }
    createMediaStreamSource() { return { connect: target => connections.push(target), disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  class AudioWorkletNode {
    constructor() { worklet = this; this.port = { close() {}, postMessage() {} }; }
    connect(target) { connections.push(target); }
    disconnect() { this.disconnected = true; }
  }
  class Worker {
    constructor() { worker = this; this.messages = []; this.terminated = false; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const sandbox = { LvScore: scoreCore, LvAnchors: anchors, AudioContext, AudioWorkletNode, Worker, Float32Array, Date, performance: { now: () => 0 }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++, addEventListener() {} }] }) } }, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn), setTimeout: fn => { timeouts.add(fn); return fn; }, clearTimeout: fn => timeouts.delete(fn), chrome: { runtime: { id: 'fixture-extension', getURL: file => `chrome-extension://fixture-extension/${file}`, sendMessage: async message => { if (message.type === 'LV_ANALYSIS_CLOCK_REQUEST') return { ...clock }; outgoing.push(message); }, onMessage: { addListener: fn => { listener = fn; } } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/analysis/offscreen.js'), 'utf8'), sandbox);
  const sender = { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/service-worker.js' };
  const request = message => new Promise(resolve => listener({ target: 'lv-offscreen', ...message }, sender, resolve));
  const score = scoreCore.createScore({ videoId: 'FIXTURE0001', title: 'Synthetic lifecycle fixture', artist: '', durationMs: 30000 }, '[00:10]wake me up', { contentHash: 'a'.repeat(64) });
  score.revision = 1;
  return { outgoing, intervals, timeouts, connections, clock, score, request, emit: (message, overrideSender = sender, respond = () => {}) => listener(message, overrideSender, respond), start: () => request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { tabId: 4, mediaKey: clock.mediaKey, sessionId: 'synthetic-session', score, streamId: 'synthetic-stream' } }), get worker() { return worker; }, get worklet() { return worklet; }, get context() { return context; }, get stopped() { return stopped; } };
}

test('synthetic Stop closes streams/context, terminates inference and clears buffered PCM/status', async () => {
  const h = harness();
  await h.start();
  await h.worker.onmessage({ data: { type: 'ready', provider: 'synthetic', model: 'fixture' } });
  const pcm = new Float32Array(4096).fill(0.2);
  h.worklet.port.onmessage({ data: { pcm, startFrame: 0, sampleRate: 16000 } });
  assert.ok(pcm.every(value => value === 0), 'incoming sample copies erased after consumption');
  assert.equal((await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.bufferedSeconds, 0.256);
  assert.ok(h.connections.includes(h.context.destination), 'capture has explicit audible destination route');
  const response = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
  assert.equal(response.analysis.state, 'stopped');
  assert.equal(response.analysis.bufferedSeconds, 0);
  assert.equal(h.stopped, 1);
  assert.ok(h.context.closed && h.worker.terminated && h.worklet.disconnected);
  assert.equal(h.worklet.port.onmessage, null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test('synthetic model load timeout cleans capture and preserves typed causal error', async () => {
  const h = harness(); await h.start();
  assert.equal(h.timeouts.size, 1);
  [...h.timeouts][0]();
  await new Promise(resolve => setImmediate(resolve));
  const response = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' });
  assert.equal(response.analysis.state, 'error');
  assert.equal(response.analysis.error.code, 'MODEL_LOAD_TIMEOUT');
  assert.equal(response.analysis.error.destination, 'analysis/model-worker');
  assert.equal(h.stopped, 1);
  assert.ok(h.worker.terminated && h.context.closed);
});

test('synthetic pause invalidates an in-flight acoustic result', async () => {
  const h = harness(); await h.start();
  await h.worker.onmessage({ data: { type: 'ready', provider: 'synthetic', model: 'fixture' } });
  h.worklet.port.onmessage({ data: { pcm: new Float32Array(192000).fill(0.1), startFrame: 0, sampleRate: 16000 } });
  const job = h.worker.messages.find(m => m.type === 'transcribe');
  assert.ok(job);
  h.clock.paused = true;
  await h.worker.onmessage({ data: { type: 'result', epoch: job.epoch, window: job.window, chunks: [{ text: 'wake', timestamp: [0, 1] }, { text: 'me', timestamp: [1, 2] }] } });
  assert.equal(h.outgoing.filter(m => m.type === 'LV_ALIGNMENT_PROPOSALS').length, 0);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('synthetic score update advances snapshot and invalidates older in-flight revision', async () => {
  const h = harness(); await h.start();
  await h.worker.onmessage({ data: { type: 'ready', provider: 'synthetic', model: 'fixture' } });
  h.worklet.port.onmessage({ data: { pcm: new Float32Array(192000), startFrame: 0, sampleRate: 16000 } });
  const old = h.worker.messages.find(m => m.type === 'transcribe');
  h.emit({ type: 'LV_SCORE_UPDATED', mediaKey: h.clock.mediaKey, tabId: 4, score: { ...h.score, revision: 2 } });
  await h.worker.onmessage({ data: { type: 'result', epoch: old.epoch, window: old.window, chunks: [{ text: 'wake', timestamp: [0, 1] }, { text: 'me', timestamp: [1, 2] }] } });
  assert.equal(h.outgoing.filter(m => m.type === 'LV_ALIGNMENT_PROPOSALS').length, 0);
  h.context.currentTime = 12;
  h.clock.currentTimeMs = 22000;
  await [...h.intervals][0]();
  h.worklet.port.onmessage({ data: { pcm: new Float32Array(192000), startFrame: 192000, sampleRate: 16000 } });
  const jobs = h.worker.messages.filter(m => m.type === 'transcribe');
  assert.equal(jobs[1].window.expectedRevision, 2);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('same-extension editor and content senders cannot start, stop or inspect offscreen analysis', async () => {
  const h = harness();
  const config = { tabId: 4, mediaKey: h.clock.mediaKey, sessionId: 'spoof', score: h.score, streamId: 'spoof' };
  const spoofed = [
    { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/editor.html' },
    { id: 'fixture-extension', url: 'https://www.youtube.com/watch?v=FIXTURE0001' },
    { id: 'fixture-extension' },
    { id: 'other-extension', url: 'chrome-extension://fixture-extension/service-worker.js' }
  ];
  for (const sender of spoofed) h.emit({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_START', config }, sender);
  assert.equal(h.worker, undefined);
  await h.start();
  let statusResponded = false;
  for (const sender of spoofed) {
    h.emit({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_STOP' }, sender);
    h.emit({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_STATUS' }, sender, () => { statusResponded = true; });
  }
  assert.equal(statusResponded, false);
  assert.equal(h.stopped, 0);
  assert.equal(h.context.closed, false);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('spoofed, malformed and wrong-media score updates leave buffered evidence and revision unchanged', async () => {
  const h = harness(); await h.start();
  await h.worker.onmessage({ data: { type: 'ready', provider: 'synthetic', model: 'fixture' } });
  h.worklet.port.onmessage({ data: { pcm: new Float32Array(4096), startFrame: 0, sampleRate: 16000 } });
  const update = { type: 'LV_SCORE_UPDATED', mediaKey: h.clock.mediaKey, tabId: 4, score: { ...h.score, revision: 2 } };
  h.emit(update, { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/editor.html' });
  h.emit({ ...update, score: { revision: 2 } });
  h.emit({ ...update, score: { ...h.score, revision: 2, source: { ...h.score.source, videoId: 'FIXTURE0003' } } });
  h.emit({ ...update, score: { ...h.score, revision: 2, phrases: [{ ...h.score.phrases[0], endMs: -1 }] } });
  assert.equal((await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STATUS' })).analysis.bufferedSeconds, 0.256);
  h.worklet.port.onmessage({ data: { pcm: new Float32Array(192000 - 4096), startFrame: 4096, sampleRate: 16000 } });
  assert.equal(h.worker.messages.find(m => m.type === 'transcribe').window.expectedRevision, 1);
  await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_STOP' });
});

test('authorized Start still rejects a malformed or media-mismatched score before capture', async () => {
  const h = harness();
  const response = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { tabId: 4, mediaKey: h.clock.mediaKey, score: { revision: 1 } } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_ANALYSIS_SCORE');
  assert.equal(h.worker, undefined);
  const wrongMedia = await h.request({ type: 'LV_ANALYSIS_OFFSCREEN_START', config: { tabId: 4, mediaKey: 'youtube:FIXTURE0003', score: h.score } });
  assert.equal(wrongMedia.error.code, 'INVALID_ANALYSIS_SCORE');
  assert.equal(h.context, undefined);
});

test('synthetic audio worklet bounds cross-thread queue to four PCM blocks and reports dropped frames', () => {
  let Capture;
  class AudioWorkletProcessor {
    constructor() { this.messages = []; this.port = { postMessage: message => this.messages.push(message) }; }
  }
  const sandbox = { AudioWorkletProcessor, Float32Array, currentFrame: 0, sampleRate: 16000, registerProcessor: (_, processor) => { Capture = processor; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/analysis/capture-worklet.js'), 'utf8'), sandbox);
  const capture = new Capture();
  const inputs = [[new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)]];
  for (let i = 0; i < 128; i++) { sandbox.currentFrame = i * 128; capture.process(inputs); }
  assert.equal(capture.messages.length, 4);
  assert.equal(capture.messages[0].pcm.length, 2048);
  assert.equal(capture.messages[0].pcm[0], 0.5);
  capture.port.onmessage({ data: { type: 'ack' } });
  for (let i = 128; i < 144; i++) { sandbox.currentFrame = i * 128; capture.process(inputs); }
  assert.equal(capture.messages.length, 5);
  assert.equal(capture.messages[4].droppedFrames, 8192);
  assert.equal(capture.messages[4].startFrame, 16384);
});
