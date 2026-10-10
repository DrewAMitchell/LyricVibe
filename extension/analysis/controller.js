/* Classic MV3 service worker global. Host owns score mutation and user gesture. */
(() => {
  'use strict';
  const path = 'analysis/offscreen.html';
  let creating;
  let generation = 0;
  let nativeBridge = null;
  let status = { state: 'stopped', automaticAdmissionEnabled: false };
  const isOffscreen = sender => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path);
  async function exists() {
    return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(path)] })).length > 0;
  }
  async function ensureOffscreen() {
    if (await exists()) return;
    if (!creating) creating = chrome.offscreen.createDocument({ url: path, reasons: ['USER_MEDIA'], justification: 'Analyze explicitly enabled tab audio locally and preserve audible playback.' }).finally(() => { creating = null; });
    await creating;
  }
  function typed(code, message) { return Object.assign(new Error(message), { code }); }
  function closeNativeBridge() {
    const bridge = nativeBridge;
    nativeBridge = null;
    try { bridge?.hostPort.disconnect(); } catch (_) { /* Already closed. */ }
    try { bridge?.offscreenPort.disconnect(); } catch (_) { /* Already closed. */ }
  }
  async function stopAnalysis(scope) {
    if (scope) {
      const active = await analysisStatus();
      if (active.tabId != null && (active.tabId !== scope.tabId || active.mediaKey !== scope.mediaKey || scope.sessionId && active.sessionId !== scope.sessionId)) {
        throw typed('ANALYSIS_SOURCE_MISMATCH', 'Stop was opened for a different analysis source.');
      }
    }
    generation++;
    try {
      if (creating) await creating.catch(() => undefined);
      if (await exists()) {
        try { await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_STOP' }); }
        finally { await chrome.offscreen.closeDocument(); }
      }
    } finally {
      closeNativeBridge();
      status = { state: 'stopped', automaticAdmissionEnabled: false, bufferedSeconds: 0 };
    }
    return status;
  }
  async function startAnalysis({ tabId, score, language = 'en', engine = 'browser', expectedRevision, lyricsHash }) {
    if (!Number.isInteger(tabId) || !score?.source || !Number.isInteger(score.revision)) throw typed('INVALID_ANALYSIS_SOURCE', 'Choose a source tab and validated score.');
    globalThis.LvScore?.validateScore(score);
    if (expectedRevision != null && expectedRevision !== score.revision) throw typed('REVISION_CONFLICT', 'Reload the score before starting analysis.');
    if (lyricsHash != null && lyricsHash !== score.lyrics.contentHash) throw typed('LYRIC_REVISION_MISMATCH', 'The selected lyrics changed before analysis could start.');
    if (!['browser', 'native'].includes(engine)) throw typed('ANALYSIS_ENGINE_INVALID', 'Choose a supported analysis engine.');
    await stopAnalysis();
    const token = generation;
    const mediaKey = globalThis.LvScore.mediaKey(score.source);
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'LV_ANALYSIS_CLOCK' });
    const clock = reply?.clock || reply;
    if (clock?.mediaKey !== mediaKey) throw typed('SOURCE_MISMATCH', 'The score no longer belongs to the selected video.');
    if (clock.isAd) throw typed('ADVERTISEMENT_ACTIVE', 'Wait for the advertisement to finish.');
    if (clock.paused || clock.seeking) throw typed('PLAYBACK_REQUIRED', 'Play the selected video before enabling audio analysis.');
    await ensureOffscreen();
    if (token !== generation) return status;
    try {
      // User must have invoked this extension on the source tab. Do not set consumerTabId.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      if (token !== generation) return status;
      const sessionId = crypto.randomUUID();
      status = { state: 'starting', engine, tabId, mediaKey, sessionId, lyricsHash: score.lyrics.contentHash, expectedRevision: score.revision, automaticAdmissionEnabled: false };
      const response = await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_START', config: { tabId, score, mediaKey, sessionId, streamId, language, engine } });
      if (token === generation && response?.analysis) status = response.analysis;
      return status;
    } catch (error) {
      await stopAnalysis();
      throw typed('TAB_CAPTURE_FAILED', 'Chrome could not capture this tab. Invoke LyricVibe on the playing source tab and enable analysis again.');
    }
  }
  async function analysisStatus() {
    if (await exists()) {
      try { const reply = await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_STATUS' }); if (reply?.analysis) status = reply.analysis; } catch (_) { /* Keep last causal status for inspection. */ }
    } else if (!['error', 'stopped'].includes(status.state)) status = { state: 'stopped', automaticAdmissionEnabled: false, bufferedSeconds: 0 };
    return { ...status };
  }
  async function clearModelCache() {
    await stopAnalysis();
    await ensureOffscreen();
    try { return await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_CACHE_CLEAR' }); }
    finally { await chrome.offscreen.closeDocument(); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isOffscreen(sender)) return;
    if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATE') { status = message.analysis; return; }
    if (message.type === 'LV_ANALYSIS_CLOCK_REQUEST') {
      if (!status.sessionId || message.sessionId !== status.sessionId || message.tabId !== status.tabId) { respond({ error: 'ANALYSIS_SOURCE_MISMATCH' }); return; }
      chrome.tabs.sendMessage(message.tabId, { type: 'LV_ANALYSIS_CLOCK' }).then(clock => respond(clock), () => respond({ error: 'SOURCE_TAB_UNAVAILABLE' }));
      return true;
    }
  });

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'lv-native-bridge' || !isOffscreen(port.sender)) { port.disconnect(); return; }
    let bridge = { offscreenPort: port, hostPort: null, sessionId: null, tabId: null, mediaKey: null };
    const close = () => {
      if (nativeBridge === bridge) nativeBridge = null;
      try { bridge.hostPort?.disconnect(); } catch (_) { /* Already closed. */ }
      bridge.hostPort = null;
    };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(message => {
      if (!bridge.sessionId) {
        if (message?.type !== 'LV_NATIVE_BRIDGE_BIND' || message.sessionId !== status.sessionId || message.tabId !== status.tabId || message.mediaKey !== status.mediaKey || status.engine !== 'native') { port.disconnect(); return; }
        closeNativeBridge();
        bridge.sessionId = message.sessionId; bridge.tabId = message.tabId; bridge.mediaKey = message.mediaKey;
        try {
          bridge.hostPort = chrome.runtime.connectNative('com.lyricvibe.native_audio');
          bridge.hostPort.onMessage.addListener(response => { if (nativeBridge === bridge) port.postMessage(response); });
          bridge.hostPort.onDisconnect.addListener(() => { if (nativeBridge === bridge) { try { port.disconnect(); } catch (_) {} close(); } });
          nativeBridge = bridge;
        } catch (_) {
          port.postMessage({ type: 'LV_NATIVE_BRIDGE_ERROR', code: 'NATIVE_HOST_CONNECT_FAILED' });
          port.disconnect(); close();
        }
        return;
      }
      if (nativeBridge !== bridge || message?.version !== 'lyricvibe.native-live.v1' || message.type !== 'hello' && message.sessionId !== bridge.sessionId) { port.disconnect(); return; }
      if (message.type === 'analyze' || message.type === 'cancel') {
        const source = message.source;
        if (!source || source.tabId !== bridge.tabId || source.mediaKey !== bridge.mediaKey || source.lyricsHash !== status.lyricsHash || source.expectedRevision !== status.expectedRevision) { port.disconnect(); return; }
      } else if (message.type !== 'hello') { port.disconnect(); return; }
      try { bridge.hostPort.postMessage(message); }
      catch (_) { port.disconnect(); close(); }
    });
  });
  globalThis.LvAnalysis = { startAnalysis, stopAnalysis, analysisStatus, clearModelCache };
})();
