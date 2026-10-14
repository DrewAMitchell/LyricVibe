/* Revisioned score owner. Raw lyric lookup caches may be shared; scores never are. */
(function (root) {
  const queues = new Map();
  const timingPreviews = new Map();
  const previewStorageKey = (previewKey) => `lvTimingPreview:${previewKey}`;
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
  // Unsaved previews are durable: they live in local storage next to saved
  // scores, keyed by video (not tab), so closing Chrome or reopening the video
  // in another tab resumes them. Older tab-scoped session previews migrate on read.
  async function readTimingPreview(previewKey) {
    let preview = timingPreviews.get(previewKey);
    if (!preview) {
      const storageKey = previewStorageKey(previewKey);
      preview = (await chrome.storage.local.get(storageKey))[storageKey];
      if (!preview) {
        const legacy = Object.entries(await chrome.storage.session.get(null) || {})
          .filter(([key, value]) => key.startsWith('lvTimingPreview:') && key.endsWith(`:${previewKey}`) && value?.score)
          .sort((a, b) => (b[1].previewRevision || 0) - (a[1].previewRevision || 0));
        if (legacy.length) {
          preview = legacy[0][1];
          await chrome.storage.local.set({ [storageKey]: preview });
          await chrome.storage.session.remove(legacy.map(([key]) => key));
        }
      }
      if (preview) timingPreviews.set(previewKey, preview);
    }
    return preview;
  }
  async function writeTimingPreview(previewKey, preview) {
    await chrome.storage.local.set({ [previewStorageKey(previewKey)]: preview });
    timingPreviews.set(previewKey, preview);
  }
  async function clearTimingPreview(previewKey) {
    timingPreviews.delete(previewKey);
    await chrome.storage.local.remove(previewStorageKey(previewKey));
  }
  async function publish(tabId, record) {
    const message = { type: 'LV_SCORE_UPDATED', tabId, mediaKey: LvScore.mediaKey(record.score.source), score: record.score, review: record.review || [], diagnostics: record.diagnostics || null };
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
    await chrome.runtime.sendMessage(message).catch(() => {});
  }
  async function publishTimingPreview(tabId, key, preview) {
    const message = { type: 'LV_TIMING_PREVIEW_UPDATED', tabId, mediaKey: key, preview };
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
    await chrome.runtime.sendMessage(message).catch(() => {});
  }
  async function publishTimingClosed(tabId, key) {
    const message = { type: 'LV_TIMING_PREVIEW_CLOSED', tabId, mediaKey: key };
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
    await chrome.runtime.sendMessage(message).catch(() => {});
  }
  async function liveIdentity(tabId, requested) {
    if (!Number.isInteger(tabId)) throw fail('SOURCE_REQUIRED', 'Open the editor from a playing YouTube tab.');
    const hints = await chrome.tabs.sendMessage(tabId, { type: 'LV_GET_HINTS' });
    if (hints.isAd) throw fail('ADVERTISEMENT_ACTIVE', 'Wait for the advertisement to finish.');
    if (hints.mediaReady === false) throw fail('SOURCE_UNREADY', 'Wait for the main video to finish loading.');
    const key = LvScore.mediaKey(hints);
    if (!key || (requested && key !== requested)) throw fail('SOURCE_CHANGED', 'The source video changed. Reopen its score.');
    return { key, hints };
  }
  function exactExtensionPage(sender, file) {
    if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
    try {
      const actual = new URL(sender.url), expected = new URL(chrome.runtime.getURL(file));
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    } catch { return false; }
  }
  function editorSourceBound(sender, tabId, key) {
    if (!exactExtensionPage(sender, 'editor.html') && !exactExtensionPage(sender, 'light-editor.html')) return false;
    const url = new URL(sender.url);
    return url.searchParams.get('sourceTab') === String(tabId) && url.searchParams.get('mediaKey') === key;
  }
  function sourceOverlayBound(sender, tabId, key) {
    return sender.id === chrome.runtime.id && sender.tab?.id === tabId &&
      LvScore.mediaKey({ url: sender.url || sender.tab.url }) === key &&
      LvScore.mediaKey({ url: sender.tab.url }) === key;
  }
  async function refreshDuration(key, record, hints) {
    const durationMs = Math.round((hints.duration || 0) * 1000);
    if (durationMs > 0 && Math.abs(durationMs - record.score.source.durationMs) > 1000) {
      record.history = [...(record.history || []), record.score].slice(-30);
      record.score = { ...record.score, revision: record.score.revision + 1, source: { ...record.score.source, durationMs } };
      await chrome.storage.local.set({ [keyFor(key)]: record });
    }
    return record.score;
  }
  function timingControlBound(sender, tabId, key) {
    return sender.id === chrome.runtime.id && (editorSourceBound(sender, tabId, key) ||
      (sender.tab?.id === tabId && LvScore.mediaKey({ url: sender.url || sender.tab.url }) === key));
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
        const { hints: currentHints } = await liveIdentity(tabId, key);
        return refreshDuration(key, record, currentHints);
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
    if (existing) return serial(key, async () => {
      const { hints: currentHints } = await liveIdentity(tabId, key);
      return refreshDuration(key, await read(key), currentHints);
    });
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
    if (message.type === 'LV_LIGHT_EDITOR_OPEN') {
      const { key } = await liveIdentity(tabId, message.mediaKey);
      if (!sourceOverlayBound(sender, tabId, key)) throw fail('SOURCE_REQUIRED', 'Open the lightweight editor from this video’s extension overlay.');
      await chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL(`light-editor.html?sourceTab=${tabId}&mediaKey=${encodeURIComponent(key)}${message.mode==='tempo'?'&mode=tempo':''}`), width: 1100, height: 650 });
      return { ok: true };
    }
    if (message.type === 'LV_NATIVE_ANALYSIS_STOP' || message.type === 'LV_NATIVE_ANALYSIS_STATUS') {
      const requested = message.mediaKey;
      if (!editorSourceBound(sender, tabId, requested)) throw fail('EDITOR_REQUIRED', 'Native analysis controls require the editor opened for this source tab.');
      return message.type === 'LV_NATIVE_ANALYSIS_STOP'
        ? { ok: true, analysis: await root.LvAnalysis.stopAnalysis({ tabId, mediaKey: requested }) }
        : { ok: true, analysis: await root.LvAnalysis.analysisStatus() };
    }
    const { key } = await liveIdentity(tabId, message.mediaKey);
    if(message.type==='LV_TEMPO_GET'||message.type==='LV_TEMPO_SET'){
      if(!editorSourceBound(sender,tabId,key))throw fail('EDITOR_REQUIRED','Tempo sections require the editor bound to this source tab.');
      return chrome.tabs.sendMessage(tabId,{...message,mediaKey:key});
    }
    if (['LV_SCORE_SEEK', 'LV_SCORE_TRANSPORT'].includes(message.type)) return chrome.tabs.sendMessage(tabId, { ...message, mediaKey: key });
    if (message.type.startsWith('LV_NATIVE_ANALYSIS_')) {
      if (!editorSourceBound(sender, tabId, key)) throw fail('EDITOR_REQUIRED', 'Native analysis controls require the editor opened for this source tab.');
      if (message.type === 'LV_NATIVE_ANALYSIS_START') {
        const record = await read(key);
        if (!record) throw fail('SCORE_MISSING', 'No timed score is loaded.');
        if (message.expectedRevision !== record.score.revision) throw fail('REVISION_CONFLICT', 'Reload the score before starting native analysis.');
        if (message.lyricsHash !== record.score.lyrics.contentHash) throw fail('LYRIC_REVISION_MISMATCH', 'The selected lyrics changed before analysis could start.');
        return { ok: true, analysis: await root.LvAnalysis.startAnalysis({ tabId, score: record.score, engine: 'native', expectedRevision: message.expectedRevision, lyricsHash: message.lyricsHash }) };
      }
    }
    if (message.type === 'LV_ANALYSIS_START') {
      const record = await read(key);
      if (!record) throw fail('SCORE_MISSING', 'No timed score is loaded.');
      return { ok: true, analysis: await root.LvAnalysis.startAnalysis({ tabId, score: record.score }) };
    }
    if (message.type === 'LV_ANALYSIS_STOP') return { ok: true, analysis: await root.LvAnalysis.stopAnalysis({ tabId, mediaKey: key }) };
    if (message.type === 'LV_ANALYSIS_STATUS') return { ok: true, analysis: await root.LvAnalysis.analysisStatus() };
    return serial(key, async () => {
      const record = await read(key);
      if (!record) throw fail('SCORE_MISSING', 'No timed score is loaded yet. Wait for lyrics or import a score.');
      if (message.type === 'LV_SCORE_GET') return { ok: true, score: record.score, review: record.review || [], diagnostics: record.diagnostics || null, tabId, mediaKey: key, analysis: await root.LvAnalysis?.analysisStatus() };
      if (message.expectedRevision !== record.score.revision) throw fail('REVISION_CONFLICT', 'The score changed. Reload it before editing.');
      if (message.type.startsWith('LV_TIMING_')) {
        if (!timingControlBound(sender, tabId, key)) throw fail('SOURCE_REQUIRED', 'Open Sync in this video’s extension overlay.');
        if (message.lyricsHash !== record.score.lyrics.contentHash) throw fail('LYRIC_REVISION_MISMATCH', 'Saved lyric revision changed. Refresh the preview.');
        const previewKey = key;
        if (message.type === 'LV_TIMING_PREPARE') {
          let candidate;
          if (message.fromSaved === true) {
            candidate = JSON.parse(JSON.stringify(record.score));
          } else {
            const { hints } = await liveIdentity(tabId, key);
            const result = await root.recognize({ hints });
            if (!result?.ok || !result.lyrics?.synced) throw fail('TIMING_UNAVAILABLE', 'No matching timed catalog source is available.');
            const hash = await digest(result.lyrics.synced);
            candidate = LvScore.createScore(record.score.source, result.lyrics.synced,
              { provider: result.lyrics.provider, entryId: String(result.match?.id ?? ''), contentHash: hash });
          }
          const draft = { ...root.LvTimingVariant.merge(record.score, candidate), token: crypto.randomUUID(), previewRevision: 0, undoScores: [],
            baseRevision: record.score.revision, baseHash: record.score.lyrics.contentHash };
          await liveIdentity(tabId, key); await writeTimingPreview(previewKey, draft); await publishTimingPreview(tabId, key, draft);
          return { ok: true, preview: draft, tabId, mediaKey: key };
        }
        if (message.type === 'LV_TIMING_CURRENT') {
          const preview = await readTimingPreview(previewKey);
          const currentPreview = preview && preview.baseRevision === record.score.revision && preview.baseHash === record.score.lyrics.contentHash
            ? preview : null;
          if (preview && !currentPreview) await clearTimingPreview(previewKey);
          return { ok: true, score: record.score, preview: currentPreview, tabId, mediaKey: key };
        }
        const draft = await readTimingPreview(previewKey);
        if (!draft || draft.token !== message.token || draft.baseRevision !== record.score.revision || draft.baseHash !== record.score.lyrics.contentHash) throw fail('PREVIEW_EXPIRED', 'Refresh this timing preview before continuing.');
        if (message.previewRevision !== draft.previewRevision) throw fail('PREVIEW_CONFLICT', 'This preview changed. Refresh before submitting another adjustment.');
        if (message.type === 'LV_TIMING_CANCEL') { await clearTimingPreview(previewKey); await publishTimingClosed(tabId, key); return { ok: true }; }
        if (message.type === 'LV_TIMING_TUNE') {
          const supplied = ['changes', 'operation', 'operations'].filter(name => Object.prototype.hasOwnProperty.call(message, name));
          if (supplied.length !== 1) throw fail('INVALID_TIMING', 'Submit exactly one of changes, operation, or operations.');
          const tunedDraft = supplied[0] === 'changes'
            ? root.LvTimingVariant.tune(draft, message.changes, message.allowProtected === true)
            : root.LvTimingVariant.operate(draft, supplied[0] === 'operation' ? message.operation : message.operations, message.allowProtected === true);
          const undoScores = [...(draft.undoScores || []), draft.score].slice(-5);
          const tuned = { ...tunedDraft, undoScores, previewRevision: draft.previewRevision + 1 };
          await writeTimingPreview(previewKey, tuned); await publishTimingPreview(tabId, key, tuned);
          return { ok: true, preview: tuned, tabId, mediaKey: key };
        }
        if (message.type === 'LV_TIMING_UNDO') {
          const undoScores = [...(draft.undoScores || [])];
          if (!undoScores.length) throw fail('PREVIEW_UNDO_EMPTY', 'There is no timing adjustment to undo.');
          const score = undoScores.pop();
          const undone = { ...draft, score, undoScores, previewRevision: draft.previewRevision + 1 };
          await writeTimingPreview(previewKey, undone); await publishTimingPreview(tabId, key, undone);
          return { ok: true, preview: undone, tabId, mediaKey: key };
        }
        if (message.type !== 'LV_TIMING_APPLY') throw fail('MESSAGE_UNKNOWN', 'Unknown timing preview action.');
        await liveIdentity(tabId, key);
        record.history = [...(record.history || []), record.score].slice(-30);
        record.score = { ...draft.score, revision: record.score.revision + 1 };
        record.review = []; record.diagnostics = null; delete record.lyricRevisionAvailable;
        await chrome.storage.local.set({ [keyFor(key)]: record });
        await clearTimingPreview(previewKey); await publish(tabId, record);
        return { ok: true, score: record.score, tabId, mediaKey: key };
      }
      let next;
      if (message.type === 'LV_NATIVE_ALIGNMENT_IMPORT') {
        if (!editorSourceBound(sender, tabId, key)) throw fail('EDITOR_REQUIRED', 'Import alignment from the editor opened for this source.');
        const receipt = LvScore.validateAlignmentReceipt(record.score, message.receipt);
        const pending = new Map((record.review || []).map(proposal => [proposal.wordId, proposal]));
        for (const proposal of receipt.proposals) pending.set(proposal.wordId, proposal);
        record.review = [...pending.values()].slice(-5000);
        record.diagnostics = { adapter: receipt.adapter, model: receipt.model, method: 'native-supplied-lyrics-alignment', automaticAdmissionEnabled: false };
        await liveIdentity(tabId, key);
        await chrome.storage.local.set({ [keyFor(key)]: record });
        await publish(tabId, record);
        return { ok: true, score: record.score, review: record.review, tabId, mediaKey: key };
      }
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
        const analysis = await root.LvAnalysis.analysisStatus();
        if (!exactExtensionPage(sender, 'analysis/offscreen.html') || !message.sessionId || message.sessionId !== analysis?.sessionId || message.tabId !== tabId || analysis?.tabId !== tabId || message.mediaKey !== key || analysis?.mediaKey !== key || ['stopped', 'error'].includes(analysis?.state)) {
          throw fail('ANALYSIS_SOURCE_MISMATCH', 'Alignment proposals must come from the active offscreen analysis session for this source.');
        }
        // No singing-calibrated adapter is installed. Diagnostics cannot grant admission.
        // A future calibrated adapter needs a host-owned policy, not a sender-supplied flag.
        const proposals = (message.proposals || []).slice(0, 5000).map(p => ({ ...p, accepted: false }));
        // Validate the envelope without adopting applyAlignment's incremented
        // clone: receiving evidence is not a score edit or an undo checkpoint.
        LvScore.applyAlignment(record.score, proposals, record.score.revision);
        const reviewByWord = new Map((record.review || []).map(p => [p.wordId, p]));
        for (const proposal of proposals) reviewByWord.set(proposal.wordId, proposal);
        record.review = [...reviewByWord.values()].slice(-5000);
        record.diagnostics = message.diagnostics;
        await liveIdentity(tabId, key);
        await chrome.storage.local.set({ [keyFor(key)]: record });
        await publish(tabId, record);
        return { ok: true, score: record.score, review: record.review, tabId, mediaKey: key };
      } else if (message.type === 'LV_SCORE_REVIEW_APPLY') {
        if (!editorSourceBound(sender, tabId, key)) throw fail('EDITOR_REQUIRED', 'Review proposals can only be applied from the editor opened for this source tab.');
        const selected = new Set(message.wordIds || []);
        const proposals = (record.review || []).filter(p => selected.has(p.wordId)).map(p => ({ ...p, accepted: true }));
        next = LvScore.applyAlignment(record.score, proposals, record.score.revision);
        record.review = (record.review || []).filter(p => !selected.has(p.wordId));
      } else throw fail('MESSAGE_UNKNOWN', 'Unknown score operation.');
      // A changed score revision invalidates pending timing evidence, including
      // its offset mapping. New analysis windows can extend review only while
      // no score edit, acceptance, import or undo intervenes.
      if (message.type !== 'LV_ALIGNMENT_PROPOSALS') { record.review = []; record.diagnostics = null; }
      if (message.type !== 'LV_SCORE_UNDO') record.history = [...(record.history || []), record.score].slice(-30);
      record.score = next;
      await liveIdentity(tabId, key);
      await chrome.storage.local.set({ [keyFor(key)]: record });
      await publish(tabId, record);
      return { ok: true, score: next, review: record.review || [], tabId, mediaKey: key };
    });
  }
  const types = new Set(['LV_ANALYSIS_CACHE_CLEAR_REQUEST', 'LV_EDITOR_OPEN', 'LV_LIGHT_EDITOR_OPEN', 'LV_SCORE_GET', 'LV_SCORE_OPERATION', 'LV_SCORE_IMPORT', 'LV_NATIVE_ALIGNMENT_IMPORT', 'LV_SCORE_UNDO', 'LV_SCORE_SEEK', 'LV_SCORE_TRANSPORT', 'LV_SCORE_REVIEW_APPLY', 'LV_ANALYSIS_START', 'LV_ANALYSIS_STOP', 'LV_ANALYSIS_STATUS', 'LV_NATIVE_ANALYSIS_START', 'LV_NATIVE_ANALYSIS_STOP', 'LV_NATIVE_ANALYSIS_STATUS', 'LV_ALIGNMENT_PROPOSALS']);
  types.add('LV_TEMPO_GET');types.add('LV_TEMPO_SET');
  for (const type of ['LV_TIMING_PREPARE', 'LV_TIMING_CURRENT', 'LV_TIMING_TUNE', 'LV_TIMING_UNDO', 'LV_TIMING_APPLY', 'LV_TIMING_CANCEL']) types.add(type);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!types.has(message?.type)) return;
    // Only this extension can submit score mutations; content scripts supply their own tab ID.
    if (sender.id && sender.id !== chrome.runtime.id) return;
    handle(message, sender).then(respond, error => respond({ ok: false, error: { code: error.code || 'SCORE_ERROR', message: error.message } }));
    return true;
  });
  root.LvScoreHost = { ensure, packageFor, digest };
})(globalThis);
