/* Offscreen owns ephemeral capture; worker termination is the inference Stop. */
(() => {
  'use strict';
  const WINDOW_SEC = 12;
  let session = null;
  let generation = 0;
  let lastErrorStatus = null;
  const send = message => chrome.runtime.sendMessage(message).catch(() => undefined);
  const publicStatus = () => session ? { state: session.state, tabId: session.tabId, mediaKey: session.mediaKey, sessionId: session.sessionId, provider: session.provider || null, model: session.model || null, modelRevision: session.modelRevision || null, language: session.language || 'en', method: 'top-one-transcription-anchors', confidenceValidated: false, automaticAdmissionEnabled: false, bufferedSeconds: session.used / (session.context?.sampleRate || 16000), droppedSeconds: session.droppedSeconds, windows: session.windows, progress: session.progress || null, error: session.error || null } : lastErrorStatus || { state: 'stopped', bufferedSeconds: 0, automaticAdmissionEnabled: false };
  function publish() { send({ type: 'LV_ANALYSIS_OFFSCREEN_STATE', analysis: publicStatus() }); }
  function scoreMatchesMedia(score, mediaKey) {
    try {
      LvScore.validateScore(score);
      return Boolean(mediaKey) && LvScore.mediaKey(score.source) === mediaKey;
    } catch (_) { return false; }
  }

  function clearWindow(s) {
    s.pcm?.fill(0);
    s.used = 0;
    s.startFrame = null;
  }

  async function stop(preserveError = false) {
    generation++;
    if (!preserveError) lastErrorStatus = null;
    const s = session;
    session = null;
    if (!s) return;
    clearInterval(s.clockTimer);
    clearTimeout(s.modelTimeout);
    s.worker?.terminate();
    if (s.worklet) { s.worklet.port.onmessage = null; s.worklet.port.close(); s.worklet.disconnect(); }
    s.source?.disconnect();
    s.stream?.getTracks().forEach(track => track.stop());
    clearWindow(s);
    await s.context?.close().catch(() => undefined);
    s.score = null;
  }

  function fail(s, code, message) {
    if (session !== s) return;
    s.error = { code, message, source: 'analysis/offscreen', destination: code.startsWith('MODEL') || code === 'INFERENCE_FAILED' ? 'analysis/model-worker' : 'tabCapture', operation: 'analyze-tab-audio', observedAt: new Date().toISOString(), recovery: 'Stop and explicitly Start again' };
    s.state = 'error';
    clearWindow(s);
    // Never leave inaudible playback or capture running after an analysis failure.
    lastErrorStatus = { ...publicStatus(), bufferedSeconds: 0 };
    const finalStatus = lastErrorStatus;
    stop(true).finally(() => send({ type: 'LV_ANALYSIS_OFFSCREEN_STATE', analysis: finalStatus }));
  }

  async function clockTick(s) {
    if (session !== s || s.polling) return;
    s.polling = true;
    const before = s.context.currentTime;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'LV_ANALYSIS_CLOCK_REQUEST', tabId: s.tabId, sessionId: s.sessionId });
      if (session !== s) return;
      const after = s.context.currentTime;
      const clock = reply?.clock || reply;
      if (after - before > 0.2 || !clock || clock.mediaKey !== s.mediaKey) {
        clearWindow(s); s.clock.reset(); s.state = 'waiting-clock';
        if (clock?.mediaKey && clock.mediaKey !== s.mediaKey) fail(s, 'MEDIA_CHANGED', 'The selected video changed; analysis stopped.');
        return;
      }
      const update = s.clock.update(clock, (before + after) / 2);
      s.lastClockAt = performance.now();
      if (update.discontinuity) clearWindow(s);
      if (s.ready) s.state = update.usable ? 'capturing' : 'paused';
    } catch (_) {
      clearWindow(s); s.clock.reset(); s.state = 'waiting-clock';
    } finally { s.polling = false; publish(); }
  }

  function pcm(s, data) {
    const input = data.pcm;
    s.droppedSeconds += (data.droppedFrames || 0) / data.sampleRate;
    if (session !== s || !s.ready || !s.clock.anchor || performance.now() - s.lastClockAt > 750) { input.fill(0); return; }
    if (s.busy) { s.droppedSeconds += input.length / data.sampleRate; input.fill(0); return; }
    if (!s.used) s.startFrame = data.startFrame;
    // A dropped sample chunk cannot become an apparently contiguous acoustic window.
    if (data.startFrame !== s.startFrame + s.used) { clearWindow(s); s.startFrame = data.startFrame; }
    const count = Math.min(input.length, s.pcm.length - s.used);
    s.pcm.set(input.subarray(0, count), s.used);
    s.used += count;
    input.fill(0);
    if (s.used < s.pcm.length) return;
    const startSec = s.startFrame / data.sampleRate;
    const mediaStartMs = s.clock.mediaAt(startSec);
    const evidenceId = `${s.sessionId}:${s.clock.epoch}:${s.startFrame}`;
    const window = { mediaStartMs, playbackRate: s.clock.anchor.playbackRate, durationSec: s.used / data.sampleRate, evidenceId, sampleStart: s.startFrame, sampleCount: s.used, sampleRate: data.sampleRate, clockEpoch: s.clock.epoch, expectedRevision: s.score.revision };
    const audio = s.pcm;
    s.busy = true;
    s.pcm = new Float32Array(audio.length);
    s.used = 0; s.startFrame = null;
    s.worker.postMessage({ type: 'transcribe', epoch: s.clock.epoch, pcm: audio, sampleRate: data.sampleRate, window, language: s.language || 'en' }, [audio.buffer]);
    s.windows++;
    publish();
  }

  async function start(config) {
    await stop();
    const token = generation;
    const s = session = { ...config, state: 'loading-model', clock: new LvAnchors.MediaClock(), used: 0, startFrame: null, ready: false, busy: false, windows: 0, droppedSeconds: 0, lastClockAt: 0 };
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: config.streamId } }, video: false });
      if (session !== s || token !== generation) { s.stream.getTracks().forEach(t => t.stop()); return; }
      s.context = new AudioContext({ sampleRate: 16000 });
      s.source = s.context.createMediaStreamSource(s.stream);
      // Capturing suppresses original tab output. Chrome requires this audible route.
      s.source.connect(s.context.destination);
      await s.context.resume();
      await s.context.audioWorklet.addModule(chrome.runtime.getURL('analysis/capture-worklet.js'));
      if (session !== s) return;
      s.worklet = new AudioWorkletNode(s.context, 'lv-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      s.source.connect(s.worklet);
      s.worklet.connect(s.context.destination);
      s.pcm = new Float32Array(Math.round(s.context.sampleRate * WINDOW_SEC));
      s.worklet.port.onmessage = ({ data }) => {
        try { pcm(s, data); } finally { if (session === s) s.worklet.port.postMessage({ type: 'ack' }); }
      };
      s.stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (session === s) fail(s, 'CAPTURE_ENDED', 'The browser ended tab audio capture.'); }));
      s.worker = new Worker(chrome.runtime.getURL('analysis/model-worker.bundle.js'), { type: 'module' });
      s.worker.onerror = () => fail(s, 'MODEL_WORKER_FAILED', 'The packaged model worker could not run.');
      s.worker.onmessage = async ({ data }) => {
        if (session !== s) return;
        if (data.type === 'progress') { s.progress = data.progress; publish(); }
        if (data.type === 'fallback') { s.provider = data.provider; s.progress = { status: data.reason }; publish(); }
        if (data.type === 'ready') {
          clearTimeout(s.modelTimeout); s.ready = true; s.provider = data.provider; s.model = data.model; s.modelRevision = data.modelRevision; s.progress = null;
          s.state = s.clock.anchor ? 'capturing' : 'waiting-clock'; publish();
        }
        if (data.type === 'error') { s.busy = false; fail(s, data.code, data.message); }
        if (data.type === 'result') {
          s.busy = false;
          await clockTick(s);
          // Pause/seek/video/rate reset invalidates the whole in-flight result.
          if (session !== s || data.epoch !== s.clock.epoch || !s.clock.anchor || performance.now() - s.lastClockAt > 750 || data.window.expectedRevision !== s.score.revision) return;
          const result = LvAnchors.matchAnchors(s.score, data.chunks, data.window);
          send({ type: 'LV_ALIGNMENT_PROPOSALS', tabId: s.tabId, sessionId: s.sessionId, mediaKey: s.mediaKey, expectedRevision: s.score.revision, proposals: result.proposals, diagnostics: { ...result.diagnostics, provider: data.provider, model: data.model, modelRevision: data.modelRevision, inferenceMs: data.inferenceMs, sampleWindow: data.window, droppedSeconds: s.droppedSeconds, audioRetained: false } });
          publish();
        }
      };
      s.modelTimeout = setTimeout(() => fail(s, 'MODEL_LOAD_TIMEOUT', 'Model setup exceeded five minutes; capture stopped.'), 300000);
      s.worker.postMessage({ type: 'load' });
      await clockTick(s);
      if (session === s) s.clockTimer = setInterval(() => clockTick(s), 250);
      publish();
    } catch (_) { fail(s, 'CAPTURE_SETUP_FAILED', 'The selected tab audio could not be captured and routed.'); }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('service-worker.js')) return;
    if (message.type === 'LV_SCORE_UPDATED' && session && message.mediaKey === session.mediaKey && message.tabId === session.tabId && message.score?.revision > session.score.revision && scoreMatchesMedia(message.score, session.mediaKey)) {
      session.score = message.score;
      clearWindow(session);
      session.clock.reset();
      return;
    }
    if (message.target !== 'lv-offscreen') return;
    if (message.type === 'LV_ANALYSIS_OFFSCREEN_START') {
      if (!message.config || !scoreMatchesMedia(message.config.score, message.config.mediaKey)) {
        respond({ ok: false, error: { code: 'INVALID_ANALYSIS_SCORE', message: 'Analysis requires a validated score bound to its media identity.' } }); return;
      }
      start(message.config).then(() => respond({ ok: true, analysis: publicStatus() }), () => respond({ ok: false })); return true;
    }
    if (message.type === 'LV_ANALYSIS_OFFSCREEN_STOP') { stop().then(() => respond({ ok: true, analysis: publicStatus() })); return true; }
    if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATUS') respond({ ok: true, analysis: publicStatus() });
    if (message.type === 'LV_ANALYSIS_CACHE_CLEAR') {
      stop().then(async () => { await caches.delete('lyricvibe-models-v1'); respond({ ok: true, analysis: publicStatus() }); }); return true;
    }
  });
})();
