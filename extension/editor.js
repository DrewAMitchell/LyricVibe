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
  const state = { score: null, wordId: null, phraseId: null, mediaMs: 0, paused: true, positionDraft: false, loop: null, pxPerSecond: 64, history: [], busy: false, draft: false, draftRevision: null, analysis: null, review: [], reviewRevision: null, clockSeen: false, drag: null };
  let demoLast = 0;
  let tooltipTarget = null;
  const seconds = value => (value / 1000).toFixed(2);
  const time = value => `${Math.floor(Math.max(0, value) / 60000)}:${String(Math.floor(Math.max(0, value) / 1000) % 60).padStart(2, '0')}`;
  const findWord = () => state.score?.phrases.flatMap(p => p.words.map(w => ({ word: w, phrase: p }))).find(item => item.word.id === state.wordId);
  const selectedPhrase = () => state.score?.phrases.find(p => p.id === state.phraseId);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; }
  function error(error) { notice(`${error.code ? `${error.code} · ` : ''}${error.message || error}${state.draft ? ' Your draft is preserved.' : ''}`, 'error'); }
  function draft(value) { if (value && !state.draft) state.draftRevision = state.score?.revision; if (!value) state.draftRevision = null; state.draft = value; $('draft-state').textContent = value ? 'Unsaved draft' : 'Saved'; $('draft-state').classList.toggle('dirty', value); }
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
    if (live) { $('connection').textContent = 'Source connected'; $('connection').classList.add('live'); }
    if (!findWord()) { state.wordId = score.phrases[0]?.words[0]?.id || null; state.phraseId = score.phrases[0]?.id || null; }
    $('song-title').textContent = `${score.source.title || 'Untitled video'}${score.source.artist ? ` · ${score.source.artist}` : ''}`;
    $('song-source').textContent = `YouTube · ${score.source.videoId} · ${score.source.durationMs > 0 ? time(score.source.durationMs) : 'Duration unknown'} · ${score.lyrics.provider || 'Unknown lyric provider'}`;
    $('song-source').dataset.tip = `Exact media identity: ${core.mediaKey(score.source)}\nLyric SHA-256: ${score.lyrics.contentHash}`;
    $('revision').textContent = `Revision ${score.revision}`;
    $('save-state').textContent = live ? `Source tab ${tabId} · Saved revision ${score.revision}` : `Synthetic demo · Local revision ${score.revision} · Not persisted`;
    if (!preserveDraft) { draft(false); populateInspector(); }
    renderTimeline(); renderPhrases(); renderClock();
    $('undo').disabled = state.busy || (!live && !state.history.length);
  }
  async function mutate(type, payload, description) {
    if (!state.score || state.busy) return;
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
      }
      notice(`${description} · Revision ${state.score.revision}${live ? ' saved to the source score.' : ' in synthetic demo only.'}`, 'success');
    } catch (cause) { error(cause); }
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
    $('play').textContent = state.paused ? (live ? '▶ Play' : '▶ Play silent preview') : 'Ⅱ Pause';
    if (!state.score) return;
    const active = core.activeAt(state.score, state.mediaMs).phrases;
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
    try { if (live) await send('LV_SCORE_SEEK', { mediaMs: target }); state.positionDraft = false; state.mediaMs = target; $('position').value = seconds(target); renderClock(); }
    catch (cause) { error(cause); }
  }
  async function transport(action, loop) {
    try {
      if (live) await send('LV_SCORE_TRANSPORT', { action, ...(loop ? { loop } : {}) });
      if (action === 'play' || action === 'pause') state.paused = action === 'pause';
      if (action === 'setLoop' || action === 'clearLoop') state.loop = action === 'setLoop' ? loop : null;
      renderClock(); updateLoopLabel();
    } catch (cause) { error(cause); }
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
    const active = ['running', 'starting', 'capturing', 'analyzing', 'loading-model', 'paused', 'waiting-clock'].includes(status);
    $('analysis-start').disabled = !live || active; $('analysis-stop').disabled = !live || !active;
  }
  async function analysisAction(type) {
    if (!live) return;
    try { const result = await send(type); analysisStatus(result.analysis || result.status || result); notice(type === 'LV_ANALYSIS_START' ? 'Learning request acknowledged. Analysis status reports the actual provider and capability.' : type === 'LV_ANALYSIS_STOP' ? 'Learning stop acknowledged.' : 'Analysis status refreshed.'); }
    catch (cause) { error(cause); }
  }
  function setReview(review) {
    state.review = review;
    $('review-open').textContent = `Review ${review.length} ↗`; $('review-open').disabled = !review.length;
    if ($('review-dialog').open) renderReview();
  }
  function renderReview() {
    state.reviewRevision = state.score.revision;
    $('review-list').replaceChildren(...state.review.map(proposal => {
      const phrase = state.score.phrases.find(phrase => phrase.words.some(word => word.id === proposal.wordId));
      const word = phrase?.words.find(word => word.id === proposal.wordId);
      const outside = phrase && !phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs);
      const protection = helpers.reviewProtection(word) || (outside ? 'Adjust phrase bounds before accepting' : '');
      const row = el('div', 'review-row'); const check = el('input'); check.type = 'checkbox'; check.value = proposal.wordId; check.disabled = Boolean(protection); check.setAttribute('aria-label', `Accept timing for ${word?.text || proposal.wordId}`);
      const details = el('span'); details.append(el('strong', '', word?.text || proposal.wordId), el('span', 'muted small', `${word ? `${seconds(word.startMs)}–${seconds(word.endMs)} → ` : ''}${seconds(proposal.startMs)}–${seconds(proposal.endMs)}s`), el('span', 'muted small', protection || 'Needs review'));
      const audition = el('button', 'quiet', live ? 'Audition' : 'Silent preview'); audition.type = 'button';
      audition.onclick = async () => {
        const startMs = helpers.seekTarget(proposal.startMs + state.score.offsetMs - 250, state.score.source.durationMs);
        const endMs = helpers.seekTarget(proposal.endMs + state.score.offsetMs + 350, state.score.source.durationMs);
        await transport('setLoop', { startMs, endMs }); await seekTo(startMs); await transport('play');
        $('review-status').textContent = `${live ? 'Auditioning' : 'Silent preview'} ${word?.text || proposal.wordId} · ${seconds(startMs)}–${seconds(endMs)}s`;
      };
      row.dataset.tip = `Evidence: ${proposal.evidenceId}\nRaw model confidence is not calibrated for singing.`; row.append(check, details, audition); return row;
    }));
    $('review-apply').disabled = true;
    $('review-status').textContent = `Revision ${state.reviewRevision} · ${state.review.length} proposals`;
  }
  function bind() {
    $('text-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordText', wordId: state.wordId, text: $('word-text').value }, 'Word text updated'); };
    $('word-text').addEventListener('input', () => { const word = findWord()?.word; $('word-text-syllable-warning').hidden = !word?.syllables?.length || $('word-text').value === word.text; });
    $('timing-form').onsubmit = event => { event.preventDefault(); operation({ type: 'setWordTiming', wordId: state.wordId, startMs: Math.round(Number($('word-start').value) * 1000), endMs: Math.round(Number($('word-end').value) * 1000) }, 'Word timing updated and locked'); };
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
    $('play').onclick = () => transport(state.paused ? 'play' : 'pause');
    $('phrase-seek').onclick = () => { const phrase = selectedPhrase(); if (phrase) seekTo(phrase.startMs + state.score.offsetMs); };
    $('loop').onclick = () => { const phrase = selectedPhrase(); if (phrase) transport(state.loop ? 'clearLoop' : 'setLoop', { startMs: Math.max(0, phrase.startMs + state.score.offsetMs), endMs: Math.max(1, phrase.endMs + state.score.offsetMs) }); };
    $('zoom').oninput = () => { state.pxPerSecond = Number($('zoom').value); renderTimeline(); };
    $('ruler').onclick = event => seekTo((event.clientX - $('ruler').getBoundingClientRect().left) / state.pxPerSecond * 1000);
    $('inspector-toggle').onclick = () => { const closed = !document.body.classList.contains('inspector-closed'); document.body.classList.toggle('inspector-closed', closed); $('inspector-toggle').setAttribute('aria-expanded', String(!closed)); try { localStorage.setItem('lv-editor-inspector', closed ? 'closed' : 'open'); } catch {} };
    try { const setting = localStorage.getItem('lv-editor-inspector'); if (setting === 'closed' || (!setting && innerWidth < 800)) { document.body.classList.add('inspector-closed'); $('inspector-toggle').setAttribute('aria-expanded', 'false'); } } catch {}
    $('analysis-start').onclick = () => analysisAction('LV_ANALYSIS_START'); $('analysis-stop').onclick = () => analysisAction('LV_ANALYSIS_STOP'); $('analysis-refresh').onclick = () => analysisAction('LV_ANALYSIS_STATUS');
    $('files-open').onclick = () => $('files-dialog').showModal();
    $('settings').onclick = () => { if (runtime?.openOptionsPage) runtime.openOptionsPage(); else notice('Settings are available in the installed extension. This is a synthetic file preview.'); };
    $('review-open').onclick = () => { renderReview(); $('review-dialog').showModal(); };
    $('review-stop').onclick = async () => { await transport('pause'); await transport('clearLoop'); };
    $('review-dialog').addEventListener('close', async () => { await transport('pause'); await transport('clearLoop'); });
    $('review-list').onchange = () => { $('review-apply').disabled = !$('review-list').querySelector('input:checked'); };
    $('review-apply').onclick = async () => { const wordIds = [...$('review-list').querySelectorAll('input:checked')].map(input => input.value); if (!wordIds.length) return; await mutate('LV_SCORE_REVIEW_APPLY', { wordIds }, 'Selected timing proposals accepted'); $('review-status').textContent = $('notice').textContent; };
    $('export').onclick = () => {
      if (!state.score) return;
      try { core.validateScore(state.score); const url = URL.createObjectURL(new Blob([JSON.stringify(state.score, null, 2)], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = `lyricvibe-${state.score.source.videoId}-r${state.score.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $('file-status').textContent = 'Validated current score exported.'; } catch (cause) { $('file-status').textContent = cause.message; }
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
      if (editing || $('files-dialog').open || $('review-dialog').open) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $('undo').click(); }
      else if (event.code === 'Space') { event.preventDefault(); $('play').click(); }
      else if (event.key.toLowerCase() === 'i') $('inspector-toggle').click();
    });
    document.addEventListener('pointerdown', beginDrag);
    document.addEventListener('pointerover', event => { const target = event.target.closest('[data-tip]'); if (target) showTooltip(target); });
    document.addEventListener('focusin', event => { const target = event.target.closest('[data-tip]'); if (target) showTooltip(target); else hideTooltip(); });
    document.addEventListener('pointerout', event => { if (!event.relatedTarget?.closest?.('[data-tip]')) hideTooltip(); });
    document.addEventListener('pointerdown', hideTooltip);
    window.addEventListener('resize', hideTooltip);
    window.addEventListener('beforeunload', event => { if (state.draft || state.busy) { event.preventDefault(); event.returnValue = ''; } });
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
    if (!live && state.score && !state.paused) {
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
    if (live) {
      $('connection').textContent = 'Connecting source'; $('clock-mode').textContent = 'Waiting for source clock';
      runtime.onMessage.addListener(message => {
        const expectedKey = state.score ? core.mediaKey(state.score.source) : requestedMediaKey;
        if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATE' && message.analysis?.tabId === tabId && (!expectedKey || message.analysis.mediaKey === expectedKey)) analysisStatus(message.analysis);
        if (message.tabId !== tabId || (expectedKey && message.mediaKey !== expectedKey)) return;
        if (message.type === 'LV_SCORE_UPDATED') { try { setScore(message.score, state.draft || Boolean(state.drag)); if (message.review) setReview(message.review); if (state.draft) notice('Source score updated. Your draft retains its original revision. Review it, then press Escape to reload saved fields before retrying.'); } catch (cause) { error(cause); } }
        if (message.type === 'LV_SCORE_PLAYBACK') { state.mediaMs = message.mediaMs; state.paused = message.paused; state.clockSeen = true; $('clock-mode').textContent = 'Live source clock'; renderClock(); }
        if (message.type === 'LV_ANALYSIS_OFFSCREEN_STATE' && message.analysis) analysisStatus(message.analysis);
      });
      try { const result = await send('LV_SCORE_GET'); setScore(result.score); setReview(result.review || []); analysisStatus(result.analysis); notice('Select a word to adjust timing. Changes save to this exact video and lyric revision.'); }
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
  init().catch(error);
})();
