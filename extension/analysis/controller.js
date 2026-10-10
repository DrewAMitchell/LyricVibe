/* Classic MV3 service worker global. Host owns score mutation and user gesture. */
(() => {
  'use strict';
  const path = 'analysis/offscreen.html';
  let creating;
  let generation = 0;
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
  async function stopAnalysis() {
    generation++;
    if (creating) await creating.catch(() => undefined);
    if (await exists()) {
      try { await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_STOP' }); }
      finally { await chrome.offscreen.closeDocument(); }
    }
    status = { state: 'stopped', automaticAdmissionEnabled: false, bufferedSeconds: 0 };
    return status;
  }
  async function startAnalysis({ tabId, score, language = 'en' }) {
    if (!Number.isInteger(tabId) || !score?.source || !Number.isInteger(score.revision)) throw typed('INVALID_ANALYSIS_SOURCE', 'Choose a source tab and validated score.');
    globalThis.LvScore?.validateScore(score);
    await stopAnalysis();
    const token = generation;
    const mediaKey = globalThis.LvScore.mediaKey(score.source);
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'LV_ANALYSIS_CLOCK' });
    const clock = reply?.clock || reply;
    if (clock?.mediaKey !== mediaKey) throw typed('SOURCE_MISMATCH', 'The score no longer belongs to the selected video.');
    if (clock.paused || clock.seeking) throw typed('PLAYBACK_REQUIRED', 'Play the selected video before enabling audio analysis.');
    await ensureOffscreen();
    if (token !== generation) return status;
    try {
      // User must have invoked this extension on the source tab. Do not set consumerTabId.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      if (token !== generation) return status;
      const sessionId = crypto.randomUUID();
      status = { state: 'starting', tabId, mediaKey, sessionId, automaticAdmissionEnabled: false };
      const response = await chrome.runtime.sendMessage({ target: 'lv-offscreen', type: 'LV_ANALYSIS_OFFSCREEN_START', config: { tabId, score, mediaKey, sessionId, streamId, language } });
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
      chrome.tabs.sendMessage(message.tabId, { type: 'LV_ANALYSIS_CLOCK' }).then(clock => respond(clock), () => respond({ error: 'SOURCE_TAB_UNAVAILABLE' }));
      return true;
    }
  });
  globalThis.LvAnalysis = { startAnalysis, stopAnalysis, analysisStatus, clearModelCache };
})();
