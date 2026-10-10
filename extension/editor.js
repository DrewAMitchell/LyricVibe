/* The editor and automation both submit the public score operations. */
(() => {
  'use strict';
  const helpers = {
    sourceTab(search) {
      const params = new URLSearchParams(search);
      const raw = params.get('sourceTab') ?? params.get('tabId');
      return raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    },
    seekTarget(mediaMs, durationMs) {
      return Math.round(Math.max(0, Math.min(durationMs > 0 ? durationMs : Infinity, mediaMs)));
    },
    sourcePlayback(message, sender, extensionId, tabId, mediaKey) {
      return message?.type === 'LV_SCORE_PLAYBACK' && sender?.id === extensionId && sender.tab?.id === tabId && message.mediaKey === mediaKey && Number.isFinite(message.mediaMs) && message.mediaMs >= 0 && typeof message.paused === 'boolean';
    },
    reviewProtection(word) {
      if (!word) return 'Unavailable word';
      if (word.locked) return 'Locked';
      return word.syllables?.some(segment => segment.locked) ? 'Protected syllable' : '';
    },
    syllablesForSplit(word, split, makeId = index => `${word.id}-syllable-${index}-${crypto.randomUUID()}`) {
      if (split === '') return [];
      const parts = split.split('|');
      if (parts.length > 32 || parts.some(part => !part.length) || parts.join('') !== word.text) throw Object.assign(new Error('Segments must join to the exact word text, including punctuation. Use | between nonempty segments (up to 32).'), { code: 'INVALID_SYLLABLE_SPLIT' });
      return parts.map((text, index) => ({ id: makeId(index), text, startMs: Math.round(word.startMs + index * (word.endMs - word.startMs) / parts.length), endMs: Math.round(word.startMs + (index + 1) * (word.endMs - word.startMs) / parts.length), provenance: 'estimated', locked: false, effects: [] }));
    },
    boundary(word, edge, deltaMs, durationMs, phraseStartMs = 0, phraseEndMs = durationMs) {
      const timing = { startMs: word.startMs, endMs: word.endMs };
      timing[edge === 'start' ? 'startMs' : 'endMs'] = Math.round(word[edge === 'start' ? 'startMs' : 'endMs'] + deltaMs);
      timing.startMs = Math.max(phraseStartMs, Math.min(timing.startMs, timing.endMs));
      timing.endMs = Math.max(timing.startMs, Math.min(timing.endMs, durationMs, phraseEndMs));
      return { type: 'setWordTiming', wordId: word.id, ...timing };
    },
    assertImport(current, incoming, core) {
      core.validateScore(incoming);
      if (core.mediaKey(current.source) !== core.mediaKey(incoming.source)) throw Object.assign(new Error('This file belongs to a different video. Open that source video before importing.'), { code: 'SOURCE_MISMATCH' });
      if (current.lyrics.contentHash !== incoming.lyrics.contentHash) throw Object.assign(new Error('This file belongs to a different lyric content revision.'), { code: 'LYRICS_MISMATCH' });
      return incoming;
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const core = globalThis.LvScore;
  const tabId = helpers.sourceTab(location.search);
  const requestedMediaKey = new URLSearchParams(location.search).get('mediaKey');
  const runtime = globalThis.chrome?.runtime;
  const live = tabId !== null && Boolean(runtime?.sendMessage);
  const localMode = !live && (new URLSearchParams(location.search).get('review') === 'local' || Boolean($('local-review-seed')));
  const state = { score: null, wordId: null, phraseId: null, mediaMs: 0, paused: true, positionDraft: false, loop: null, pxPerSecond: 64, history: [], busy: false, draft: false, draftRevision: null, analysis: null, review: [], reviewRevision: null, clockSeen: false, drag: null };
  let demoLast = 0;
  let tooltipTarget = null;
  let localPackage = null;
  let localMediaUrl = null;
  let mediaReady = false;
  let localDirty = false;
  let previewScore = null;
  let mediaLoadEpoch = 0;
  let reviewQueue = null;
  const hasAudio = () => localMode && mediaReady;
  const seconds = value => (value / 1000).toFixed(3);
  const time = value => `${Math.floor(Math.max(0, value) / 60000)}:${String(Math.floor(Math.max(0, value) / 1000) % 60).padStart(2, '0')}`;
  const findWord = () => state.score?.phrases.flatMap(p => p.words.map(w => ({ word: w, phrase: p }))).find(item => item.word.id === state.wordId);
  const selectedPhrase = () => state.score?.phrases.find(p => p.id === state.phraseId);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; }
  function error(error) { notice(`${error.code ? `${error.code} · ` : ''}${error.message || error}${state.draft ? ' Your draft is preserved.' : ''}`, 'error'); }
  function draft(value) { if (value && !state.draft) state.draftRevision = state.score?.revision; if (!value) state.draftRevision = null; state.draft = value; $('draft-state').textContent = value ? 'Unsaved draft' : localMode ? 'Applied' : 'Saved'; $('draft-state').classList.toggle('dirty', value); }
  function identity() { return { tabId, mediaKey: core.mediaKey(state.score.source) }; }
  async function send(type, payload = {}) {
    let response;
    try { response = await runtime.sendMessage({ type, ...(state.score ? identity() : { tabId, ...(requestedMediaKey ? { mediaKey: requestedMediaKey } : {}) }), ...payload }); }
    catch (cause) { throw Object.assign(new Error(`Editor → source tab: ${cause.message || 'runtime unavailable'}. Retry after reconnecting the source.`), { code: 'RUNTIME_UNAVAILABLE' }); }
    if (!response || response.ok !== true) throw Object.assign(new Error(response?.error?.message || 'The source did not acknowledge the request.'), { code: response?.error?.code || 'NO_RESPONSE' });
    return response;
  }
  function setScore(score, preserveDraft = false) {
    core.validateScore(score);
    if (state.score && core.mediaKey(score.source) !== core.mediaKey(state.score.source)) throw Object.assign(new Error('The source video changed. Reopen the editor from the current video.'), { code: 'SOURCE_CHANGED' });
    state.score = score;
    previewScore = null;
    if (live) { $('connection').textContent = 'Source connected'; $('connection').classList.add('live'); }
    if (!findWord()) { state.wordId = score.phrases[0]?.words[0]?.id || null; state.phraseId = score.phrases[0]?.id || null; }
    $('song-title').textContent = `${score.source.title || 'Untitled video'}${score.source.artist ? ` · ${score.source.artist}` : ''}`;
    $('song-source').textContent = `YouTube · ${score.source.videoId} · ${score.source.durationMs > 0 ? time(score.source.durationMs) : 'Duration unknown'} · ${score.lyrics.provider || 'Unknown lyric provider'}`;
    $('song-source').dataset.tip = `Exact media identity: ${core.mediaKey(score.source)}\nLyric SHA-256: ${score.lyrics.contentHash}`;
    $('revision').textContent = `Revision ${score.revision}`;
    $('save-state').textContent = live ? `Source tab ${tabId} · Saved revision ${score.revision}` : localMode ? `Local recording · Revision ${score.revision} · Export to keep edits` : `Synthetic demo · Local revision ${score.revision} · Not persisted`;
    if (!preserveDraft) { draft(false); populateInspector(); }
    renderTimeline(); renderPhrases(); renderClock();
    $('undo').disabled = state.busy || (!live && !state.history.length);
  }
  async function mutate(type, payload, description) {
    if (!state.score || state.busy) return { ok: false, error: { code: 'EDITOR_BUSY', message: 'Score unavailable or editor busy.' } };
    const before = state.score;
    const expectedRevision = type === 'LV_SCORE_REVIEW_APPLY' ? state.reviewRevision : state.draft ? state.draftRevision : before.revision;
    state.busy = true;
    try {
      let predicted;
      if (type === 'LV_SCORE_OPERATION') predicted = core.applyOperation(before, payload.operation, expectedRevision);
      if (type === 'LV_SCORE_IMPORT') predicted = helpers.assertImport(before, payload.score, core);
      if (type === 'LV_SCORE_REVIEW_APPLY') predicted = core.applyAlignment(before, state.review.filter(proposal => payload.wordIds.includes(proposal.wordId)).map(proposal => ({ ...proposal, accepted: true })), expectedRevision);
      if (live) {
        const result = await send(type, { ...payload, expectedRevision });
        if (result.score) { setScore(result.score); setReview(result.review || []); } else { const latest = await send('LV_SCORE_GET'); setScore(latest.score); setReview(latest.review || []); }
      } else {
        if (type === 'LV_SCORE_UNDO') {
          const previous = state.history.pop();
          if (!previous) return;
          setScore({ ...previous, revision: before.revision + 1 });
        } else {
          state.history.push(before); if (state.history.length > 50) state.history.shift();
          setScore(type === 'LV_SCORE_IMPORT' ? { ...predicted, revision: before.revision + 1 } : predicted);
        }
        setReview([]);
        if (localMode) localDirty = true;
      }
      notice(`${description} · Revision ${state.score.revision}${live ? ' saved to the source score.' : localMode ? '. Export to keep your edits; previous suggestions are now stale.' : ' in synthetic demo only.'}`, 'success');
      return { ok: true, score: structuredClone(state.score) };
    } catch (cause) { error(cause); return { ok: false, error: { code: cause.code || 'EDITOR_OPERATION_FAILED', message: cause.message } }; }
    finally { state.busy = false; $('undo').disabled = !live && !state.history.length; }
  }
  const operation = (operation, description) => mutate('LV_SCORE_OPERATION', { operation }, description);
  function select(wordId, focus = true, region = 'timeline') {
    if (state.draft && wordId !== state.wordId) { notice('Apply your current word draft before selecting another word, or press Escape to discard the draft.'); return; }
    state.wordId = wordId;
    const item = findWord();
    if (!item) return;
    state.phraseId = item.phrase.id;
    populateInspector(); renderTimeline(); renderPhrases(); updateLoopLabel();
    if (focus) document.querySelector(`${region === 'phrases' ? '.phrase-word' : '.word-block'}[data-word-id="${CSS.escape(wordId)}"]`)?.focus({ preventScroll: true });
  }
  function populateInspector() {
    const item = findWord();
    $('selection-empty').hidden = Boolean(item); $('selection-editor').hidden = !item;
    $('offset').value = state.score?.offsetMs || 0;
    if (!item) return;
    const { word, phrase } = item;
    $('selected-word').textContent = word.text;
    $('word-text').value = word.text;
    $('word-text-syllable-warning').hidden = true;
    $('word-start').value = seconds(word.startMs); $('word-end').value = seconds(word.endMs);
    $('word-lock').checked = word.locked;
    $('word-evidence').replaceChildren(el('span', word.provenance, word.provenance[0].toUpperCase() + word.provenance.slice(1)), el('span', 'muted', word.locked ? '· Locked' : '· Unlocked'));
    $('word-evidence').dataset.tip = word.provenance === 'estimated' ? 'Timing is estimated from lyric cues. No acoustic alignment evidence.' : word.provenance === 'manual' ? 'Timing was manually edited. Locked words resist automatic alignment.' : 'An accepted alignment proposal set this timing. Inspect analysis diagnostics for provider and evidence.';
    $('word-effect').value = word.effects[0]?.type || 'none'; $('effect-strength').value = word.effects[0]?.strength ?? 0.3;
    $('word-reveal').value = word.reveal?.easing || 'instant';
    $('strength-value').value = Number($('effect-strength').value).toFixed(2);
    renderSyllableInspector(word);
    $('phrase-text').textContent = phrase.words.map(w => w.text).join(' ');
    $('phrase-lane').replaceChildren(...state.score.lanes.map(lane => { const option = el('option', '', lane.label); option.value = lane.id; return option; }));
    $('phrase-lane').value = phrase.laneId;
    $('phrase-evidence').textContent = `${seconds(phrase.startMs)}–${seconds(phrase.endMs)}s · ${phrase.endEstimated ? 'End estimated · review silence' : 'Explicit phrase end'}`;
    $('phrase-start').value = seconds(phrase.startMs); $('phrase-end').value = seconds(phrase.endMs);
    renderSelectedProposal();
    updateLoopLabel();
  }
  function renderSyllableInspector(word) {
    const syllables = word.syllables || [];
    $('syllable-split').value = syllables.map(segment => segment.text).join('|');
    $('syllable-count').textContent = syllables.length ? `${syllables.length} segments` : 'Optional';
    $('syllable-list').replaceChildren(...syllables.map(segment => {
      const row = el('section', 'syllable-row'); row.dataset.syllableId = segment.id;
      const heading = el('div', 'syllable-heading');
      const name = el('strong', '', segment.text); const provenance = el('span', `${segment.provenance} small`, segment.provenance);
      const lockLabel = el('label', 'syllable-lock-label', 'Lock'); const lock = el('input'); lock.type = 'checkbox'; lock.checked = segment.locked; lock.setAttribute('aria-label', `Protect syllable ${segment.text} from alignment`); lock.onchange = () => operation({ type: 'setSyllableLock', syllableId: segment.id, locked: lock.checked }, 'Syllable protection updated').then(() => document.querySelector(`[data-syllable-id="${CSS.escape(segment.id)}"] .syllable-lock-label input`)?.focus({ preventScroll: true })); lockLabel.append(lock); heading.append(name, provenance, lockLabel);
      const timing = el('form', 'syllable-timing'); const fields = el('div', 'two-fields');
      const startLabel = el('label', '', 'Start · s'); const start = el('input'); start.type = 'number'; start.step = '0.001'; start.min = String(word.startMs / 1000); start.max = String(word.endMs / 1000); start.required = true; start.value = (segment.startMs / 1000).toFixed(3); start.setAttribute('aria-label', `${segment.text} start in source seconds`); startLabel.append(start);
      const endLabel = el('label', '', 'End · s'); const end = el('input'); end.type = 'number'; end.step = '0.001'; end.min = String(word.startMs / 1000); end.max = String(word.endMs / 1000); end.required = true; end.value = (segment.endMs / 1000).toFixed(3); end.setAttribute('aria-label', `${segment.text} end in source seconds`); endLabel.append(end); fields.append(startLabel, endLabel);
      const apply = el('button', 'wide', 'Save'); apply.type = 'submit'; apply.setAttribute('aria-label', `Save ${segment.text} syllable timing`); apply.dataset.tip = 'Save precise manual syllable timing within its parent word and lock it against alignment.'; timing.append(fields, apply); timing.onsubmit = event => { event.preventDefault(); operation({ type: 'setSyllableTiming', syllableId: segment.id, startMs: Math.round(Number(start.value) * 1000), endMs: Math.round(Number(end.value) * 1000) }, 'Syllable timing updated and locked').then(() => document.querySelector(`[data-syllable-id="${CSS.escape(segment.id)}"] .syllable-timing button`)?.focus({ preventScroll: true })); };
      const effects = el('form', 'syllable-effects'); const effectLabel = el('label', 'small', 'Effect'); const effect = el('select'); effect.setAttribute('aria-label', `${segment.text} syllable effect`);
      ['none', 'shake', 'tilt', 'pulse'].forEach(type => { const option = el('option', '', type[0].toUpperCase() + type.slice(1)); option.value = type; effect.append(option); }); effect.value = segment.effects[0]?.type || 'none'; effectLabel.append(effect);
      const strengthLabel = el('label', 'small', 'Strength'); const strength = el('input'); strength.type = 'number'; strength.min = '0'; strength.max = '1'; strength.step = '0.05'; strength.required = true; strength.value = segment.effects[0]?.strength ?? 0.3; strength.setAttribute('aria-label', `${segment.text} effect strength`); strengthLabel.append(strength);
      const applyEffect = el('button', '', 'Apply'); applyEffect.type = 'submit'; effects.append(effectLabel, strengthLabel, applyEffect); effects.onsubmit = event => { event.preventDefault(); operation({ type: 'setSyllableEffect', syllableId: segment.id, effect: effect.value === 'none' ? null : { type: effect.value, strength: Number(strength.value) } }, 'Syllable effect updated').then(() => document.querySelector(`[data-syllable-id="${CSS.escape(segment.id)}"] .syllable-effects button`)?.focus({ preventScroll: true })); };
      const revealLabel = el('label', 'syllable-reveal-label', 'Reveal'); const reveal = el('select', 'syllable-reveal'); reveal.setAttribute('aria-label', `${segment.text} syllable reveal`);
      [['instant', 'Instant'], ['linear', 'Sweep · linear'], ['ease-out', 'Sweep · ease out'], ['ease-in-out', 'Sweep · ease in/out']].forEach(([value, text]) => { const option = el('option', '', text); option.value = value; reveal.append(option); }); reveal.value = segment.reveal?.easing || 'instant';
      reveal.onchange = () => operation({ type: 'setSyllableReveal', syllableId: segment.id, reveal: reveal.value === 'instant' ? null : { type: 'sweep', easing: reveal.value } }, 'Syllable reveal updated').then(() => document.querySelector(`[data-syllable-id="${CSS.escape(segment.id)}"] .syllable-reveal`)?.focus({ preventScroll: true })); revealLabel.append(reveal);
      const appearance = el('details', 'syllable-appearance'); appearance.append(el('summary', '', 'Appearance'), effects, revealLabel);
      row.append(heading, timing, appearance); return row;
    }));
  }
  function renderTimeline() {
    if (!state.score) return;
    const extentMs = Math.max(state.score.source.durationMs, ...state.score.phrases.map(phrase => phrase.endMs + state.score.offsetMs), 10000);
    const width = Math.max(1, extentMs / 1000 * state.pxPerSecond);
    $('timeline').style.width = `${width}px`;
    $('ruler').replaceChildren(); $('tracks').replaceChildren();
    const tickSeconds = state.pxPerSecond >= 90 ? 1 : state.pxPerSecond >= 40 ? 2 : 5;
    for (let second = 0; second <= extentMs / 1000; second += tickSeconds) {
      const tick = el('div', 'tick'); tick.style.left = `${second * state.pxPerSecond}px`; tick.append(el('span', '', time(second * 1000))); $('ruler').append(tick);
    }
    const roles = ['lead', 'backing'];
    roles.forEach(role => {
      const lane = el('div', `lane ${role}`);
      state.score.phrases.filter(phrase => state.score.lanes.find(l => l.id === phrase.laneId)?.role === role).forEach(phrase => {
        const block = el('div', `phrase-block${phrase.endEstimated ? ' uncertain' : ''}${phrase.id === state.phraseId ? ' selected' : ''}`);
        block.style.left = `${(phrase.startMs + state.score.offsetMs) / 1000 * state.pxPerSecond}px`; block.style.width = `${(phrase.endMs - phrase.startMs) / 1000 * state.pxPerSecond}px`;
        phrase.words.forEach(word => {
          const button = el('button', `word-block ${word.provenance}${word.id === state.wordId ? ' selected' : ''}`);
          button.type = 'button'; button.dataset.wordId = word.id; button.setAttribute('aria-pressed', String(word.id === state.wordId));
          button.setAttribute('aria-label', `${word.text}, ${seconds(word.startMs)} to ${seconds(word.endMs)} seconds, ${word.provenance}${word.locked ? ', locked' : ''}`);
          button.dataset.tip = `${word.text} · ${seconds(word.startMs)}–${seconds(word.endMs)}s\n${word.provenance}${word.locked ? ' · Locked' : ''}. Select to edit; drag an edge for manual timing.`;
          button.style.left = `${(word.startMs - phrase.startMs) / 1000 * state.pxPerSecond}px`;
          button.style.width = `${Math.max(3, (word.endMs - word.startMs) / 1000 * state.pxPerSecond)}px`;
          button.append(el('span', 'word-label', `${word.text}${word.locked ? ' ⌑' : ''}`));
          (word.syllables || []).slice(1).forEach(segment => { const mark = el('span', 'syllable-boundary'); mark.style.left = `${(segment.startMs - word.startMs) / Math.max(1, word.endMs - word.startMs) * 100}%`; mark.setAttribute('aria-hidden', 'true'); button.append(mark); });
          ['start', 'end'].forEach(edge => { const handle = el('span', `boundary ${edge}`); handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true'); button.append(handle); });
          button.addEventListener('click', event => { if (!event.defaultPrevented) select(word.id); });
          block.append(button);
        });
        lane.append(block);
      });
      $('tracks').append(lane);
    });
    renderProposalTrack(); drawWaveform();
    renderClock();
  }
  function renderPhrases() {
    $('phrases').replaceChildren(...state.score.phrases.map(phrase => {
      const lane = state.score.lanes.find(l => l.id === phrase.laneId);
      const row = el('div', 'phrase-row');
      const seek = el('button', 'phrase-time', time(phrase.startMs + state.score.offsetMs)); seek.dataset.tip = 'Seek to this phrase'; seek.setAttribute('aria-label', `Seek to ${time(phrase.startMs + state.score.offsetMs)}`); seek.onclick = () => seekTo(phrase.startMs + state.score.offsetMs);
      const chip = el('span', `lane-chip ${lane.role}`, lane.label);
      const words = el('div', 'phrase-words');
      phrase.words.forEach(word => { const button = el('button', `phrase-word${word.id === state.wordId ? ' selected' : ''}`, word.text); button.dataset.wordId = word.id; button.setAttribute('aria-pressed', String(word.id === state.wordId)); button.onclick = () => select(word.id, true, 'phrases'); words.append(button); });
      row.append(seek, chip, words, el('span', 'uncertainty', phrase.endEstimated ? 'End estimated' : 'Explicit end'));
      return row;
    }));
  }
  function renderClock() {
    if (!state.positionDraft && document.activeElement !== $('position')) $('position').value = seconds(state.mediaMs);
    $('playhead').style.left = `${state.mediaMs / 1000 * state.pxPerSecond}px`;
    $('play').textContent = state.paused ? (live || localMode ? '▶ Play' : '▶ Play silent preview') : 'Ⅱ Pause';
    $('play').dataset.symbol = state.paused ? '▶' : 'Ⅱ';
    if (localMode) $('play').disabled = !mediaReady;
    if (localMode) document.body.classList.toggle('recording-ready', mediaReady);
    $('word-start-here').disabled = $('word-end-here').disabled = !state.paused || !findWord() || findWord()?.word.locked || (localMode && !mediaReady);
    if (!state.score) return;
    if (localMode) $('clock-mode').textContent = !mediaReady ? 'Choose a recording' : $('proposal-preview').checked && previewScore ? 'Recording clock · unverified model preview' : 'Recording clock · saved score';
    const active = core.activeAt(localMode && $('proposal-preview').checked && previewScore ? previewScore : state.score, state.mediaMs).phrases;
    $('lyric-preview').replaceChildren(...active.map(phrase => {
      const role = state.score.lanes.find(l => l.id === phrase.laneId)?.role;
      const line = el('span', `preview-line ${role}`); line.style.opacity = phrase.opacity;
      phrase.words.forEach((word, i) => {
        if (i) line.append(document.createTextNode(' '));
        const span = el('span', `preview-word${phrase.activeWords.includes(word.id) ? ' active' : ''}`);
        if (word.syllables?.length) word.syllables.forEach(segment => { const part = el('span', `preview-syllable${phrase.activeSyllables?.includes(segment.id) ? ' active' : ''}`, segment.text); applyPreviewReveal(part, segment); span.append(part); });
        else span.textContent = word.text;
        applyPreviewReveal(span, word);
        line.append(span);
      });
      return line;
    }));
    if (!active.length) $('lyric-preview').textContent = '—';
  }
  function applyPreviewReveal(node, item) {
    node.style.visibility = state.mediaMs - state.score.offsetMs >= item.startMs ? 'visible' : 'hidden';
    const progress = core.revealProgress(item, state.mediaMs, state.score.offsetMs);
    node.dataset.revealProgress = progress.toFixed(6);
    if (!item.reveal) return;
    node.classList.add('preview-reveal');
    node.style.clipPath = `inset(0 ${((1 - progress) * 100).toFixed(3)}% 0 0)`;
  }
  async function seekTo(mediaMs) {
    if (!state.score) return;
    if (!Number.isFinite(mediaMs)) { error(Object.assign(new Error('Enter a finite source position in seconds.'), { code: 'INVALID_TIME' })); return; }
    const target = helpers.seekTarget(mediaMs, state.score.source.durationMs);
    try { if (localMode && !mediaReady) throw new Error('Choose the recording before seeking.'); if (live) await send('LV_SCORE_SEEK', { mediaMs: target }); if (hasAudio()) $('local-media').currentTime = target / 1000; state.positionDraft = false; state.mediaMs = target; $('position').value = seconds(target); renderClock(); return { ok: true, mediaMs: target }; }
    catch (cause) { error(cause); return { ok: false, error: { code: cause.code || 'SEEK_FAILED', message: cause.message } }; }
  }
  async function transport(action, loop) {
    try {
      if (live) await send('LV_SCORE_TRANSPORT', { action, ...(loop ? { loop } : {}) });
      if (localMode && (action === 'play' || action === 'pause')) {
        if (action === 'play') { if (!mediaReady) throw new Error('Choose the recording before playing.'); await $('local-media').play(); }
        else $('local-media').pause();
      }
      if (action === 'play' || action === 'pause') state.paused = action === 'pause';
      if (action === 'setLoop' || action === 'clearLoop') state.loop = action === 'setLoop' ? loop : null;
      renderClock(); updateLoopLabel();
      return { ok: true };
    } catch (cause) { error(cause); return { ok: false, error: { code: cause.code || 'TRANSPORT_FAILED', message: cause.message } }; }
  }
  function updateLoopLabel() {
    const phrase = selectedPhrase();
    $('loop').setAttribute('aria-pressed', String(Boolean(state.loop)));
    $('loop-range').textContent = state.loop ? `Loop ${seconds(state.loop.startMs)}–${seconds(state.loop.endMs)}s` : phrase ? `${seconds(phrase.startMs + state.score.offsetMs)}–${seconds(phrase.endMs + state.score.offsetMs)}s` : 'Select a phrase to audition';
    $('loop').disabled = !phrase;
  }
  function analysisStatus(analysis) {
    state.analysis = analysis || {};
    const status = analysis?.state || analysis?.status || 'unavailable';
    const details = analysis?.error?.message || analysis?.message || analysis?.reason || analysis?.diagnostics?.message || analysis?.provider || '';
    const progress = Number(analysis?.progress?.progress);
    $('analysis-status').textContent = `${status}${Number.isFinite(progress) ? ` ${Math.round(progress)}%` : ''}${details ? ` · ${details}` : ''}`;
    $('analysis-status').dataset.tip = JSON.stringify(analysis || { status: 'unavailable' }, null, 2).slice(0, 1800);
    if (status === 'error' && analysis?.error) error(analysis.error);
    const active = ['running', 'starting', 'connecting-native', 'capturing', 'analyzing', 'loading-model', 'paused', 'waiting-clock'].includes(status);
    $('analysis-start').disabled = !live || active; $('analysis-stop').disabled = !live || !active; $('analysis-provider').disabled = !live || active;
  }
  async function analysisAction(type) {
    if (!live) return;
    try {
      const result = await send(type, { expectedRevision: state.score.revision, lyricsHash: state.score.lyrics.contentHash });
      const analysis = result.analysis || result.status || result;
      analysisStatus(analysis);
      if (analysis.state === 'error') {
        const cause = analysis.error || { code: 'ANALYSIS_FAILED', message: 'Analysis could not start. Inspect its status before retrying.' };
        error(cause);
        return { ok: false, error: { code: cause.code || 'ANALYSIS_FAILED', message: cause.message }, analysis };
      }
      notice(type.endsWith('_START') ? 'Analysis requested. Timings remain unverified suggestions until reviewed.' : type.endsWith('_STOP') ? 'Analysis stopped.' : 'Analysis status refreshed.');
      return result;
    }
    catch (cause) { error(cause); return { ok: false, error: { code: cause.code || 'ANALYSIS_FAILED', message: cause.message } }; }
  }
  function setReview(review, diagnostics = null) {
    state.review = review;
    state.alignmentDiagnostics = diagnostics;
    reviewQueue = localMode && review.length ? globalThis.LvReviewQueue.create(state.score, review) : null;
    previewScore = null;
    if (localMode && review.length) {
      const eligible = review.filter(proposal => !proposalProtection(proposal));
      if (eligible.length) { try { previewScore = core.applyAlignment(state.score, eligible.map(p => ({ ...p, accepted: true })), state.score.revision); } catch (cause) { error(cause); } }
    }
    $('review-open').textContent = `Review ${review.length} ↗`; $('review-open').disabled = !review.length;
    $('proposal-preview').disabled = !review.length;
    updateReviewQueue();
    if (state.score) { renderProposalTrack(); renderSelectedProposal(); renderClock(); }
    if ($('review-dialog').open) renderReview();
  }
  function proposalProtection(proposal) {
    const phrase = state.score?.phrases.find(p => p.words.some(w => w.id === proposal.wordId));
    const word = phrase?.words.find(w => w.id === proposal.wordId);
    return helpers.reviewProtection(word) || (phrase && !phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs) ? 'Adjust phrase bounds before accepting' : '');
  }
  function renderSelectedProposal() {
    const proposal = state.review.find(p => p.wordId === state.wordId);
    $('proposal-word').hidden = !localMode || !proposal;
    if (!proposal) return;
    const word = findWord()?.word;
    $('proposal-times').textContent = `${seconds(proposal.startMs)}–${seconds(proposal.endMs)} s · ${proposal.startMs - word.startMs >= 0 ? '+' : ''}${proposal.startMs - word.startMs} ms at start`;
    const protection = proposalProtection(proposal);
    const flags = globalThis.LvReviewQueue.diagnosticsForProposal(state.score, proposal).flags;
    const hints = { SHORT_WORD: 'Very short interval', LONG_WORD: 'Long interval: check sustain and silence', LARGE_SHIFT: 'Large timing shift', SAME_LANE_OVERLAP: 'Overlaps saved words' };
    $('proposal-protection').textContent = protection || (flags.length ? `${flags.map(flag => hints[flag]).join(' · ')}. Unverified model timing.` : 'Supplied lyric word · unverified model timing · audition before accepting');
    $('proposal-accept').textContent = reviewQueue?.selectedWordIds.includes(state.wordId) ? 'Kept · next' : 'Keep & next';
    $('proposal-accept').disabled = Boolean(protection) || state.busy;
    $('proposal-audition').disabled = !hasAudio();
  }
  function renderProposalTrack() {
    const track = $('proposal-track');
    if (!localMode || !state.score) return;
    track.replaceChildren(...state.review.map(proposal => {
      const word = state.score.phrases.flatMap(p => p.words).find(w => w.id === proposal.wordId);
      const button = el('button', `proposal-block${proposal.wordId === state.wordId ? ' selected' : ''}${reviewQueue?.selectedWordIds.includes(proposal.wordId) ? ' queued' : ''}`, word?.text || '');
      button.dataset.wordId = proposal.wordId; button.dataset.startMs = proposal.startMs; button.dataset.endMs = proposal.endMs;
      button.style.left = `${(proposal.startMs + state.score.offsetMs) / 1000 * state.pxPerSecond}px`;
      button.style.width = `${Math.max(4, (proposal.endMs - proposal.startMs) / 1000 * state.pxPerSecond)}px`;
      button.setAttribute('aria-label', `Proposed ${word?.text}: ${seconds(proposal.startMs)} to ${seconds(proposal.endMs)} seconds`);
      button.dataset.tip = `${word?.text} · proposed ${seconds(proposal.startMs)}–${seconds(proposal.endMs)}s\nSelect to audition and compare with saved timing below.`;
      button.onclick = () => { select(proposal.wordId, false); document.body.classList.remove('inspector-closed'); $('inspector-toggle').setAttribute('aria-expanded', 'true'); };
      return button;
    }));
  }
  function updateReviewQueue() {
    const count = reviewQueue?.selectedWordIds.length || 0;
    $('local-apply').textContent = `Apply ${count} reviewed`; $('local-apply').disabled = !count || state.draft || state.busy;
  }
  function keepProposal(wordId, checked = true) {
    if (!reviewQueue) throw new Error('No review queue is loaded.');
    reviewQueue = globalThis.LvReviewQueue.toggle(reviewQueue, wordId, checked, state.score);
    updateReviewQueue(); renderSelectedProposal(); renderProposalTrack();
  }
  function nextProposal() {
    const index = state.review.findIndex(p => p.wordId === state.wordId);
    const next = state.review[index + 1];
    if (!next) { notice('End of proposals. Apply your reviewed timings together, or open Review to change selections.'); return; }
    select(next.wordId, false);
    const scroll = $('timeline-scroll'); const x = (next.startMs + state.score.offsetMs) / 1000 * state.pxPerSecond;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 100) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * .3);
  }
  async function applyQueued() {
    if (state.draft) { notice('Apply or discard your word draft before applying reviewed timings.'); return; }
    const selected = globalThis.LvReviewQueue.selected(reviewQueue, state.score);
    if (!selected.length) return;
    return mutate('LV_SCORE_REVIEW_APPLY', { wordIds: selected.map(p => p.wordId) }, 'Reviewed timings applied together');
  }
  function drawWaveform() {
    if (!localPackage) return;
    const canvas = $('waveform'); const scroll = $('timeline-scroll'); const ratio = devicePixelRatio || 1;
    const width = scroll.clientWidth; const height = 54;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== height * ratio) canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#283641'; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
    const { peaks, bucketMs } = localPackage.waveform; const scale = state.pxPerSecond / 1000;
    const first = Math.max(0, Math.floor(scroll.scrollLeft / scale / bucketMs));
    const last = Math.min(peaks.length, Math.ceil((scroll.scrollLeft + width) / scale / bucketMs));
    ctx.fillStyle = '#79a6af';
    for (let i = first; i < last; i++) {
      const x = i * bucketMs * scale - scroll.scrollLeft; const amplitude = peaks[i] * (height / 2 - 5);
      ctx.fillRect(x, height / 2 - amplitude, Math.max(1, bucketMs * scale - 1), Math.max(1, amplitude * 2));
    }
  }
  async function auditionProposal(proposal) {
    if (!proposal) return;
    const startMs = helpers.seekTarget(proposal.startMs + state.score.offsetMs - 400, state.score.source.durationMs);
    const endMs = helpers.seekTarget(proposal.endMs + state.score.offsetMs + 500, state.score.source.durationMs);
    if (!(await transport('setLoop', { startMs, endMs })).ok || !(await seekTo(startMs)).ok || !(await transport('play')).ok) return;
    notice(`Auditioning ${findWord()?.word.text || 'proposal'} · ${seconds(startMs)}–${seconds(endMs)}s. Loop turns off when you press Loop.`);
  }
  function localFrame() {
    if (hasAudio()) {
      const audio = $('local-media');
      if (state.loop && !audio.paused && audio.currentTime * 1000 >= state.loop.endMs) audio.currentTime = state.loop.startMs / 1000;
      state.mediaMs = audio.currentTime * 1000; state.paused = audio.paused; renderClock();
    }
    if (localMode) requestAnimationFrame(localFrame);
  }
  function detachMedia() {
    mediaLoadEpoch++; mediaReady = false; $('local-media').pause(); $('local-media').removeAttribute('src'); $('local-media').load();
    if (localMediaUrl) URL.revokeObjectURL(localMediaUrl); localMediaUrl = null;
    state.paused = true; state.loop = null;
  }
  function waitForMetadata(url, epoch) {
    const audio = $('local-media');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Recording metadata did not load within 15 seconds.')), 15000);
      const loaded = () => finish(); const failed = () => finish(new Error('The browser could not decode this recording. Choose a supported local audio or video file.'));
      function finish(cause) { clearTimeout(timeout); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); if (epoch !== mediaLoadEpoch) reject(Object.assign(new Error('Recording selection changed.'), { code: 'SELECTION_CHANGED' })); else if (cause) reject(cause); else resolve(audio.duration * 1000); }
      audio.addEventListener('loadedmetadata', loaded); audio.addEventListener('error', failed); audio.src = url; audio.load();
    });
  }
  async function attachLocalMedia(file) {
    if (!localPackage) throw new Error('Open a review package first.');
    detachMedia(); const epoch = mediaLoadEpoch;
    if (file.size !== localPackage.audio.sizeBytes || file.size > 512 * 1024 * 1024) throw Object.assign(new Error('The recording size does not match this review package.'), { code: 'AUDIO_MISMATCH' });
    $('local-media-status').textContent = 'Checking recording identity…';
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (epoch !== mediaLoadEpoch) return;
    if (sha256 !== localPackage.audio.sha256) throw Object.assign(new Error('This recording does not match the package SHA-256.'), { code: 'AUDIO_MISMATCH' });
    localMediaUrl = URL.createObjectURL(file);
    const durationMs = await waitForMetadata(localMediaUrl, epoch);
    globalThis.LvLocalReview.validateMediaFile(localPackage.audio, { name: file.name, sizeBytes: file.size, durationMs, sha256 });
    mediaReady = true; state.mediaMs = $('local-media').currentTime * 1000;
    $('local-media-status').textContent = `${file.name} · recording verified · ${seconds(durationMs)} s`;
    $('connection').textContent = 'LOCAL RECORDING'; $('connection').classList.add('live'); $('clock-mode').textContent = 'Recording clock · proposed preview';
    renderSelectedProposal(); renderClock();
    notice('Recording verified. Select a proposed word above the saved lead timing, then audition or accept it.', 'success');
  }
  async function loadLocalPackage(incoming) {
    if (localDirty || state.draft || state.busy) throw new Error('Export your current edits and apply or discard drafts before opening another package.');
    const validated = globalThis.LvLocalReview.validatePackage(incoming);
    detachMedia(); localPackage = validated; state.score = null; state.history = []; state.mediaMs = 0; state.wordId = null; state.phraseId = null;
    setScore(validated.score); setReview(core.validateAlignmentReceipt(validated.score, validated.receipt).proposals);
    state.reviewRevision = state.score.revision;
    $('local-media-file').disabled = false; $('local-export').disabled = false;
    $('local-media-status').textContent = `Choose ${validated.audio.name} · ${state.review.length} model proposals · no timing changed`;
    $('analysis-status').textContent = `${state.review.length} native proposals · supplied-lyrics CTC · review required`;
    const first = state.review[0];
    if (first) { select(first.wordId, false); $('timeline-scroll').scrollLeft = Math.max(0, (first.startMs / 1000 - 2) * state.pxPerSecond); }
    drawWaveform();
  }
  function renderReview() {
    state.reviewRevision = state.score.revision;
    $('review-list').replaceChildren(...state.review.map(proposal => {
      const phrase = state.score.phrases.find(phrase => phrase.words.some(word => word.id === proposal.wordId));
      const word = phrase?.words.find(word => word.id === proposal.wordId);
      const outside = phrase && !phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs);
      const protection = helpers.reviewProtection(word) || (outside ? 'Adjust phrase bounds before accepting' : '');
      const row = el('div', 'review-row'); const check = el('input'); check.type = 'checkbox'; check.value = proposal.wordId; check.disabled = Boolean(protection); check.setAttribute('aria-label', `Accept timing for ${word?.text || proposal.wordId}`);
      if (localMode) check.checked = Boolean(reviewQueue?.selectedWordIds.includes(proposal.wordId));
      const details = el('span'); details.append(el('strong', '', word?.text || proposal.wordId), el('span', 'muted small', `${word ? `${seconds(word.startMs)}–${seconds(word.endMs)} → ` : ''}${seconds(proposal.startMs)}–${seconds(proposal.endMs)}s`), el('span', 'muted small', protection || 'Needs review'));
      const audition = el('button', 'quiet', live || localMode ? 'Audition' : 'Silent preview'); audition.type = 'button'; audition.disabled = localMode && !mediaReady;
      audition.onclick = async () => {
        const startMs = helpers.seekTarget(proposal.startMs + state.score.offsetMs - 250, state.score.source.durationMs);
        const endMs = helpers.seekTarget(proposal.endMs + state.score.offsetMs + 350, state.score.source.durationMs);
        await transport('setLoop', { startMs, endMs }); await seekTo(startMs); await transport('play');
        $('review-status').textContent = `${live || localMode ? 'Auditioning' : 'Silent preview'} ${word?.text || proposal.wordId} · ${seconds(startMs)}–${seconds(endMs)}s`;
      };
      row.dataset.tip = `Evidence: ${proposal.evidenceId}\nRaw model confidence is not calibrated for singing.`; row.append(check, details, audition); return row;
    }));
    $('review-apply').disabled = !$('review-list').querySelector('input:checked');
    $('review-status').textContent = `Revision ${state.reviewRevision} · ${state.review.length} proposals`;
  }
  function bind() {
    $('local-open').onclick = () => { const url = new URL('editor.html?review=local', location.href); if (live) window.open(url.href, '_blank'); else location.href = url.href; };
    $('local-review-file').onchange = async () => {
      const file = $('local-review-file').files[0]; if (!file) return;
      try { if (file.size > 5 * 1024 * 1024) throw new Error('Review package exceeds 5 MiB.'); await loadLocalPackage(await file.text()); notice('Package opened. Choose its original recording to audition the proposed timing.'); } catch (cause) { error(cause); }
    };
    $('local-media-file').onchange = async () => { const file = $('local-media-file').files[0]; if (!file) return; try { await attachLocalMedia(file); } catch (cause) { if (cause.code === 'SELECTION_CHANGED') return; detachMedia(); $('local-media-status').textContent = 'Recording unavailable · choose the matching original file'; renderClock(); error(cause); } };
    $('local-export').onclick = () => $('export').click();
    $('proposal-preview').onchange = () => { $('clock-mode').textContent = $('proposal-preview').checked ? 'Recording clock · proposed preview' : 'Recording clock · saved score'; renderClock(); };
    $('proposal-audition').onclick = () => auditionProposal(state.review.find(p => p.wordId === state.wordId));
    $('proposal-accept').onclick = () => { try { keepProposal(state.wordId); nextProposal(); } catch (cause) { error(cause); } };
    $('proposal-next').onclick = nextProposal;
    $('local-apply').onclick = () => applyQueued().catch(error);
    $('timeline-scroll').addEventListener('scroll', () => {
      const y = $('timeline-scroll').scrollTop;
      document.querySelectorAll('.lane-labels>div').forEach(label => { label.style.transform = `translateY(${-y}px)`; });
      drawWaveform();
    }, { passive: true });
    $('waveform').onclick = event => seekTo((event.clientX - $('waveform').getBoundingClientRect().left + $('timeline-scroll').scrollLeft) / state.pxPerSecond * 1000);
    $('local-media').addEventListener('ended', () => { state.paused = true; renderClock(); });
    $('local-media').addEventListener('error', () => { if (!mediaReady) return; mediaReady = false; state.paused = true; renderClock(); notice('Recording playback failed. Choose the original recording again.', 'error'); });
    $('text-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordText', wordId: state.wordId, text: $('word-text').value }, 'Word text updated'); };
    $('word-text').addEventListener('input', () => { const word = findWord()?.word; $('word-text-syllable-warning').hidden = !word?.syllables?.length || $('word-text').value === word.text; });
    $('timing-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordTiming', wordId: state.wordId, startMs: Math.round(Number($('word-start').value) * 1000), endMs: Math.round(Number($('word-end').value) * 1000) }, 'Word timing updated and locked'); };
    for (const edge of ['start', 'end']) $('word-' + edge + '-here').onclick = () => {
      if (!state.paused || !findWord() || findWord().word.locked || (localMode && !mediaReady)) return;
      const sourceMs = hasAudio() ? $('local-media').currentTime * 1000 : state.mediaMs;
      $('word-' + edge).value = seconds(Math.max(0, Math.round(sourceMs) - state.score.offsetMs)); draft(true);
      notice(`Playhead copied to ${edge}. Apply timing saves this manual boundary and locks the word.`);
    };
    $('word-lock').onchange = () => operation({ type: 'setWordLock', wordId: state.wordId, locked: $('word-lock').checked }, 'Word protection updated');
    $('effect-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordEffect', wordId: state.wordId, effect: $('word-effect').value === 'none' ? null : { type: $('word-effect').value, strength: Number($('effect-strength').value) } }, 'Word effect updated'); };
    $('reveal-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordReveal', wordId: state.wordId, reveal: $('word-reveal').value === 'instant' ? null : { type: 'sweep', easing: $('word-reveal').value } }, 'Word reveal updated'); };
    $('effect-strength').oninput = () => { $('strength-value').value = Number($('effect-strength').value).toFixed(2); draft(true); };
    $('phrase-lane').onchange = () => operation({ type: 'setPhraseLane', phraseId: state.phraseId, laneId: $('phrase-lane').value }, 'Phrase lane updated');
    $('syllable-split-form').onsubmit = event => { event.preventDefault(); const word = findWord()?.word; if (!word) return; try { operation({ type: 'setWordSyllables', wordId: word.id, syllables: helpers.syllablesForSplit(word, $('syllable-split').value) }, 'Estimated syllable split updated'); } catch (cause) { error(cause); } };
    $('syllable-editor').addEventListener('input', event => { if (event.target.matches('input,select')) draft(true); });
    $('phrase-timing-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setPhraseTiming', phraseId: state.phraseId, startMs: Math.round(Number($('phrase-start').value) * 1000), endMs: Math.round(Number($('phrase-end').value) * 1000) }, 'Phrase and contained word timing rescaled'); };
    $('offset-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setOffset', offsetMs: Number($('offset').value) }, 'Score offset updated'); };
    $('offset').addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      if (!event.deltaY) return;
      const step = event.altKey ? 1 : event.shiftKey ? 1000 : 100;
      $('offset').value = String((Number($('offset').value) || 0) + (event.deltaY < 0 ? step : -step));
      draft(true);
    }, { passive: false });
    ['word-text', 'word-start', 'word-end', 'word-effect', 'word-reveal', 'offset', 'phrase-start', 'phrase-end'].forEach(id => $(id).addEventListener('input', () => draft(true)));
    $('undo').onclick = () => mutate('LV_SCORE_UNDO', {}, 'Previous score restored');
    $('seek').onclick = () => seekTo(Number($('position').value) * 1000);
    $('position').oninput = () => { state.positionDraft = true; };
    $('position').onkeydown = event => { if (event.key === 'Enter') seekTo(Number($('position').value) * 1000); };
    $('seek-back').onclick = () => seekTo(state.mediaMs - 5000); $('seek-forward').onclick = () => seekTo(state.mediaMs + 5000);
    for (const [id, direction] of [['seek-fine-back', -1], ['seek-fine-forward', 1]]) $(id).onclick = async event => {
      if (!(await transport('pause')).ok) return;
      if (!(await transport('clearLoop')).ok) return;
      const currentMs = hasAudio() ? $('local-media').currentTime * 1000 : state.mediaMs;
      await seekTo(currentMs + direction * (event.altKey ? 10 : event.shiftKey ? 250 : 50));
    };
    $('play').onclick = () => transport(state.paused ? 'play' : 'pause');
    $('phrase-seek').onclick = () => { const phrase = selectedPhrase(); if (phrase) seekTo(phrase.startMs + state.score.offsetMs); };
    $('loop').onclick = () => { const phrase = selectedPhrase(); if (phrase) transport(state.loop ? 'clearLoop' : 'setLoop', { startMs: Math.max(0, phrase.startMs + state.score.offsetMs), endMs: Math.max(1, phrase.endMs + state.score.offsetMs) }); };
    $('zoom').oninput = () => { state.pxPerSecond = Number($('zoom').value); renderTimeline(); };
    $('ruler').onclick = event => seekTo((event.clientX - $('ruler').getBoundingClientRect().left) / state.pxPerSecond * 1000);
    $('inspector-toggle').onclick = () => {
      const restoreFocus = $('inspector').contains(document.activeElement);
      const closed = !document.body.classList.contains('inspector-closed');
      document.body.classList.toggle('inspector-closed', closed);
      $('inspector-toggle').setAttribute('aria-expanded', String(!closed));
      if (restoreFocus) $(closed ? 'inspector-expand' : 'inspector-collapse').focus();
      try { localStorage.setItem('lv-editor-inspector', closed ? 'closed' : 'open'); } catch {}
    };
    $('inspector-collapse').onclick = () => $('inspector-toggle').click();
    $('inspector-expand').onclick = () => $('inspector-toggle').click();
    let preferredInspectorWidth = $('inspector').getBoundingClientRect().width;
    const resizeInspector = width => {
      const maximum = Math.max(180, Math.min(600, document.querySelector('.workspace').clientWidth * (innerWidth <= 600 ? .58 : .55)));
      const value = Math.round(Math.max(180, Math.min(maximum, width)));
      $('inspector').style.width = `${value}px`;
      $('inspector-resize').setAttribute('aria-valuenow', String(value));
      $('inspector-resize').setAttribute('aria-valuemax', String(Math.round(maximum)));
      return value;
    };
    try { const savedWidth = Number(localStorage.getItem('lv-editor-inspector-width')); if (savedWidth >= 180 && savedWidth <= 600) preferredInspectorWidth = savedWidth; } catch {}
    resizeInspector(preferredInspectorWidth);
    const saveInspectorWidth = () => {
      preferredInspectorWidth = Math.round($('inspector').getBoundingClientRect().width);
      try { localStorage.setItem('lv-editor-inspector-width', String(preferredInspectorWidth)); } catch {}
    };
    $('inspector-resize').onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); const startX = event.clientX, startWidth = $('inspector').getBoundingClientRect().width;
      const handle = $('inspector-resize'); handle.focus(); handle.setPointerCapture(event.pointerId);
      handle.onpointermove = move => resizeInspector(startWidth + startX - move.clientX);
      const finish = () => { handle.onpointermove = null; handle.onpointerup = handle.onpointercancel = null; saveInspectorWidth(); };
      handle.onpointerup = handle.onpointercancel = finish;
    };
    $('inspector-resize').onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const width = $('inspector').getBoundingClientRect().width;
      resizeInspector(event.key === 'Home' ? 180 : event.key === 'End' ? 600 : width + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 50 : 10));
      saveInspectorWidth();
    };
    $('recording-toggle').onclick = () => {
      const open = !document.body.classList.contains('recording-setup-open');
      document.body.classList.toggle('recording-setup-open', open);
      $('recording-toggle').setAttribute('aria-expanded', String(open));
    };
    const compactCommands = matchMedia('(max-width:1050px)');
    const updateCommandLayout = () => {
      $('workspace-tools').open = $('transport-tools').open = !compactCommands.matches;
      hideTooltip();
    };
    updateCommandLayout(); compactCommands.addEventListener('change', updateCommandLayout);
    for (const id of ['workspace-tools', 'transport-tools']) $(id).addEventListener('click', event => {
      if (compactCommands.matches && event.target.closest('button')) $(id).open = false;
    });
    try { const setting = localStorage.getItem('lv-editor-inspector'); if (setting === 'closed' || (!setting && innerWidth < 800)) { document.body.classList.add('inspector-closed'); $('inspector-toggle').setAttribute('aria-expanded', 'false'); } } catch {}
    const analysisType = suffix => `LV_${$('analysis-provider').value === 'native' ? 'NATIVE_' : ''}ANALYSIS_${suffix}`;
    $('analysis-start').onclick = () => analysisAction(analysisType('START')); $('analysis-stop').onclick = () => analysisAction(analysisType('STOP')); $('analysis-refresh').onclick = () => analysisAction(analysisType('STATUS'));
    $('analysis-provider').onchange = () => { $('analysis-provider-note').textContent = $('analysis-provider').value === 'native' ? 'Native companion required. Temporary local audio; model timings require review.' : 'Browser model download: ~145 MiB GPU / ~39 MiB CPU. Timings require review.'; analysisAction(analysisType('STATUS')); };
    $('files-open').onclick = () => $('files-dialog').showModal();
    $('settings').onclick = () => { if (runtime?.openOptionsPage) runtime.openOptionsPage(); else notice('Settings are available in the installed extension. This is a synthetic file preview.'); };
    $('review-open').onclick = () => { renderReview(); $('review-dialog').showModal(); };
    $('review-stop').onclick = async () => { await transport('pause'); await transport('clearLoop'); };
    $('review-dialog').addEventListener('close', async () => { await transport('pause'); await transport('clearLoop'); });
    $('review-list').onchange = event => { try { if (localMode) keepProposal(event.target.value, event.target.checked); $('review-apply').disabled = !$('review-list').querySelector('input:checked'); } catch (cause) { error(cause); } };
    $('review-apply').onclick = async () => { const wordIds = [...$('review-list').querySelectorAll('input:checked')].map(input => input.value); if (!wordIds.length) return; await mutate('LV_SCORE_REVIEW_APPLY', { wordIds }, 'Selected timing proposals accepted'); $('review-status').textContent = $('notice').textContent; };
    $('export').onclick = () => {
      if (!state.score) return;
      try { core.validateScore(state.score); const url = URL.createObjectURL(new Blob([JSON.stringify(state.score, null, 2)], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = `lyricvibe-${state.score.source.videoId}-r${state.score.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); localDirty = false; $('file-status').textContent = 'Validated score download requested.'; if (localMode) notice('Score download requested. Import that JSON in the extension on the matching YouTube video to use your edits.', 'success'); } catch (cause) { $('file-status').textContent = cause.message; }
    };
    $('import-file').onchange = () => { $('import').disabled = !$('import-file').files.length; $('file-status').textContent = ''; };
    $('import').onclick = async () => {
      const file = $('import-file').files[0]; if (!file) return;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('JSON file exceeds the 5 MB limit.');
        if (state.draft || state.busy) throw new Error('Apply or discard your current draft before importing.');
        const incoming = JSON.parse(await file.text());
        if (incoming.version === 'lyricvibe.alignment.v1') {
          const receipt = core.validateAlignmentReceipt(state.score, incoming);
          state.busy = true;
          try {
            if (live) { const result = await send('LV_NATIVE_ALIGNMENT_IMPORT', { receipt, expectedRevision: state.score.revision }); setReview(result.review); }
            else setReview(receipt.proposals);
          } finally { state.busy = false; }
          notice('Timing suggestions loaded. Audition before accepting; no timing changed.', 'success');
          $('files-dialog').close(); renderReview(); $('review-dialog').showModal();
        } else {
          const score = helpers.assertImport(state.score, incoming, core);
          await mutate('LV_SCORE_IMPORT', { score }, 'Score imported');
          $('file-status').textContent = $('notice').textContent;
        }
      } catch (cause) { $('file-status').textContent = `${cause.code || 'INVALID_FILE'} · ${cause.message}`; }
    };
    document.addEventListener('keydown', event => {
      const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === 'Escape' && state.positionDraft && event.target === $('position')) { state.positionDraft = false; $('position').value = seconds(state.mediaMs); return; }
      if (event.key === 'Escape' && state.draft) { draft(false); populateInspector(); notice('Draft discarded. Saved word restored.'); return; }
      if (event.key === 'Escape') { $('workspace-tools').open = $('transport-tools').open = !compactCommands.matches; }
      if (editing || $('files-dialog').open || $('review-dialog').open) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $('undo').click(); }
      else if (event.code === 'Space' && !event.target.closest('button,summary,a')) { event.preventDefault(); $('play').click(); }
      else if (event.key.toLowerCase() === 'i') $('inspector-toggle').click();
    });
    document.addEventListener('pointerdown', beginDrag);
    document.addEventListener('pointerover', event => { const target = event.target.closest('[data-tip]'); if (target) showTooltip(target); });
    document.addEventListener('focusin', event => { const target = event.target.closest('[data-tip]'); if (target) showTooltip(target); else hideTooltip(); });
    document.addEventListener('pointerout', event => { if (!event.relatedTarget?.closest?.('[data-tip]')) hideTooltip(); });
    document.addEventListener('pointerdown', hideTooltip);
    window.addEventListener('resize', () => { resizeInspector(preferredInspectorWidth); hideTooltip(); drawWaveform(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(drawWaveform).observe($('timeline-scroll'));
    window.addEventListener('beforeunload', event => { if (state.draft || state.busy || localDirty) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => { if (localMode) detachMedia(); });
  }
  function beginDrag(event) {
    const handle = event.target.closest('.boundary');
    if (!handle || event.button !== 0 || state.busy) return;
    event.preventDefault(); event.stopPropagation();
    const button = handle.closest('.word-block');
    if (state.draft) { notice('Apply or discard your current draft before dragging a boundary.'); return; }
    const item = state.score.phrases.flatMap(p => p.words.map(w => ({ word: w, phrase: p }))).find(item => item.word.id === button.dataset.wordId);
    if (item.word.locked) { notice('This word is locked. Turn off “Protect from alignment” in the inspector before changing its word timing.'); return; }
    select(item.word.id);
    const word = { ...item.word }; const edge = handle.dataset.edge; const x = event.clientX;
    state.drag = { wordId: word.id, revision: state.score.revision };
    document.body.classList.add('dragging');
    let proposed = null;
    const move = moveEvent => {
      const deltaMs = (moveEvent.clientX - x) / state.pxPerSecond * 1000;
      proposed = helpers.boundary(word, edge, deltaMs, state.score.source.durationMs > 0 ? state.score.source.durationMs : Infinity, item.phrase.startMs, item.phrase.endMs);
      $('word-start').value = seconds(proposed.startMs); $('word-end').value = seconds(proposed.endMs); draft(true);
      const target = document.querySelector(`.word-block[data-word-id="${CSS.escape(word.id)}"]`);
      if (target) { target.style.left = `${(proposed.startMs - item.phrase.startMs) / 1000 * state.pxPerSecond}px`; target.style.width = `${Math.max(3, (proposed.endMs - proposed.startMs) / 1000 * state.pxPerSecond)}px`; }
      notice(`Manual timing preview · ${word.text}: ${seconds(proposed.startMs)}–${seconds(proposed.endMs)}s · Release to save and lock`);
    };
    const finish = async finishEvent => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('dragging');
      const revision = state.drag?.revision; state.drag = null;
      // Suppress the pointer-generated click after replacing timeline nodes.
      finishEvent.preventDefault();
      if (!proposed) return;
      if (revision !== state.score.revision) { error(Object.assign(new Error('The score changed during your drag. Review the preserved timing fields and apply again.'), { code: 'REVISION_CONFLICT' })); renderTimeline(); return; }
      await operation(proposed, 'Dragged word timing saved and locked');
    };
    const cancel = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', cancel); document.body.classList.remove('dragging'); state.drag = null; draft(false); populateInspector(); renderTimeline(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', cancel);
  }
  function showTooltip(target) {
    if (!target.dataset.tip || state.drag) return;
    tooltipTarget?.removeAttribute('aria-describedby'); tooltipTarget = target;
    const tip = $('tooltip'); tip.textContent = target.dataset.tip; tip.hidden = false; tip.style.whiteSpace = 'pre-line'; target.setAttribute('aria-describedby', 'tooltip');
    const bounds = target.getBoundingClientRect(); const rect = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, bounds.left))}px`;
    tip.style.top = `${Math.max(8, bounds.bottom + rect.height + 8 > innerHeight ? bounds.top - rect.height - 8 : bounds.bottom + 8)}px`;
  }
  function hideTooltip() { $('tooltip').hidden = true; tooltipTarget?.removeAttribute('aria-describedby'); tooltipTarget = null; }
  async function demoScore() {
    const text = 'my own|together|stay with me';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const rows = [
      ['lead', 3000, 6500, ['my', 'own'], 'estimated', false],
      ['lead', 8000, 11600, ['together'], 'estimated', false],
      ['backing', 8500, 12200, ['stay', 'with', 'me'], 'estimated', true]
    ];
    const score = { version: 'lyricvibe.score.v1', revision: 0, offsetMs: 0, source: { platform: 'youtube', videoId: 'DEMO_ONLY01', title: 'Silent timing demo', artist: '', durationMs: 16000 }, lyrics: { provider: 'synthetic-fixture', entryId: null, contentHash }, lanes: [{ id: 'lead', role: 'lead', label: 'Lead' }, { id: 'backing', role: 'backing', label: 'Backing' }], phrases: rows.map(([laneId, startMs, endMs, words, provenance, endEstimated], i) => ({ id: `p${i}`, laneId, startMs, endMs, endEstimated, fadeOutMs: 180, words: words.map((text, j) => ({ id: `w${i}-${j}`, text, startMs: Math.round(startMs + j * (endMs - startMs) / words.length), endMs: Math.round(startMs + (j + 1) * (endMs - startMs) / words.length - 100), provenance, locked: false, effects: [] })) })) };
    const own = score.phrases[0].words[1]; own.reveal = { type: 'sweep', easing: 'ease-out' };
    const together = score.phrases[1].words[0];
    together.syllables = [{ id: 'demo-to', text: 'to', startMs: 8000, endMs: 8900 }, { id: 'demo-ge', text: 'ge', startMs: 8900, endMs: 9700 }, { id: 'demo-ther', text: 'ther', startMs: 9700, endMs: 11500 }].map(segment => ({ ...segment, provenance: 'estimated', locked: false, effects: [], reveal: { type: 'sweep', easing: 'linear' } }));
    core.validateScore(score); return score;
  }
  async function demoPreset(kind) {
    if (state.draft) { notice('Apply the current draft or press Escape before changing demo scenes.'); return; }
    state.paused = true; state.loop = null;
    const word = state.score.phrases.flatMap(phrase => phrase.words).find(word => word.text === (kind === 'word' ? 'own' : 'together'));
    if (!word) return;
    select(word.id, false);
    $('syllable-editor').open = kind !== 'word'; $('appearance-editor').open = kind === 'word';
    document.body.classList.remove('inspector-closed'); $('inspector-toggle').setAttribute('aria-expanded', 'true');
    await seekTo(kind === 'word' ? word.startMs + (word.endMs - word.startMs) * .35 + state.score.offsetMs : 9300 + state.score.offsetMs);
    $('timeline-scroll').scrollLeft = Math.max(0, (word.startMs / 1000 - 1) * state.pxPerSecond);
    $('inspector').scrollTop = 0;
    $('demo-word').setAttribute('aria-pressed', String(kind === 'word')); $('demo-syllables').setAttribute('aria-pressed', String(kind !== 'word'));
    notice(kind === 'word' ? '“own” reveals left to right with ease out. Play or seek to inspect the exposure.' : '“together” has three timed segments: to · ge · ther. Backing vocals run independently below.');
  }
  function demoFrame(now) {
    if (!live && !localMode && state.score && !state.paused) {
      state.mediaMs += Math.min(100, now - (demoLast || now));
      if (state.loop && state.mediaMs >= state.loop.endMs) state.mediaMs = state.loop.startMs;
      if (state.mediaMs >= state.score.source.durationMs) { state.mediaMs = state.score.source.durationMs; state.paused = true; }
      renderClock();
    }
    demoLast = now; requestAnimationFrame(demoFrame);
  }
  async function init() {
    bind();
    if (!core) { notice('SCORE_CORE_MISSING · The shared score engine could not load. Open the packaged extension with score-core.js present.', 'error'); return; }
    if (localMode) {
      document.body.classList.add('local-review'); $('local-setup').hidden = false; $('proposal-controls').hidden = false;
      $('recording-toggle').hidden = false;
      $('waveform').hidden = false; $('proposal-track').hidden = false; document.querySelectorAll('.local-lane-label').forEach(node => { node.hidden = false; });
      $('connection').textContent = 'LOCAL REVIEW'; $('clock-mode').textContent = 'Choose a recording';
      $('song-title').textContent = 'Review native timing against your recording'; $('song-source').textContent = 'Local playback · no audio upload';
      $('local-open').hidden = true; $('settings').hidden = true; $('play').disabled = true; $('local-apply').hidden = false;
      $('play').dataset.tip = 'Play or pause the selected local recording. Shortcut: Space';
      analysisStatus({ state: 'unavailable', message: 'Open a native review package and its recording' });
      $('local-media').addEventListener('timeupdate', () => {
        if (hasAudio() && state.loop && !$('local-media').paused && $('local-media').currentTime * 1000 >= state.loop.endMs) $('local-media').currentTime = state.loop.startMs / 1000;
      });
      requestAnimationFrame(localFrame);
      const seed = $('local-review-seed');
      if (seed) {
        const data = JSON.parse(seed.textContent); await loadLocalPackage(data.package);
        const mediaUrl = new URL(data.mediaUrl); if (mediaUrl.protocol !== 'file:') throw new Error('A prepared launcher must reference a local file.');
        const epoch = mediaLoadEpoch;
        const durationMs = await waitForMetadata(mediaUrl.href, epoch);
        if (Math.abs(durationMs - localPackage.audio.durationMs) > 500) throw new Error('Prepared recording duration changed. Choose the original file to verify it.');
        mediaReady = true;
        $('local-media-status').textContent = `${localPackage.audio.name} · identity checked when package was prepared`;
        $('connection').textContent = 'LOCAL RECORDING'; $('connection').classList.add('live'); $('clock-mode').textContent = 'Recording clock · proposed preview';
        renderSelectedProposal(); renderClock(); notice('Actual recording ready. Select a proposed word, then audition it. Previewing does not change saved timing.');
      } else notice('Open the native review package, then choose its recording. Timing and media identity are checked before review.');
    } else if (live) {
      $('connection').textContent = 'Connecting source'; $('clock-mode').textContent = 'Waiting for source clock';
      runtime.onMessage.addListener((message, sender) => {
        const expectedKey = state.score ? core.mediaKey(state.score.source) : requestedMediaKey;
        if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATE' && message.analysis?.tabId === tabId && (!expectedKey || message.analysis.mediaKey === expectedKey)) analysisStatus(message.analysis);
        if (message.type === 'LV_SCORE_PLAYBACK') {
          if (!helpers.sourcePlayback(message, sender, runtime.id, tabId, expectedKey)) return;
          state.mediaMs = message.mediaMs; state.paused = message.paused; state.clockSeen = true;
          $('clock-mode').textContent = 'Live source clock'; renderClock(); return;
        }
        if (message.tabId !== tabId || (expectedKey && message.mediaKey !== expectedKey)) return;
        if (message.type === 'LV_SCORE_UPDATED') { try { setScore(message.score, state.draft || Boolean(state.drag)); if (message.review) setReview(message.review, message.diagnostics); if (state.draft) notice('Source score updated. Your draft retains its original revision. Review it, then press Escape to reload saved fields before retrying.'); } catch (cause) { error(cause); } }
        if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATE' && message.analysis) analysisStatus(message.analysis);
      });
      try { const result = await send('LV_SCORE_GET'); setScore(result.score); setReview(result.review || [], result.diagnostics); analysisStatus(result.analysis); notice('Select a word to adjust timing. Changes save to this exact video and lyric revision.'); }
      catch (cause) { $('connection').textContent = 'Source unavailable'; $('connection').classList.remove('live'); error(cause); }
    } else {
      document.body.classList.add('demo'); $('demo-presets').hidden = false;
      $('connection').textContent = 'SYNTHETIC DEMO'; $('clock-mode').textContent = 'Synthetic clock · no audio';
      setScore(await demoScore()); analysisStatus({ state: 'unavailable', message: 'Demo has no source audio or model evidence' });
      $('demo-word').onclick = () => demoPreset('word'); $('demo-syllables').onclick = () => demoPreset('syllables');
      $('play').dataset.tip = 'Advance this silent synthetic preview. No audio plays. Shortcut: Space';
      await demoPreset('syllables');
      if (matchMedia('(max-width:800px)').matches) { document.body.classList.add('inspector-closed'); $('inspector-toggle').setAttribute('aria-expanded', 'false'); }
      requestAnimationFrame(demoFrame);
    }
  }
  // UI automation and agents use the same score operations and transport as the controls.
  globalThis.LvEditor = Object.freeze({
    getState() {
      return structuredClone({ version: 'lyricvibe.editor-state.v1', mode: live ? 'youtube' : localMode ? 'local-recording' : 'synthetic', score: state.score, review: state.review, queuedWordIds: reviewQueue?.selectedWordIds || [], playback: { mediaMs: hasAudio() ? $('local-media').currentTime * 1000 : state.mediaMs, paused: hasAudio() ? $('local-media').paused : state.paused, loop: state.loop }, analysis: state.analysis, alignmentDiagnostics: state.alignmentDiagnostics || null, draft: state.draft, busy: state.busy, audioReady: hasAudio() });
    },
    async dispatch(request) {
      try {
        if (!state.score || state.busy || state.draft) throw Object.assign(new Error('Open a score and apply or discard pending drafts first.'), { code: 'EDITOR_BUSY' });
        if (request?.mediaKey !== core.mediaKey(state.score.source)) throw Object.assign(new Error('Editor source does not match request.'), { code: 'SOURCE_MISMATCH' });
        if (request.lyricsHash !== state.score.lyrics.contentHash) throw Object.assign(new Error('Editor lyric hash does not match request.'), { code: 'LYRIC_REVISION_MISMATCH' });
        if (request.expectedRevision !== state.score.revision) throw Object.assign(new Error('Editor revision changed; read state before retrying.'), { code: 'REVISION_CONFLICT' });
        if (request.type === 'LV_SCORE_OPERATION') return await mutate(request.type, { operation: request.operation }, 'Agent score operation applied');
        if (request.type === 'LV_SCORE_UNDO') return await mutate(request.type, {}, 'Previous score restored');
        if (['LV_NATIVE_ANALYSIS_START', 'LV_NATIVE_ANALYSIS_STOP', 'LV_NATIVE_ANALYSIS_STATUS'].includes(request.type) && live) { $('analysis-provider').value = 'native'; return await analysisAction(request.type); }
        if (request.type === 'LV_SCORE_REVIEW_SELECT' && localMode) { keepProposal(request.wordId, request.checked); return { ok: true, queuedWordIds: [...reviewQueue.selectedWordIds] }; }
        if (request.type === 'LV_SCORE_REVIEW_APPLY' && localMode) {
          if (request.wordIds !== undefined) { if (!Array.isArray(request.wordIds)) throw new Error('wordIds must be an array.'); let nextQueue = reviewQueue; for (const wordId of request.wordIds) nextQueue = globalThis.LvReviewQueue.toggle(nextQueue, wordId, true, state.score); reviewQueue = nextQueue; updateReviewQueue(); renderSelectedProposal(); renderProposalTrack(); }
          return await applyQueued() || { ok: false, error: { code: 'EMPTY_SELECTION', message: 'No timings selected.' } };
        }
        if (request.type === 'LV_SCORE_SEEK') { if (!Number.isFinite(request.mediaMs)) throw new Error('mediaMs must be finite.'); return await seekTo(request.mediaMs); }
        if (request.type === 'LV_SCORE_TRANSPORT') {
          if (!['play', 'pause', 'setLoop', 'clearLoop'].includes(request.action)) throw new Error('Unknown transport action.');
          if (request.action === 'setLoop' && (!Number.isFinite(request.loop?.startMs) || !Number.isFinite(request.loop?.endMs) || request.loop.startMs < 0 || request.loop.endMs <= request.loop.startMs || request.loop.endMs > state.score.source.durationMs)) throw new Error('Loop must fit inside the source duration.');
          return await transport(request.action, request.loop);
        }
        throw Object.assign(new Error('Unsupported editor request type.'), { code: 'INVALID_OPERATION' });
      } catch (cause) { return { ok: false, error: { code: cause.code || 'INVALID_OPERATION', message: cause.message } }; }
    }
  });
  init().catch(error);
})();
