/* Revisioned score owner. Raw lyric lookup caches may be shared; scores never are. */
(function (root) {
  const queues = new Map();
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const keyFor = (key) => `lvScore:${key}`;
  async function serial(key, work) {
    const prior = queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
  }
  async function digest(text) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function read(key) {
    const value = (await chrome.storage.local.get(keyFor(key)))[keyFor(key)];
    if (value) LvScore.validateScore(value.score);
    return value;
  }
  async function publish(tabId, record) {
    const message = { type: 'LV_SCORE_UPDATED', tabId, mediaKey: LvScore.mediaKey(record.score.source), score: record.score, review: record.review || [], diagnostics: record.diagnostics || null };
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
    await chrome.runtime.sendMessage(message).catch(() => {});
  }
  async function liveIdentity(tabId, requested) {
    if (!Number.isInteger(tabId)) throw fail('SOURCE_REQUIRED', 'Open the editor from a playing YouTube tab.');
    const hints = await chrome.tabs.sendMessage(tabId, { type: 'LV_GET_HINTS' });
    const key = LvScore.mediaKey(hints);
    if (!key || (requested && key !== requested)) throw fail('SOURCE_CHANGED', 'The source video changed. Reopen its score.');
    return { key, hints };
  }
  async function ensure(tabId, payload) {
    const requested = LvScore.mediaKey(payload.hints || {});
    const { key, hints } = await liveIdentity(tabId, requested);
    const raw = payload.lyrics.synced || '';
    if (!raw.trim()) return null; // Plain text has no honest timing; keep upstream fallback.
    const hash = await digest(raw);
    return serial(key, async () => {
      const record = await read(key);
      // New database text never silently replaces manual work. It is a separate revision to review.
      if (record) {
        if (record.score.lyrics.contentHash !== hash) {
          record.lyricRevisionAvailable = hash;
          await chrome.storage.local.set({ [keyFor(key)]: record });
        }
        await liveIdentity(tabId, key);
        return record.score;
      }
      const score = LvScore.createScore({ platform: 'youtube', videoId: key.slice(8), title: payload.track.title || '', artist: payload.track.artist || '', durationMs: Math.round((hints.duration || 0) * 1000) }, raw,
        { provider: payload.lyrics.provider || 'LRCLIB', entryId: payload.match?.id == null ? null : String(payload.match.id), contentHash: hash });
      const fresh = { score, history: [], review: [] };
      await liveIdentity(tabId, key);
      await chrome.storage.local.set({ [keyFor(key)]: fresh });
      return score;
    });
  }
  async function packageFor(tabId, hints) {
    const key = LvScore.mediaKey(hints);
    if (!key) return null;
    const existing = await read(key);
    if (existing) { await liveIdentity(tabId, key); return existing.score; }
    const { lvPackageBase } = await chrome.storage.local.get('lvPackageBase');
    if (!lvPackageBase) return null;
    const base = new URL(lvPackageBase);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw fail('ENDPOINT_INVALID', 'Use HTTPS or a loopback HTTP endpoint.');
    const response = await fetch(`${base.href.replace(/\/$/, '')}/v1/youtube/${key.slice(8)}/score`, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
    if (response.status === 404) return null;
    if (!response.ok) throw fail('ENDPOINT_UNAVAILABLE', `Package endpoint returned ${response.status}.`);
    const body = await response.text();
    if (body.length > 2_000_000) throw fail('PACKAGE_TOO_LARGE', 'Score package exceeds 2 MB.');
    const score = JSON.parse(body);
    LvScore.validateScore(score);
    if (LvScore.mediaKey(score.source) !== key) throw fail('SOURCE_MISMATCH', 'Package belongs to another video.');
    await liveIdentity(tabId, key);
    return serial(key, async () => {
      const current = await read(key);
      await liveIdentity(tabId, key);
      if (current) return current.score;
      await chrome.storage.local.set({ [keyFor(key)]: { score, history: [], review: [] } });
      return score;
    });
  }
  async function handle(message, sender) {
    if (message.type === 'LV_ANALYSIS_CACHE_CLEAR_REQUEST') return root.LvAnalysis.clearModelCache();
    const tabId = message.tabId ?? sender.tab?.id;
    if (message.type === 'LV_EDITOR_OPEN') {
      const { key } = await liveIdentity(tabId, message.mediaKey);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?sourceTab=${tabId}&mediaKey=${encodeURIComponent(key)}`) });
      return { ok: true };
    }
    const { key } = await liveIdentity(tabId, message.mediaKey);
    if (['LV_SCORE_SEEK', 'LV_SCORE_TRANSPORT'].includes(message.type)) return chrome.tabs.sendMessage(tabId, { ...message, mediaKey: key });
    if (message.type === 'LV_ANALYSIS_START') {
      const record = await read(key);
      if (!record) throw fail('SCORE_MISSING', 'No timed score is loaded.');
      return { ok: true, analysis: await root.LvAnalysis.startAnalysis({ tabId, score: record.score }) };
    }
    if (message.type === 'LV_ANALYSIS_STOP') return { ok: true, analysis: await root.LvAnalysis.stopAnalysis() };
    if (message.type === 'LV_ANALYSIS_STATUS') return { ok: true, analysis: await root.LvAnalysis.analysisStatus() };
    return serial(key, async () => {
      const record = await read(key);
      if (!record) throw fail('SCORE_MISSING', 'No timed score is loaded yet. Wait for lyrics or import a score.');
      if (message.type === 'LV_SCORE_GET') return { ok: true, score: record.score, review: record.review || [], tabId, mediaKey: key, analysis: await root.LvAnalysis?.analysisStatus() };
      if (message.expectedRevision !== record.score.revision) throw fail('REVISION_CONFLICT', 'The score changed. Reload it before editing.');
      let next;
      if (message.type === 'LV_SCORE_OPERATION') next = LvScore.applyOperation(record.score, message.operation, message.expectedRevision);
      else if (message.type === 'LV_SCORE_IMPORT') {
        LvScore.validateScore(message.score);
        if (LvScore.mediaKey(message.score.source) !== key) throw fail('SOURCE_MISMATCH', 'Import belongs to another video.');
        if (message.score.lyrics.contentHash !== record.score.lyrics.contentHash) throw fail('LYRIC_REVISION_MISMATCH', 'Import belongs to another lyric revision.');
        next = { ...message.score, revision: record.score.revision + 1 };
      } else if (message.type === 'LV_SCORE_UNDO') {
        if (!record.history?.length) throw fail('UNDO_EMPTY', 'Nothing to undo.');
        next = { ...record.history.pop(), revision: record.score.revision + 1 };
      } else if (message.type === 'LV_ALIGNMENT_PROPOSALS') {
        // A calibrated adapter may admit strong proposals. Raw ASR probabilities cannot.
        const proposals = (message.proposals || []).slice(0, 5000).map(p => ({ ...p, accepted: Boolean(p.accepted && message.diagnostics?.validatedForSinging === true && p.confidence >= 0.98) }));
        const reviewByWord = new Map((record.review || []).map(p => [p.wordId, p]));
        for (const proposal of proposals) {
          if (proposal.accepted) reviewByWord.delete(proposal.wordId);
          else reviewByWord.set(proposal.wordId, proposal);
        }
        record.review = [...reviewByWord.values()].slice(-5000);
        record.diagnostics = message.diagnostics;
        next = LvScore.applyAlignment(record.score, proposals, record.score.revision);
      } else if (message.type === 'LV_SCORE_REVIEW_APPLY') {
        const selected = new Set(message.wordIds || []);
        const proposals = (record.review || []).filter(p => selected.has(p.wordId)).map(p => ({ ...p, accepted: true }));
        next = LvScore.applyAlignment(record.score, proposals, record.score.revision);
        record.review = (record.review || []).filter(p => !selected.has(p.wordId));
      } else throw fail('MESSAGE_UNKNOWN', 'Unknown score operation.');
      if (message.type !== 'LV_SCORE_UNDO') record.history = [...(record.history || []), record.score].slice(-30);
      record.score = next;
      await liveIdentity(tabId, key);
      await chrome.storage.local.set({ [keyFor(key)]: record });
      await publish(tabId, record);
      return { ok: true, score: next, review: record.review || [], tabId, mediaKey: key };
    });
  }
  const types = new Set(['LV_ANALYSIS_CACHE_CLEAR_REQUEST', 'LV_EDITOR_OPEN', 'LV_SCORE_GET', 'LV_SCORE_OPERATION', 'LV_SCORE_IMPORT', 'LV_SCORE_UNDO', 'LV_SCORE_SEEK', 'LV_SCORE_TRANSPORT', 'LV_SCORE_REVIEW_APPLY', 'LV_ANALYSIS_START', 'LV_ANALYSIS_STOP', 'LV_ANALYSIS_STATUS', 'LV_ALIGNMENT_PROPOSALS']);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!types.has(message?.type)) return;
    // Only this extension can submit score mutations; content scripts supply their own tab ID.
    if (sender.id && sender.id !== chrome.runtime.id) return;
    handle(message, sender).then(respond, error => respond({ ok: false, error: { code: error.code || 'SCORE_ERROR', message: error.message } }));
    return true;
  });
  root.LvScoreHost = { ensure, packageFor, digest };
})(globalThis);
