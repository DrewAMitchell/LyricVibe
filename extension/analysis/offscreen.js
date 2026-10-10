/* Offscreen owns ephemeral capture; worker termination is the inference Stop. */
(() => {
  'use strict';
  const WINDOW_SEC = 12;
  let session = null;
  let generation = 0;
  let lastErrorStatus = null;
  const send = message => chrome.runtime.sendMessage(message).catch(() => undefined);
  const publicStatus = () => session ? { state: session.state, tabId: session.tabId, mediaKey: session.mediaKey, sessionId: session.sessionId, engine: session.engine || 'browser', lyricsHash: session.score?.lyrics?.contentHash || null, expectedRevision: session.score?.revision ?? null, provider: session.provider || null, model: session.model || null, modelRevision: session.modelRevision || null, language: session.language || 'en', method: session.engine === 'native' ? 'native-live-supplied-text-ctc' : 'top-one-transcription-anchors', confidenceValidated: false, automaticAdmissionEnabled: false, bufferedSeconds: session.used / (session.context?.sampleRate || 16000), droppedSeconds: session.droppedSeconds, windows: session.windows, ...(session.engine === 'native' && session.lastWindow ? { lastWindow: { ...session.lastWindow } } : {}), progress: session.progress || session.unsupportedReason || null, error: session.error || null } : lastErrorStatus || { state: 'stopped', bufferedSeconds: 0, automaticAdmissionEnabled: false };
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
    clearTimeout(s.cancelTimeout);
    s.worker?.terminate();
    if (s.nativePort) {
      if (s.inflight) {
        try { s.nativePort.postMessage({ version: LvNativeLive.VERSION, type: 'cancel', requestId: s.inflight.requestId, sessionId: s.sessionId, source: { ...s.inflight.source, captureEpoch: s.inflight.source.captureEpoch } }); } catch (_) { /* Host already closed. */ }
      }
      s.nativePort.onMessage.removeListener(s.nativeMessage);
      s.nativePort.disconnect();
      s.nativePort = null;
    }
    if (s.worklet) { s.worklet.port.onmessage = null; s.worklet.port.close(); s.worklet.disconnect(); }
    s.source?.disconnect();
    s.stream?.getTracks().forEach(track => track.stop());
    clearWindow(s);
    await s.context?.close().catch(() => undefined);
    s.score = null;
  }

  function fail(s, code, message, detail = {}) {
    if (session !== s) return;
    const phase = detail.phase || s.phase || null;
    const nativeHostCode = code.startsWith('NATIVE_') || code.startsWith('ALIGNMENT_') || code.startsWith('INVALID_LYRICS_') || code.startsWith('AUDIO_CHECKSUM_') || ['PROTOCOL_MISMATCH', 'INVALID_REQUEST', 'INVALID_SOURCE_BINDING', 'INVALID_AUDIO_WINDOW'].includes(code);
    const nativeHostFailure = s.engine === 'native' && (nativeHostCode || phase === 'native-host' || phase === 'capturing' && !['SOURCE_TAB_UNAVAILABLE', 'MEDIA_CHANGED', 'ADVERTISEMENT_ACTIVE', 'SCORE_REVISION_CHANGED', 'CAPTURE_ENDED'].includes(code));
    s.error = { code, message, source: 'analysis/offscreen', destination: code.startsWith('MODEL') || code === 'INFERENCE_FAILED' ? 'analysis/model-worker' : nativeHostFailure ? LvNativeLive.HOST_NAME : 'tabCapture', operation: 'analyze-tab-audio', phase, causeName: detail.causeName || null, causeCode: detail.causeCode || null, observedAt: new Date().toISOString(), recovery: 'Stop and explicitly Start again' };
    s.state = 'error';
    clearWindow(s);
    // Never leave inaudible playback or capture running after an analysis failure.
    lastErrorStatus = { ...publicStatus(), bufferedSeconds: 0 };
    const finalStatus = lastErrorStatus;
    stop(true).finally(() => send({ type: 'LV_ANALYSIS_OFFSCREEN_STATE', analysis: finalStatus }));
  }

  function cancelInflight(s) {
    if (!s.inflight) return;
    const pending = s.inflight;
    if (s.lastWindowRequestId === pending.requestId && s.lastWindow) {
      s.lastWindow.stage = 'discarded';
      s.lastWindow.resultReason = pending.source.captureEpoch !== s.clock.epoch || pending.source.expectedRevision !== s.score.revision ? 'staleepoch' : 'staleclock';
    }
    s.inflight = null;
    s.cancelPending = pending;
    s.busy = true;
    clearTimeout(s.cancelTimeout);
    s.cancelTimeout = setTimeout(() => { if (session === s && s.cancelPending === pending) fail(s, 'NATIVE_CANCEL_TIMEOUT', 'The native host did not confirm that stale analysis was cancelled.'); }, 10000);
    try { s.nativePort?.postMessage({ version: LvNativeLive.VERSION, type: 'cancel', requestId: pending.requestId, sessionId: s.sessionId, source: pending.source }); } catch (_) { /* Best effort; stale responses remain locally fenced. */ }
  }

  async function nativeReply(s, message) {
    const pending = s.inflight;
    if (s.cancelPending && message?.requestId === s.cancelPending.requestId && message?.sessionId === s.sessionId) {
      if (message.type === 'status' && message.state === 'accepted') return;
      if (['status', 'result', 'error'].includes(message.type)) {
        try { LvNativeLive.validateEnvelope(message, s.cancelPending.expected); }
        catch (error) { fail(s, error.code || 'NATIVE_CANCEL_MISMATCH', 'The native host cancellation response was invalid.'); return; }
        clearTimeout(s.cancelTimeout); s.cancelTimeout = null; s.cancelPending = null; s.busy = false; publish();
      }
      return;
    }
    if (!pending || message?.requestId !== pending.requestId || message?.sessionId !== s.sessionId) return;
    if (message.type === 'status' && message.state === 'busy') {
      fail(s, 'NATIVE_HOST_BUSY', 'The native audio host is already processing another request.');
      return;
    }
    if (message.type === 'status' && message.state === 'accepted') {
      try { LvNativeLive.validateAccepted(message, pending.expected); pending.accepted = true; }
      catch (error) { fail(s, error.code || 'NATIVE_ACK_INVALID', error.message); }
      return;
    }
    if (message.type === 'status' && message.state === 'cancelled') { s.inflight = null; s.busy = false; return; }
    if (message.type !== 'result' && message.type !== 'error') return;
    await clockTick(s);
    if (session !== s || s.inflight !== pending) return;
    if (pending.source.captureEpoch !== s.clock.epoch || pending.source.expectedRevision !== s.score.revision ||
        !s.clock.anchor || performance.now() - s.lastClockAt > 750) {
      if (s.lastWindowRequestId === pending.requestId && s.lastWindow) {
        s.lastWindow.stage = 'discarded';
        s.lastWindow.resultReason = pending.source.captureEpoch !== s.clock.epoch || pending.source.expectedRevision !== s.score.revision ? 'staleepoch' : 'staleclock';
        s.lastWindow.nativeWordCount = Array.isArray(message.words) ? message.words.length : null;
        s.lastWindow.resultAudioStartMs = Number.isSafeInteger(message.audio?.audioStartMs) ? message.audio.audioStartMs : null;
      }
      s.inflight = null; s.busy = false; publish(); return;
    }
    s.inflight = null;
    try {
      const result = LvNativeLive.validateResult(message, pending.expected, s.score);
      if (!result.proposals.length) {
        if (s.lastWindowRequestId === pending.requestId && s.lastWindow) {
          s.lastWindow.stage = 'result';
          s.lastWindow.nativeWordCount = message.words.length;
          s.lastWindow.proposalCount = 0;
          s.lastWindow.resultAudioStartMs = message.audio.audioStartMs;
          s.lastWindow.resultReason = message.words.length ? 'skipped' : 'emptyaligned';
          s.lastWindow.nativeReasonCode = result.diagnostics.reasonCode;
        }
        s.busy = false; publish(); return;
      }
      if (s.lastWindowRequestId === pending.requestId && s.lastWindow) {
        s.lastWindow.stage = 'result';
        s.lastWindow.nativeWordCount = message.words.length;
        s.lastWindow.proposalCount = result.proposals.length;
        s.lastWindow.resultAudioStartMs = message.audio.audioStartMs;
        s.lastWindow.resultReason = null;
      }
      result.diagnostics.sampleWindow.requestId = pending.requestId;
      s.pendingProposal = { requestId: pending.requestId, revision: s.score.revision };
      const response = await chrome.runtime.sendMessage({ type: 'LV_ALIGNMENT_PROPOSALS', engine: 'native', tabId: s.tabId, sessionId: s.sessionId, mediaKey: s.mediaKey, expectedRevision: s.score.revision, proposals: result.proposals, diagnostics: result.diagnostics });
      if (session !== s) return;
      if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'The score owner rejected native proposals.'), { code: response?.error?.code || 'NATIVE_PROPOSAL_REJECTED' });
      if (response.score?.revision > s.score.revision) { s.score = response.score; s.pendingProposal = null; clearWindow(s); }
      s.busy = false;
    } catch (error) {
      s.pendingProposal = null;
      fail(s, error.code || 'NATIVE_RESULT_INVALID', error.code === 'ANALYSIS_SOURCE_MISMATCH' || error.code === 'REVISION_CONFLICT'
        ? 'The source or score changed during native analysis; stop and start again.'
        : 'Native analysis failed validation; stop and explicitly start a new session.');
    }
    publish();
  }

  async function connectNative(s) {
    s.state = 'connecting-native'; publish();
    s.nativePort = chrome.runtime.connect({ name: 'lv-native-bridge' });
    s.nativeMessage = message => {
      if (session !== s) return;
      if (message?.type === 'LV_NATIVE_BRIDGE_ERROR') { fail(s, message.code || 'NATIVE_HOST_CONNECT_FAILED', 'The native audio host could not be started.'); return; }
      if (!s.nativeReady) {
        try { s.nativeInfo = LvNativeLive.validateHello(message); s.nativeReady = true; s.provider = message.adapter || null; s.model = message.model || null; s.modelRevision = message.modelRevision || null; s.pcm = new Float32Array(Math.round(s.context.sampleRate * s.nativeInfo.limits.maxAudioMs / 1000)); s.ready = true; s.state = s.clock.anchor ? 'capturing' : 'waiting-clock'; publish(); }
        catch (error) { fail(s, error.code || 'NATIVE_HOST_INCOMPATIBLE', error.message); }
        return;
      }
      nativeReply(s, message);
    };
    s.nativePort.onMessage.addListener(s.nativeMessage);
    s.nativePort.onDisconnect.addListener(() => { if (session === s) fail(s, 'NATIVE_HOST_DISCONNECTED', 'The native audio host disconnected.'); });
    const timeout = setTimeout(() => { if (session === s && !s.nativeReady) fail(s, 'NATIVE_HOST_TIMEOUT', 'The native audio host did not become ready.'); }, 15000);
    s.nativePort.postMessage({ type: 'LV_NATIVE_BRIDGE_BIND', sessionId: s.sessionId, tabId: s.tabId, mediaKey: s.mediaKey });
    s.nativePort.postMessage({ version: LvNativeLive.VERSION, type: 'hello' });
    while (session === s && !s.nativeReady && s.state !== 'error') await new Promise(resolve => setTimeout(resolve, 25));
    clearTimeout(timeout);
    if (session !== s || s.state === 'error') throw Object.assign(new Error('Native host setup failed.'), { code: s.error?.code || 'NATIVE_HOST_SETUP_FAILED' });
  }

  async function submitNativeWindow(s, floatPcm, data, startFrame) {
    const startSec = startFrame / data.sampleRate;
    const mediaStartMs = Math.round(s.clock.mediaAt(startSec));
    const durationMs = Math.round(floatPcm.length * 1000 / data.sampleRate);
    const windowNumber = (s.windowSequence || 0) + 1;
    s.windowSequence = windowNumber;
    s.lastWindowRequestId = null;
    let nonZeroSampleCount = 0, squareSum = 0;
    for (let i = 0; i < floatPcm.length; i++) {
      const sample = Number.isFinite(floatPcm[i]) ? floatPcm[i] : 0;
      if (sample !== 0) nonZeroSampleCount++;
      squareSum += sample * sample;
    }
    s.lastWindow = { windowNumber, captureEpoch: s.clock.epoch, expectedWordCount: 0, nativeWordCount: null, proposalCount: null, stage: 'selecting', resultReason: null, nativeReasonCode: null, capturedAudioStartMs: mediaStartMs, submittedAudioStartMs: null, resultAudioStartMs: null, nonZeroSampleCount, rms: Math.sqrt(squareSum / Math.max(1, floatPcm.length)) };
    let expectedWords;
    try { expectedWords = LvNativeLive.expectedWordsForWindow(s.score, mediaStartMs, durationMs, s.clock.anchor.playbackRate); }
    catch (error) {
      floatPcm.fill(0); s.droppedSeconds += durationMs / 1000; s.windows++;
      if (error.code === 'UNSUPPORTED_LYRICS' || error.code === 'UNSUPPORTED_PLAYBACK_RATE') { s.busy = false; s.lastWindow.stage = 'skipped'; s.lastWindow.resultReason = 'skipped'; s.unsupportedReason = { code: error.code, message: error.message, ...(error.wordId ? { wordId: error.wordId } : {}), ...(error.tokenClass ? { tokenClass: error.tokenClass } : {}) }; publish(); return; }
      throw error;
    }
    s.unsupportedReason = null;
    if (!expectedWords.length) { s.busy = false; s.lastWindow.stage = 'skipped'; s.lastWindow.resultReason = 'noeligible'; s.lastWindow.submittedAudioStartMs = mediaStartMs; s.droppedSeconds += durationMs / 1000; floatPcm.fill(0); s.windows++; s.unsupportedReason = { code: 'NO_COMPLETE_LEAD_PHRASE', message: 'Waiting for a complete, non-overlapping lead phrase inside the captured window.' }; publish(); return; }
    s.lastWindow.expectedWordCount = expectedWords.length;
    const source = { tabId: s.tabId, mediaKey: s.mediaKey, lyricsHash: s.score.lyrics.contentHash, expectedRevision: s.score.revision, captureEpoch: s.clock.epoch };
    const requestId = crypto.randomUUID();
    const request = await LvNativeLive.createRequest({ requestId, sessionId: s.sessionId, source, audioStartMs: mediaStartMs, playbackRate: s.clock.anchor.playbackRate, floatPcm, expectedWords });
    floatPcm.fill(0);
    if (session !== s || source.captureEpoch !== s.clock.epoch || source.expectedRevision !== s.score.revision || !s.clock.anchor) {
      request.audio.pcmBase64 = '';
      if (session === s) { s.busy = false; s.lastWindow.stage = 'discarded'; s.lastWindow.resultReason = 'staleclock'; publish(); }
      return;
    }
    const expected = { ...request, expectedWords, audio: { ...request.audio, pcmBase64: undefined } };
    s.inflight = { requestId, source, expected, accepted: false };
    s.lastWindowRequestId = requestId;
    s.lastWindow.stage = 'submitted';
    s.lastWindow.submittedAudioStartMs = mediaStartMs;
    s.busy = true;
    try { s.nativePort.postMessage(request); }
    catch (_) { s.inflight = null; s.busy = false; fail(s, 'NATIVE_SEND_FAILED', 'The captured audio window could not be sent to the native host.'); return; }
    request.audio.pcmBase64 = '';
    s.windows++; publish();
  }

  async function clockTick(s) {
    if (session !== s) return;
    if (s.clockPromise) return s.clockPromise;
    s.polling = true;
    const poll = (async () => {
      const before = s.context.currentTime;
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'LV_ANALYSIS_CLOCK_REQUEST', tabId: s.tabId, sessionId: s.sessionId });
        if (session !== s) return;
        const after = s.context.currentTime;
        const clock = reply?.clock || reply;
        if (after - before > 0.2 || !clock || clock.mediaKey !== s.mediaKey) {
          clearWindow(s); s.clock.reset(); s.state = 'waiting-clock';
          if (s.engine === 'native') cancelInflight(s);
          if (clock?.mediaKey && clock.mediaKey !== s.mediaKey) fail(s, 'MEDIA_CHANGED', 'The selected video changed; analysis stopped.');
          else if (clock?.error) fail(s, 'SOURCE_TAB_UNAVAILABLE', 'The source tab stopped reporting playback.');
          return;
        }
        const update = s.clock.update(clock, (before + after) / 2);
        s.lastClockAt = performance.now();
        if (update.discontinuity) clearWindow(s);
        if (update.discontinuity && s.engine === 'native') cancelInflight(s);
        if (clock.isAd || clock.mediaReady === false) {
          clearWindow(s); cancelInflight(s);
          if (clock.isAd) { fail(s, 'ADVERTISEMENT_ACTIVE', 'Advertisement playback stopped native analysis.'); return; }
        }
        if (s.ready) s.state = update.usable ? 'capturing' : 'paused';
      } catch (_) {
        clearWindow(s); s.clock.reset(); s.state = 'waiting-clock';
      }
    })();
    s.clockPromise = poll.finally(() => { s.polling = false; s.clockPromise = null; publish(); });
    return s.clockPromise;
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
    const windowStartFrame = s.startFrame;
    s.busy = true;
    s.pcm = new Float32Array(audio.length);
    s.used = 0; s.startFrame = null;
    if (s.engine === 'native') {
      submitNativeWindow(s, audio, data, windowStartFrame).catch(error => { audio.fill(0); fail(s, error.code || 'NATIVE_REQUEST_FAILED', 'Native alignment request failed safely.'); });
      return;
    }
    s.worker.postMessage({ type: 'transcribe', epoch: s.clock.epoch, pcm: audio, sampleRate: data.sampleRate, window, language: s.language || 'en' }, [audio.buffer]);
    s.windows++;
    publish();
  }

  async function start(config) {
    await stop();
    const token = generation;
    const s = session = { ...config, state: 'loading-model', clock: new LvAnchors.MediaClock(), used: 0, startFrame: null, ready: false, busy: false, windows: 0, droppedSeconds: 0, lastClockAt: 0 };
    try {
      s.phase = 'tab-capture';
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: config.streamId } }, video: false });
      if (session !== s || token !== generation) { s.stream.getTracks().forEach(t => t.stop()); return; }
      s.phase = 'audio-context';
      s.context = new AudioContext({ sampleRate: 16000 });
      if (s.engine === 'native' && s.context.sampleRate !== LvNativeLive.SAMPLE_RATE_HZ) throw Object.assign(new Error('Native live analysis requires a 16 kHz capture context.'), { code: 'NATIVE_SAMPLE_RATE_UNSUPPORTED' });
      s.source = s.context.createMediaStreamSource(s.stream);
      // Capturing suppresses original tab output. Chrome requires this audible route.
      s.source.connect(s.context.destination);
      await s.context.resume();
      s.phase = 'capture-worklet';
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
      if (s.engine === 'native') { s.phase = 'native-host'; await connectNative(s); }
      else s.worker = new Worker(chrome.runtime.getURL('analysis/model-worker.bundle.js'), { type: 'module' });
      if (s.engine !== 'native') {
      s.phase = 'browser-model';
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
      }
      s.phase = 'source-clock';
      await clockTick(s);
      if (session === s) s.clockTimer = setInterval(() => clockTick(s), 250);
      s.phase = 'capturing';
      publish();
    } catch (error) { fail(s, error.code || 'CAPTURE_SETUP_FAILED', 'The selected tab audio could not be captured and routed.', { phase: s.phase, causeName: error?.name, causeCode: error?.code }); }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('service-worker.js')) return;
    if (message.type === 'LV_SCORE_UPDATED' && session && message.mediaKey === session.mediaKey && message.tabId === session.tabId && message.score?.revision > session.score.revision && scoreMatchesMedia(message.score, session.mediaKey)) {
      if (session.engine === 'native' && session.pendingProposal && message.diagnostics?.sampleWindow?.requestId === session.pendingProposal.requestId && message.score.revision === session.pendingProposal.revision + 1) {
        session.score = message.score; session.pendingProposal = null; clearWindow(session); publish(); return;
      }
      if (session.engine === 'native') { cancelInflight(session); fail(session, 'SCORE_REVISION_CHANGED', 'The score changed during native analysis; stop and start again.'); return; }
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
