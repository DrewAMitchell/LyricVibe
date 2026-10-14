(function initLyricVibeOverlay() {
  /* ══════════════════════════════════════
     CONSTANTS & CONFIG
     ══════════════════════════════════════ */
  const DEFAULT_SYNC_OFFSET_MS = -80;
  const SYNC_NUDGE_MS = 80;
  const THEMES = ['samay', 'flow', 'fire', 'neon', 'glass', 'hype', 'soft', 'clean', 'retro', 'elegant', 'aurora', 'matrix', 'vinyl', 'cosmic'];
  const THEME_LABELS = {
    flow: 'FLOW', samay: 'SAMAY', hype: 'HYPE', soft: 'SOFT', neon: 'NEON',
    clean: 'CLEAN', retro: 'RETRO', glass: 'GLASS', fire: 'FIRE', elegant: 'ELEGANT',
    aurora: 'AURORA', matrix: 'MATRIX', vinyl: 'VINYL', cosmic: 'COSMIC'
  };
  const ANIMATIONS = ['slam', 'fade-up', 'scale-pop', 'slide-left', 'slide-right', 'blur-in', 'glitch', 'typewriter', 'shatter', 'wave'];

  const SETUP_OPENERS = new Set([
    'after', 'although', 'and', 'as', 'before', 'because', 'but', 'even',
    'if', 'i', 'just', 'maybe', 'my', 'now', 'once', 'she', 'since', 'so',
    'still', 'that', 'the', 'then', 'they', 'though', 'till', 'until',
    'when', 'while', 'with', 'you'
  ]);
  const TAG_OPENERS = new Set(['is', 'are', 'was', 'were', 'not', 'no', 'never', 'only', 'all']);

  /* If overlay already exists, just show it */
  if (window.__lyricVibeOverlay && window.__lyricVibeOverlay.show) {
    /* Only reuse the old overlay if its extension context is still alive.
       After an extension reload/update the old content script survives with a
       DEAD chrome.runtime: it can't answer LV_GET_HINTS, so song detection
       silently breaks until the page is refreshed. Detect that zombie and
       replace it instead of returning early. */
    const lvxOld = window.__lyricVibeOverlay;
    var lvxOldAlive = false; // var: hoisted so it's visible after this block
    try { lvxOldAlive = lvxOld.interfaceVersion === 2 && typeof lvxOld.ping === 'function' ? lvxOld.ping() : false; } catch (_) {}
    if (!lvxOldAlive) {
      try { if (typeof lvxOld.hide === 'function') lvxOld.hide(); } catch (_) {}
      try { const lvxEl = document.getElementById('lvx-root'); if (lvxEl) lvxEl.remove(); } catch (_) {}
      window.__lyricVibeOverlay = null;
      // (zombie replaced — fall through to full re-initialization below)
    }
    if (lvxOldAlive) {
      window.__lyricVibeOverlay.show();
      return;
    }
  }
  if (window.__lvxNeverTrue) { // no-op guard: absorbs a leftover legacy return statement
    return;
  }

  /* ══════════════════════════════════════
     STATE
     ══════════════════════════════════════ */
  const state = {
    score: null,
    auditionLoop: null,
    scoreSignature: '',
    lastClockSent: 0,
    active: false,
    lines: [],
    currentIndex: -1,
    currentMoment: null,
    revealTimers: [],
    rafId: 0,
    hudTimer: 0,
    trackTitle: '',
    lyricSource: '',
    syncOffsetMs: DEFAULT_SYNC_OFFSET_MS,
    fallbackStartMs: 0,
    fallbackMediaStartMs: 0,
    theme: 'samay',
    // Sync tracking for auto-adjustment
    lastMediaTime: 0,
    lastWallTime: 0,
    mediaDriftSamples: [],
    playbackRate: 1,
    // Real-time auto-calibration
    timingErrors: [],        // recent render timing errors vs LRC timestamp
    autoCalibrated: false,   // true after first calibration pass
    baseOffsetMs: DEFAULT_SYNC_OFFSET_MS, // original computed offset
    detectedSyncOffsetMs: DEFAULT_SYNC_OFFSET_MS, // genre/tempo-aware baseline for Auto Sync
    syncPreferenceVersion: 0, // prevents stale stored offsets from overriding an Auto Sync reset
    // Spotify-specific: polling for time from DOM
    spotifyPollInterval: 0,
    spotifyCurrentTimeMs: 0,
    spotifyLastPollWall: 0,
    spotifyPauseDetected: false,
    spotifyNullCount: 0,       // count of consecutive null time reads
    spotifyLastGoodWall: 0,    // last wall time when we got a non-null read
    isSpotify: false,
    // New: user preferences & track context
    fontScale: 1,              // user font size multiplier (+/- keys)
    liteMode: false,           // see-through mode (B key)
    trackKey: '',              // cache key for per-song offset memory
    trackDurationMs: 0,        // for the progress bar
    offsetWasRestored: false,  // true if offset loaded from per-song memory
    errorShown: false          // true when error screen is up (observer stays active)
  };
  const timing = { draft: null, view: 'proposed', phraseIndex: 0, dirty: false, busy: false, auditioned: false, priorLoop: null };
  const tapping = { take: null, wordId: null, binding: null, clockMs: null, rate: 1, audio: null, splitDirty: false, heldInput: null, cancelledSpace: false, reviewId: null, correctionUndo: [] };
  const performanceTake = { armed: false, binding: null, laneId: null, rate: 1, marks: [] };

  /* ══════════════════════════════════════
     DOM CONSTRUCTION
     ══════════════════════════════════════ */
  const root = document.createElement('div');
  root.id = 'lvx-root';

  const stage = document.createElement('div');
  stage.className = 'lvx-stage';

  const hud = document.createElement('div');
  hud.className = 'lvx-hud';

  const hudLabel = document.createElement('span');
  hudLabel.className = 'lvx-hud-label';
  hudLabel.textContent = 'LYRICVIBE';

  const hudText = document.createElement('span');
  hudText.className = 'lvx-hud-text';
  hudText.textContent = 'Ready';

  const stopButton = document.createElement('button');
  stopButton.className = 'lvx-stop';
  stopButton.textContent = '✕';
  stopButton.title = 'Stop LyricVibe (Esc)';
  stopButton.addEventListener('click', () => {
    try { chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {}); } catch (_) {}
    teardown();
  });

  const themeButton = document.createElement('button');
  themeButton.className = 'lvx-theme-btn';
  themeButton.textContent = 'SAMAY';
  themeButton.title = 'Cycle theme (T)';
  themeButton.addEventListener('click', () => cycleTheme());

  const syncEarlier = document.createElement('button');
  syncEarlier.className = 'lvx-sync-btn';
  syncEarlier.textContent = '[ ←';
  syncEarlier.title = 'Lyrics earlier ([)';
  syncEarlier.addEventListener('click', () => nudgeSync(-SYNC_NUDGE_MS));

  const syncLater = document.createElement('button');
  syncLater.className = 'lvx-sync-btn';
  syncLater.textContent = '→ ]';
  syncLater.title = 'Lyrics later (])';
  syncLater.addEventListener('click', () => nudgeSync(SYNC_NUDGE_MS));

  const offsetControl = document.createElement('label');
  offsetControl.className = 'lvx-offset-control';
  offsetControl.textContent = 'OFFSET ';
  const offsetInput = document.createElement('input');
  offsetInput.className = 'lvx-offset-input';
  offsetInput.type = 'number'; offsetInput.step = '1'; offsetInput.value = '0';
  offsetInput.setAttribute('aria-label', 'Lyric offset in milliseconds');
  offsetInput.title = 'Type exact milliseconds. Scroll: 100 ms · Shift: 1000 ms · Alt: 1 ms. Positive moves lyrics later.';
  offsetControl.append(offsetInput, document.createTextNode(' ms'));
  let offsetWheelTimer = 0;
  let offsetDraftKey = '';
  const currentOffsetKey = () => state.score ? LvScore.mediaKey(state.score.source) : state.trackKey;
  function commitOffsetInput() {
    clearTimeout(offsetWheelTimer); offsetWheelTimer = 0;
    if (offsetDraftKey !== currentOffsetKey()) {
      offsetInput.value = String(state.syncOffsetMs);
      setHud('The video changed. Adjust the current video’s offset again.', true, true);
      return;
    }
    const value = Number(offsetInput.value);
    if (!offsetInput.value.trim() || !Number.isSafeInteger(value)) { offsetInput.reportValidity(); return; }
    setSyncOffset(value);
  }
  offsetInput.addEventListener('focus', () => { offsetDraftKey = currentOffsetKey(); });
  offsetInput.addEventListener('blur', commitOffsetInput);
  offsetInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); offsetInput.blur(); }
    else if (event.key === 'Escape') { offsetInput.value = String(state.syncOffsetMs); offsetInput.blur(); }
  });
  offsetInput.addEventListener('wheel', event => {
    event.preventDefault(); event.stopPropagation();
    if (!event.deltaY) return;
    if (document.activeElement !== offsetInput) offsetDraftKey = currentOffsetKey();
    const step = event.altKey ? 1 : event.shiftKey ? 1000 : 100;
    offsetInput.value = String((Number(offsetInput.value) || 0) + (event.deltaY < 0 ? step : -step));
    clearTimeout(offsetWheelTimer);
    offsetWheelTimer = setTimeout(commitOffsetInput, 180);
  }, { passive: false });

  const quickSyncButton = document.createElement('button');
  quickSyncButton.className = 'lvx-quick-sync-btn';
  quickSyncButton.textContent = '⟳ SYNC';
  quickSyncButton.title = 'Preview catalog timing and fine-tune this video';
  quickSyncButton.addEventListener('click', () => quickSyncLyrics());

  const helpButton = document.createElement('button');
  helpButton.className = 'lvx-help-btn';
  helpButton.textContent = '?';
  helpButton.title = 'Keyboard shortcuts (? or H)';
  helpButton.addEventListener('click', () => toggleShortcutsPanel());

  const editButton = document.createElement('button');
  editButton.className = 'lvx-theme-btn';
  editButton.textContent = 'EDIT TIMING';
  editButton.setAttribute('aria-label', 'Open lyric timing editor');
  editButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LV_EDITOR_OPEN', mediaKey: globalThis.LvScore?.mediaKey({ url: location.href }) }).then(result => {
      if (!result?.ok) setHud(result?.error?.message || 'Editor could not open', true, true);
    }).catch(error => setHud(error.message, true, true));
  });

  hud.append(hudLabel, hudText, offsetControl, syncEarlier, syncLater, quickSyncButton, editButton, themeButton, helpButton, stopButton);

  /* Next-line preview (bottom center) */
  const preview = document.createElement('div');
  preview.className = 'lvx-preview';

  /* Song progress bar (bottom edge) */
  const progress = document.createElement('div');
  progress.className = 'lvx-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'lvx-progress-fill';
  progress.appendChild(progressFill);

  /* Keyboard shortcuts help panel */
  let shortcutsAutoHideTimer = 0;
  const shortcutsPanel = document.createElement('div');
  shortcutsPanel.className = 'lvx-shortcuts-panel';
  shortcutsPanel.innerHTML = [
    '<div class="lvx-shortcuts-header">',
    '  <span class="lvx-shortcuts-title">KEYBOARD SHORTCUTS</span>',
    '  <button class="lvx-shortcuts-close">✕</button>',
    '</div>',
    '<div class="lvx-shortcuts-grid">',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">T</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">Shift+T</span>',
    '    <span class="lvx-shortcut-desc">Cycle themes forward / backward</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">[</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">]</span>',
    '    <span class="lvx-shortcut-desc">Nudge sync earlier / later</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">⟳ SYNC</span>',
    '    <span class="lvx-shortcut-desc">Reset manual sync and auto-calibrate this song</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">+</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">−</span>',
    '    <span class="lvx-shortcut-desc">Increase / decrease text size</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">B</span>',
    '    <span class="lvx-shortcut-desc">Toggle see-through mode</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">Esc</span>',
    '    <span class="lvx-shortcut-desc">Close the visualizer</span>',
    '  </div>',
    '  <div class="lvx-shortcut-row">',
    '    <span class="lvx-key-badge">?</span><span class="lvx-shortcut-sep">/</span><span class="lvx-key-badge">H</span>',
    '    <span class="lvx-shortcut-desc">Show / hide this panel</span>',
    '  </div>',
    '</div>',
    '<div class="lvx-shortcuts-footer">Sync offsets are remembered per song</div>',
  ].join('\n');
  shortcutsPanel.querySelector('.lvx-shortcuts-close').addEventListener('click', () => toggleShortcutsPanel(false));

  const syncPanel = document.createElement('section');
  syncPanel.className = 'lvx-sync-panel'; syncPanel.hidden = true; syncPanel.tabIndex = -1;
  syncPanel.setAttribute('aria-label', 'Sync this video');
  syncPanel.innerHTML = `<header><div><span class="lvx-sync-eyebrow">TIMING REVIEW</span><h2>Sync this video</h2></div><button data-sync="close" aria-label="Close timing preview">✕</button></header>
    <button data-sync="light-editor" class="lvx-light-editor-open">↗ Open lightweight editor</button>
    <p class="lvx-sync-save-status" role="status"></p>
    <p class="lvx-sync-notice" role="status" aria-live="polite">Load a timing preview to begin.</p>
    <div class="lvx-sync-tabs" role="group" aria-label="Timing to audition"><button data-sync="saved" aria-pressed="false">Saved</button><button data-sync="proposed" aria-pressed="true">Proposed · unsaved</button></div>
    <div class="lvx-sync-nav"><button data-sync="previous" aria-label="Previous lyric phrase">‹</button><span class="lvx-sync-position"></span><button data-sync="next" aria-label="Next lyric phrase">›</button></div>
    <p class="lvx-sync-phrase"></p><div class="lvx-sync-range"></div>
    <div class="lvx-sync-transport"><button data-sync="audition">▶ Audition at 1×</button><button data-sync="pause">Ⅱ Pause</button><output class="lvx-sync-clock" aria-label="Source playback time" aria-live="off">0.000s</output></div>
    <label class="lvx-sync-loop"><input type="checkbox" data-sync="loop"> Loop this phrase</label>
    <details class="lvx-tap-panel"><summary>Sync by ear <span>phrase → syllables · words optional</span></summary>
      <div class="lvx-capture-phases" role="group" aria-label="Syncing phase"><button data-phase="phrase">1 · Phrases</button><button data-phase="syllable">2 · Syllables</button><button data-phase="word">Words · optional</button></div>
      <p class="lvx-sync-hint">Hold Space while each word is sung. On the next pass, tap at syllable changes inside its saved boundaries.</p>
      <div class="lvx-perform-cue"><span class="lvx-beat-pulse" hidden aria-hidden="true"></span><small>READY</small><strong class="lvx-perform-phrase"></strong><div class="lvx-upcoming-phrases" aria-label="Upcoming lyrics"></div><span class="lvx-perform-instruction">Then start performing</span><p class="lvx-estimated-phrase" aria-live="off"></p><p class="lvx-cue-legend">Blue follows your recording cue</p><div class="lvx-live-recovery" hidden><button data-sync="tap-back">← Back one</button><button data-sync="tap-skip">Skip one →</button><button data-sync="tap-reassign-back">Last tap ← word</button><button data-sync="tap-reassign-next">Last tap → word</button><small>Left / Right moves the cue; Ctrl + Left / Right reassigns the last tap. The song keeps playing.</small></div></div>
      <label class="lvx-practice-speed">YouTube practice speed <select data-sync="tap-speed" aria-label="Practice playback speed"><option value="0.5">½× · Half speed</option><option value="0.25">¼× · Quarter speed</option><option value="0.75">¾× · Slower</option><option value="1">1× · Normal</option></select></label>
      <label class="lvx-syllable-flow">Syllable pass <select data-sync="tap-syllable-flow"><option value="events">Tap freely · assign afterward</option><option value="words">Word pass · hold each word over your syllable taps</option><option value="phrase-stream">Suggested word cursor · legacy</option><option value="continuous">Fixed word frames · optional</option><option value="phrase">Phrase practice · prepared spelling</option></select></label>
      <div class="lvx-tap-actions lvx-perform-actions"><button data-sync="tap-arm">▶ Start take</button><button data-sync="tap-stop">■ Stop</button><button data-sync="retime-flag" title="Flag the phrase you just performed for retiming (F)">⚑ Flag phrase · F</button><button data-sync="tempo-tap" title="Tap along with the beat anywhere in the song (T). One tempo covers the whole song; not available during a take.">♩ Tap tempo · T</button><button data-sync="tap-mark">Next lyric · Space</button><button data-sync="tap-release">Release · Enter</button></div>
      <div class="lvx-tap-words" hidden aria-hidden="true"></div>
      <section class="lvx-phrase-syllables" hidden aria-label="Phrase syllable spelling"><details><summary>Syllable spelling <span>Edit cuts with |</span></summary><p class="lvx-sync-hint">One Space press per syllable entrance. Dictionary suggestions guide spelling, not audio alignment.</p><div class="lvx-phrase-syllable-fields"></div><button data-sync="phrase-suggest">Suggest phrase syllables</button></details><p class="lvx-phrase-syllable-hint" role="status"></p></section>
      <div class="lvx-tap-actions lvx-syllable-review" hidden><button data-sync="syllable-retake">↻ Retake phrase</button><button data-sync="syllable-hear">▶ Hear this take</button><button data-sync="syllable-next">✓ Keep phrase & next</button></div>
      <div class="lvx-tap-timeline" aria-label="Current phrase timing"><div class="lvx-tap-blocks"></div><i class="lvx-tap-playhead" hidden></i></div>
      <div class="lvx-tap-status" role="status" aria-live="polite">Choose a word to begin.</div>
      <div class="lvx-tap-actions"><button data-sync="tap-use">Use take in preview</button><button data-sync="tap-undo">↶ Undo mark</button><button data-sync="tap-discard">Discard take</button></div>
      <button data-sync="transcript-open" class="lvx-transcript-open">✎ Lyrics text</button><dialog class="lvx-transcript-editor" aria-label="Lyrics text"><h3>Lyrics</h3><p class="lvx-sync-hint">Paste or edit the lyrics, one phrase per line. <code>[backing]</code> puts a line on the backing lane. Fixed words keep their timing; new lines get estimated timing to retime; deleted words and lines are hidden. Undo preview reverts.</p><textarea data-sync="transcript-text" rows="18" spellcheck="true" aria-label="Lyrics, one phrase per line"></textarea><ul class="lvx-transcript-changes" aria-live="polite"></ul><div class="lvx-tap-actions"><button data-sync="transcript-apply">Apply to preview</button><button data-sync="transcript-close">Close</button></div></dialog><section class="lvx-event-review" hidden aria-label="Assign recorded events"><p class="lvx-event-summary" role="status"></p><div class="lvx-event-phrases"></div><div class="lvx-tap-actions"><button data-sync="events-review">Use reviewed assignments</button><button data-sync="events-export">Export events</button></div><p class="lvx-sync-hint">Counts group your recorded entrances into words. Amber means uncertain or changed. Raw timestamps never move. A word starts at its first entrance; its end stays provisional until word-boundary cleanup. Long gaps are flagged because a held syllable can look like the next word. Unresolved phrases stay in the take.</p></section>
      <section class="lvx-mark-correction" hidden aria-label="Correct recorded timing"><label>Recorded <select data-sync="correct-mark" aria-label="Recorded mark to correct"></select></label><div class="lvx-correction-times"><label>Start ms <input data-sync="correct-start" type="number" min="0" step="10"></label><label>End ms <input data-sync="correct-end" type="number" min="0" step="10"></label></div><div class="lvx-tap-actions"><button data-sync="correct-hear">▶ Hear this mark</button><button data-sync="correct-save">Use exact times</button></div><label>Adjust <select data-sync="correct-edge"><option value="move">Whole mark</option><option value="start">Start only</option><option value="end">End only</option></select></label><div class="lvx-tap-actions"><button data-sync="correct-earlier">← Earlier 10 ms</button><button data-sync="correct-later">Later 10 ms →</button><button data-sync="correct-undo">↶ Undo correction</button></div><p class="lvx-sync-hint">Alt + ← / → adjusts the selected edge by 10 ms; add Shift for 50 ms. Corrections use original song time. Hear this mark plays a short loop at practice speed.</p></section>
      <details class="lvx-perform-options"><summary>Performance options <span>units · grid · clicks</span></summary>
      <div class="lvx-tap-settings"><label>Word gesture <select data-sync="tap-cadence"><option value="hold">Hold for word duration</option><option value="flow">Space → next lyric</option><option value="pairs">Separate start / end</option></select></label><label>Word pass <select data-sync="tap-scope"><option value="lane">Continue through vocal track</option><option value="phrase">This phrase only</option></select></label></div>
      <select data-sync="tap-mode" hidden aria-label="Timing unit"><option value="phrase">Phrases</option><option value="word">Words</option><option value="syllable">Syllables across phrase</option></select><div class="lvx-tap-settings"><label><input type="checkbox" data-sync="tap-snap"> Snap to ¼ beat</label><label>BPM <input type="number" data-sync="tap-bpm" value="120" min="20" max="400" step="1" aria-label="Timing grid BPM"></label></div>
      <div class="lvx-tap-segmentation" hidden><label>Spoken as <input data-sync="tap-spoken" type="text" maxlength="256" spellcheck="false" aria-label="Spoken form; display lyric stays unchanged"></label><label>Syllables · separate with |<input data-sync="tap-split" type="text" spellcheck="false" aria-label="Syllable spelling separated by vertical bars"></label><div class="lvx-tap-actions"><button data-sync="tap-suggest">Suggest syllables</button><button data-sync="tap-segment">Set syllables</button></div><p class="lvx-pronunciation-hint" role="status">Dictionary counts guide editable spelling splits. Suggestions do not set timing.</p><p class="lvx-sync-hint">The lyric stays as written. Syllables join to its spoken form. Initial divisions are estimates; tap while listening to set times.</p></div>
      <label class="lvx-sync-loop"><input type="checkbox" data-sync="tap-click"> Audible marks · words only</label>
      </details>
    </details>
    <details class="lvx-effect-panel"><summary>Perform effects <span>second pass</span></summary><p class="lvx-sync-hint">Play your timed vocal track. Press a key while its word or syllable is active. Gaps stay empty; timings stay unchanged.</p><label class="lvx-sync-loop">Target <select data-sync="effect-scope"><option value="word">Word</option><option value="syllable">Authored syllable</option></select></label><div class="lvx-tap-actions"><button data-sync="effect-start">▶ Start effect pass</button><button data-sync="effect-stop">■ Stop</button></div><div class="lvx-effect-pads"><button data-effect="pulse">1 · Pulse</button><button data-effect="tilt">2 · Tilt</button><button data-effect="shake">3 · Shake</button><button data-effect="clear">0 · Clear</button></div><p class="lvx-effect-status" role="status">Effects are buffered until you use the pass.</p><div class="lvx-tap-actions"><button data-sync="effect-use">Use effects in preview</button><button data-sync="effect-undo">↶ Undo effect</button><button data-sync="effect-discard">Discard effects</button></div></details>
    <details><summary>Exact word timings <span>milliseconds</span></summary><p class="lvx-sync-hint">One word per line: word, start, end. These changes affect the preview until you apply.</p><label class="lvx-sync-protected"><input type="checkbox" data-sync="protected"> Edit saved timings in this phrase</label><textarea aria-label="Exact word timings in milliseconds" spellcheck="false" rows="5"></textarea><div class="lvx-sync-text-actions"><button data-sync="tune">Use these times</button><button data-sync="reset">Reset text</button></div></details>
    <div class="lvx-sync-text-actions"><button data-sync="export">↓ Export preview JSON</button><button data-sync="discard-all" class="lvx-danger">Discard all proposed changes</button></div>
    <footer><button data-sync="undo">↶ Undo saved change</button><button data-sync="apply" class="lvx-sync-primary"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></svg> Save timings</button></footer>`;
  const syncNotice = syncPanel.querySelector('.lvx-sync-notice');
  const syncText = syncPanel.querySelector('textarea');
  const syncButton = name => syncPanel.querySelector(`[data-sync="${name}"]`);
  const toggleButtons=new Map();
  for(const input of syncPanel.querySelectorAll('input[type=checkbox]')){
    const label=input.closest('label'),host=document.createElement('div'),button=document.createElement('button');
    host.className=label.className+' lvx-toggle-host';button.type='button';button.className='lvx-toggle';button.textContent=label.textContent.trim();button.dataset.toggle=input.dataset.sync;
    input.hidden=true;host.append(input,button);label.replaceWith(host);toggleButtons.set(input,button);
    button.onclick=()=>{input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));refreshToggles();};
  }
  function refreshToggles(){for(const [input,button]of toggleButtons){button.setAttribute('aria-pressed',String(input.checked));button.disabled=input.disabled;}}
  // Syllable authoring is part of its main phase, not buried in expert options.
  const syllableFields=syncPanel.querySelector('.lvx-tap-segmentation');
  const captureActions=syncButton('tap-arm').parentElement;
  captureActions.before(syncPanel.querySelector('.lvx-phrase-syllables'),syncPanel.querySelector('.lvx-tap-words'),syllableFields);
  syncPanel.querySelector('.lvx-perform-cue').after(syncPanel.querySelector('.lvx-live-recovery'));
  // tone: '' for status, 'warn' for attention, 'error' for anything that blocks you (red box).
  const setSyncNotice = (text, tone = '') => { syncNotice.textContent = text; syncNotice.dataset.tone = tone; };
  const timingTapPending = () => Boolean(tapping.take && (tapping.take.status === 'armed' || !rawTake(tapping.take) && (tapCount(tapping.take) || tapping.take.pendingStartMs !== null || tapping.take.actionHistory?.length)));
  const effectPending = () => performanceTake.armed || performanceTake.marks.length > 0;
  const tapPending = () => timingTapPending() || effectPending();
  const tapWord = () => timingPhrase()?.words.find(w => w.id === tapping.wordId) || timingPhrase()?.words[0];
  const tapBinding = () => timing.draft ? `${LvScore.mediaKey(state.score.source)}:${timing.draft.token}:${timing.draft.previewRevision}` : null;
  const continuousSyllables = () => syncButton('tap-mode').value==='syllable' && syncButton('tap-syllable-flow').value==='continuous';
  const phraseStream = () => syncButton('tap-mode').value==='syllable' && syncButton('tap-syllable-flow').value==='phrase-stream';
  const streamTake = take => take?.cadence==='phrase-stream';
  const eventPass = () => syncButton('tap-mode').value==='syllable' && syncButton('tap-syllable-flow').value==='events';
  const eventTake = take => take?.cadence==='performance-events';
  const wordPass = () => syncButton('tap-mode').value==='syllable' && syncButton('tap-syllable-flow').value==='words';
  const wordTake = take => take?.cadence==='word-holds';
  // Raw takes record absolute source-clock times and are reviewed after Stop.
  const rawTake = take => eventTake(take)||wordTake(take);
  const tapCount = take => eventTake(take)?take.events.length:wordTake(take)?take.holds.length:take?.marks.length||0;
  const continuousPass = () => continuousSyllables() || phraseStream() || eventPass() || wordPass();
  const frameTake = take => take?.cadence==='word-frames';
  function discardTapTake() { const restored=tapping.restored;tapping.restored=false;tapping.take = null; tapping.eventCounts={};tapping.eventApplied=[];tapping.eventReport=null;tapping.eventArchiveKey=null; tapping.frameWordId=null; tapping.streamWordId=null; tapping.followSeek=false;tapping.seekPhraseId=null;tapping.armSeekMs=null; tapping.auditionScore=null; tapping.auditionMarks=null; tapping.binding = null; tapping.clockMs = null; tapping.splitDirty = false; tapping.heldInput = null; tapping.cancelledSpace = false; tapping.reviewId = null; tapping.correctionUndo = [];if(restored)syncButton('tap-syllable-flow').value='events'; }
  function restartTranscript() {
    if(syncButton('tap-mode').value==='syllable'){
      const media=getMedia(),phrase=timingPhrase();media?.pause();state.auditionLoop=null;discardTapTake();
      tapping.wordId=phrase?.words.find(w=>!w.excluded)?.id||null;
      if(media&&phrase)media.currentTime=Math.max(0,phraseLeadInMs(phrase)+state.score.offsetMs)/1000;
      state.scoreSignature='';refreshTimingPanel();
      setSyncNotice('Take discarded. Word and syllable cues reset to the start of this phrase; playback is paused at its lead-in. Other preview edits are preserved.');return;
    }
    discardTapTake();
    timing.phraseIndex = 0; tapping.wordId = timing.draft?.score.phrases[0]?.words[0]?.id || null;
    const media = getMedia(), first = timing.draft?.score.phrases[0];
    if (media && first) { media.pause(); state.auditionLoop = null; syncButton('loop').checked = false; media.currentTime = Math.max(0,first.startMs + state.score.offsetMs - 800) / 1000; }
    refreshTimingPanel(); setSyncNotice('Take discarded. Back at the beginning of the transcript; your preview and saved track are unchanged.');
  }
  function discardEffects() { performanceTake.armed = false; performanceTake.binding = null; performanceTake.marks = []; state.scoreSignature = ''; }
  function stopEffects(reason) { if (!performanceTake.armed) return; performanceTake.armed = false; refreshTimingPanel(); if (reason) setSyncNotice(reason); if (performanceTake.marks.length) setTimeout(() => void useEffects(), 0); }
  // A Words · Hold take over a video with recorded syllable taps is a word pass:
  // its holds claim those taps instead of replacing their timing.
  async function adoptWordHolds(){
    const take=tapping.take;
    if(!take||take.cadence!=='pairs'||take.mode!=='word'||!take.marks.length||!['stopped','complete'].includes(take.status)||timing.busy||!timing.draft)return false;
    const events=await latestArchivedSyllableEvents().catch(()=>null);
    if(!events?.length||tapping.take!==take)return false;
    timing.busy=true;refreshTimingPanel();
    try{
      const ids=new Set(take.marks.map(m=>m.wordId??m.id)),phrases=timing.draft.score.phrases,first=phrases.findIndex(p=>p.words.some(w=>ids.has(w.id)));
      if(first<0)return false;
      setSyncNotice(`Matching ${ids.size} word holds to ${events.length} syllable taps…`);
      const total=phrases.slice(first).filter(p=>p.laneId===phrases[first].laneId).reduce((n,p)=>n+p.words.filter(w=>!w.excluded).length,0);
      const units=await prepareStreamUnits(phrases[first],true,first,done=>{if(done%20===0||done===total)setSyncNotice(`Looking up syllable counts · ${done}/${total} words…`);});
      if(tapping.take!==take)throw Error('The take changed while matching; nothing was converted.');
      tapping.take=LvTapTiming.wordHoldsFromPairs(take,units,events,state.score.offsetMs);tapping.eventApplied=[];tapping.followSeek=false;tapping.seekPhraseId=null;
      await archiveEvents();
      const report=LvTapTiming.associateWordHolds(tapping.take),ready=report.phrases.filter(p=>p.heldCount&&p.ready).length,flagged=report.phrases.filter(p=>p.heldCount&&p.issues.length).length;
      setSyncNotice(`Word pass ready: ${tapping.take.holds.length} words claimed ${events.length-report.unclaimed.length} of ${events.length} syllable taps · ${ready} phrases ready · ${flagged} with amber flags. Review below, then Use held phrases. Export keeps a copy.`);
      return true;
    }catch(error){setSyncNotice(error.message,'error');return false;}
    finally{timing.busy=false;state.scoreSignature='';refreshTimingPanel();syncPanel.querySelector('.lvx-event-review:not([hidden])')?.scrollIntoView({block:'nearest'});}
  }
  // Whole-transcript text editing over the unsaved preview.
  const transcript={dirty:false,shownFor:null};
  function transcriptReview(){
    const list=syncPanel.querySelector('.lvx-transcript-changes'),area=syncButton('transcript-text');list.replaceChildren();
    if(!timing.draft)return null;
    try{
      const result=LvTranscriptText.diff(timing.draft.score,area.value);
      const labels={respell:'fix',replace:'replace (re-estimated)',insert:'insert (re-estimated)',hide:'hide words','delete-line':'hide line','add-line':'new line (estimated)',lane:'lane'};
      for(const c of result.changes){const li=document.createElement('li');li.textContent=`${c.line?`Line ${c.line}`:'Removed'} · ${labels[c.kind]}: ${c.from||'∅'} → ${c.to||'(hidden)'}`;if(c.kind!=='respell')li.dataset.review='true';list.append(li);}
      if(!result.changes.length){const li=document.createElement('li');li.textContent='No changes.';list.append(li);}
      return result;
    }catch(error){const li=document.createElement('li');li.dataset.review='true';li.textContent=error.message;list.append(li);return null;}
  }
  function refreshTranscriptEditor(){
    const area=syncButton('transcript-text');if(!area)return;
    // An older worker may inject this overlay without the transcript module until the extension reloads.
    const missing=typeof LvTranscriptText==='undefined';syncButton('transcript-open').hidden=missing;if(missing)return;
    const draft=timing.draft,binding=draft?`${draft.token}:${draft.previewRevision}`:null;
    if(!transcript.dirty&&draft&&transcript.shownFor!==binding){area.value=LvTranscriptText.toText(draft.score);transcript.shownFor=binding;}
    syncButton('transcript-apply').disabled=timing.busy||!draft||!transcript.dirty;syncButton('transcript-open').disabled=!draft;area.disabled=timing.busy||!draft;
  }
  // Keep a re-spelled word's syllable timings: split the new text into the same count.
  async function respellSyllables(operations){
    const words=new Map(timing.draft.score.phrases.flatMap(p=>p.words).map(w=>[w.id,w]));
    const extra=[],notes=[];
    for(const op of operations.filter(o=>o.type==='setWordText')){
      const word=words.get(op.wordId);if(!word?.syllables?.length)continue;
      const count=word.syllables.length;let parts=count===1?[op.text]:null;
      if(!parts){try{const r=await chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_COUNT',text:op.text,count});parts=r?.countSuggestion?.parts||null;}catch{parts=null;}}
      if(!parts||parts.length!==count){notes.push(`${word.text} → ${op.text}: syllables cleared (could not split into ${count})`);continue;}
      const spoken=parts.join('');
      extra.push({type:'setWordSyllables',wordId:op.wordId,...(spoken!==op.text?{spokenText:spoken}:{}),syllables:word.syllables.map((syl,i)=>({id:syl.id,text:parts[i],startMs:syl.startMs,endMs:syl.endMs,provenance:syl.provenance,locked:syl.locked,effects:syl.effects||[]}))});
    }
    return {extra,notes};
  }
  async function applyTranscript(){
    if(!timing.draft||timing.busy||!transcript.dirty)return;
    const result=transcriptReview();if(!result)return;
    if(!result.operations.length){transcript.dirty=false;transcript.shownFor=null;refreshTimingPanel();return;}
    timing.busy=true;refreshTimingPanel();
    try{
      setSyncNotice(`Applying ${result.changes.length} lyric changes…`);
      const {extra,notes}=await respellSyllables(result.operations);
      const response=await timingRequest('LV_TIMING_TUNE',{operations:[...result.operations,...extra],allowProtected:true});
      timing.draft=response.preview;timing.auditioned=false;state.scoreSignature='';
      transcript.dirty=false;transcript.shownFor=null;syncPanel.querySelector('.lvx-transcript-editor').close();
      setSyncNotice(`${result.changes.length} lyric changes are in the preview${extra.length?` · ${extra.length} words kept their syllable timings`:''}${notes.length?' · '+notes.join('; '):''}. Undo preview reverts; Save timings keeps them.`);
    }catch(error){setSyncNotice(error.message,'error');}finally{timing.busy=false;refreshTimingPanel();}
  }

  // Tap tempo: raw beat taps (source clock) fit to a beat grid, persisted per video.
  const tempo={mediaKey:null,taps:[],estimate:null};
  async function loadTempo(){
    const mediaKey=state.score?LvScore.mediaKey(state.score.source):null;
    if(!mediaKey||tempo.mediaKey===mediaKey)return tempo;
    try{const key='lvTempo:'+mediaKey,stored=(await chrome.storage.local.get(key))[key];tempo.taps=Array.isArray(stored?.taps)?stored.taps:[];tempo.estimate=stored?.estimate||null;}catch{tempo.taps=[];tempo.estimate=null;}
    tempo.mediaKey=mediaKey;applyTempoToGrid();refreshTimingPanel();return tempo;
  }
  function applyTempoToGrid(){if(!tempo.estimate)return;const bpm=syncButton('tap-bpm');bpm.step='0.01';bpm.value=String(tempo.estimate.bpm);}
  async function tapTempo(){
    const media=getMedia();if(!media||!state.score)return;
    if(tapping.take?.status==='armed'||performanceTake.armed){setSyncNotice('Tempo tapping is separate from takes. Pause or stop the take, then tap T along with the song.','warn');return;}
    await loadTempo();
    const ms=Math.round(media.currentTime*1000),last=tempo.taps.at(-1);
    // A pause of 3s, or tapping earlier than the last tap after a seek, starts a fresh tempo session.
    if(last===undefined||ms<=last||ms-last>3000)tempo.taps=[];
    tempo.taps=[...tempo.taps,ms].slice(-64);
    const estimate=tempo.taps.length>=4?LvTapTiming.estimateTempo(tempo.taps):null;
    if(estimate)tempo.estimate=estimate;
    try{await chrome.storage.local.set({['lvTempo:'+tempo.mediaKey]:{taps:tempo.taps,estimate:tempo.estimate,updatedAt:new Date().toISOString()}});}catch{}
    applyTempoToGrid();
    setSyncNotice(estimate?`♩ ${estimate.bpm} BPM · ${estimate.count} taps · steadiness ±${estimate.residualMs}ms. Keep tapping to refine; the beat dot follows playback.`:`♩ Tap the beat with T · ${tempo.taps.length}/4 taps${tempo.estimate?` · current ${tempo.estimate.bpm} BPM kept`:''}`);
    refreshTimingPanel();
  }
  function refreshBeatPulse(sourceMs){
    const dot=syncPanel.querySelector('.lvx-beat-pulse');if(!dot)return;
    const e=tempo.estimate;dot.hidden=!e;if(!e)return;
    const beats=(sourceMs-e.anchorMs)/e.periodMs,index=Math.floor(beats),phase=beats-index;
    dot.dataset.on=String(phase<.18);
    dot.textContent=`♩ ${e.bpm}`;
  }

  // Phrases the user flags during playback for retiming, persisted per video.
  const retimeFlags={mediaKey:null,items:[]};
  async function loadRetimeFlags(){
    const mediaKey=state.score?LvScore.mediaKey(state.score.source):null;
    if(!mediaKey||retimeFlags.mediaKey===mediaKey)return retimeFlags.items;
    try{const key='lvRetimeFlags:'+mediaKey,stored=(await chrome.storage.local.get(key))[key];retimeFlags.items=Array.isArray(stored)?stored:[];}catch{retimeFlags.items=[];}
    retimeFlags.mediaKey=mediaKey;refreshTimingPanel();return retimeFlags.items;
  }
  async function saveRetimeFlags(){if(!retimeFlags.mediaKey)return;try{await chrome.storage.local.set({['lvRetimeFlags:'+retimeFlags.mediaKey]:retimeFlags.items});}catch(error){setSyncNotice('Flag kept in this tab; local save failed: '+error.message);}}
  const isFlagged=phraseId=>retimeFlags.items.some(f=>f.phraseId===phraseId);
  const phraseOrdinal=phraseId=>timing.draft?timing.draft.score.phrases.findIndex(p=>p.id===phraseId)+1:0;
  async function flagPhraseForRetime(){
    const media=getMedia();if(!timing.draft||!media)return;
    await loadRetimeFlags();
    const take=tapping.take,phrases=timing.draft.score.phrases,now=Math.round(media.currentTime*1000)-state.score.offsetMs;
    let phraseId=null;
    // During a word pass the mistake is most likely in the word just held.
    if(wordTake(take)&&take.holds.length)phraseId=take.holds.reduce((a,b)=>b.pressMs>a.pressMs?b:a).phraseId;
    if(!phraseId)phraseId=(phrases.find(p=>now>=p.startMs&&now<p.endMs)||[...phrases].reverse().find(p=>p.startMs<=now)||phrases[0])?.id;
    if(!phraseId)return;
    // A late reaction usually means the mistake was just before: within 2s of a phrase start, or in a
    // gap, the previous phrase in the lane is flagged too.
    const current=phrases.find(p=>p.id===phraseId),lane=phrases.filter(p=>p.laneId===current.laneId&&p.words.some(w=>!w.excluded));
    const previous=lane.filter(p=>p.startMs<current.startMs).at(-1);
    const nearStart=now<current.startMs+2000||now>=current.endMs;
    const ids=[...(previous&&nearStart?[previous.id]:[]),phraseId];
    for(const id of ids)if(!isFlagged(id))retimeFlags.items=[...retimeFlags.items,{phraseId:id,sourceMs:Math.round(media.currentTime*1000),flaggedAt:new Date().toISOString()}];
    await saveRetimeFlags();
    setSyncNotice(`⚑ ${ids.map(id=>'Phrase '+phraseOrdinal(id)).join(' and ')} flagged for retiming · ${retimeFlags.items.length} flagged. Keep going; Retime them from the review after Stop.`);
    refreshTimingPanel();
  }
  async function clearRetimeFlag(phraseId){retimeFlags.items=retimeFlags.items.filter(f=>f.phraseId!==phraseId);await saveRetimeFlags();}
  async function retimePhrase(phraseId){
    const take=tapping.take;
    if(!wordTake(take)||take.status==='armed'||timing.busy)return;
    try{
      for(const [name,value] of [['tap-mode','syllable'],['tap-syllable-flow','words']]){const e=syncButton(name);if(e.value!==value){e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}}
      tapping.take=LvTapTiming.retimePhraseHolds(take,phraseId);tapping.followSeek=false;tapping.seekPhraseId=null;
      tapping.eventApplied=(tapping.eventApplied||[]).filter(id=>id!==phraseId);
      setSyncNotice(`Retiming phrase ${phraseOrdinal(phraseId)}: hold Space for each word. It stops after the phrase; other phrases are unchanged.`);
      await armTapTake();
    }catch(error){setSyncNotice(error.message,'error');}
  }
  // Pause or Stop ends editing for the moment, so the take goes straight into the preview.
  async function finishStoppedTake(){
    let take=tapping.take;
    if(!take||!['stopped','complete'].includes(take.status)||timing.busy)return;
    if(take.cadence==='pairs'&&take.mode==='word'&&take.marks.length&&await adoptWordHolds())take=tapping.take;
    if(!take||tapping.take!==take)return;
    if(rawTake(take)){
      const report=wordTake(take)?LvTapTiming.associateWordHolds(take):LvTapTiming.associateEvents(take,{counts:tapping.eventCounts||{}});
      if(report.phrases.some(p=>p.ready&&p.marks.length&&!tapping.eventApplied?.includes(p.phraseId)))await useEventAssignments();
      return;
    }
    if(take.marks?.length&&(['phrase','word'].includes(take.mode)||frameTake(take)||streamTake(take)))await useTapTake();
  }
  function stopTapTake(reason = 'Take stopped. Completed marks are retained.') {
    if (tapping.take && tapping.take.status!=='complete') tapping.take = eventTake(tapping.take)?LvTapTiming.stopEvents(tapping.take):wordTake(tapping.take)?LvTapTiming.stopWordHolds(tapping.take):LvTapTiming.stop(tapping.take);
    if(streamTake(tapping.take)||rawTake(tapping.take))tapping.take={...tapping.take,stoppedScoreMs:Math.round((getMedia()?.currentTime||0)*1000-(rawTake(tapping.take)?0:state.score.offsetMs))};
    tapping.heldInput = null;
    if(rawTake(tapping.take))void archiveEvents().catch(error=>setSyncNotice('Events remain in this tab; local backup failed: '+error.message));
    refreshTimingPanel(); setSyncNotice(reason);
    void finishStoppedTake();
  }
  function refreshTapPanel() {
    const word = tapWord(), take = tapping.take, mode = syncButton('tap-mode').value;
    const sourceMatches=!!timing.draft&&LvScore.mediaKey(timing.draft.score.source)===LvScore.mediaKey({url:location.href});
    const continuous=continuousPass();
    syncButton('tap-syllable-flow').parentElement.hidden=mode!=='syllable';
    syncButton('tap-syllable-flow').disabled=timing.busy||tapPending();
    syncButton('tap-speed').parentElement.hidden=take?.status==='armed';
    if(take?.status==='armed')syncButton('tap-syllable-flow').parentElement.hidden=true;
    for (const button of syncPanel.querySelectorAll('[data-phase]')) { button.setAttribute('aria-pressed',String(button.dataset.phase === mode)); button.disabled = timing.busy || tapPending() || tapping.splitDirty; }
    const words = syncPanel.querySelector('.lvx-tap-words'); words.replaceChildren(); words.hidden=true; words.setAttribute('aria-hidden','true');
    for (const item of timingPhrase()?.words || []) {
      const button = document.createElement('button'); button.type = 'button';
      const mark = take?.marks.find(m => m.wordId === item.id && !m.syllableId);
      button.textContent = item.text; button.setAttribute('aria-pressed', String(item.id === word?.id));
      const range = document.createElement('small'); range.textContent = `${mark ? '✓ ' : ''}${mark?.startMs ?? item.startMs}–${mark?.endMs ?? item.endMs}`;
      button.append(range); button.disabled = timing.busy;
      button.classList.toggle('lvx-marked', Boolean(mark));
      button.classList.toggle('lvx-recording', take?.status === 'armed' && take.units[take.index]?.wordId === item.id);
      button.addEventListener('click', () => {
        if (tapPending() || tapping.splitDirty) { setSyncNotice('Use the take or set the syllable spelling before selecting another word.'); return; }
        tapping.wordId = item.id; refreshTapPanel();
      }); words.append(button);
    }
    const segmentation = syncPanel.querySelector('.lvx-tap-segmentation'); segmentation.hidden = true;
    renderPhraseSyllableFields();
    const pronunciationHint=syncPanel.querySelector('.lvx-pronunciation-hint');
    if(pronunciationHint.dataset.word!==word?.id){pronunciationHint.dataset.word=word?.id||'';pronunciationHint.textContent='Dictionary counts guide editable spelling splits. Suggestions do not set timing.';}
    const split = syncButton('tap-split');
    if (!tapping.splitDirty && document.activeElement !== split) split.value = word?.syllables?.length ? word.syllables.map(s => s.text).join('|') : word?.spokenText || word?.text || '';
    const spoken=syncButton('tap-spoken');if(!tapping.splitDirty&&document.activeElement!==spoken)spoken.value=word?.spokenText||word?.text||'';
    spoken.disabled=timing.busy||tapPending();split.disabled=timing.busy||tapPending();syncButton('tap-suggest').disabled=timing.busy||!word||tapPending();
    syncButton('tap-segment').disabled = timing.busy || !word || tapPending() || Boolean(word.syllables?.some(s => s.locked));
    syncButton('tap-mode').disabled = timing.busy || tapPending() || tapping.splitDirty;
    for (const name of ['tap-cadence','tap-scope']) syncButton(name).disabled = mode === 'syllable' || timing.busy || tapPending();
    syncButton('tap-snap').disabled = timing.busy || tapPending();
    syncButton('tap-bpm').disabled = timing.busy || tapPending() || !syncButton('tap-snap').checked;
    syncButton('tap-click').disabled=mode==='syllable';
    syncButton('tap-speed').disabled = timing.busy || take?.status === 'armed' || performanceTake.armed;
    syncButton('tap-arm').disabled = !sourceMatches || timing.busy || !word || (mode!=='syllable'&&word.excluded) || !timingPhrase()?.words.some(w=>!w.excluded) || timing.dirty || (mode!=='syllable'&&tapping.splitDirty) || effectPending() || tapping.take?.status === 'armed' || tapping.take?.status === 'complete';
    syncButton('tap-arm').textContent = (eventPass()||phraseStream())?(take?.status==='stopped'?'▶ Continue syllable pass':'▶ Start syllable pass'):continuous?'▶ Start continuous pass':mode==='syllable'?'▶ Start phrase take':tapping.take?.status === 'stopped' ? '▶ Continue take' : '▶ Start take';
    if(wordPass())syncButton('tap-arm').textContent=wordTake(take)&&take.status==='stopped'?'▶ Continue word pass':'▶ Start word pass';
    if((streamTake(take)||rawTake(take))&&take.status==='stopped'&&tapping.seekPhraseId)syncButton('tap-arm').textContent='▶ Retake from this phrase';
    syncButton('tap-mark').disabled = timing.busy || take?.status !== 'armed';
    syncButton('tap-mark').textContent = (take?.cadence || syncButton('tap-cadence').value) === 'flow' ? (take?.index === take?.units.length - 1 && take?.pendingStartMs !== null ? 'Finish lyric · Space' : 'Next lyric · Space') : take?.pendingStartMs !== null && take ? 'Mark end · Space' : 'Mark start · Space';
    if (take?.status === 'complete') syncButton('tap-mark').textContent = 'Pass complete';
    else if (wordTake(take)) syncButton('tap-mark').textContent = take.pendingStartMs!==null ? 'Release at word end' : 'Hold for next word · Space';
    else if (mode === 'syllable') syncButton('tap-mark').textContent = 'Next syllable · Space';
    else if (syncButton('tap-cadence').value === 'hold') syncButton('tap-mark').textContent = `Hold Space · ${mode} duration`;
    syncButton('tap-release').disabled = mode === 'syllable' || timing.busy || take?.status !== 'armed' || take.pendingStartMs === null;
    syncButton('tap-stop').disabled = !take || (take.status !== 'armed' && getMedia()?.paused);
    syncButton('tap-undo').disabled = timing.busy || !take || (!tapCount(take) && take.pendingStartMs === null && !take.actionHistory?.length);
    syncButton('tap-use').disabled = timing.busy || !tapCount(take) || take.status === 'armed' || take.pendingStartMs !== null;
    syncButton('tap-discard').disabled = timing.busy || !take;
    if(mode==='syllable'&&!continuous)syncButton('tap-use').disabled=timing.busy||take?.status!=='complete';
    const review=syncPanel.querySelector('.lvx-syllable-review');review.hidden=mode!=='syllable'||!take||continuous;
    syncButton('syllable-retake').disabled=timing.busy||!sourceMatches;
    for(const name of ['syllable-hear','syllable-next'])syncButton(name).disabled=timing.busy||!sourceMatches||take?.status!=='complete';
    syncPanel.querySelector('.lvx-tap-panel > .lvx-sync-hint').textContent = mode === 'phrase' ? 'First pass: hold Space for each whole sung phrase, then release before the rest. Use the take in preview, then refine one phrase at a time in Syllables.' : mode === 'syllable' ? 'Tap Space once at every syllable entrance, including the first. The phrase keeps its outside edges. Listen in a loop, then Retake or Keep phrase & next.' : syncButton('tap-cadence').value === 'hold' ? 'Hold Space while each word is sung. Key down starts it; key up ends it and advances. Silence needs no extra key. Stop leaves any unfinished word unchanged.' : (take?.cadence || syncButton('tap-cadence').value) === 'flow'
      ? 'Space starts the next lyric. Enter releases before a rest, or ends the final lyric. Stop retains completed words; an unfinished word is left unchanged.'
      : 'Space marks START, then END. Each pair advances. Stop retains completed words; an unfinished word is left unchanged.';
    const unit = take?.units[take.index];
    syncPanel.querySelector('.lvx-tap-status').textContent = take
      ? `${take.marks.length} / ${take.units.length} ${take.mode === 'phrase' ? 'phrases' : take.mode === 'word' ? 'words' : 'syllables'} marked · ${take.status === 'armed' ? `${take.pendingStartMs === null ? 'Hold for next entrance' : 'Release at its end'}` : 'Take retained · correct, use or discard'}`
      : word ? `Selected: “${word.text}” · ${mode === 'syllable' ? `${word.syllables?.length || 0} authored syllables` : 'word boundaries'}` : 'Choose a word to begin.';
    const cue = syncPanel.querySelector('.lvx-perform-cue');
    cue.dataset.recording = String(take?.status === 'armed');
    cue.querySelector('small').textContent = take ? `${take.mode.toUpperCase()} ${Math.min(take.index+1,take.units.length)} / ${take.units.length} · ${take.status === 'armed' ? take.pendingStartMs === null ? 'NEXT TO RECORD' : 'RECORDING' : 'REVIEW'}` : `${mode.toUpperCase()} MODE · READY`;
    cue.querySelector('.lvx-perform-instruction').textContent = take?.status === 'armed' ? (take.pendingStartMs === null ? 'Space starts the outlined lyric' : 'Release Space at its end') : take ? `${take.marks.length} completed · correct, use, continue or undo` : `Hold Space for each ${mode}`;
    if (mode === 'syllable' && (!take || take.status === 'armed')) cue.querySelector('.lvx-perform-instruction').textContent = 'One press per syllable entrance · phrase bounds stay fixed';
    if(mode==='syllable'&&take?.status==='complete')syncPanel.querySelector('.lvx-tap-status').textContent=`${take.units.length} / ${take.units.length} syllables · listen, retake or keep this phrase`;
    if(mode==='syllable'&&take?.status==='complete')cue.querySelector('.lvx-perform-instruction').textContent='Listen, Retake phrase, or Keep phrase & next';
    if(continuous){
      syncPanel.querySelector('.lvx-tap-panel > .lvx-sync-hint').textContent='Tap Space once per syllable as the song plays. The current word’s saved frame owns your taps: two presses make two syllables. Continue through this vocal track, then Stop and Use take in preview. Untapped words stay unchanged.';
      cue.querySelector('.lvx-perform-instruction').textContent=take?.status==='armed'?'Tap each syllable · word edges stay fixed':'Start from the selected word · dictionary counts are optional';
      if(take)syncPanel.querySelector('.lvx-tap-status').textContent=`${take.marks.length} syllables in ${new Set(take.marks.map(m=>m.wordId)).size} words · ${take.status==='armed'?'continuous recording':'take retained · use or discard'}`;
      cue.querySelector('small').textContent=take?.status==='armed'?'CONTINUOUS SYLLABLES · RECORDING':take?'CONTINUOUS SYLLABLES · REVIEW':'CONTINUOUS SYLLABLES · READY';
    }
    if(phraseStream()){
      syncPanel.querySelector('.lvx-tap-panel > .lvx-sync-hint').textContent='Tap Space at every syllable entrance. Phrase edges contain the take; old word timings are ignored. Suggested counts advance the cue, and you can correct it live.';
      cue.querySelector('.lvx-perform-instruction').textContent='Space: next syllable · ← / →: move cue · Ctrl + ← / →: reassign last tap';
      cue.querySelector('small').textContent=take?.status==='armed'?'PHRASE-GUIDED SYLLABLES · RECORDING':take?'PHRASE-GUIDED SYLLABLES · REVIEW':'PHRASE-GUIDED SYLLABLES · READY';
      if(take?.status==='stopped'&&tapping.seekPhraseId){
        cue.querySelector('.lvx-perform-instruction').textContent='Retake from this phrase keeps earlier phrases and replaces this and later taps. Undo mark restores the previous take.';
        cue.querySelector('small').textContent='PHRASE AT PLAYHEAD · READY TO RETAKE';
      }
    }
    if (mode!=='syllable' && syncButton('tap-cadence').value === 'hold' && (!take || take.status === 'armed')) cue.querySelector('.lvx-perform-instruction').textContent = take?.pendingStartMs !== null && take ? `Release Space when this ${mode} ends` : `Hold Space while the outlined ${mode} is sung`;
    refreshToggles();
    const recovery=syncPanel.querySelector('.lvx-live-recovery');recovery.hidden=!take||!['armed','complete'].includes(take.status)||getMedia()?.paused||mode==='syllable'&&!streamTake(take)&&!wordTake(take);
    for(const name of ['tap-reassign-back','tap-reassign-next']){syncButton(name).hidden=!streamTake(take);syncButton(name).disabled=timing.busy||!take?.marks.length;}
    syncButton('tap-back').disabled=timing.busy||!take||take.index===0&&take.pendingStartMs==null;
    syncButton('tap-skip').disabled=timing.busy||!take||take.index>=take.units.length-1;
    if(eventPass()){
      syncPanel.querySelector('.lvx-tap-panel > .lvx-sync-hint').textContent='Tap Space for every syllable you hear. Every entrance is recorded exactly; word grouping happens after Stop. Phrase and word boundaries stay available as references.';
      cue.querySelector('small').textContent=take?.status==='armed'?'PERFORMANCE EVENTS · RECORDING':'PERFORMANCE EVENTS · READY';
      cue.querySelector('.lvx-perform-instruction').textContent='Space records an entrance · no word cursor · sound cues muted';
      syncPanel.querySelector('.lvx-tap-status').textContent=take?tapCount(take)+' events · '+(take.status==='armed'?'recording exact timestamps':'retained for word assignment'):'Start, then tap every syllable you hear';
      syncButton('tap-use').hidden=true;
    }else if(wordPass()){
      syncPanel.querySelector('.lvx-tap-panel > .lvx-sync-hint').textContent='Hold Space while each word is sung and release when it ends. Your recorded syllable taps stay fixed: each press claims the taps that follow it, and each release ends the word’s last syllable.';
      cue.querySelector('small').textContent=take?.status==='armed'?'WORD PASS · RECORDING':'WORD PASS · READY';
      cue.querySelector('.lvx-perform-instruction').textContent=wordTake(take)&&take.pendingStartMs!==null?'Release Space when this word ends':'Hold Space for the outlined word · Back/Skip if you lose your place';
      syncPanel.querySelector('.lvx-tap-status').textContent=(wordTake(take)?(take.retime?`Retiming phrase ${phraseOrdinal(take.retime.phraseId)} · `:'')+`${take.holds.length} / ${take.units.length} words held · ${take.syllableEvents.length} syllable taps`:'Start, then hold Space for each word')+(retimeFlags.items.length?` · ⚑ ${retimeFlags.items.length} flagged`:'');
      syncButton('tap-use').hidden=true;
    }else syncButton('tap-use').hidden=false;
    refreshTranscriptEditor();
    if(state.score&&retimeFlags.mediaKey!==LvScore.mediaKey(state.score.source))void loadRetimeFlags();
    if(state.score&&tempo.mediaKey!==LvScore.mediaKey(state.score.source))void loadTempo();
    renderEventReview();renderPerformPhrase(); renderTapTimeline(); refreshMarkCorrection(); refreshEffectPanel();
  }
  function phraseSpellingState() {
    const key=`${timing.draft?.token}:${timingPhrase()?.id}`;
    if(tapping.spellingKey!==key){tapping.spellingKey=key;tapping.spellings=new Map();}
    return tapping.spellings;
  }
  function renderPhraseSyllableFields() {
    const section=syncPanel.querySelector('.lvx-phrase-syllables'),fields=section.querySelector('.lvx-phrase-syllable-fields');
    section.hidden=syncButton('tap-mode').value!=='syllable'||!timing.draft||continuousPass();
    if(section.hidden)return;
    const entries=phraseSpellingState(),words=timingPhrase().words.filter(w=>!w.excluded),key=words.map(w=>w.id).join('|');
    if(fields.dataset.key!==`${tapping.spellingKey}:${key}`){
      fields.replaceChildren();fields.dataset.key=`${tapping.spellingKey}:${key}`;
      for(const word of words){
        if(!entries.has(word.id))entries.set(word.id,{value:word.syllables?.length?word.syllables.map(s=>s.text).join('|'):word.spokenText||word.text,edited:false,checked:!!word.syllables?.length});
        const label=document.createElement('label'),input=document.createElement('input');label.textContent=word.text;
        input.type='text';input.dataset.word=word.id;input.setAttribute('aria-label',`Syllables for ${word.text}, separate with vertical bars`);input.value=entries.get(word.id).value;
        input.addEventListener('input',()=>{entries.set(word.id,{value:input.value,edited:true,checked:true});timing.auditioned=false;});
        const choices=document.createElement('div');choices.className='lvx-pronunciation-options';choices.setAttribute('role','group');choices.setAttribute('aria-label',`Pronunciations for ${word.text}`);
        label.append(input,choices);fields.append(label);
      }
    }
    for(const input of fields.querySelectorAll('input')){const entry=entries.get(input.dataset.word);input.disabled=timing.busy||!!tapping.take;if(document.activeElement!==input)input.value=entry?.value||'';const choices=input.parentElement.querySelector('.lvx-pronunciation-options');choices.replaceChildren();for(const alternative of entry?.alternatives||[]){if(!alternative.parts?.length)continue;const b=document.createElement('button');b.type='button';b.textContent=`${alternative.count} ${alternative.count===1?'syllable':'syllables'}`;b.setAttribute('aria-label',`${alternative.count} syllables: ${alternative.parts.join('|')}`);b.setAttribute('aria-pressed',String(entry.value===alternative.parts.join('|')&&!entry.requiresChoice));b.disabled=timing.busy||!!tapping.take;b.onclick=()=>{entry.value=alternative.parts.join('|');entry.edited=true;entry.checked=true;entry.requiresChoice=false;input.value=entry.value;timing.auditioned=false;refreshTapPanel();input.focus();};choices.append(b);}}
    syncButton('phrase-suggest').disabled=timing.busy||!!tapping.take;
    section.querySelector('.lvx-phrase-syllable-hint').textContent=tapping.take?'Spelling is fixed for this take. Retake to record again.':'Start prepares dictionary suggestions for this phrase. Use | to change the sung syllables; unknown words stay unsplit.';
  }
  async function preparePhraseSyllables() {
    const binding=tapBinding(),phrase=timingPhrase(),entries=phraseSpellingState(),operations=[];
    for(const word of phrase.words.filter(w=>!w.excluded)){
      const entry=entries.get(word.id);
      if(!entry.pronunciationChecked){
        const response=await chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_SUGGEST',text:word.text});
        if(tapBinding()!==binding||timingPhrase()?.id!==phrase.id)throw Error('The phrase changed while preparing syllables.');
        if(response?.ok){entry.alternatives=response.suggestion.alternatives||[];entry.requiresChoice=response.suggestion.status==='ambiguous'&&!entry.edited&&!word.syllables?.length;if(!entry.edited&&!word.syllables?.length&&response.suggestion.parts?.length)entry.value=response.suggestion.parts.join('|');}
        entry.pronunciationChecked=true;
        entry.checked=true;
      }
      if(entry.requiresChoice)continue;
      const parts=entry.value.split('|'),spoken=parts.join('');
      if(!spoken.trim()||spoken.length>256||parts.some(p=>!p.trim()))throw Error(`Enter nonempty syllables for “${word.text}”, separated with |.`);
      if(word.syllables?.length&&word.syllables.map(s=>s.text).join('|')===entry.value)continue;
      const span=word.endMs-word.startMs;
      if(span<parts.length)throw Error(`The interval for “${word.text}” is too short. Adjust its phrase first.`);
      for(const child of word.syllables||[])if(child.locked)operations.push({type:'setSyllableLock',syllableId:child.id,locked:false});
      operations.push({type:'setWordSyllables',wordId:word.id,spokenText:spoken===word.text?null:spoken,startTapping:true,syllables:parts.map((text,i)=>({id:`${word.id}-syllable-${i+1}`,text,startMs:word.startMs+Math.round(span*i/parts.length),endMs:word.startMs+Math.round(span*(i+1)/parts.length)}))});
    }
    if(operations.length){const result=await timingRequest('LV_TIMING_TUNE',{operations,allowProtected:true});timing.draft=result.preview;timing.auditioned=false;}
  }
  function phraseSyllableUnits(phrase) {
    return phrase.words.filter(w=>!w.excluded).flatMap(word=>(word.syllables||[]).map(s=>({...s,syllableId:s.id,wordId:word.id,phraseId:phrase.id,spelling:s.text,minMs:phrase.startMs,maxMs:phrase.endMs,estimatedStartMs:s.startMs,estimatedEndMs:s.endMs})));
  }
  function syllableTakeScore() {
    const take=tapping.take;
    if(take?.mode!=='syllable'||take.status!=='complete'||tapping.binding!==tapBinding())return null;
    const key=JSON.stringify(take.marks);
    if(tapping.auditionMarks!==key){tapping.auditionScore=LvScore.applyOperation(timing.draft.score,{type:'setPhraseSyllableTimings',phraseId:take.units[0].phraseId,marks:take.marks},timing.draft.score.revision);tapping.auditionMarks=key;state.scoreSignature='';}
    return tapping.auditionScore;
  }
  async function hearSyllableTake() {
    try{const score=syllableTakeScore();if(!score)return;const media=getMedia(),phrase=timingPhrase(score);
      if(!media||isAdvertisement()||LvScore.mediaKey({url:location.href})!==LvScore.mediaKey(score.source))throw Error('Reopen Sync on the matching video.');
      const startMs=Math.max(0,phrase.startMs+score.offsetMs-350),endMs=phrase.endMs+score.offsetMs+350;
      media.playbackRate=Number(syncButton('tap-speed').value);media.currentTime=startMs/1000;state.auditionLoop=syncButton('loop').checked?{startMs,endMs}:null;
      timing.view='proposed';await media.play();setSyncNotice('Playing your phrase take. Retake, correct a shared boundary below, or Keep phrase & next.');
    }catch(error){setSyncNotice(error.message,'error');}
  }
  async function keepSyllableAndNext(){const phrase=timingPhrase();await useTapTake();if(tapping.take)return;getMedia()?.pause();state.auditionLoop=null;const next=timing.draft?.score.phrases.findIndex((p,i)=>i>timing.phraseIndex&&p.laneId===phrase.laneId&&p.words.some(w=>!w.excluded));if(next>=0){timing.phraseIndex=next;tapping.wordId=timingPhrase().words.find(w=>!w.excluded)?.id;}refreshTimingPanel();setSyncNotice(next>=0?'Phrase kept in preview. Next phrase is ready. Save timings whenever you want.':'Last phrase kept in preview. Save timings when ready.');}
  function followTapUnit() {
    const unit = tapping.take?.units[tapping.take.index];
    if (!unit) return;
    const index = timing.draft.score.phrases.findIndex(p => p.id === unit.phraseId || p.words.some(w => w.id === unit.wordId));
    if (index >= 0) { timing.phraseIndex = index; tapping.wordId = unit.wordId; }
  }
  function wordTimingUnits(words) {
    return words.filter(word=>!word.excluded).flatMap(word => {
      const parts = LvScore.hyphenWordParts(word.text), count = parts.length;
      return parts.map((spelling,index) => ({id:count > 1 ? `${word.id}__take-part-${index+1}` : word.id,wordId:word.id,
        text:count > 1 ? spelling.replace(/[-\u2010\u2011]+$/u,'') : spelling,spelling,partIndex:index,partCount:count,
        estimatedStartMs:word.startMs+Math.round((word.endMs-word.startMs)*index/count),
        estimatedEndMs:word.startMs+Math.round((word.endMs-word.startMs)*(index+1)/count),
        minMs:0,maxMs:timing.draft.score.source.durationMs}));
    });
  }
  function renderPerformPhrase() {
    const phrase=timingPhrase(), take=tapping.take, unit=take?.units[take.index], container=syncPanel.querySelector('.lvx-perform-phrase');
    container.replaceChildren();
    const units=phrase ? (continuousPass()?phrase.words.filter(w=>!w.excluded).map(w=>({id:w.id,wordId:w.id,spelling:w.text,estimatedStartMs:w.startMs,estimatedEndMs:w.endMs})):syncButton('tap-mode').value==='syllable'?phraseSyllableUnits(phrase):wordTimingUnits(phrase.words)) : [];
    const marks=new Map((take?.marks || []).map(mark=>[mark.id,mark]));
    for (const item of units) {
      const span=document.createElement('span'), mark=marks.get(item.id);
      span.className='lvx-context-word'; span.textContent=item.spelling;span.dataset.unit=item.id;
      span.dataset.start=mark?.startMs ?? item.estimatedStartMs; span.dataset.end=mark?.endMs ?? item.estimatedEndMs;
      const next=eventPass()?false:streamTake(take)?item.wordId===tapping.streamWordId:frameTake(take)?item.wordId===tapping.frameWordId:take ? take.mode === 'phrase' ? unit?.phraseId===phrase.id : item.id===unit?.id : syncButton('tap-mode').value === 'phrase' || item.wordId===tapWord()?.id;
      span.classList.toggle('lvx-next-record',Boolean(next));
      span.classList.toggle('lvx-recording-current',Boolean(next));
      container.append(span);
      if (units[units.indexOf(item)+1]?.wordId!==item.wordId && !/[-\u2010\u2011]$/u.test(item.spelling)) container.append(document.createTextNode(' '));
    }
    renderUpcomingLyrics(syncPanel.querySelector('.lvx-upcoming-phrases'),phrase);
    refreshPerformClock((getMedia()?.currentTime || 0)*1000-state.score.offsetMs);
  }
  function renderUpcomingLyrics(container,phrase) {
    container.replaceChildren();
    if(!phrase||!timing.draft){container.hidden=true;return;}
    container.hidden=false;
    const phrases=timing.draft.score.phrases,index=phrases.findIndex(p=>p.id===phrase.id);
    const next=phrases.slice(index+1).filter(p=>p.laneId===phrase.laneId&&p.words.some(w=>!w.excluded)).slice(0,2);
    for(const [i,p] of next.entries()){
      const line=document.createElement('p'),label=document.createElement('small');label.textContent=i?'Then':'Next';
      line.dataset.phrase=p.id;line.append(label,document.createTextNode(p.words.filter(w=>!w.excluded).map(w=>w.text).join(' ')));container.append(line);
    }
    if(!next.length){const p=document.createElement('p');p.textContent='End of this vocal track';container.append(p);}
  }
  function streamCueAt(take,now) {
    const matches=[...new Set(take.units.filter(u=>now>=u.minMs&&now<u.maxMs).map(u=>u.phraseId))];
    if(matches.length!==1)return null;
    return take.units[take.index]?.phraseId===matches[0]?take.units[take.index]:take.units.find(u=>u.phraseId===matches[0]);
  }
  // Keep the selected phrase on the playhead (score clock), in both directions.
  // The selection is kept while the playhead sits in its lead-in or body.
  // Lead-in for parking playback before a phrase: up to 800ms, but never inside the previous phrase.
  function phraseLeadInMs(phrase){
    const lane=timing.draft.score.phrases.filter(p=>p.laneId===phrase.laneId&&p.words.some(w=>!w.excluded));
    const previous=lane.filter(p=>p.startMs<phrase.startMs).at(-1);
    return Math.max(0,phrase.startMs-800,Math.min(phrase.startMs,previous?previous.endMs:0));
  }
  function followPlaybackPhrase(now){
    const phrase=timingPhrase();if(!phrase||!timing.draft)return null;
    const lane=timing.draft.score.phrases.filter(p=>p.laneId===phrase.laneId&&p.words.some(w=>!w.excluded));
    // A lead-in counts for the selected phrase only while no other phrase is actually playing.
    if(now>=phrase.startMs&&now<phrase.endMs)return phrase;
    if(now>=phrase.startMs-1500&&now<phrase.startMs&&!lane.some(p=>p!==phrase&&now>=p.startMs&&now<p.endMs))return phrase;
    const target=lane.find(p=>now>=p.startMs&&now<p.endMs)||lane.find(p=>p.startMs>now)||lane.at(-1);
    if(target&&target.id!==phrase.id){
      timing.phraseIndex=timing.draft.score.phrases.indexOf(target);
      tapping.wordId=target.words.find(w=>!w.excluded)?.id||null;tapping.streamWordId=null;
      state.scoreSignature='';refreshTimingPanel();
    }
    return target;
  }
  // No hidden cursor: outside a recording take, the selected word is the one at the playhead.
  function followPlaybackWord(now){
    const phrase=timingPhrase();if(!phrase)return;
    const word=phrase.words.find(w=>!w.excluded&&now>=w.startMs&&now<w.endMs);
    if(word&&tapping.wordId!==word.id){tapping.wordId=word.id;state.scoreSignature='';refreshTapPanel();}
  }
  function refreshPerformClock(now) {
    refreshBeatPulse(now+state.score.offsetMs);
    if((streamTake(tapping.take)||rawTake(tapping.take))&&tapping.take.status==='stopped'&&tapping.followSeek){
      const target=followPlaybackPhrase(now),id=target?.id||null;
      if(tapping.seekPhraseId!==id){tapping.seekPhraseId=id;state.scoreSignature='';refreshTimingPanel();}
      syncPanel.querySelector('.lvx-estimated-phrase').textContent=target?'Following your playback position · recorded taps unchanged until Retake':'No phrase at this position';
      return;
    }
    if(wordTake(tapping.take)&&tapping.take.status==='armed'){
      const take=tapping.take,unit=take.units[take.index];
      if(unit&&tapping.streamWordId!==unit.wordId){tapping.streamWordId=unit.wordId;timing.phraseIndex=timing.draft.score.phrases.findIndex(p=>p.id===unit.phraseId);tapping.wordId=unit.wordId;state.scoreSignature='';refreshTimingPanel();}
      syncPanel.querySelector('.lvx-estimated-phrase').hidden=false;
      syncPanel.querySelector('.lvx-estimated-phrase').textContent=unit?`Next: “${unit.text}” · ${take.syllableEvents.filter(e=>e.sourceMs>=unit.minMs&&e.sourceMs<unit.maxMs).length} syllable taps in this phrase`:'Every word is held';
      syncPanel.querySelector('.lvx-cue-legend').textContent='Outlined word is next to hold';
      return;
    }
    if(eventTake(tapping.take)&&tapping.take.status==='armed'){
      const eventNow=now+state.score.offsetMs;
      const take=tapping.take,frames=take.units.filter((u,i,a)=>!i||a[i-1].phraseId!==u.phraseId);
      const active=frames.filter(u=>eventNow>=u.minMs&&eventNow<u.maxMs),unit=active.length===1?active[0]:frames.find(u=>u.minMs>eventNow)||frames.at(-1);
      if(unit&&timingPhrase()?.id!==unit.phraseId){timing.phraseIndex=timing.draft.score.phrases.findIndex(p=>p.id===unit.phraseId);tapping.wordId=unit.wordId;state.scoreSignature='';refreshTimingPanel();}
      syncPanel.querySelector('.lvx-estimated-phrase').hidden=false;
      syncPanel.querySelector('.lvx-estimated-phrase').textContent=active.length===1?'Tap each entrance you hear · '+take.events.filter(e=>e.sourceMs>=unit.minMs&&e.sourceMs<unit.maxMs).length+' events in this phrase':'Phrase lead-in or rest · taps are still preserved';
      syncPanel.querySelector('.lvx-cue-legend').textContent='Whole phrase shown · no word assignment during recording';
      return;
    }
    if(streamTake(tapping.take)&&tapping.take.status==='armed'){
      const take=tapping.take,unit=streamCueAt(take,now),id=unit?.wordId||null;
      if(tapping.streamWordId!==id){tapping.streamWordId=id;if(unit){timing.phraseIndex=timing.draft.score.phrases.findIndex(p=>p.id===unit.phraseId);tapping.wordId=id;}state.scoreSignature='';refreshTimingPanel();}
      const recorded=unit?take.marks.filter(m=>m.wordId===unit.wordId).length:0;
      syncPanel.querySelector('.lvx-estimated-phrase').hidden=false;
      syncPanel.querySelector('.lvx-estimated-phrase').textContent=unit?`Next: “${unit.text}” · syllable ${recorded+1} · ${unit.expectedCount} suggested`:'Phrase lead-in or rest · wait for the next phrase';
      syncPanel.querySelector('.lvx-cue-legend').textContent='Blue follows the suggested sequence and your corrections · old word timings are ignored';
      return;
    }
    if(frameTake(tapping.take)&&tapping.take.status==='armed'){
      const matches=tapping.take.units.filter(u=>now>=u.minMs&&now<u.maxMs),unit=matches.length===1?matches[0]:null;
      const id=unit?.wordId||null;
      if(tapping.frameWordId!==id){tapping.frameWordId=id;if(unit){timing.phraseIndex=timing.draft.score.phrases.findIndex(p=>p.id===unit.phraseId);tapping.wordId=id;}state.scoreSignature='';refreshTapPanel();}
      syncPanel.querySelector('.lvx-estimated-phrase').hidden=false;
      syncPanel.querySelector('.lvx-estimated-phrase').textContent=unit?`“${unit.text}” · ${tapping.take.marks.filter(m=>m.wordId===id).length} taps`:matches.length?'Overlapping word frames · no tap target':'Rest · no tap target';
      syncPanel.querySelector('.lvx-cue-legend').textContent='Blue follows the current word frame · your presses set its syllable count';
      return;
    }
    let phrase=timingPhrase();
    if(tapping.take&&['armed','complete'].includes(tapping.take.status)&&!(tapping.take.mode==='syllable'&&tapping.take.status==='complete')){
      for(const span of syncPanel.querySelectorAll('.lvx-estimated-playing'))span.classList.remove('lvx-estimated-playing');
      const live=syncPanel.querySelector('.lvx-estimated-phrase');live.hidden=true;
      syncPanel.querySelector('.lvx-cue-legend').textContent='Blue follows your presses · original timing is hidden during recording';
      return;
    }
    if((!tapping.take||tapping.take.status==='stopped')&&!timing.busy){followPlaybackPhrase(now);followPlaybackWord(now);}
    syncPanel.querySelector('.lvx-estimated-phrase').hidden=false;
    syncPanel.querySelector('.lvx-cue-legend').textContent=tapping.take?.mode==='syllable'&&tapping.take.status==='complete'?'Playing your recorded syllable boundaries · not yet kept':'Blue: selected recording cue · playback estimates shown below';
    phrase=timingPhrase();
    for (const span of syncPanel.querySelectorAll('.lvx-context-word')) span.classList.toggle('lvx-estimated-playing',now>=Number(span.dataset.start)&&now<Number(span.dataset.end));
    for (const block of syncPanel.querySelectorAll('.lvx-tap-blocks button')) block.classList.toggle('lvx-estimated-playing',now>=Number(block.dataset.start)&&now<Number(block.dataset.end));
    if(tapping.take?.mode==='syllable'&&tapping.take.status==='complete'){syncPanel.querySelector('.lvx-estimated-phrase').textContent=now>=phrase.startMs&&now<phrase.endMs?'Playing this phrase take':'Phrase lead-in or rest';return;}
    const matches=timing.draft?.score.phrases.filter(p=>p.laneId===phrase?.laneId&&now>=p.startMs&&now<p.endMs) || [];
    const live=syncPanel.querySelector('.lvx-estimated-phrase');
    const message=matches.length===1 ? matches[0].id===phrase?.id ? 'Estimated phrase is playing' : `Estimated now: ${matches[0].words.map(w=>w.text).join(' ')}` : matches.length>1 ? 'Estimated phrases overlap' : 'Estimated rest · waiting for the next phrase';
    if (live.textContent!==message) live.textContent=message;
  }
  function refreshMarkCorrection() {
    const take=tapping.take, section=syncPanel.querySelector('.lvx-mark-correction'), select=syncButton('correct-mark');
    section.hidden=!take?.marks.length || take.status==='armed';
    if (section.hidden) return;
    if (!take.marks.some(m=>m.id===tapping.reviewId)) tapping.reviewId=take.marks.at(-1).id;
    select.replaceChildren();
    for (const mark of take.marks) { const option=document.createElement('option'); option.value=mark.id; option.textContent=frameTake(take)||streamTake(take)?`${take.units.find(u=>u.wordId===mark.wordId)?.text} · syllable ${take.marks.filter(m=>m.wordId===mark.wordId).indexOf(mark)+1}`:take.units.find(u=>u.id===mark.id)?.text || mark.id; select.append(option); }
    select.value=tapping.reviewId;
    const mark=take.marks.find(m=>m.id===tapping.reviewId), index=take.marks.indexOf(mark);
    for (const edge of ['start','end']) { const input=syncButton(`correct-${edge}`); if (document.activeElement!==input) input.value=mark[`${edge}Ms`]; input.disabled=timing.busy || take.mode==='syllable'&&(edge==='start'&&index===0 || edge==='end'&&index===take.units.length-1); }
    if(frameTake(take)){syncButton('correct-start').disabled=timing.busy||take.marks[index-1]?.wordId!==mark.wordId;syncButton('correct-end').disabled=timing.busy||take.marks[index+1]?.wordId!==mark.wordId;}
    if(streamTake(take)){syncButton('correct-start').disabled=timing.busy||take.marks[index-1]?.phraseId!==mark.phraseId;syncButton('correct-end').disabled=timing.busy||take.marks[index+1]?.phraseId!==mark.phraseId;}
    const move=syncButton('correct-edge').querySelector('[value=move]'); move.disabled=take.mode==='syllable';
    if (move.disabled && syncButton('correct-edge').value==='move') syncButton('correct-edge').value='end';
    syncButton('correct-undo').disabled=timing.busy || !tapping.correctionUndo.length;
    for (const name of ['correct-mark','correct-edge','correct-hear','correct-save','correct-earlier','correct-later']) syncButton(name).disabled=timing.busy;
  }
  function correctMark(deltaMs) {
    const take=tapping.take;
    if (timing.busy || !take || take.status==='armed' || tapping.binding!==tapBinding()) return;
    try {
      const updated=LvTapTiming.adjust(take,{id:tapping.reviewId,edge:syncButton('correct-edge').value,deltaMs});
      tapping.correctionUndo.push(take); tapping.correctionUndo=tapping.correctionUndo.slice(-128); tapping.take=updated;
      refreshTimingPanel(); setSyncNotice(`Recorded mark adjusted ${deltaMs>0?'later':'earlier'} by ${Math.abs(deltaMs)} ms. Preview and saved track unchanged until you use the take.`);
    } catch(error) { setSyncNotice(error.message,'error'); }
  }
  function correctMarkExact() {
    const take=tapping.take, mark=take?.marks.find(m=>m.id===tapping.reviewId);
    if (timing.busy || !mark || take.status==='armed' || tapping.binding!==tapBinding()) return;
    try {
      const start=Number(syncButton('correct-start').value), end=Number(syncButton('correct-end').value);
      if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start) throw Error('Enter whole milliseconds with a positive duration.');
      let next=take;
      const deltas={start:start-mark.startMs,end:end-mark.endMs};
      if (deltas.start===deltas.end && take.mode!=='syllable') next=LvTapTiming.adjust(next,{id:mark.id,edge:'move',deltaMs:deltas.start});
      else for (const edge of start>=mark.endMs ? ['end','start'] : ['start','end']) if(deltas[edge]) next=LvTapTiming.adjust(next,{id:mark.id,edge,deltaMs:deltas[edge]});
      tapping.correctionUndo.push(take); tapping.correctionUndo=tapping.correctionUndo.slice(-128); tapping.take=next;
      syncButton('correct-save').focus(); refreshTimingPanel(); setSyncNotice('Exact recorded times updated. Use take in preview when ready.');
    } catch(error) { setSyncNotice(error.message,'error'); }
  }
  async function hearCorrectedMark() {
    const mark=tapping.take?.marks.find(m=>m.id===tapping.reviewId), media=getMedia();
    if (!mark || !media || timing.busy || tapping.take.status==='armed' || tapping.binding!==tapBinding()) return;
    media.pause();
    const startMs=Math.max(0,mark.startMs+state.score.offsetMs-350), endMs=Math.min(state.score.source.durationMs,mark.endMs+state.score.offsetMs+350);
    state.auditionLoop={startMs,endMs}; media.preservesPitch=true; media.playbackRate=Number(syncButton('tap-speed').value); media.currentTime=startMs/1000;
    try { await media.play(); setSyncNotice('Looping this recorded mark at practice speed. Pause to stop; corrections remain buffered.'); } catch(error) {setSyncNotice(error.message,'error');}
  }
  syncButton('correct-mark').addEventListener('change',()=>{tapping.reviewId=syncButton('correct-mark').value;refreshMarkCorrection();});
  syncButton('correct-earlier').addEventListener('click',()=>correctMark(-10));
  syncButton('correct-later').addEventListener('click',()=>correctMark(10));
  syncButton('correct-save').addEventListener('click',correctMarkExact);
  syncButton('correct-hear').addEventListener('click',hearCorrectedMark);
  syncButton('correct-undo').addEventListener('click',()=>{if(!timing.busy && tapping.take?.status!=='armed' && tapping.binding===tapBinding() && tapping.correctionUndo.length){tapping.take=tapping.correctionUndo.pop();refreshTimingPanel();}});
  function renderTapTimeline() {
    const phrase = timingPhrase(), lane = syncPanel.querySelector('.lvx-tap-blocks'); lane.replaceChildren();
    lane.parentElement.hidden=Boolean(tapping.take&&['armed','complete'].includes(tapping.take.status));
    if (!phrase) return;
    const syllables = syncButton('tap-mode').value === 'syllable';
    const marks = new Map((tapping.take?.marks || []).map(m => [m.id,m]));
    const items = (syllables ? phraseSyllableUnits(phrase) : wordTimingUnits(phrase.words).map(unit=>({...unit,startMs:unit.estimatedStartMs,endMs:unit.estimatedEndMs}))).map(w => ({...w,...marks.get(w.id)}));
    if (!items.length) { lane.dataset.start = ''; lane.dataset.end = ''; return; }
    const start = Math.min(...items.map(w => w.startMs)), end = Math.max(...items.map(w => w.endMs));
    lane.dataset.start = start; lane.dataset.end = Math.max(start + 1,end);
    for (const word of items) {
      const block = document.createElement('button'); block.type = 'button'; block.textContent = word.text;
      block.title = `${word.text}: ${word.startMs}–${word.endMs} ms`; block.setAttribute('aria-label', block.title);
      block.dataset.start=word.startMs; block.dataset.end=word.endMs;
      block.style.left = `${100 * (word.startMs-start)/(end-start || 1)}%`; block.style.width = `${100 * (word.endMs-word.startMs)/(end-start || 1)}%`;
      block.classList.toggle('lvx-marked',marks.has(word.id)); block.setAttribute('aria-pressed',String((word.wordId || word.id) === tapWord()?.id));
      block.disabled = syllables || timing.busy || tapPending() || tapping.splitDirty;
      block.addEventListener('click',() => { tapping.wordId = word.wordId || word.id; refreshTapPanel(); }); lane.append(block);
    }
  }
  async function prepareStreamUnits(phrase,raw=false,fromIndex=timing.phraseIndex,onProgress=null) {
    let done=0;
    const binding=tapBinding(),phrases=timing.draft.score.phrases.slice(fromIndex).filter(p=>p.laneId===phrase.laneId&&p.endMs>p.startMs);
    const units=await Promise.all(phrases.flatMap(p=>p.words.filter(w=>!w.excluded).map(async word=>{
      const authored=word.syllables?.length&&word.syllables.some(s=>s.locked||s.provenance==='manual');
      let expectedCount=authored?word.syllables.length:raw?null:1,countOptions=[],countSource=authored?'authored':'unknown',parts=word.syllables?.map(s=>s.text)||[word.spokenText||word.text];
      if(!authored){try{const r=await chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_SUGGEST',text:word.text,...(word.spokenText?{spokenText:word.spokenText}:{})});
        countOptions=r?.suggestion?.syllableCounts||[];if(countOptions.length){countSource='dictionary';expectedCount=countOptions[0];}
        const candidate=r?.suggestion?.parts?.length?r.suggestion.parts:r?.suggestion?.alternatives?.find(a=>a.count===expectedCount)?.parts;
        if(candidate?.length){parts=candidate;expectedCount=parts.length;}
      }catch{/* A dictionary outage must not prevent a manual take. */}}
      if(onProgress)onProgress(++done);
      return {id:word.id,wordId:word.id,phraseId:p.id,text:word.text,parts,expectedCount,countOptions,countSource,referenceStartMs:word.startMs+(raw?state.score.offsetMs:0),referenceEndMs:word.endMs+(raw?state.score.offsetMs:0),referenceManual:word.provenance==='manual',minMs:p.startMs+(raw?state.score.offsetMs:0),maxMs:p.endMs+(raw?state.score.offsetMs:0),estimatedStartMs:p.startMs};
    })));
    if(binding!==tapBinding())throw Error('The preview changed while preparing suggestions. Your existing take is retained.');
    return units;
  }
  async function armTapTake() {
    const mode=syncButton('tap-mode').value;
    if (timing.busy || !timing.draft || timing.dirty || (mode!=='syllable'&&tapping.splitDirty) || effectPending() || tapping.take?.status === 'armed' || tapping.take?.status === 'complete') return;
    let word = tapWord(), phrase = timingPhrase();const media = getMedia();
    if (!word || !media || isAdvertisement() || youtubeMediaState()?.clockUsable === false || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) { setSyncNotice('Wait for this video’s main audio before starting a take.'); return; }
    try {
      timing.busy=true;refreshTimingPanel();
      if(mode==='syllable'&&!continuousPass()){discardTapTake();await preparePhraseSyllables();phrase=timingPhrase();word=phrase.words.find(w=>!w.excluded);tapping.wordId=word?.id;const unresolved=[...phraseSpellingState()].filter(([,e])=>e.requiresChoice);if(unresolved.length){syncPanel.querySelector('.lvx-phrase-syllables details').open=true;throw Error('Choose the sung syllable count in Syllable spelling for: '+unresolved.map(([id])=>phrase.words.find(w=>w.id===id)?.text).join(', ')+'. Then Start phrase take.');}}
      const laneWords = (syncButton('tap-scope').value === 'lane' ? timing.draft.score.phrases.slice(timing.phraseIndex).filter(p => p.laneId === phrase.laneId).flatMap(p => p.words) : phrase.words).filter(w=>!w.excluded);
      const selected = mode === 'word' ? laneWords.slice(laneWords.findIndex(w => w.id === word.id)) : phraseSyllableUnits(phrase);
      const phrases=(syncButton('tap-scope').value === 'lane' ? timing.draft.score.phrases.slice(timing.phraseIndex).filter(p=>p.laneId===phrase.laneId) : [phrase]).filter(p=>p.words.some(w=>!w.excluded));
      const retiming=wordTake(tapping.take)&&tapping.take.retime;
      if(!retiming){
        // Start and Continue both begin at the phrase you are listening to, never a stale selection or the take's old end.
        const now=Math.round(media.currentTime*1000)-state.score.offsetMs,lane=timing.draft.score.phrases.filter(p=>p.laneId===phrase.laneId&&p.words.some(w=>!w.excluded));
        const parked=now>=phrase.startMs-1500&&now<phrase.endMs;
        if(!parked){
          const target=lane.find(p=>now>=p.startMs-1000&&now<p.startMs)||lane.find(p=>now>=p.startMs&&now<p.endMs)||lane.find(p=>p.startMs>now)||lane.at(-1);
          if(target&&target.id!==phrase.id){timing.phraseIndex=timing.draft.score.phrases.indexOf(target);phrase=target;word=phrase.words.find(w=>!w.excluded)||word;tapping.wordId=word.id;state.scoreSignature='';}
        }
      }
      const units = eventPass()||wordPass() ? await prepareStreamUnits(phrase,true) : phraseStream() ? await prepareStreamUnits(phrase) : continuousSyllables() ? timing.draft.score.phrases.slice(timing.phraseIndex).filter(p=>p.laneId===phrase.laneId).flatMap(p=>p.words.filter(w=>!w.excluded&&w.startMs>=word.startMs&&w.endMs>w.startMs).map(w=>({id:w.id,wordId:w.id,phraseId:p.id,text:w.text,minMs:w.startMs,maxMs:w.endMs,estimatedStartMs:w.startMs}))).sort((a,b)=>a.minMs-b.minMs) : mode === 'phrase' ? phrases.map(p=>({id:p.id,phraseId:p.id,wordId:p.words.find(w=>!w.excluded).id,text:p.words.filter(w=>!w.excluded).map(w=>w.text).join(' '),estimatedStartMs:p.startMs,minMs:0,maxMs:timing.draft.score.source.durationMs})) : mode === 'word' ? wordTimingUnits(selected) : selected.map(item => ({ id: item.id, wordId: word.id,
        ...(mode === 'syllable' ? { syllableId: item.id,wordId:item.wordId,phraseId:phrase.id } : {}), text: item.text,
        minMs: mode === 'word' ? 0 : phrase.startMs, maxMs: mode === 'word' ? timing.draft.score.source.durationMs : phrase.endMs }));
      // A raw take of the other kind (syllable taps vs word holds) is archived and becomes the source, not a continuation.
      let current=tapping.take&&(eventPass()?eventTake(tapping.take):wordPass()?wordTake(tapping.take):!rawTake(tapping.take))?tapping.take:null;
      if (current && tapping.binding !== tapBinding()) throw Error('This take belongs to an older preview. Discard it before continuing.');
      const syllableSource=wordPass()&&!current?(eventTake(tapping.take)&&tapping.take.events.length?tapping.take.events:await latestArchivedSyllableEvents()):null;
      if(wordPass()&&!current&&!syllableSource?.length)throw Error('Record a “Tap freely” syllable pass first. The word pass claims those taps.');
      const resuming=Boolean(current&&current.status==='stopped'&&!retiming);
      const retakePhraseId=resuming&&(streamTake(current)||rawTake(current))?phrase.id:null;
      if(resuming&&!streamTake(current)&&!rawTake(current)&&['word','phrase'].includes(current.mode)){
        const at=current.mode==='phrase'?current.units.findIndex(u=>u.id===phrase.id||u.phraseId===phrase.id):current.units.findIndex(u=>phrase.words.some(w=>w.id===u.wordId));
        if(at>=0)current=LvTapTiming.reposition(current,at);
      }
      if(retakePhraseId&&rawTake(current)&&!current.units.some(u=>u.phraseId===retakePhraseId)){
        const at=timing.draft.score.phrases.findIndex(p=>p.id===retakePhraseId),firstMin=current.units[0].minMs;
        const earlier=(await prepareStreamUnits(timing.draft.score.phrases[at],true,at)).filter(u=>u.minMs<firstMin&&!current.units.some(c=>c.wordId===u.wordId));
        if(earlier.length)current={...current,units:[...earlier,...current.units]};
      }
      const retained=retakePhraseId?(eventTake(current)?LvTapTiming.rewindEvents(current,retakePhraseId):wordTake(current)?LvTapTiming.rewindWordHolds(current,retakePhraseId):LvTapTiming.rewindToPhrase(current,retakePhraseId)):current;
      if(!current&&rawTake(tapping.take)){tapping.take=null;tapping.eventCounts={};tapping.eventApplied=[];}
      const take = retained ? { ...retained, status:'armed' } : wordPass()?LvTapTiming.beginWordHolds(units,syllableSource):eventPass()?LvTapTiming.beginEvents(units):LvTapTiming.begin(units, { mode, cadence:phraseStream()?'phrase-stream':continuousSyllables()?'word-frames':mode === 'syllable' ? 'entrances' : syncButton('tap-cadence').value === 'hold' ? 'pairs' : syncButton('tap-cadence').value, bpm: continuousPass()?null:syncButton('tap-snap').checked ? Number(syncButton('tap-bpm').value) : null });
      tapping.correctionUndo = []; tapping.cancelledSpace=false;
      timing.busy = true; refreshTimingPanel();
      const practiceRate = Number(syncButton('tap-speed').value);
      if (![.25,.5,.75,1].includes(practiceRate)) throw Error('Choose quarter, half, slower or normal practice speed.');
      media.preservesPitch = true; media.playbackRate = practiceRate;
      if(mode==='syllable'&&tapping.audio){await tapping.audio.close();tapping.audio=null;}
      if (mode!=='syllable'&&syncButton('tap-click').checked) {
        tapping.audio ||= new AudioContext(); await tapping.audio.resume();
      }
      state.auditionLoop = null;if(mode!=='syllable'||continuousPass())syncButton('loop').checked = false;
      const nextUnit = take.units[take.index];
      const nextStart = wordTake(take)&&take.retime?nextUnit.minMs-state.score.offsetMs:resuming?phrase.startMs:retakePhraseId?nextUnit.minMs-(rawTake(take)?state.score.offsetMs:0):(streamTake(take)||rawTake(take))&&take.lastMs!==null?take.lastMs-(rawTake(take)?state.score.offsetMs:0):mode !== 'syllable'||continuousPass() ? nextUnit?.estimatedStartMs : phrase.startMs;
      tapping.armSeekMs=Math.max(0, (nextStart ?? word.startMs) + state.score.offsetMs - 800);
      media.currentTime = tapping.armSeekMs / 1000;
      await media.play();
      if (!timing.draft || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) throw Error('Source changed before the take started.');
      // With a tapped tempo, snapping uses its beat phase instead of the first tap.
      if(take.bpm!==null&&tempo.estimate&&take.originMs===null&&Math.abs(take.bpm-tempo.estimate.bpm)<.01)take.originMs=tempo.estimate.anchorMs-state.score.offsetMs;
      tapping.take = take; tapping.binding = tapBinding(); tapping.clockMs = media.currentTime * 1000; tapping.rate = media.playbackRate;tapping.followSeek=false;tapping.seekPhraseId=null;tapping.streamWordId=null;
      timing.view = 'proposed'; timing.auditioned = false; state.scoreSignature = '';
      setSyncNotice(mode === 'syllable' ? 'Tap Space at each syllable entrance, including the first. Phrase start and end stay fixed. The completed take plays back for review.' : syncButton('tap-cadence').value === 'hold' ? 'Hold Space for each sung word; release it at the end. Each release advances automatically.' : take.cadence === 'flow' ? 'Space starts each next lyric. Enter releases before a rest or at the end. Stop retains completed marks.' : 'Space marks START then END. Use take updates only the unsaved preview.');
      if(frameTake(take))setSyncNotice('Continuous syllable pass: tap each entrance. Two taps inside a word make two syllables. Stop whenever you want; untapped words keep their timing.');
      if(wordTake(take))setSyncNotice('Hold Space while each word is sung; release when it ends. Your syllable taps stay fixed. Stop anytime; held phrases can go to the preview.');
      if(eventTake(take))setSyncNotice('Tap each syllable you hear. Timestamps are captured without assigning words. Stop to review grouping; editor sounds are muted.');
      if(streamTake(take))setSyncNotice('Tap the syllables as they arrive. Old word times are ignored. Left / Right moves the next cue; Ctrl + Left / Right changes the last tap’s word without seeking.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); if (tapping.take?.status === 'armed') { renderScore(getMediaTimeMs()); syncButton('tap-mark').focus({preventScroll:true});syncPanel.querySelector('.lvx-perform-cue').scrollIntoView({block:'start'}); } }
  }
  function markTapTime(event = {}) {
    const take = tapping.take, media = getMedia();
    if (!take || take.status !== 'armed' || event.repeat) return;
    if (event.shiftKey) { setSyncNotice('Note change within the held unit. Use plain Space to mark its release; the selected unit has not advanced.'); return; }
    if (tapping.binding !== tapBinding() || !media || media.paused || media.seeking || isAdvertisement() || youtubeMediaState()?.clockUsable === false || media.playbackRate !== tapping.rate || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) { stopTapTake('Take stopped because playback or its source changed. Completed marks are retained.'); return; }
    try {
      if (event.release) tapping.heldInput = null;
      tapping.take = (wordTake(take)?(event.release?LvTapTiming.releaseWord:LvTapTiming.pressWord):eventTake(take)?LvTapTiming.markEvent:event.release ? LvTapTiming.release : LvTapTiming.mark)(take, Math.round(media.currentTime * 1000 - (rawTake(take)?0:state.score.offsetMs)));
      if(!rawTake(tapping.take))followTapUnit();
      timing.auditioned = false;
      if (take.mode!=='syllable'&&syncButton('tap-click').checked && tapping.audio?.state === 'running') {
        const oscillator = tapping.audio.createOscillator(), gain = tapping.audio.createGain(), now = tapping.audio.currentTime;
        oscillator.frequency.value = take.pendingStartMs === null ? 800 : 1100;
        gain.gain.setValueAtTime(.06, now); gain.gain.exponentialRampToValueAtTime(.001, now + .025);
        oscillator.connect(gain); gain.connect(tapping.audio.destination); oscillator.start(now); oscillator.stop(now + .03);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
      refreshTimingPanel();
      renderScore(getMediaTimeMs());
      if(tapping.take.mode==='syllable'&&tapping.take.status==='complete'&&!wordTake(tapping.take))void hearSyllableTake();
      if(['phrase','word'].includes(tapping.take.mode)&&tapping.take.status==='complete')void finishStoppedTake();
      if(wordTake(take)&&take.retime&&!tapping.take.retime&&tapping.take.status==='stopped'){
        getMedia()?.pause();const id=take.retime.phraseId;void clearRetimeFlag(id);void archiveEvents().catch(()=>{});
        setSyncNotice(`Phrase ${phraseOrdinal(id)} retimed. Review it below, then Use held phrases. Other phrases are unchanged.`);
      }
      if(wordTake(tapping.take)&&tapping.take.status==='complete'){getMedia()?.pause();setSyncNotice(`All ${tapping.take.holds.length} words held. Review below, then Use held phrases.`);}
    } catch (error) { setSyncNotice(error.message,'error'); }
  }
  // Going back must be as easy as going forward: rewind playback to the
  // unit's lead-in and keep recording. The seek is marked internal so the
  // seek/pause guards do not end the take.
  function rewindPlaybackForTake(targetMs){
    const media=getMedia();if(!media||!Number.isFinite(targetMs))return;
    tapping.armSeekMs=Math.max(0,Math.round(targetMs));tapping.takeSeekUntil=performance.now()+1500;
    media.currentTime=tapping.armSeekMs/1000;
    if(media.paused)void media.play().catch(()=>{});
  }
  // Back like a media player: a held unit restarts; more than 1s into the next unit, it restarts;
  // otherwise (e.g. right after a rewind) it steps to the previous unit and clears it for rewriting.
  function backTarget(take){
    if(take.pendingStartMs!==null)return take.index;
    const unit=take.units[take.index],start=unit?.estimatedStartMs??unit?.minMs,now=getMediaTimeMs()-state.score.offsetMs;
    if(unit&&Number.isFinite(start)&&now>start+1000)return take.index;
    return take.index-1;
  }
  function repositionTap(index) {
    const take=tapping.take;
    if(timing.busy||!take||!['armed','complete'].includes(take.status)||getMedia()?.paused||take.mode==='syllable'||tapping.binding!==tapBinding())return false;
    try{
      const updated=LvTapTiming.reposition(take,index), removed=take.marks.length-updated.marks.length;
      if(tapping.heldInput==='keyboard')tapping.cancelledSpace=true;
      tapping.heldInput=null;tapping.take={...updated,status:'armed'};tapping.correctionUndo=[];tapping.reviewId=null;
      const rewinding=index<=take.index;
      if(rewinding){
        // Rewind to the lead-in, but never before the last kept mark (the next mark must follow it).
        const unit=updated.units[index],lead=(unit.estimatedStartMs??unit.minMs??0)-800,floor=updated.lastMs!=null?updated.lastMs+1:0;
        rewindPlaybackForTake(Math.max(lead,floor)+state.score.offsetMs);
      }
      followTapUnit();state.scoreSignature='';refreshTimingPanel();renderScore(getMediaTimeMs());
      if(rewinding){setSyncNotice(`Back to ${take.mode==='phrase'?'phrase':'word'} ${index+1}: ${updated.units[index].text}. Playback rewound to its lead-in${removed?`; ${removed} later mark${removed===1?'':'s'} cleared for rerecording`:''}. Keep going.`);return true;}
      setSyncNotice(`${take.mode==='phrase'?'Phrase':'Word'} ${index+1}: ${updated.units[index].text}. ${removed?`${removed} later mark${removed===1?'':'s'} cleared for rerecording. `:''}The song keeps playing; skipped lyrics keep existing timing.`);
      return true;
    }catch(error){setSyncNotice(error.message,'error');return false;}
  }
  function recoverStream(direction,reassign=false){
    const take=tapping.take,media=getMedia();
    if(!streamTake(take)||take.status!=='armed'||!media||media.paused||media.seeking||tapping.binding!==tapBinding()||timing.busy)return;
    try{
      tapping.take=reassign?LvTapTiming.reassignLast(take,direction):LvTapTiming.moveCursor(take,direction,Math.round(media.currentTime*1000-state.score.offsetMs));
      followTapUnit();state.scoreSignature='';refreshTimingPanel();
      const last=tapping.take.marks.at(-1),target=tapping.take.units.find(u=>u.wordId===(reassign?last?.wordId:tapping.take.units[tapping.take.index]?.wordId));
      setSyncNotice(reassign?`Last tap now belongs to “${target?.text}”. Its timestamp is unchanged; playback continues.`:`Next cue: “${target?.text}”. Existing taps and playback position are unchanged.`);
    }catch(error){setSyncNotice(error.message,'error');}
  }
  function restoreBufferedTake(packet){
    if(timing.busy||tapPending()||timing.dirty||tapping.splitDirty||!timing.draft||!getMedia()?.paused)throw Error('Restore requires an empty, paused editor with no pending text.');
    if(!packet||packet.binding!==tapBinding())throw Error('The buffered take belongs to a different preview revision or video.');
    const stream=packet.take?.cadence==='phrase-stream';
    const take=stream?LvTapTiming.restorePhraseStreamTake(packet.take):LvTapTiming.restoreWordFrameTake(packet.take),words=timing.draft.score.phrases.flatMap(p=>p.words.map(w=>({word:w,phrase:p})));
    for(const unit of take.units){const match=words.find(x=>x.word.id===unit.wordId);
      if(!match||match.word.excluded||match.word.text!==unit.text||(stream?match.phrase.startMs:match.word.startMs)!==unit.minMs||(stream?match.phrase.endMs:match.word.endMs)!==unit.maxMs||match.phrase.id!==unit.phraseId)throw Error('The take frames changed; keep the numeric take for review instead of guessing a match.');
    }
    tapping.take=take;tapping.binding=packet.binding;tapping.rate=Number(syncButton('tap-speed').value);tapping.restored=true;
    tapping.followSeek=stream;tapping.seekPhraseId=null;
    syncButton('tap-mode').value='syllable';syncButton('tap-syllable-flow').value=stream?'phrase-stream':'continuous';
    if(packet.wordId&&words.some(x=>x.word.id===packet.wordId)){const match=words.find(x=>x.word.id===packet.wordId);timing.phraseIndex=timing.draft.score.phrases.findIndex(p=>p.id===match.phrase.id);tapping.wordId=packet.wordId;}
    else followTapUnit();
    state.scoreSignature='';refreshTimingPanel();renderScore(getMediaTimeMs());
    setSyncNotice(`${take.marks.length} buffered taps restored exactly. Review, continue, or seek back to retake a phrase.`);
    return true;
  }
  function skipWordHold(delta){const take=tapping.take;if(!wordTake(take)||timing.busy)return;try{tapping.take=LvTapTiming.skipWords(take,delta);if(delta<0&&take.status==='armed'){const unit=tapping.take.units[tapping.take.index];rewindPlaybackForTake(Math.max((tapping.take.lastMs??unit.minMs)-600,0));}tapping.streamWordId=null;state.scoreSignature='';refreshTimingPanel();renderScore(getMediaTimeMs());}catch(error){setSyncNotice(error.message,'error');}}
  syncButton('tap-back').addEventListener('click',()=>wordTake(tapping.take)?skipWordHold(-1):streamTake(tapping.take)?recoverStream(-1):(tapping.take?repositionTap(backTarget(tapping.take)):null));
  syncButton('tap-skip').addEventListener('click',()=>wordTake(tapping.take)?skipWordHold(1):streamTake(tapping.take)?recoverStream(1):repositionTap((tapping.take?.index??0)+1));
  syncButton('tap-reassign-back').addEventListener('click',()=>recoverStream(-1,true));
  syncButton('tap-reassign-next').addEventListener('click',()=>recoverStream(1,true));
  async function useTapTake() {
    const take = tapping.take;
    if(rawTake(take)){await useEventAssignments();return;}
    if (!take?.marks.length || take.status === 'armed' || timing.busy) return;
    if (tapping.binding !== tapBinding()) { setSyncNotice('This take belongs to an older preview. Discard it and make a fresh take.'); return; }
    timing.busy = true; refreshTimingPanel();
    try {
      const grouped = new Map();
      if (take.mode === 'word') for (const mark of take.marks) { if (!grouped.has(mark.wordId)) grouped.set(mark.wordId,[]); grouped.get(mark.wordId).push(mark); }
      const payload = frameTake(take)||streamTake(take) ? {operations:await continuousSyllableOperations(take)} : take.mode === 'phrase' ? {operations:take.marks.map(mark=>({type:'setPhraseTiming',phraseId:mark.id,startMs:mark.startMs,endMs:mark.endMs}))} : take.mode === 'word'
        ? { changes: [...grouped].map(([wordId,marks]) => {
          const units = take.units.filter(unit=>unit.wordId===wordId);
          if (units.length > 1 && units.length !== marks.length) throw Error('Finish every part of this hyphenated word, or undo its marks, before using the take.');
          return {wordId,startMs:marks[0].startMs,endMs:marks.at(-1).endMs,
            ...(units.length > 1 ? {hyphenParts:marks.map(mark=>({text:units.find(unit=>unit.id===mark.id).spelling,startMs:mark.startMs,endMs:mark.endMs}))} : {})};
        }) }
        : { operation:{type:'setPhraseSyllableTimings',phraseId:take.units[0].phraseId,marks:take.marks} };
      if(take.mode==='syllable'&&!frameTake(take)&&!streamTake(take)&&take.status!=='complete')throw Error('Finish this phrase or retake it. Other phrases can already be saved.');
      if(tapping.take!==take||tapping.binding!==tapBinding())throw Error('The take or preview changed while preparing spelling. Your marks are retained.');
      // Re-recording is explicit permission to replace saved timings; Undo preview and Discard all revert it.
      const result = await timingRequest('LV_TIMING_TUNE', { ...payload, allowProtected: true });
      timing.draft = result.preview; discardTapTake(); timing.auditioned = false; state.scoreSignature = '';
      if (take.mode === 'phrase') { syncButton('tap-mode').value='syllable';syncButton('loop').checked=false; timing.phraseIndex=0; tapping.wordId=timing.draft.score.phrases[0]?.words[0]?.id; }
      setSyncNotice(take.mode === 'phrase' ? 'Phrases added to preview. Keep refining, or save this iteration.' : 'Take added to preview. Save timings to keep it for this video.');
      if(frameTake(take))setSyncNotice('Tapped syllables added to preview; word edges and untapped words kept. Text cuts are suggestions: inspect them in the lightweight editor. Save timings when ready.');
      if(streamTake(take))setSyncNotice('Phrase-guided syllables added to preview. Word edges now come from your taps. Untapped words and an unfinished trailing word keep their earlier data. Save timings when ready.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  async function continuousSyllableOperations(take,onProgress=null) {
    let spelled=0;
    const words=timing.draft.score.phrases.flatMap(p=>p.words),grouped=new Map();
    for(const mark of take.marks){if(!grouped.has(mark.wordId))grouped.set(mark.wordId,[]);grouped.get(mark.wordId).push(mark);}
    if(streamTake(take)){
      const last=take.marks.at(-1),phraseUnits=take.units.filter(u=>u.phraseId===last?.phraseId);
      if(last&&take.stoppedScoreMs<last.endMs&&last.wordId!==phraseUnits.at(-1)?.wordId)grouped.delete(last.wordId);
      if(!grouped.size)throw Error('The final word has no recorded release yet. Continue into the next word or finish the phrase, then use the take. Your taps are retained.');
    }
    const groups=await Promise.all([...grouped].map(async([wordId,marks],_,all)=>{
      try{
      const word=words.find(w=>w.id===wordId);
      const response=await chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_COUNT',text:word.text,count:marks.length,...(word.spokenText?{spokenText:word.spokenText}:{}),existingParts:word.syllables?.map(s=>s.text)});
      const parts=response?.countSuggestion?.parts;
      if(!parts?.length)throw Error(`Cannot spell ${marks.length} syllables for “${word.text}”. Your taps are retained; edit its spoken form or undo an extra tap.`);
      const operations=(word.syllables||[]).filter(s=>s.locked).map(s=>({type:'setSyllableLock',syllableId:s.id,locked:false}));
      const spoken=parts.join('');
      operations.push({type:'setWordSyllables',wordId,spokenText:spoken===word.text?null:spoken,syllables:marks.map((m,i)=>({id:m.syllableId,text:parts[i],startMs:m.startMs,endMs:m.endMs,...(word.syllables?.length===marks.length?{effects:word.syllables[i].effects}:{})}))});
      return operations;
      }finally{if(onProgress)onProgress(++spelled,all.length);}
    }));
    const operations=groups.flat();
    if(!streamTake(take))return operations;
    const performances=new Map();
    for(const op of operations.filter(o=>o.type==='setWordSyllables')){
      const phrase=timing.draft.score.phrases.find(p=>p.words.some(w=>w.id===op.wordId));
      if(!performances.has(phrase.id))performances.set(phrase.id,[]);
      performances.get(phrase.id).push({wordId:op.wordId,spokenText:op.spokenText,syllables:op.syllables});
    }
    return [...operations.filter(o=>o.type==='setSyllableLock'),...[...performances].map(([phraseId,words])=>({type:'setPhraseSyllablePerformance',phraseId,words}))];
  }
  function eventEnvelope() {
    const take=tapping.take;
    if(wordTake(take))return {schema:'lyricvibe-word-holds-v1',createdAt:new Date().toISOString(),mediaKey:LvScore.mediaKey(state.score.source),lyricsHash:timing.draft.baseHash,
      baseRevision:timing.draft.baseRevision,previewToken:timing.draft.token,previewRevision:timing.draft.previewRevision,offsetMs:state.score.offsetMs,
      holds:take.holds,syllableEvents:take.syllableEvents,referenceUnits:take.units,stoppedScoreMs:take.stoppedScoreMs,
      interpretation:LvTapTiming.associateWordHolds(take),appliedPhraseIds:tapping.eventApplied||[],interpretationStatus:'human-review-required',audioIncluded:false};
    return {schema:'lyricvibe-performance-events-v1',createdAt:new Date().toISOString(),mediaKey:LvScore.mediaKey(state.score.source),lyricsHash:timing.draft.baseHash,
      baseRevision:timing.draft.baseRevision,previewToken:timing.draft.token,previewRevision:timing.draft.previewRevision,offsetMs:state.score.offsetMs,
      events:take.events,referenceUnits:take.units,stoppedScoreMs:take.stoppedScoreMs,counts:tapping.eventCounts||{},
      interpretation:LvTapTiming.associateEvents(take,{counts:tapping.eventCounts||{}}),appliedPhraseIds:tapping.eventApplied||[],
      interpretationStatus:'human-review-required',audioIncluded:false};
  }
  async function archiveEvents() {
    if(!rawTake(tapping.take)||!tapCount(tapping.take)||!timing.draft)return;
    // A stopped capture is an immutable local receipt, independent of score Undo.
    const packet=eventEnvelope(),key='lvPerformanceEvents:'+packet.mediaKey+':'+Date.now()+':'+crypto.randomUUID();
    await chrome.storage.local.set({[key]:packet});tapping.eventArchiveKey=key;return packet;
  }
  // Newest locally archived syllable taps for this video, from a free-tap pass or a word pass built on one.
  async function latestArchivedSyllableEvents() {
    const mediaKey=LvScore.mediaKey(state.score.source),prefix='lvPerformanceEvents:'+mediaKey+':';
    const all=await chrome.storage.local.get(null);
    const stamp=key=>Number(key.slice(prefix.length).split(':')[0]);
    const packets=Object.entries(all).filter(([k,v])=>k.startsWith(prefix)&&v?.mediaKey===mediaKey).sort((a,b)=>stamp(b[0])-stamp(a[0]));
    for(const [,packet] of packets){const events=packet.schema==='lyricvibe-word-holds-v1'?packet.syllableEvents:packet.events;if(events?.length)return events;}
    return null;
  }
  function renderWordReview(take,section){
    const report=LvTapTiming.associateWordHolds(take);tapping.eventReport=report;
    const held=report.phrases.filter(p=>p.heldCount),ready=held.filter(p=>p.ready&&!tapping.eventApplied?.includes(p.phraseId));
    section.querySelector('.lvx-event-summary').textContent=`${take.holds.length} words held over ${take.syllableEvents.length} syllable taps · ${ready.length} phrases ready · ${retimeFlags.items.length} flagged · ${report.unclaimed.length} taps unclaimed. Syllable times were not moved.`;
    section.querySelector('.lvx-event-review > .lvx-sync-hint').textContent='Each press claimed the syllable taps after it; each release ends that word\u2019s last syllable. Amber marks a count that differs from the dictionary, a tap after the release, or a word you did not hold.';
    const list=section.querySelector('.lvx-event-phrases');list.replaceChildren();
    const labels={'word-not-held':'not held','no-syllable-claimed':'no syllable tap · press used','syllable-after-release':'tap after release','count-differs':'differs from dictionary','release-before-last-syllable':'released before last tap','release-overlaps-next':'release trimmed at next word'};
    const ordered=[...held.filter(p=>isFlagged(p.phraseId)),...held.filter(p=>!isFlagged(p.phraseId))];
    for(const p of ordered){
      const flagged=isFlagged(p.phraseId);
      const row=document.createElement('details');row.className='lvx-event-phrase';row.open=flagged||!p.ready||p.issues.length>0;row.dataset.review=String(flagged||!p.ready||p.issues.length>0);
      const heading=document.createElement('summary'),ordinal=timing.draft.score.phrases.findIndex(x=>x.id===p.phraseId)+1;
      heading.textContent=`${flagged?'⚑ ':''}Phrase ${ordinal} · ${p.heldCount}/${p.words.length} words · ${tapping.eventApplied?.includes(p.phraseId)?'in preview':p.ready?'ready':'hold every word to use'}`;
      const actions=document.createElement('div');actions.className='lvx-tap-actions';
      const retime=document.createElement('button');retime.type='button';retime.textContent='↺ Retime this phrase';retime.disabled=timing.busy;retime.addEventListener('click',()=>void retimePhrase(p.phraseId));
      actions.append(retime);
      if(flagged){const unflag=document.createElement('button');unflag.type='button';unflag.textContent='Clear flag';unflag.addEventListener('click',async()=>{await clearRetimeFlag(p.phraseId);refreshTimingPanel();});actions.append(unflag);}
      const fields=document.createElement('div');fields.className='lvx-event-counts';
      for(const w of p.words){
        const label=document.createElement('label');label.dataset.review=String(w.issues.length>0);label.append(document.createTextNode(w.text));
        const hint=document.createElement('small');
        hint.textContent=w.held?`${w.count} syllable${w.count===1?'':'s'} · ${((w.releaseMs-w.pressMs)/1000).toFixed(2)}s held`:'';
        if(w.issues.length)hint.textContent+=(hint.textContent?' · ':'')+w.issues.map(i=>labels[i]||i).join(' · ');
        label.append(hint);fields.append(label);
      }
      row.append(heading,fields,actions);list.append(row);
    }
    if(report.unclaimed.length){const note=document.createElement('p');note.className='lvx-sync-hint';note.textContent=`${report.unclaimed.length} syllable taps are outside any held word and remain unused.`;list.append(note);}
    syncButton('events-review').textContent='Use held phrases';
    syncButton('events-review').disabled=timing.busy||!ready.length;
    syncButton('events-export').disabled=timing.busy;
  }
  function renderEventReview() {
    const take=tapping.take,section=syncPanel.querySelector('.lvx-event-review');
    section.hidden=!rawTake(take)||take.status==='armed'||!tapCount(take);
    if(section.hidden)return;
    if(wordTake(take)){renderWordReview(take,section);return;}
    syncButton('events-review').textContent='Use reviewed assignments';
    section.querySelector('.lvx-event-review > .lvx-sync-hint').textContent='Counts group your recorded entrances into words. Amber means uncertain or changed. Raw timestamps never move. A word starts at its first entrance; its end stays provisional until word-boundary cleanup. Long gaps are flagged because a held syllable can look like the next word. Unresolved phrases stay in the take.';
    const report=LvTapTiming.associateEvents(take,{counts:tapping.eventCounts||{}});tapping.eventReport=report;
    const pending=report.phrases.filter(p=>p.eventCount),ready=pending.filter(p=>p.ready&&!tapping.eventApplied?.includes(p.phraseId));
    section.querySelector('.lvx-event-summary').textContent=`${take.events.length} exact events · ${ready.length} phrases ready · ${report.unassigned.length+pending.filter(p=>!p.ready).reduce((sum,p)=>sum+p.eventCount,0)} events need grouping. No timestamps were squeezed.`;
    const list=section.querySelector('.lvx-event-phrases');list.replaceChildren();
    for(const p of pending){
      const row=document.createElement('details');row.className='lvx-event-phrase';row.open=!p.ready;
      row.dataset.review=String(!p.ready||p.gaps?.length>0||p.counts.some(c=>c.changed||c.uncertain));
      const heading=document.createElement('summary'),ordinal=timing.draft.score.phrases.findIndex(x=>x.id===p.phraseId)+1;
      heading.textContent=`${isFlagged(p.phraseId)?'⚑ ':''}Phrase ${ordinal} · ${p.eventCount} entrances · ${tapping.eventApplied?.includes(p.phraseId)?'in preview':p.ready?'grouping proposed':'review needed'}`;
      const reason=document.createElement('p');reason.className='lvx-sync-hint';reason.textContent=(p.issues.length?p.issues.join(' · ').replaceAll('-',' '):'Suggested counts match. Listen before saving.')+(p.gaps?.length?' — '+p.gaps.map(g=>`${(g.gapMs/1000).toFixed(2)}s gap ${g.atWordBoundary===false?'inside a word: it may have ended earlier':'before the next word: the entrance after it may still belong to the current word'}`).join('; '):'');
      const fields=document.createElement('div');fields.className='lvx-event-counts';
      for(const c of p.counts){
        const label=document.createElement('label');label.dataset.review=String(c.uncertain||c.changed);label.append(document.createTextNode(c.text));
        const input=document.createElement('input');input.type='number';input.min='1';input.max='64';input.step='1';input.dataset.eventWord=c.wordId;input.setAttribute('aria-label',`Entrances in ${c.text}`);
        input.value=tapping.eventCounts?.[c.wordId]??c.count??c.suggestedCount??1;input.disabled=timing.busy;
        input.addEventListener('change',()=>{const n=Number(input.value);if(!Number.isSafeInteger(n)||n<1||n>64){setSyncNotice('Use a whole count from 1 to 64.');return;}tapping.eventCounts||={};tapping.eventCounts[c.wordId]=n;tapping.eventApplied=(tapping.eventApplied||[]).filter(id=>id!==p.phraseId);renderEventReview();void useEventAssignments();});
        const hint=document.createElement('small');hint.textContent=c.uncertain?'unknown / review':c.changed?'changed grouping':c.source;
        const reference=take.units.find(u=>u.wordId===c.wordId),owned=p.marks.filter(m=>m.wordId===c.wordId);
        // Only the onset is observed; a word's release comes from boundary cleanup, not from the next tap.
        if(owned.length&&reference){const startDelta=owned[0].startMs-reference.referenceStartMs,endSource=owned.at(-1).endSource;
          if(Number.isFinite(startDelta)&&startDelta){label.dataset.review='true';hint.textContent+=` · onset ${startDelta>=0?'+':''}${startDelta}ms vs ${reference.referenceManual?'manual':'estimated'} reference`;}
          if(endSource?.startsWith('provisional'))hint.textContent+=' · end provisional';}
        if(p.gaps?.some(g=>g.previousWordId===c.wordId||g.nextWordId===c.wordId)){label.dataset.review='true';hint.textContent+=' · long gap: check owner';}
        label.append(input,hint);fields.append(label);
      }
      const times=document.createElement('p');times.className='lvx-sync-hint';const ids=new Set(p.marks.map(m=>m.eventId));
      times.textContent='Entrances (s): '+take.events.filter(e=>ids.has(e.id)||take.units.some(u=>u.phraseId===p.phraseId&&e.sourceMs>=u.minMs&&e.sourceMs<u.maxMs)).map(e=>(e.sourceMs/1000).toFixed(3)).join(' · ');
      row.append(heading,reason,fields,times);list.append(row);
    }
    if(report.unassigned.length){const note=document.createElement('p');note.className='lvx-sync-hint';note.textContent='Unassigned timestamps remain intact: '+report.unassigned.map(e=>(e.sourceMs/1000).toFixed(3)+'s').join(' · ');list.append(note);}
    syncButton('events-review').disabled=timing.busy||!ready.length;
    syncButton('events-export').disabled=timing.busy;
  }
  async function useEventAssignments() {
    const take=tapping.take;if(!rawTake(take)||take.status==='armed'||timing.busy||tapping.binding!==tapBinding())return;
    timing.busy=true;refreshTimingPanel();
    try{
      const report=wordTake(take)?LvTapTiming.associateWordHolds(take):LvTapTiming.associateEvents(take,{counts:tapping.eventCounts||{}}),phrases=report.phrases.filter(p=>p.ready&&p.marks.length&&!tapping.eventApplied?.includes(p.phraseId));
      if(!phrases.length)throw Error(wordTake(take)?'Hold every word of a phrase to use it. All taps are retained.':'Resolve the highlighted counts first. All raw events are retained.');
      await archiveEvents();
      setSyncNotice(`Preparing ${phrases.length} phrases for the preview…`);
      const marks=phrases.flatMap(p=>p.marks).map(m=>({...m,startMs:m.startMs-state.score.offsetMs,endMs:m.endMs-state.score.offsetMs})),operations=await continuousSyllableOperations({...take,cadence:'phrase-stream',marks,stoppedScoreMs:Number.MAX_SAFE_INTEGER},(done,total)=>setSyncNotice(`Spelling syllables · ${done}/${total} words…`));
      // Held performances may run outside estimated phrase bounds; widen those phrases first.
      if(wordTake(take)){const widen=[];for(const p of phrases){const own=marks.filter(m=>m.phraseId===p.phraseId),phrase=timing.draft.score.phrases.find(x=>x.id===p.phraseId);if(!own.length||!phrase)continue;
        const startMs=Math.min(phrase.startMs,own[0].startMs),endMs=Math.max(phrase.endMs,own.at(-1).endMs);if(startMs!==phrase.startMs||endMs!==phrase.endMs)widen.push({type:'setPhraseTiming',phraseId:p.phraseId,startMs,endMs});}
        operations.unshift(...widen);}
      setSyncNotice('Updating the preview…');
      if(tapping.take!==take||tapping.binding!==tapBinding())throw Error('The take changed during review; nothing was applied.');
      const result=await timingRequest('LV_TIMING_TUNE',{operations,allowProtected:true});timing.draft=result.preview;tapping.binding=tapBinding();
      tapping.eventApplied=[...(tapping.eventApplied||[]),...phrases.map(p=>p.phraseId)];timing.auditioned=false;state.scoreSignature='';
      await archiveEvents();
      setSyncNotice(`${phrases.length} reviewed phrases added to preview. Raw events and original word references are backed up locally. Export to keep a portable copy. Save timings whenever you like; the take stays here for more review. Unresolved phrases are unchanged.`);
    }catch(error){setSyncNotice(error.message,'error');}finally{timing.busy=false;refreshTimingPanel();}
  }
  syncButton('events-review').addEventListener('click',useEventAssignments);
  syncButton('events-export').addEventListener('click',()=>{
    if(!rawTake(tapping.take))return;const blob=new Blob([JSON.stringify(eventEnvelope(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`lyricvibe-${state.score.source.videoId}-${wordTake(tapping.take)?'word-holds':'performance-events'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  async function setTapSyllables() {
    if (timing.busy || !timing.draft || tapPending()) return;
    const word = tapWord(), parts = syncButton('tap-split').value.split('|'), spoken=syncButton('tap-spoken').value.trim();
    if (!word || !spoken || spoken.length>256 || parts.some(p => !p) || parts.join('') !== spoken) { setSyncNotice('Separate the spoken form with |. The parts must join exactly; the displayed lyric stays unchanged.'); return; }
    timing.busy = true; refreshTimingPanel();
    try {
      const span = word.endMs - word.startMs;
      const operation = { type:'setWordSyllables', wordId:word.id, spokenText:spoken===word.text?null:spoken, startTapping:true,
        syllables:parts.map((text,index) => ({id:`${word.id}-syllable-${index+1}`,text,startMs:word.startMs+Math.round(span*index/parts.length),endMs:word.startMs+Math.round(span*(index+1)/parts.length)})) };
      const result = await timingRequest('LV_TIMING_TUNE', { operation, allowProtected:true });
      timing.draft = result.preview; tapping.splitDirty = false; timing.auditioned = false; state.scoreSignature = '';
      setSyncNotice('Syllable spelling added to the preview. Their equal initial divisions are estimates; tap while listening to set their boundaries.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  async function suggestTapSyllables(){
    const word=tapWord(), binding=tapBinding();if(!word||timing.busy||tapPending())return;
    const beforeSpoken=syncButton('tap-spoken').value,beforeSplit=syncButton('tap-split').value;
    timing.busy=true;refreshTimingPanel();
    try{
      const response=await chrome.runtime.sendMessage({type:'LV_PRONUNCIATION_SUGGEST',text:word.text,...(beforeSpoken&&beforeSpoken!==word.text?{spokenText:beforeSpoken}:{})});
      if(tapBinding()!==binding||tapWord()?.id!==word.id||syncButton('tap-spoken').value!==beforeSpoken||syncButton('tap-split').value!==beforeSplit)return;
      if(!response?.ok)throw Error(response?.error?.message||'Pronunciation dictionary unavailable.');
      const suggestion=response.suggestion,hint=syncPanel.querySelector('.lvx-pronunciation-hint');
      if(!suggestion.parts?.length){hint.textContent=suggestion.status==='ambiguous'?`The dictionary lists ${suggestion.syllableCounts.join(' or ')} syllables. Enter the way it is sung.`:suggestion.status==='unavailable'?`The dictionary gives ${suggestion.syllableCounts.join(' or ')} syllables, but has no usable spelling split. Enter the split manually.`:'No dictionary suggestion for this spoken form. Enter a split manually.';return;}
      syncButton('tap-spoken').value=suggestion.spokenText;syncButton('tap-split').value=suggestion.parts.join('|');tapping.splitDirty=true;
      hint.textContent=`${suggestion.parts.length} syllables · dictionary count, suggested spelling cuts. Edit if sung differently, then Set syllables.`;
      setSyncNotice('Suggestion only. Your display text, saved score and timings are unchanged.');
    }catch(error){setSyncNotice(error.message,'error');}
    finally{timing.busy=false;refreshTimingPanel();}
  }
  for (const name of ['tap-mode','tap-cadence','tap-scope','tap-syllable-flow']) syncButton(name).addEventListener('change',()=>{if(name==='tap-mode'&&syncButton(name).value==='syllable')syncButton('loop').checked=!continuousPass();refreshTapPanel();});
  for (const button of syncPanel.querySelectorAll('[data-phase]')) button.addEventListener('click',()=>{
    if (timing.busy || tapPending() || tapping.splitDirty) return;
    syncButton('tap-mode').value=button.dataset.phase;
    if(button.dataset.phase==='syllable')syncButton('loop').checked=false;
    if (button.dataset.phase!=='syllable') { timing.phraseIndex=0; tapping.wordId=timing.draft?.score.phrases[0]?.words[0]?.id; }
    refreshTimingPanel();
  });
  syncButton('tap-split').addEventListener('input', () => {
    const word = tapWord(), original = word?.syllables?.length ? word.syllables.map(s => s.text).join('|') : word?.text || '';
    tapping.splitDirty = syncButton('tap-split').value !== original; refreshTimingPanel();
  });
  syncButton('tap-snap').addEventListener('change', refreshTapPanel);
  syncButton('tap-arm').addEventListener('click', armTapTake);
  syncButton('tap-mark').addEventListener('click', event => { if (syncButton('tap-mode').value === 'syllable' || syncButton('tap-cadence').value !== 'hold') markTapTime(event); });
  syncButton('tap-mark').addEventListener('pointerdown', event => {
    if (syncButton('tap-mode').value === 'syllable' || syncButton('tap-cadence').value !== 'hold' || tapping.take?.status !== 'armed' || tapping.heldInput || tapping.take.pendingStartMs !== null || event.button !== 0) return;
    event.preventDefault(); syncButton('tap-mark').setPointerCapture(event.pointerId); markTapTime();
    if (tapping.take?.status === 'armed' && tapping.take.pendingStartMs !== null) tapping.heldInput = 'pointer';
  });
  syncButton('tap-mark').addEventListener('pointerup', () => { if (tapping.heldInput === 'pointer') markTapTime({release:true}); });
  syncButton('tap-mark').addEventListener('pointercancel', () => { if (tapping.heldInput === 'pointer') stopTapTake('Pointer canceled. Unfinished word unchanged; completed words retained.'); });
  syncButton('tap-release').addEventListener('click', () => markTapTime({release:true}));
  syncButton('tap-stop').addEventListener('click', () => { stopTapTake(); getMedia()?.pause(); });
  syncButton('retime-flag').addEventListener('click', () => void flagPhraseForRetime());
  // The change list updates as you type; Apply is the only step.
  let transcriptTimer=null;
  syncButton('transcript-text').addEventListener('input',()=>{transcript.dirty=true;refreshTranscriptEditor();clearTimeout(transcriptTimer);transcriptTimer=setTimeout(()=>void transcriptReview(),300);});
  syncButton('transcript-apply').addEventListener('click',()=>void applyTranscript());
  syncButton('transcript-open').addEventListener('click',()=>{
    const dialog=syncPanel.querySelector('.lvx-transcript-editor'),area=syncButton('transcript-text');
    transcript.shownFor=transcript.dirty?transcript.shownFor:null;refreshTranscriptEditor();dialog.showModal();
    if(!transcript.dirty){area.select();syncPanel.querySelector('.lvx-transcript-changes').replaceChildren();}
  });
  syncButton('transcript-close').addEventListener('click',()=>syncPanel.querySelector('.lvx-transcript-editor').close());
  syncButton('tempo-tap').addEventListener('click', () => void tapTempo());
  syncButton('tap-undo').addEventListener('click', () => { if (tapping.take) { const live=streamTake(tapping.take)&&tapping.take.status==='armed';tapping.take = eventTake(tapping.take)?LvTapTiming.undoEvent(tapping.take):wordTake(tapping.take)?LvTapTiming.undoWordHold(tapping.take):live?LvTapTiming.undo(tapping.take):LvTapTiming.stop(LvTapTiming.undo(tapping.take)); tapping.followSeek=false;tapping.seekPhraseId=null;tapping.correctionUndo = []; if(!rawTake(tapping.take))followTapUnit();state.scoreSignature=''; } refreshTimingPanel(); });
  syncButton('tap-use').addEventListener('click', useTapTake);
  syncButton('syllable-retake').addEventListener('click',()=>{getMedia()?.pause();state.auditionLoop=null;discardTapTake();void armTapTake();});
  syncButton('syllable-hear').addEventListener('click',hearSyllableTake);
  syncButton('syllable-next').addEventListener('click',keepSyllableAndNext);
  syncButton('phrase-suggest').addEventListener('click',async()=>{if(timing.busy||tapping.take)return;timing.busy=true;refreshTimingPanel();try{await preparePhraseSyllables();setSyncNotice('Dictionary suggestions prepared in preview. Inspect the | cuts, then Start phrase take. Unknown words remain unsplit.');}catch(error){setSyncNotice(error.message,'error');}finally{timing.busy=false;refreshTimingPanel();}});
  syncButton('tap-discard').addEventListener('click', restartTranscript);
  syncButton('tap-segment').addEventListener('click', setTapSyllables);
  syncButton('tap-suggest').addEventListener('click',suggestTapSyllables);
  syncButton('tap-spoken').addEventListener('input',()=>{tapping.splitDirty=true;refreshTapPanel();});
  function effectSourceReady() {
    const media = getMedia();
    return media && !media.paused && !media.seeking && !isAdvertisement() && youtubeMediaState()?.clockUsable !== false && media.playbackRate === performanceTake.rate && performanceTake.binding === tapBinding() && LvScore.mediaKey({url:location.href}) === LvScore.mediaKey(state.score.source);
  }
  function activeEffectTarget() {
    if (!timing.draft) return null;
    const now = Math.round(getMediaTimeMs() - timing.draft.score.offsetMs);
    const words = timing.draft.score.phrases.filter(p => p.laneId === performanceTake.laneId).flatMap(p => p.words).filter(w => now >= w.startMs && now < w.endMs);
    if (words.length !== 1) return null;
    const word = words[0];
    if (syncButton('effect-scope').value === 'syllable') {
      const parts = (word.syllables || []).filter(s => now >= s.startMs && now < s.endMs);
      return parts.length === 1 ? {id:parts[0].id,text:parts[0].text,type:'setSyllableEffect',syllableId:parts[0].id} : null;
    }
    return {id:word.id,text:word.text,type:'setWordEffect',wordId:word.id};
  }
  function refreshEffectPanel() {
    const active = performanceTake.armed;
    syncButton('effect-start').disabled = timing.busy || !timing.draft || timing.dirty || tapping.splitDirty || timingTapPending() || active || performanceTake.marks.length > 0;
    syncButton('effect-stop').disabled = !active;
    syncButton('effect-scope').disabled = active || performanceTake.marks.length > 0;
    for (const button of syncPanel.querySelectorAll('[data-effect]')) button.disabled = !active;
    syncButton('effect-use').disabled = timing.busy || active || !performanceTake.marks.length;
    syncButton('effect-undo').disabled = timing.busy || !performanceTake.marks.length;
    syncButton('effect-discard').disabled = timing.busy || !effectPending();
    syncPanel.querySelector('.lvx-effect-status').textContent = `${performanceTake.marks.length} gestures buffered${active ? ' · keys 1 / 2 / 3 / 0 are live' : ' · nothing saved'}`;
  }
  async function startEffects() {
    if (timing.busy || !timing.draft || timing.dirty || tapping.splitDirty || tapPending()) return;
    const media = getMedia(), phrase = timingPhrase();
    if (!media || isAdvertisement() || youtubeMediaState()?.clockUsable === false || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) return;
    timing.busy = true; refreshTimingPanel();
    const binding = tapBinding();
    try {
      state.auditionLoop = null; syncButton('loop').checked = false;
      media.currentTime = Math.max(0,phrase.startMs + state.score.offsetMs - 600) / 1000;
      await media.play();
      if (binding !== tapBinding() || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) throw Error('Preview changed before the effect pass started.');
      performanceTake.armed = true; performanceTake.binding = binding; performanceTake.laneId = phrase.laneId; performanceTake.rate = media.playbackRate;
      timing.view = 'proposed'; timing.auditioned = false; state.scoreSignature = '';
      setSyncNotice('Effect keys are live for this vocal track: 1 Pulse, 2 Tilt, 3 Shake, 0 Clear. Pause or Stop to add them to the preview.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); syncButton('effect-stop').focus(); }
  }
  function markEffect(type, event = {}) {
    if (!performanceTake.armed || event.repeat || !['pulse','tilt','shake','clear'].includes(type)) return;
    if (!effectSourceReady()) { stopEffects('Effects stopped because playback or its source changed. Gestures retained.'); return; }
    const target = activeEffectTarget();
    if (!target) { setSyncNotice('No unique active lyric in this vocal track. Nothing added during this gap or overlap.'); return; }
    if (performanceTake.marks.length >= 512) { stopEffects('Gesture buffer is full. Use or discard this pass before continuing.'); return; }
    const operation = {type:target.type,...(target.wordId ? {wordId:target.wordId} : {syllableId:target.syllableId}),effect:type === 'clear' ? null : {type,strength:.6}};
    const unique = new Set([...performanceTake.marks.map(m => m.targetId),target.id]);
    if (unique.size > 128) { stopEffects('128 lyric targets recorded. Use this pass before continuing.'); return; }
    performanceTake.marks.push({targetId:target.id,atMs:Math.round(getMediaTimeMs()-state.score.offsetMs),operation});
    timing.auditioned = false; state.scoreSignature = ''; refreshEffectPanel();
    setSyncNotice(`${type === 'clear' ? 'Clear' : type} → “${target.text}” · buffered, not saved`);
  }
  async function useEffects() {
    if (timing.busy || performanceTake.armed || !performanceTake.marks.length) return;
    if (performanceTake.binding !== tapBinding()) { setSyncNotice('This effect pass belongs to an older preview. Discard it before recording again.'); return; }
    const operations = [...new Map(performanceTake.marks.map(m => [m.targetId,m.operation])).values()];
    timing.busy = true; refreshTimingPanel();
    try {
      const result = await timingRequest('LV_TIMING_TUNE',{operations});
      timing.draft = result.preview; discardEffects(); timing.auditioned = false;
      setSyncNotice('Effects added to the preview. Save timings keeps them.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  syncButton('effect-start').addEventListener('click', startEffects);
  syncButton('effect-stop').addEventListener('click', () => { stopEffects(); getMedia()?.pause(); });
  syncButton('effect-use').addEventListener('click', useEffects);
  syncButton('effect-undo').addEventListener('click', () => { performanceTake.marks.pop(); state.scoreSignature = ''; refreshTimingPanel(); });
  syncButton('effect-discard').addEventListener('click', () => { discardEffects(); refreshTimingPanel(); });
  for (const button of syncPanel.querySelectorAll('[data-effect]')) button.addEventListener('click', () => markEffect(button.dataset.effect));
  const timingEnvelope = type => ({ type, mediaKey: LvScore.mediaKey(state.score.source), expectedRevision: state.score.revision,
    lyricsHash: state.score.lyrics.contentHash, token: timing.draft?.token, previewRevision: timing.draft?.previewRevision });
  async function timingRequest(type, extra = {}) {
    if (!state.score || LvScore.mediaKey({ url: location.href }) !== LvScore.mediaKey(state.score.source)) throw Error('The video changed. Reopen Sync for the current video.');
    const result = await chrome.runtime.sendMessage({ ...timingEnvelope(type), ...extra });
    if (!result?.ok) throw Error(result?.error?.message || 'Timing request failed.');
    return result;
  }
  function timingPhrase(score = timing.draft?.score) { return score?.phrases[timing.phraseIndex]; }
  function refreshTimingPanel() {
    const draft = timing.draft, phrase = timingPhrase();
    syncPanel.setAttribute('aria-busy', String(timing.busy));
    syncButton('close').disabled = timing.busy;
    root.classList.toggle('lvx-sync-open', !syncPanel.hidden);
    for (const control of [offsetInput, syncEarlier, syncLater]) control.disabled = Boolean(draft);
    syncButton('saved').setAttribute('aria-pressed', String(timing.view === 'saved'));
    syncButton('proposed').setAttribute('aria-pressed', String(timing.view === 'proposed'));
    syncButton('previous').disabled = timing.busy || !draft || timing.phraseIndex === 0;
    syncButton('next').disabled = timing.busy || !draft || timing.phraseIndex >= draft.score.phrases.length - 1;
    for (const name of ['audition', 'tune', 'reset']) syncButton(name).disabled = timing.busy || !draft;
    syncButton('apply').disabled = timing.busy || !draft || timing.dirty || tapping.splitDirty || tapPending() || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source);
    const saveReason = timing.busy ? 'Updating preview…' : !draft ? 'Open a preview to refine this recording.' : timing.dirty || tapping.splitDirty ? 'Use your typed changes first.' : tapPending() ? (tapping.take?.status==='armed' ? 'Stop the take, then Use take in preview. Partial passes are welcome.' : 'Use take in preview first. Unmarked lyrics keep their existing timing.') : !timing.auditioned ? 'Ready to save. Unsaved changes are kept on disk until you save or discard them.' : 'Ready to save this iteration. Keep refining whenever you like.';
    syncButton('apply').setAttribute('aria-description', saveReason);
    syncPanel.querySelector('.lvx-sync-save-status').textContent=saveReason;
    syncButton('light-editor').disabled=timing.busy||!draft||timing.dirty||tapping.splitDirty||effectPending();
    syncButton('export').disabled = timing.busy || !draft || timing.dirty || tapping.splitDirty || tapPending();
    syncButton('undo').disabled = timing.busy || Boolean(draft);
    syncPanel.querySelector('.lvx-sync-position').textContent = draft ? `Phrase ${timing.phraseIndex + 1} / ${draft.score.phrases.length}` : 'No preview';
    syncPanel.querySelector('.lvx-sync-phrase').textContent = phrase?.words.map(w => w.text).join(' ') || 'Your saved score stays unchanged while you review.';
    const shown = timing.view === 'saved' ? timingPhrase(state.score) : phrase;
    const protectedPhrase = draft?.preservedPhraseIds.includes(phrase?.id);
    syncPanel.querySelector('.lvx-sync-range').textContent = shown ? `${(shown.startMs / 1000).toFixed(3)}–${(shown.endMs / 1000).toFixed(3)}s · ${(()=>{const a=phrase?phraseAuthoring(phrase):null;return a?`${authoringProgress(a)==='todo'?'to do for this mode · ':authoringProgress(a)==='done'?'done for this mode · ':''}${AUTHORING_LABELS[a.level]}${a.mixed?' (some words further)':''}`:'';})()}` : '';
    syncPanel.querySelector('.lvx-sync-protected').hidden = !protectedPhrase && !(syncButton('tap-scope').value === 'lane' && draft?.protectedIds.length);
    syncText.disabled = timing.busy || !draft;
    if (!timing.dirty) syncText.value = phrase?.words.map(w => `${w.text}\t${w.startMs}\t${w.endMs}`).join('\n') || '';
    refreshTapPanel();
  }
  async function openTimingReview() {
    if (timing.busy) return;
    if (!syncPanel.hidden && timing.draft) { syncPanel.focus(); return; }
    timing.priorLoop = state.auditionLoop; syncPanel.hidden = false; timing.busy = true; refreshTimingPanel();
    setSyncNotice('Opening your saved lyrics and timings…');
    try {
      const current=await timingRequest('LV_TIMING_CURRENT');
      const result = current.preview ? current : await timingRequest('LV_TIMING_PREPARE', { fromSaved: true });
      timing.draft = result.preview; timing.phraseIndex = 0; timing.view = 'proposed'; timing.dirty = false; timing.auditioned = false;
      setSyncNotice(current.preview ? 'Resumed your unsaved preview. Record or refine timings, then audition and Save timings.' : 'Your saved lyrics and timings are ready. Record or refine a take, then audition and Save timings.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  function discardTimingLocal() {
    discardTapTake();
    discardEffects();
    timing.draft = null; timing.dirty = false; timing.auditioned = false; state.auditionLoop = timing.priorLoop; timing.priorLoop = null; state.scoreSignature = '';
    refreshTimingPanel();
  }
  async function closeTimingReview() {
    if (timing.busy) return;
    if (timing.draft) await timingRequest('LV_TIMING_CANCEL').catch(() => {});
    if (tapping.audio) { tapping.audio.close().catch(() => {}); tapping.audio = null; }
    discardTimingLocal(); syncPanel.hidden = true; refreshTimingPanel();
  }
  function navigateTiming(delta) {
    if (tapPending() || tapping.splitDirty) { setSyncNotice('Use the take or set the syllable spelling before changing phrases.'); return false; }
    if (timing.dirty) { setSyncNotice('Use these times or reset the text before changing phrases.'); return false; }
    if (!timing.draft || timing.busy || !Number.isInteger(delta)) return false;
    timing.phraseIndex = clamp(timing.phraseIndex + delta, 0, timing.draft.score.phrases.length - 1);
    const media=getMedia(),phrase=timingPhrase();
    if(media&&phrase&&!tapping.take?.status?.startsWith('arm')){
      tapping.wordId=phrase.words.find(w=>!w.excluded)?.id||null;tapping.armSeekMs=Math.max(0,phraseLeadInMs(phrase)+state.score.offsetMs);media.currentTime=tapping.armSeekMs/1000;
    }
    else if(!tapping.take)tapping.followSeek=false;
    syncButton('protected').checked = false; refreshTimingPanel(); return true;
  }
  async function tuneTimingText() {
    if (tapPending() || tapping.splitDirty) { setSyncNotice('Use the take or set the syllable spelling before editing word timings.'); return; }
    if (timing.busy || !timing.draft) return;
    const phrase = timingPhrase(), lines = syncText.value.trim().split(/\r?\n/);
    try {
      if (lines.length !== phrase.words.length) throw Error('Keep one line for every word in this phrase.');
      const changes = [];
      lines.forEach((line, index) => {
        const match = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s*$/), word = phrase.words[index];
        if (!match || match[1] !== word.text) throw Error(`Line ${index + 1}: keep the word, then enter start and end milliseconds.`);
        const startMs = Number(match[2]), endMs = Number(match[3]);
        if (startMs !== word.startMs || endMs !== word.endMs) changes.push({ wordId: word.id, startMs, endMs });
      });
      timing.busy = true; refreshTimingPanel();
      const result = await timingRequest('LV_TIMING_TUNE', { changes, allowProtected: true });
      timing.draft = result.preview; timing.dirty = false; timing.auditioned = false; state.scoreSignature = '';
      setSyncNotice('Preview updated. Nothing saved. Audition the proposed timing again before applying.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  async function auditionTiming() {
    if (tapping.take?.status === 'armed' || performanceTake.armed) { setSyncNotice('Stop the pass before auditioning. Completed gestures will stay available.'); return; }
    if (!timing.draft || timing.busy) return;
    if (timing.dirty) { setSyncNotice('Use these times or reset the text before auditioning.'); return; }
    const media = getMedia(), phrase = timingPhrase(timing.view === 'saved' ? state.score : timing.draft.score);
    if (!media || isAdvertisement() || youtubeMediaState()?.clockUsable === false || LvScore.mediaKey({url:location.href}) !== LvScore.mediaKey(state.score.source)) { setSyncNotice('Wait for this video’s main audio before auditioning.'); return; }
    const startMs = Math.max(0, phrase.startMs + state.score.offsetMs - 600), endMs = phrase.endMs + state.score.offsetMs + 400;
    media.preservesPitch = true; media.playbackRate = 1;
    state.auditionLoop = syncButton('loop').checked ? { startMs, endMs } : null;
    media.currentTime = startMs / 1000;
    try { await media.play(); if (timing.view === 'proposed') timing.auditioned = true; setSyncNotice(`${timing.view === 'proposed' ? 'Proposed · unsaved' : 'Saved'} timing is playing. Pause whenever you need.`); }
    catch (error) { setSyncNotice(`Playback could not start: ${error.message}`); }
    refreshTimingPanel();
  }
  async function applyTimingReview() {
    // Audition is recommended, not required: the preview lives only in session storage, and Save is undoable.
    if (!timing.draft || timing.busy || timing.dirty || tapping.splitDirty || tapPending()) return;
    timing.busy = true; refreshTimingPanel();
    try {
      const result = await timingRequest('LV_TIMING_APPLY');
      state.score = result.score; state.syncOffsetMs = result.score.offsetMs;
      discardTimingLocal(); transcript.dirty = false; transcript.shownFor = null;
      // Keep editing: a fresh preview of what was just saved, so any mode can start straight away.
      const reopened = await timingRequest('LV_TIMING_PREPARE', { fromSaved: true });
      timing.draft = reopened.preview; timing.view = 'proposed';
      setSyncNotice('Timings saved. Keep going in any mode; Undo saved change restores the previous score.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  }
  syncButton('close').addEventListener('click', closeTimingReview);
  syncButton('previous').addEventListener('click', () => navigateTiming(-1));
  syncButton('next').addEventListener('click', () => navigateTiming(1));
  for (const view of ['saved', 'proposed']) syncButton(view).addEventListener('click', () => { timing.view = view; state.scoreSignature = ''; refreshTimingPanel(); });
  syncButton('audition').addEventListener('click', auditionTiming);
  syncButton('pause').addEventListener('click', () => getMedia()?.pause());
  syncButton('loop').addEventListener('change', () => { if (!syncButton('loop').checked) state.auditionLoop = null; });
  syncText.addEventListener('input', () => { timing.dirty = true; refreshTimingPanel(); });
  syncButton('tune').addEventListener('click', tuneTimingText);
  syncButton('reset').addEventListener('click', () => { timing.dirty = false; refreshTimingPanel(); });
  syncButton('apply').addEventListener('click', applyTimingReview);
  syncButton('discard-all').addEventListener('click', async () => {
    if (timing.busy || !timing.draft) return;
    if (!window.confirm('Discard all proposed changes? The preview, any take, effects and lyric edits go back to your saved score. Raw tap backups are kept.')) return;
    getMedia()?.pause(); timing.busy = true; refreshTimingPanel();
    try {
      await timingRequest('LV_TIMING_CANCEL').catch(() => {});
      discardTimingLocal(); transcript.dirty = false; transcript.shownFor = null; syncPanel.hidden = false;
      const result = await timingRequest('LV_TIMING_PREPARE', { fromSaved: true });
      timing.draft = result.preview; timing.view = 'proposed';
      setSyncNotice('Proposed changes discarded. You are editing your saved score again.');
    } catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  });
  syncButton('light-editor').addEventListener('click', async()=>{
    if(timing.busy||!timing.draft||timing.dirty||tapping.splitDirty||effectPending())return;
    if(tapping.take){
      getMedia()?.pause();stopTapTake();
      if(tapCount(tapping.take))await useTapTake();else discardTapTake();
      if(timingTapPending())return;
    }
    try{await timingRequest('LV_LIGHT_EDITOR_OPEN');setSyncNotice('Lightweight editor opened. It shares this preview and controls this YouTube video.');}
    catch(error){setSyncNotice(error.message,'error');}
    refreshTimingPanel();
  });
  syncButton('export').addEventListener('click', () => {
    if (!timing.draft || timing.busy || timing.dirty || tapping.splitDirty || tapPending()) return;
    const score = LvScore.validateScore(timing.draft.score), url = URL.createObjectURL(new Blob([JSON.stringify(score)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `lyricvibe-${score.source.videoId}-preview.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000); setSyncNotice('Preview JSON exported. This does not save it as this video’s playback score.');
  });
  syncButton('undo').addEventListener('click', async () => {
    if (timing.busy || timing.draft) return;
    timing.busy = true; refreshTimingPanel();
    try { const result = await timingRequest('LV_SCORE_UNDO'); state.score = result.score; state.syncOffsetMs = result.score.offsetMs; state.scoreSignature = ''; setSyncNotice('Previous saved score restored.'); }
    catch (error) { setSyncNotice(error.message,'error'); }
    finally { timing.busy = false; refreshTimingPanel(); }
  });
  syncPanel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closeTimingReview(); }
  });
  root.append(stage, preview, progress, hud, shortcutsPanel, syncPanel);
  function mountRoot() {
    const surface = document.fullscreenElement;
    if (surface && !['VIDEO', 'AUDIO'].includes(surface.tagName)) surface.appendChild(root);
    else document.documentElement.appendChild(root);
  }
  mountRoot();
  document.addEventListener('fullscreenchange', () => { if (root.isConnected) mountRoot(); });

  window.__lyricVibeOverlay = {
    interfaceVersion: 2,
    // Health check: returns false once this script's extension context dies
    // (extension reloaded/updated), so the next injection knows to replace us.
    ping() {
      try { return Boolean(chrome?.runtime?.id && chrome.runtime.getManifest()); }
      catch (_) { return false; }
    },
    show,
    hide: teardown,
    hints: getPageHints,
    sync: Object.freeze({ getState: () => JSON.parse(JSON.stringify(timing)), open: openTimingReview,
      selectPhrase: index => navigateTiming(index - timing.phraseIndex), setView: view => { if (['saved','proposed'].includes(view)) syncButton(view).click(); },
      tuneText: text => { syncText.value = text; timing.dirty = true; return tuneTimingText(); }, audition: auditionTiming, cancel: closeTimingReview,
      tap: Object.freeze({ getState: () => JSON.parse(JSON.stringify({take:tapping.take,binding:tapping.binding,wordId:tapWord()?.id,phraseId:timingPhrase()?.id,splitDirty:tapping.splitDirty,spellings:[...(tapping.spellings||new Map())],audioState:tapping.audio?.state||null})),
        start: armTapTake, mark: markTapTime, release: () => markTapTime({release:true}), stop: stopTapTake, use: useTapTake,
        reposition: repositionTap, moveCue:direction=>recoverStream(direction), reassignLast:direction=>recoverStream(direction,true), assignment:()=>wordTake(tapping.take)?LvTapTiming.associateWordHolds(tapping.take):eventTake(tapping.take)?LvTapTiming.associateEvents(tapping.take,{counts:tapping.eventCounts||{}}):null, restoreBuffered:restoreBufferedTake, discard: restartTranscript }),
      effects: Object.freeze({getState:() => JSON.parse(JSON.stringify(performanceTake)),start:startEffects,mark:markEffect,stop:stopEffects,use:useEffects,discard:() => {discardEffects();refreshTimingPanel();}}) })
  };

  setHud('Ready. Play music, then click LyricVibe.', false, true);

  /* Load saved preferences (theme, font scale, lite mode) */
  try {
    chrome.storage.local.get(['lvxTheme', 'lvxFontScale', 'lvxLiteMode'], (result) => {
      if (result && result.lvxTheme && THEMES.includes(result.lvxTheme)) {
        applyTheme(result.lvxTheme);
      }
      if (result && Number.isFinite(result.lvxFontScale)) {
        state.fontScale = clamp(result.lvxFontScale, 0.6, 1.6);
      }
      if (result && result.lvxLiteMode) {
        state.liteMode = true;
        root.classList.add('lvx-lite');
      }
    });
  } catch (_) {}

  /* Detect if we're on Spotify */
  state.isSpotify = location.hostname.includes('spotify.com');

  /* Universal track-change observer: auto-refresh when song changes
     on ANY supported platform (YouTube Music, SoundCloud, Spotify, etc.) */
  setupTrackChangeObserver();

  /* ══════════════════════════════════════
     MESSAGE LISTENER
     ══════════════════════════════════════ */
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return; // extension context invalidated
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if(message.type==='LV_TIMING_PREVIEW_UPDATED'){
      if(message.mediaKey!==LvScore.mediaKey({url:location.href})||timing.busy)return;
      if(!timing.draft){
        if(tapPending()||timing.dirty||tapping.splitDirty)return;
        if(message.preview?.baseRevision!==state.score?.revision||message.preview?.baseHash!==state.score?.lyrics.contentHash)return;
        try{LvScore.validateScore(message.preview.score);timing.draft=message.preview;timing.phraseIndex=Math.min(timing.phraseIndex,timing.draft.score.phrases.length-1);timing.auditioned=false;state.scoreSignature='';refreshTimingPanel();}catch(error){setSyncNotice(error.message,'error');}return;
      }
      if(timing.draft.token!==message.preview?.token)return;
      if(message.preview.previewRevision<=timing.draft.previewRevision)return;
      if(tapPending()||timing.dirty||tapping.splitDirty){setSyncNotice('The preview changed in the lightweight editor. Your input is retained; finish or discard it before reopening Sync.');return;}
      try{LvScore.validateScore(message.preview.score);timing.draft=message.preview;timing.auditioned=false;state.scoreSignature='';refreshTimingPanel();setSyncNotice('Preview updated in the lightweight editor. Saved timings remain unchanged.');}catch(error){setSyncNotice(error.message,'error');}
      return;
    }
    if(message.type==='LV_TIMING_PREVIEW_CLOSED'){
      if(message.mediaKey===LvScore.mediaKey({url:location.href})&&!timing.busy&&!tapPending()&&!timing.dirty){discardTimingLocal();setSyncNotice('Preview closed. Saved timings remain available.');}return;
    }

    if (message.type === 'LV_ANALYSIS_CLOCK') {
      const media = getMedia();
      const youtube = youtubeMediaState();
      const blocked = isAdvertisement() || youtube?.clockUsable === false;
      sendResponse({ mediaKey: LvScore.mediaKey({ url: location.href }), currentTimeMs: Math.round((media?.currentTime || 0) * 1000), paused: blocked || (media?.paused ?? true), playbackRate: media?.playbackRate || 1, seeking: blocked || media?.seeking || false, isAd: isAdvertisement(), reason: youtube?.reason || null });
      return;
    }
    if (message.type === 'LV_SCORE_UPDATED') {
      if (message.mediaKey !== LvScore.mediaKey({ url: location.href })) return;
      try {
        LvScore.validateScore(message.score);
        // A different video in the same tab: park the old preview (it stays stored for its video) and follow the new one.
        const switched = Boolean(timing.draft && LvScore.mediaKey(timing.draft.score.source) !== message.mediaKey);
        if (switched) { discardTimingLocal(); transcript.dirty = false; transcript.shownFor = null; }
        if (timing.draft && (message.score.revision !== timing.draft.baseRevision || message.score.lyrics.contentHash !== timing.draft.baseHash)) {
          const retainedTake = tapping.take, retainedBinding = tapping.binding, retainedEffects = {...performanceTake,marks:[...performanceTake.marks]};
          discardTimingLocal();
          if (retainedTake) { tapping.take = eventTake(retainedTake)?LvTapTiming.stopEvents(retainedTake):wordTake(retainedTake)?LvTapTiming.stopWordHolds(retainedTake):LvTapTiming.stop(retainedTake); tapping.binding = retainedBinding; }
          if (retainedEffects.marks.length || retainedEffects.armed) Object.assign(performanceTake,retainedEffects,{armed:false});
          setSyncNotice('The saved score changed. Reopen Sync to refresh. Any retained take belongs to the previous revision and cannot be applied.');
        }
        state.score = message.score;
        state.scoreSignature = '';
        state.active = true;
        state.errorShown = false;
        state.trackTitle = [message.score.source.artist, message.score.source.title].filter(Boolean).join(' — ');
        state.trackDurationMs = message.score.source.durationMs;
        state.trackKey = message.mediaKey;
        state.syncOffsetMs = message.score.offsetMs;
        if (!syncPanel.hidden) refreshTimingPanel();
        if (switched && !syncPanel.hidden) void openTimingReview();
        stage.style.setProperty('--lvx-score-scale', state.fontScale);
        preview.textContent = '';
        show();
        root.classList.add('lvx-active');
        setHud(`${state.trackTitle} · video-specific score · edit timing to review estimates`);
        startLoop();
        sendResponse({ ok: true });
      } catch (error) { sendResponse({ ok: false, error: { code: error.code, message: error.message } }); }
      return;
    }
    if (message.type === 'LV_SCORE_SEEK' || message.type === 'LV_SCORE_TRANSPORT') {
      const media = getMedia();
      if (!media || isAdvertisement() || youtubeMediaState()?.clockUsable === false || message.mediaKey !== LvScore.mediaKey({ url: location.href })) {
        sendResponse({ ok: false, error: { code: 'SOURCE_CHANGED', message: 'Source video changed or media is unavailable.' } });
        return;
      }
      if (message.type === 'LV_SCORE_SEEK') media.currentTime = Math.max(0, Math.min(media.duration || Infinity, Number(message.mediaMs) / 1000));
      else if (message.action === 'pause') media.pause();
      else if (message.action === 'play') {
        media.play().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: { code: 'PLAY_DENIED', message: error.message } }));
        return true;
      } else if (message.action === 'setRate') {
        if(![.25,.5,.75,1].includes(message.rate)){sendResponse({ok:false,error:{code:'RATE_INVALID',message:'Choose quarter, half, slower or normal speed.'}});return;}
        media.preservesPitch=true;media.playbackRate=message.rate;
      } else if (message.action === 'clearLoop') state.auditionLoop = null;
      else if (message.action === 'setLoop') {
        const loop = message.loop;
        if (!loop || !Number.isFinite(loop.startMs) || !Number.isFinite(loop.endMs) || loop.startMs < 0 || loop.endMs <= loop.startMs) {
          sendResponse({ ok: false, error: { code: 'LOOP_INVALID', message: 'Choose a positive loop range.' } });
          return;
        }
        state.auditionLoop = loop;
        media.currentTime = loop.startMs / 1000;
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'LV_GET_HINTS') {
      sendResponse(getPageHints());
      return true;
    }

    if (message.type === 'LV_STATUS') {
      cancelLoop();
      clearRevealTimers();
      stage.textContent = '';
      preview.textContent = '';
      progressFill.style.width = '0%';
      state.errorShown = true; // Ensure observer stays active while status is shown
      setHud(message.text || 'Working...');
    }

    if (message.type === 'LV_STATUS_WARNING') {
      cancelLoop();
      clearRevealTimers();
      stage.textContent = '';
      preview.textContent = '';
      progressFill.style.width = '0%';
      state.errorShown = true; // Ensure observer stays active while status is shown
      setHud(message.text || 'Service busy...', false, true, true);
    }

    if (message.type === 'LV_ERROR') {
      // Soft teardown: stop playback loop but KEEP overlay open and
      // KEEP the observer active so it can auto-recover on the next track.
      clearRevealTimers();
      cancelLoop();
      stopSpotifyPolling();
      state.currentIndex = -1;
      state.currentMoment = null;
      state.errorShown = true; // observer stays active to catch next song

      show();
      const errorMsg = message.text || 'Lyrics not available';
      stage.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'lvx-not-available';
      errorDiv.textContent = errorMsg;
      stage.appendChild(errorDiv);
      progressFill.style.width = '0%';
      preview.textContent = '';
      root.classList.add('lvx-active');
      setHud(`${errorMsg}  ·  Will retry on next track`, true, true);
    }

    if (message.type === 'LV_API_ERROR') {
      // API is down/degraded — show clear message with retry button
      clearRevealTimers();
      cancelLoop();
      stopSpotifyPolling();
      state.currentIndex = -1;
      state.currentMoment = null;
      state.errorShown = true;

      show();
      const errorMsg = message.text || 'Lyrics service is temporarily unavailable';
      stage.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'lvx-not-available lvx-api-error';
      errorDiv.innerHTML = '';

      const msgSpan = document.createElement('div');
      msgSpan.className = 'lvx-api-error-msg';
      msgSpan.textContent = errorMsg;
      errorDiv.appendChild(msgSpan);

      if (message.canRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'lvx-retry-btn';
        retryBtn.textContent = '↻ TRY AGAIN';
        retryBtn.addEventListener('click', () => {
          try { chrome.runtime?.sendMessage({ type: 'LV_RETRY' }).catch(() => {}); } catch (_) {}
          stage.textContent = '';
          setHud('Retrying...', false, false, true);
        });
        errorDiv.appendChild(retryBtn);
      }

      stage.appendChild(errorDiv);
      progressFill.style.width = '0%';
      preview.textContent = '';
      root.classList.add('lvx-active');
      setHud(`${errorMsg}`, true, true, true);
    }

    if (message.type === 'LV_TRACK') {
      startTrack(message.payload);
    }

    if (message.type === 'LV_STOP') {
      teardown();
    }
  });

  document.addEventListener('keydown', handleKeys, true);
  window.addEventListener('keydown', handleTapKeys, true);
  window.addEventListener('keyup', handleTapKeys, true);
  window.addEventListener('blur', () => { if (tapping.heldInput) stopTapTake('Take stopped because focus changed. Unfinished word unchanged; completed words retained.'); });
  for (const eventName of ['seeking', 'pause', 'ratechange', 'ended']) document.addEventListener(eventName, event => {
    if(eventName==='seeking'&&event.target===getMedia()){
      const internal=timing.busy||Number.isFinite(tapping.armSeekMs)&&Math.abs(event.target.currentTime*1000-tapping.armSeekMs)<100||performance.now()<(tapping.takeSeekUntil||0);
      tapping.armSeekMs=null;
      if(internal)return;
      if(streamTake(tapping.take)||rawTake(tapping.take)){tapping.followSeek=true;tapping.seekPhraseId=null;}
      else if(!tapping.take)tapping.followSeek=true;
    }
    if (performanceTake.armed && event.target === getMedia()) stopEffects('Effects stopped because playback changed. Gestures retained.');
    if (tapping.take?.status === 'armed' && event.target === getMedia() && (eventName !== 'ratechange' || getMedia()?.playbackRate !== tapping.rate)) stopTapTake('Take stopped because playback changed. Completed marks are retained.');
  }, true);
  document.addEventListener('seeked',event=>{
    if(event.target===getMedia()&&!tapping.take&&tapping.followSeek&&!timing.busy&&!syncPanel.hidden){refreshPerformClock(event.target.currentTime*1000-state.score.offsetMs);return;}
    if(event.target!==getMedia()||!(streamTake(tapping.take)||rawTake(tapping.take))||!tapping.followSeek||timing.busy)return;
    refreshPerformClock(event.target.currentTime*1000-state.score.offsetMs);
    setSyncNotice('Following your seek position. Recorded taps are intact. Retake from this phrase replaces this and later taps; earlier phrases stay. Undo mark restores the previous take.');
  },true);
  window.addEventListener('resize', () => {
    if (state.currentMoment) fitMoment(state.currentMoment);
    if (state.theme === 'flow') flowFitAllSlots();
  });

  /* ══════════════════════════════════════
     PAGE HINTS (works for YT, Spotify, SC, etc.)
     ══════════════════════════════════════ */
  function getPageHints() {
    const media = getMedia();
    const youtube = youtubeMediaState();
    const url = location.href;
    const title = document.title || '';
    const host = location.hostname;
    const hints = {
      url,
      host,
      pageTitle: title,
      currentTime: media && Number.isFinite(media.currentTime) ? media.currentTime : null,
      duration: youtube?.lookupDurationMs ? youtube.lookupDurationMs / 1000 : !isAdvertisement() && media && Number.isFinite(media.duration) ? media.duration : null,
      isAd: isAdvertisement(),
      mediaReady: youtube ? youtube.clockUsable : true
    };

    if (host.includes('music.youtube.com')) {
      hints.track = textFrom('.title.ytmusic-player-bar') ||
        textFrom('ytmusic-player-bar .title') ||
        textFrom('ytmusic-player-bar yt-formatted-string.title') || '';
      hints.artist = textFrom('.byline.ytmusic-player-bar a') ||
        textFrom('ytmusic-player-bar .byline a') ||
        textFrom('ytmusic-player-bar .subtitle a') || '';
      // Try to get album from YouTube Music
      hints.album = textFrom('ytmusic-player-bar .byline a:nth-child(3)') ||
        textFrom('ytmusic-player-bar .subtitle a[href*="browse/"]') || '';
    } else if (host.includes('youtube.com')) {
      hints.track = textFrom('h1 yt-formatted-string') ||
        textFrom('h1.title') ||
        title.replace(/ - YouTube$/i, '');
    } else if (host.includes('spotify.com')) {
      /* ── SPOTIFY RESILIENT SELECTORS (2026) ── */
      hints.track = spotifyGetTrack(title);
      hints.artist = spotifyGetArtist(title);
      hints.album = spotifyGetAlbum();

      // Spotify time from DOM (no <audio>/<video> element exposed)
      const spotifyTime = getSpotifyCurrentTimeFromDom();
      if (spotifyTime !== null) {
        hints.currentTime = spotifyTime / 1000;
      }
      const spotifyDuration = getSpotifyDurationFromDom();
      if (spotifyDuration !== null) {
        hints.duration = spotifyDuration / 1000;
      }
    } else if (host.includes('soundcloud.com')) {
      // ═══ SOUNDCLOUD ═══
      // Key challenge: SoundCloud "artist" = uploader (random username), NOT the real artist.
      // The real artist is typically embedded in the track title: "Artist - Song Title"
      // We must parse the title to extract the real artist for accurate lyrics lookup.

      let scRawTitle = '';
      let scUploader = '';

      // Step 1: Read raw track title and uploader from DOM (multiple selector strategies)
      scRawTitle = textFrom('.playbackSoundBadge__titleLink') ||
        textFrom('.playbackSoundBadge__titleLink span') ||
        textFrom('.soundTitle__title span') || '';
      scUploader = textFrom('.playbackSoundBadge__lightLink') ||
        textFrom('.soundTitle__username') || '';

      // Strategy 2: DOM traversal of player bar links
      if (!scRawTitle) {
        const scPlayer = document.querySelector('.playControls__soundBadge') ||
          document.querySelector('.playControls__inner') ||
          document.querySelector('.playControls');
        if (scPlayer) {
          for (const a of scPlayer.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            const txt = a.textContent.trim();
            if (!txt || txt.length < 2) continue;
            if (!scRawTitle && href.split('/').length >= 3 && !href.includes('/sets/')) {
              scRawTitle = txt;
            }
            if (!scUploader && href.match(/^\/[^/]+\/?$/)) {
              scUploader = txt;
            }
          }
        }
      }

      // Strategy 3: Parse document.title (most reliable — always has the track info)
      // Format: "Stream Track Title by Uploader | Listen..." or "Track Title by Uploader | SoundCloud"
      if (!scRawTitle && title) {
        let scTitle = title
          .replace(/\s*[|·]\s*(?:Listen|SoundCloud).*$/i, '')
          .replace(/^Stream\s+/i, '')
          .trim();
        const byMatch = scTitle.match(/^(.+?)\s+by\s+(.+)$/i);
        if (byMatch) {
          scRawTitle = byMatch[1].trim();
          if (!scUploader) scUploader = byMatch[2].trim();
        } else if (scTitle) {
          scRawTitle = scTitle;
        }
      }

      // Step 2: Parse the real artist from the track title
      // SoundCloud track titles commonly use these formats:
      //   "Artist - Song Title"
      //   "Artist — Song Title"  (em dash)
      //   "Artist – Song Title"  (en dash)
      //   "Artist: Song Title"
      if (scRawTitle) {
        const dashMatch = scRawTitle.match(/^(.+?)\s*[-–—]\s+(.+)$/);
        if (dashMatch && dashMatch[1].length >= 2 && dashMatch[2].length >= 2) {
          // Title has "Artist - Song" format — extract both
          hints.artist = dashMatch[1].trim();
          hints.track = dashMatch[2].trim();
        } else {
          // No embedded artist — use the full title as track, uploader as artist fallback
          hints.track = scRawTitle;
          hints.artist = scUploader;
        }
      }

      // Mark this as SoundCloud so the service worker knows
      hints.isSoundCloud = true;
    }

    // Stable key so the service worker can tell whether the page DOM
    // has caught up to a new track yet (prevents reading stale data).
    const t = (hints.track || hints.pageTitle || '').trim();
    const a = (hints.artist || '').trim();
    hints.trackKey = t ? `${t}|||${a}` : '';

    return hints;
  }

  /* ══════════════════════════════════════
     SPOTIFY DOM HELPERS — multi-strategy cascade
     ══════════════════════════════════════ */
  function spotifyGetPlayerRoot() {
    return document.querySelector('[data-testid="now-playing-widget"]') ||
           document.querySelector('[data-testid="now-playing-bar"]') ||
           document.querySelector('footer') ||
           null;
  }

  function spotifyGetTrack(pageTitle) {
    // Strategy 1: data-testid selectors
    let t = textFrom('[data-testid="context-item-info-title"]') ||
            textFrom('[data-testid="now-playing-widget"] [data-testid="context-item-info-title"]') ||
            textFrom('[data-testid="context-item-link"] [dir="auto"]');
    if (t) return t;

    // Strategy 2: Links in now-playing widget (non-artist links)
    const root = spotifyGetPlayerRoot();
    if (root) {
      // First try links to /track/ paths
      for (const link of root.querySelectorAll('a[href*="/track/"]')) {
        const txt = link.textContent.trim();
        if (txt && txt.length > 1) return txt;
      }
      // Then try first non-artist, non-album link
      for (const link of root.querySelectorAll('a')) {
        const txt = link.textContent.trim();
        const href = link.href || '';
        if (txt && txt.length > 1 && !href.includes('/artist/') && !href.includes('/album/') && !href.includes('/playlist/')) return txt;
      }
      // Try any [dir="auto"] text node (Spotify uses this for song titles)
      const dirAuto = root.querySelector('[dir="auto"]');
      if (dirAuto) {
        const txt = dirAuto.textContent.trim();
        if (txt && txt.length > 1) return txt;
      }
    }

    // Strategy 3: Page title parsing
    if (pageTitle) {
      const parsed = parseSpotifyTitle(pageTitle);
      if (parsed.track) return parsed.track;
    }
    return '';
  }

  function spotifyGetArtist(pageTitle) {
    // Strategy 1: data-testid selectors
    let a = textFrom('[data-testid="context-item-info-subtitles"]') ||
            textFrom('[data-testid="context-item-info-artist"]');
    if (a) return a;

    // Strategy 2: Links to /artist/ in player root
    const root = spotifyGetPlayerRoot();
    if (root) {
      const artistLinks = root.querySelectorAll('a[href*="/artist/"]');
      const names = [];
      for (const link of artistLinks) {
        const txt = link.textContent.trim();
        if (txt && txt.length > 1) names.push(txt);
      }
      if (names.length) return names.join(', ');
    }

    // Strategy 3: Page title parsing
    if (pageTitle) {
      const parsed = parseSpotifyTitle(pageTitle);
      if (parsed.artist) return parsed.artist;
    }
    return '';
  }

  function spotifyGetAlbum() {
    const root = spotifyGetPlayerRoot();
    if (!root) return '';
    for (const link of root.querySelectorAll('a[href*="/album/"]')) {
      const txt = link.textContent.trim();
      if (txt && txt.length > 1) return txt;
    }
    return '';
  }

  function parseSpotifyTitle(title) {
    let cleaned = (title || '')
      .replace(/\s*[|·•]\s*Spotify\s*$/i, '')
      .replace(/\s*-\s*Spotify\s*$/i, '')
      .trim();
    const dotSplit = cleaned.split(' · ');
    if (dotSplit.length >= 2) {
      return { track: dotSplit[0].trim(), artist: dotSplit.slice(1).join(' ').trim() };
    }
    const dashSplit = cleaned.split(' - ');
    if (dashSplit.length >= 2) {
      return { track: dashSplit[1].trim(), artist: dashSplit[0].trim() };
    }
    return { track: cleaned, artist: '' };
  }

  /* ══════════════════════════════════════
     SPOTIFY TIME READING — multi-source with progress bar fill
     ══════════════════════════════════════ */
  function getSpotifyCurrentTimeFromDom() {
    // Source 1: data-testid time text
    const el = document.querySelector('[data-testid="playback-position"]');
    if (el) {
      const ms = parseTimeString(el.textContent);
      if (ms !== null) return ms;
    }

    // Source 2: input[type="range"] on progress bar
    const bar = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]') ||
                document.querySelector('.playback-bar input[type="range"]') ||
                document.querySelector('[data-testid="progress-bar"] input[type="range"]');
    if (bar) {
      const val = parseFloat(bar.value);
      const max = parseFloat(bar.max);
      if (Number.isFinite(val) && Number.isFinite(max) && max > 0) {
        return max > 600000 ? val : val * 1000;
      }
    }

    // Source 3: progress bar fill width ratio × duration
    const dur = getSpotifyDurationFromDom();
    if (dur !== null && dur > 0) {
      // Try the progress bar fill div
      const progressTrack = document.querySelector('[data-testid="playback-progressbar"]') ||
                             document.querySelector('[data-testid="progress-bar"]') ||
                             document.querySelector('.playback-bar');
      if (progressTrack) {
        const fill = progressTrack.querySelector('[style*="width"]') ||
                     progressTrack.querySelector('[data-testid="progress-bar-fill"]') ||
                     progressTrack.querySelector('div > div');
        if (fill) {
          const style = fill.getAttribute('style') || '';
          const widthMatch = style.match(/width:\s*([\d.]+)%/) ||
                             style.match(/transform:\s*translateX\(([-\d.]+)%\)/);
          if (widthMatch) {
            const pct = Math.abs(parseFloat(widthMatch[1])) / 100;
            if (pct >= 0 && pct <= 1) return Math.round(dur * pct);
          }
          // Try computed width ratio
          const trackRect = progressTrack.getBoundingClientRect();
          const fillRect = fill.getBoundingClientRect();
          if (trackRect.width > 0 && fillRect.width > 0) {
            const ratio = fillRect.width / trackRect.width;
            if (ratio >= 0 && ratio <= 1) return Math.round(dur * ratio);
          }
        }
      }
    }

    // Source 4: scan footer spans for time-like text
    const footerTimes = document.querySelectorAll('footer span, [data-testid="now-playing-bar"] span');
    for (const span of footerTimes) {
      const ms = parseTimeString(span.textContent);
      if (ms !== null) return ms;
    }
    return null;
  }

  function getSpotifyDurationFromDom() {
    const el = document.querySelector('[data-testid="playback-duration"]');
    if (el) return parseTimeString(el.textContent);
    // Fallback: input max on range
    const bar = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]') ||
                document.querySelector('.playback-bar input[type="range"]');
    if (bar) {
      const max = parseFloat(bar.max);
      if (Number.isFinite(max) && max > 0) return max > 600000 ? max : max * 1000;
    }
    // Fallback: second time string in footer
    const spans = document.querySelectorAll('footer span, [data-testid="now-playing-bar"] span');
    let found = 0;
    for (const span of spans) {
      const ms = parseTimeString(span.textContent);
      if (ms !== null) { found++; if (found === 2) return ms; }
    }
    return null;
  }

  /* ── Spotify Pause Detection ── */
  function isSpotifyPaused() {
    // ONLY check the main playback play/pause button — NOT any other "Play" button on the page
    // (Spotify has many buttons like "Shuffle Play", playlist "Play" etc.)
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    if (btn) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label === 'play' || label === 'play song') return true;
      if (label === 'pause' || label === 'pause song') return false;
      // Partial match but only exact play/pause context
      if (/^play$/i.test(label.trim())) return true;
      if (/^pause$/i.test(label.trim())) return false;
    }
    // Fallback: only trust stale-time detection (set by polling)
    return state.spotifyPauseDetected || false;
  }

  function parseTimeString(str) {
    if (!str) return null;
    const clean = str.trim();
    if (!/^\d+:\d{2}(:\d{2})?$/.test(clean)) return null;
    const parts = clean.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return null;
  }

  function textFrom(selector) {
    try {
      const node = document.querySelector(selector);
      return node ? node.textContent.trim().replace(/\s+/g, ' ') : '';
    } catch (_) { return ''; }
  }

  function getMedia() {
    const player = document.querySelector('#movie_player video, ytmusic-player video');
    if (player && Number.isFinite(player.currentTime)) return player;
    const candidates = [...document.querySelectorAll('video, audio')];
    return candidates.find((item) => Number.isFinite(item.currentTime) && item.duration) ||
      candidates.find((item) => Number.isFinite(item.currentTime)) ||
      null;
  }

  function isAdvertisement() {
    const player = document.getElementById('movie_player');
    return Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'));
  }

  function youtubeMediaState() {
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(location.hostname) || !globalThis.LvYoutubeMedia) return null;
    const media = getMedia();
    return LvYoutubeMedia.inspect({ url: location.href, canonicalUrl: document.querySelector('link[rel="canonical"]')?.href, isoDuration: document.querySelector('meta[itemprop="duration"]')?.content, playerDurationText: document.querySelector('#movie_player .ytp-time-duration')?.textContent, playerClassName: document.querySelector('#movie_player')?.className, mediaDurationSec: media?.duration, mediaCurrentTimeSec: media?.currentTime, mediaPaused: media?.paused, mediaSeeking: media?.seeking });
  }

  /* ══════════════════════════════════════
     SPOTIFY TIME POLLING — resilient, pause-aware
     ══════════════════════════════════════ */
  function startSpotifyPolling() {
    stopSpotifyPolling();
    if (!state.isSpotify) return;

    let staleCount = 0;
    state.spotifyNullCount = 0;

    state.spotifyPollInterval = setInterval(() => {
      const ms = getSpotifyCurrentTimeFromDom();

      // Handle null reads (DOM not ready or element disappeared)
      if (ms === null) {
        state.spotifyNullCount++;
        // After 10 null reads (2s), don't freeze — keep interpolating from last good value
        // After 50 null reads (10s), mark as stalled
        if (state.spotifyNullCount > 50 && !state.spotifyPauseDetected) {
          state.spotifyPauseDetected = true;
        }
        return;
      }

      // Got a valid read
      state.spotifyNullCount = 0;
      state.spotifyLastGoodWall = performance.now();

      if (ms !== state.spotifyCurrentTimeMs) {
        // Time value changed — music is playing, re-anchor interpolation
        state.spotifyCurrentTimeMs = ms;
        state.spotifyLastPollWall = performance.now();
        state.spotifyPauseDetected = false;
        staleCount = 0;
      } else {
        staleCount++;
        // Spotify text updates ~1x/sec, polling at 200ms = ~5 polls per text change
        // If stale for 30+ polls (~6 seconds), THEN check the pause button
        if (staleCount > 30) {
          const btnPaused = isSpotifyPaused();
          if (btnPaused) {
            state.spotifyPauseDetected = true;
            state.spotifyLastPollWall = performance.now();
          } else {
            state.spotifyPauseDetected = false;
          }
          staleCount = 20; // Reset slightly so we don't spam the button check
        }
      }
    }, 200);
  }

  function stopSpotifyPolling() {
    if (state.spotifyPollInterval) {
      clearInterval(state.spotifyPollInterval);
      state.spotifyPollInterval = 0;
    }
  }

  /* ══════════════════════════════════════
     UNIVERSAL TRACK CHANGE OBSERVER
     Works on Spotify, YouTube Music, SoundCloud, plain YouTube, etc.
     ══════════════════════════════════════ */
  function setupTrackChangeObserver() {
    let lastTrackKey = '';
    let pendingKey = '';
    let stabilityTimer = 0;
    let mediaHooked = null;
    let ytmVideoSrcObserver = null;
    const isYTMusic = location.hostname.includes('music.youtube.com');

    // Simple track key using only DOM text metadata.
    // The stability timer below handles slow/partial updates natively!
    const currentTrackKey = () => {
      const h = getPageHints();
      const exactKey = globalThis.LvScore?.mediaKey(h);
      if (exactKey) return exactKey;
      const track = (h.track || h.pageTitle || '').trim();
      const artist = (h.artist || '').trim();
      return track ? `${track}|||${artist}` : '';
    };

    const onPotentialChange = () => {
      const listening = state.active || state.errorShown;
      if (!listening) {
        const k = currentTrackKey();
        if (k) lastTrackKey = k;
        return;
      }

      const key = currentTrackKey();
      if (!key) return;

      if (key !== lastTrackKey) {
        if (key !== pendingKey) {
          pendingKey = key;
          clearTimeout(stabilityTimer);
          
          // Wait for DOM to stabilize (prevents partial-update false positives)
          // Keep these as SHORT as possible — the service worker has its own retries
          const waitMs = state.isSpotify ? 150 : isYTMusic ? 300 : 100;
          
          stabilityTimer = setTimeout(() => {
            const prevKey = lastTrackKey;
            lastTrackKey = pendingKey;
            
            if (state.isSpotify) {
              try {
                chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {});
                setTimeout(() => {
                  try { chrome.runtime?.sendMessage({ type: 'LV_SPOTIFY_TRACK_CHANGED' }).catch(() => {}); } catch (_) {}
                }, 100);
              } catch (_) {}
            } else {
              try {
                cancelLoop();
                clearRevealTimers();
                stage.textContent = '';
                preview.textContent = '';
                progressFill.style.width = '0%';
                chrome.runtime?.sendMessage({ type: 'LV_TRACK_CHANGED', prevKey: prevKey || '' }).catch(() => {});
              } catch (_) {}
            }
          }, waitMs);
        }
      } else {
        // Reverted to lastTrackKey before stabilizing, or just noise
        pendingKey = '';
        clearTimeout(stabilityTimer);
      }
    };

    let throttleTimer = 0;
    const triggerCheck = () => {
      clearTimeout(throttleTimer);
      throttleTimer = setTimeout(onPotentialChange, 50);
    };

    const observer = new MutationObserver(triggerCheck);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(triggerCheck).observe(titleEl, { childList: true, characterData: true });
    }

    const hookMedia = () => {
      const media = getMedia();
      if (!media || media === mediaHooked) return;
      mediaHooked = media;
      ['loadedmetadata', 'durationchange', 'play'].forEach((evt) => {
        media.addEventListener(evt, triggerCheck, { passive: true });
      });

      if (isYTMusic && media.tagName === 'VIDEO') {
        if (ytmVideoSrcObserver) ytmVideoSrcObserver.disconnect();
        ytmVideoSrcObserver = new MutationObserver(triggerCheck);
        ytmVideoSrcObserver.observe(media, { attributes: true, attributeFilter: ['src'] });
      }
    };
    hookMedia();
    setInterval(hookMedia, 3000);

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        triggerCheck();
      }
    }, isYTMusic ? 400 : 1000);

    setInterval(triggerCheck, 3000);
  }

  /* ══════════════════════════════════════
     TRACK START
     ══════════════════════════════════════ */
  function startTrack(payload) {
    state.score = null;
    state.auditionLoop = null;
    clearRevealTimers();
    cancelLoop();
    stage.textContent = '';

    const track = payload.track || {};
    const lyrics = payload.lyrics || {};
    const synced = parseLrc(lyrics.synced || '');
    const plain = lyrics.plain
      ? lyrics.plain.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      : [];

    const prepared = prepareLines(synced.length ? synced : fakeTimedLyrics(plain));
    const title = [track.artist, track.title].filter(Boolean).join(' — ') || 'Song found';

    state.active = true;
    state.errorShown = false;
    state.lines = prepared;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.trackTitle = title;
    state.lyricSource = synced.length ? 'synced' : 'plain fallback';
    state.syncOffsetMs = computeAdaptiveSyncOffset(prepared);
    state.trackKey = trackStorageKey(track);
    state.trackDurationMs = Number(track.durationMs || 0) ||
      (payload.hints && payload.hints.duration ? payload.hints.duration * 1000 : 0);
    state.offsetWasRestored = false;
    state.syncPreferenceVersion += 1;
    state._flowLastIndex = -999; // reset FLOW teleprompter for new song
    if (state.theme === 'flow') flowInit(); // rebuild FLOW DOM for new lyrics
    preview.textContent = '';
    progressFill.style.width = '0%';

    // Duration differences are not measured intro offsets.

    // SPOTIFY SYNC COMPENSATION
    // Start with a moderate offset. The auto-calibration system (below) will
    // fine-tune this per-song after the first few lyric lines are rendered.
    if (state.isSpotify && synced.length) {
      state.syncOffsetMs -= 250;
    }

    state.baseOffsetMs = state.syncOffsetMs;
    state.detectedSyncOffsetMs = state.syncOffsetMs;
    state.timingErrors = [];
    state.autoCalibrated = false;
    state.spotifyAutoCalibSamples = [];
    state.mediaDriftSamples = [];
    state.playbackRate = 1;

    const media = getMedia();
    let mediaNow;
    if (state.isSpotify) {
      const spotMs = getSpotifyCurrentTimeFromDom();
      mediaNow = spotMs !== null ? spotMs : Number(track.playOffsetMs || 0);
      state.spotifyCurrentTimeMs = mediaNow;
      state.spotifyLastPollWall = performance.now();
      startSpotifyPolling();
    } else {
      mediaNow = media && Number.isFinite(media.currentTime)
        ? media.currentTime * 1000
        : Number(track.playOffsetMs || 0);
    }

    state.fallbackMediaStartMs = mediaNow;
    state.fallbackStartMs = performance.now();
    state.lastMediaTime = mediaNow;
    state.lastWallTime = performance.now();

    if (!state.lines.length) {
      setHud('Song found, but no lyrics were returned.', true, true);
      return;
    }

    show();
    root.classList.add('lvx-active');
    setHud(`${title} · ${state.lyricSource} · offset ${formatOffset(state.syncOffsetMs)}`);
    startLoop();

    /* PER-SONG OFFSET MEMORY: if the user manually nudged sync for this song
       before, restore their preferred offset (overrides the adaptive guess). */
    if (state.trackKey) {
      try {
        const preferenceVersion = state.syncPreferenceVersion;
        chrome.storage.local.get(`lvxOffset:${state.trackKey}`, (result) => {
          const saved = result && result[`lvxOffset:${state.trackKey}`];
          if (Number.isFinite(saved) && state.active && state.trackKey && state.syncPreferenceVersion === preferenceVersion) {
            state.syncOffsetMs = saved;
            state.baseOffsetMs = saved;
            state.autoCalibrated = true; // trust the user's saved offset
            state.offsetWasRestored = true;
            setHud(`${title} · saved sync restored (${formatOffset(saved)})`);
          }
        });
      } catch (_) {}
    }

    // SAFETY NET: if no lyric line renders within 12 seconds, show error
    // This catches cases where DOM time reading fails silently (blank screen bug)
    if (state.isSpotify) {
      setTimeout(() => {
        if (state.active && state.currentIndex < 0) {
          // Only show error if the first lyric should have played by now
          if (state.lines.length && state.lines[0].time < 11000) {
            stage.innerHTML = '';
            const errorDiv = document.createElement('div');
            errorDiv.className = 'lvx-not-available';
            errorDiv.textContent = 'Lyrics found but sync failed. Try skipping forward/back.';
            stage.appendChild(errorDiv);
            setHud('Sync failed — try restarting the song', true, true);
          }
        }
      }, 12000);
    }
  }

  /* ══════════════════════════════════════
     LRC PARSER
     ══════════════════════════════════════ */
  function parseLrc(raw) {
    const lines = [];
    String(raw || '').split(/\n+/).forEach((line) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      if (!matches.length) return;

      const text = line.replace(/\[[^\]]+\]/g, '').trim();
      if (!text) return;

      matches.forEach((match) => {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0;
        lines.push({
          time: minutes * 60000 + seconds * 1000 + fraction,
          text
        });
      });
    });
    return lines.sort((a, b) => a.time - b.time);
  }

  function computeAdaptiveSyncOffset(lines) {
    if (lines.length < 2) return DEFAULT_SYNC_OFFSET_MS;

    const gaps = [];
    let totalWords = 0;

    for (let i = 0; i < lines.length - 1; i++) {
      const g = lines[i + 1].time - lines[i].time;
      if (g > 150 && g < 10000) gaps.push(g);
      totalWords += (lines[i].text || '').split(/\s+/).filter(Boolean).length;
    }
    totalWords += (lines[lines.length - 1].text || '').split(/\s+/).filter(Boolean).length;

    if (!gaps.length) return DEFAULT_SYNC_OFFSET_MS;

    // Use MEDIAN gap (not mean) — immune to long instrumental breaks skewing the result
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    const avgWordsPerLine = totalWords / lines.length;

    // Detect genre/tempo from lyric patterns
    // LRCLIB timestamps are already well-placed — we just need small lead for rendering
    let offset;

    if (medianGap < 900) {
      // Rapid-fire rap / drill: needs visible lead
      offset = -160;
    } else if (medianGap < 1600) {
      // Fast pop / hip-hop
      offset = -120;
    } else if (medianGap < 2600) {
      // Normal pop / rock
      offset = -90;
    } else if (medianGap < 4000) {
      // Slow song
      offset = -65;
    } else {
      // Very slow ballad: barely any lead — LRC timestamps are usually right on time
      offset = -45;
    }

    // Dense lines (many words) need a touch more lead to read ahead
    if (avgWordsPerLine > 9) offset -= 15;
    else if (avgWordsPerLine < 3) offset += 10; // short phrases can arrive a bit later

    // Hard clamp — never more than -180ms early, never positive
    return Math.max(-180, Math.min(-30, offset));
  }

  function fakeTimedLyrics(lines) {
    return lines.map((text, index) => {
      const wc = text.split(/\s+/).filter(Boolean).length;
      const interval = Math.max(2200, Math.min(wc * 420, 4200));
      const startTime = index === 0 ? 0
        : lines.slice(0, index).reduce((acc, t) => {
            const w = t.split(/\s+/).filter(Boolean).length;
            return acc + Math.max(2200, Math.min(w * 420, 4200));
          }, 0);
      return { time: startTime, text };
    });
  }

  /* ══════════════════════════════════════
     LINE PREPARATION
     ══════════════════════════════════════ */
  function prepareLines(rawLines) {
    const clean = rawLines
      .map((line) => ({
        time: Number(line.time || 0),
        text: cleanText(line.text || '')
      }))
      .filter((line) => line.text)
      .sort((a, b) => a.time - b.time);

    const counts = new Map();
    clean.forEach((line) => {
      const key = normalize(line.text);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });

    return clean.map((line, index) => {
      const next = clean[index + 1];
      const duration = next ? Math.max(420, next.time - line.time) : 4500;
      const repeated = (counts.get(normalize(line.text)) || 0) > 1;
      const role = classifyLine(line.text, duration, repeated);
      return {
        ...line,
        index,
        nextTime: next ? next.time : line.time + 4500,
        duration,
        repeated,
        role,
        composition: composeMoment(line.text, role, index, repeated),
        animation: pickAnimation(index)
      };
    });
  }

  function pickAnimation(index) {
    const h = ((index + 1) * 2654435761) >>> 0;
    return ANIMATIONS[h % ANIMATIONS.length];
  }

  function classifyLine(text, duration, repeated) {
    const list = words(text);
    const wc = list.length;
    const lower = normalize(text);
    const first = lower.split(' ')[0] || '';
    const tagLike = TAG_OPENERS.has(first) && wc <= 5;

    if (tagLike) return 'tag';
    if (repeated && wc <= 9) return 'punch';
    if (wc <= 3 || text.length <= 14) return 'punch';
    if (duration <= 1250 && wc <= 6) return 'punch';
    if (/!$/.test(text.trim()) && wc <= 7) return 'punch';
    if (wc >= 8 || /[,;:?]/.test(text) || (SETUP_OPENERS.has(first) && wc >= 5)) return 'mixed';
    return 'main';
  }

  function composeMoment(text, role, index, repeated) {
    const list = words(text);
    const wc = list.length;
    const normalized = cleanText(text);

    if (role === 'tag') {
      return {
        layout: layoutFor(index, 'tag'),
        layers: [{ kind: 'tag', text: normalized }]
      };
    }

    if (role === 'punch' || role === 'main' || wc <= 5) {
      return {
        layout: layoutFor(index, role),
        layers: [{ kind: role === 'punch' || repeated ? 'punch' : 'main', text: normalized }]
      };
    }

    const split = splitForKineticMoment(normalized);
    if (split.support && split.main) {
      const layers = [
        { kind: 'support', text: split.support },
        { kind: repeated ? 'punch' : 'main', text: split.main }
      ];
      if (split.tag) layers.push({ kind: 'tag', text: split.tag });
      return {
        layout: layoutFor(index, 'mixed'),
        layers
      };
    }

    return {
      layout: layoutFor(index, 'main'),
      layers: [{ kind: 'main', text: normalized }]
    };
  }

  function splitForKineticMoment(text) {
    const cleaned = cleanText(text);
    const hardSplit = cleaned.match(/^(.+?)([,;:]|\s+-\s+|\s+but\s+|\s+and\s+)(.+)$/i);
    if (hardSplit) {
      const head = cleanText(`${hardSplit[1]}${hardSplit[2].trim().match(/but|and/i) ? ` ${hardSplit[2].trim()}` : hardSplit[2]}`);
      const tail = cleanText(hardSplit[3]);
      if (words(tail).length >= 2 && words(tail).length <= 7) {
        return { support: trimWords(head, 9), main: tail, tag: '' };
      }
      if (words(tail).length > 7) {
        return { support: trimWords(head, 8), main: tailWords(tail, 5), tag: '' };
      }
    }

    const list = words(cleaned);
    if (list.length >= 8) {
      const mainCount = list.length >= 12 ? 5 : 4;
      const support = list.slice(0, Math.max(3, list.length - mainCount)).join(' ');
      const main = list.slice(-mainCount).join(' ');
      return { support: trimWords(support, 8), main, tag: '' };
    }

    return { support: '', main: cleaned, tag: '' };
  }

  /* ══════════════════════════════════════
     LAYOUT SELECTOR (expanded with new layouts)
     ══════════════════════════════════════ */
  function layoutFor(index, role) {
    const h = ((index + 1) * 2654435761) >>> 0;

    const mixedLayouts = [
      'lvx-layout-ref-a',     'lvx-layout-ref-b',     'lvx-layout-ref-c',
      'lvx-layout-diag-a',    'lvx-layout-diag-b',    'lvx-layout-split-v',
      'lvx-layout-asymm-l',   'lvx-layout-asymm-r',   'lvx-layout-cinema',
      'lvx-layout-stack',     'lvx-layout-typewriter', 'lvx-layout-widescreen',
      'lvx-layout-drift',     'lvx-layout-scatter',    'lvx-layout-cascade',
    ];
    const mainLayouts = [
      'lvx-layout-center',      'lvx-layout-left',       'lvx-layout-low',
      'lvx-layout-corner-tl',   'lvx-layout-corner-br',  'lvx-layout-edge-r',
      'lvx-layout-high',        'lvx-layout-edge-l',     'lvx-layout-typewriter',
      'lvx-layout-spotlight',   'lvx-layout-widescreen', 'lvx-layout-whisper',
      'lvx-layout-drift',       'lvx-layout-cascade',
    ];
    const punchLayouts = [
      'lvx-layout-center',     'lvx-layout-wide',       'lvx-layout-hero',
      'lvx-layout-corner-tl',  'lvx-layout-left',       'lvx-layout-corner-br',
      'lvx-layout-stadium',    'lvx-layout-cinema',     'lvx-layout-spotlight',
      'lvx-layout-scatter',    'lvx-layout-drift',
    ];

    if (role === 'mixed') return mixedLayouts[h % mixedLayouts.length];
    if (role === 'tag')   return 'lvx-layout-tag';
    if (role === 'punch') return punchLayouts[h % punchLayouts.length];
    return mainLayouts[h % mainLayouts.length];
  }

  /* ══════════════════════════════════════
     MAIN PLAYBACK LOOP (improved sync)
     ══════════════════════════════════════ */
  function startLoop() {
    cancelLoop();

    function tick() {
      if (!state.active) return;

      const mediaMs = getMediaTimeMs();
      if (state.score) {
        const key = LvScore.mediaKey({ url: location.href });
        if (key !== LvScore.mediaKey(state.score.source)) {
          if (performanceTake.armed) stopEffects('Effects stopped: the video changed. Gestures retained.');
          if (tapping.take?.status === 'armed') stopTapTake('Take stopped: the video changed. Completed marks are retained.');
          stage.textContent = '';
          state.auditionLoop = null;
          if (!syncPanel.hidden && !syncNotice.textContent.startsWith('The video changed')) { setSyncNotice('The video changed. Sync switches to this video as soon as its lyrics load; the other video’s unsaved preview is kept for when you go back.','warn'); refreshTimingPanel(); }
          state.rafId = requestAnimationFrame(tick);
          return;
        }
        const media = getMedia();
        const ad = isAdvertisement() || youtubeMediaState()?.clockUsable === false;
        if (performanceTake.armed && ad) stopEffects('Effects stopped because the main-video clock is unavailable. Gestures retained.');
        if (tapping.take?.status === 'armed' && performance.now() >= (tapping.takeSeekUntil || 0) && (ad || media?.paused || media?.seeking || media?.playbackRate !== tapping.rate || tapping.binding !== tapBinding())) stopTapTake('Take stopped because playback changed. Completed marks are retained.');
        stage.classList.toggle('lvx-score-paused', media?.paused ?? true);
        root.classList.toggle('lvx-ad-paused', ad);
        if (ad) {
          stage.textContent = '';
          state.scoreSignature = '';
          state.rafId = requestAnimationFrame(tick);
          return;
        }
        if (state.auditionLoop && media && !media.paused && mediaMs >= state.auditionLoop.endMs) media.currentTime = state.auditionLoop.startMs / 1000;
        if (performanceTake.armed && !effectSourceReady()) stopEffects('Effects stopped because playback changed. Gestures retained.');
        renderScore(mediaMs);
        if (!syncPanel.hidden) {
          refreshPerformClock(mediaMs-state.score.offsetMs);
          const lane = syncPanel.querySelector('.lvx-tap-blocks'), head = syncPanel.querySelector('.lvx-tap-playhead');
          const now = mediaMs - state.score.offsetMs, start = Number(lane.dataset.start), end = Number(lane.dataset.end);
          head.hidden = !(now >= start && now <= end); head.style.left = `${clamp((now-start)/(end-start || 1)*100,0,100)}%`;
          if (performanceTake.armed) {
            const target = activeEffectTarget();
            syncPanel.querySelector('.lvx-effect-status').textContent = `${performanceTake.marks.length} gestures · ${target ? `“${target.text}” · 1 Pulse / 2 Tilt / 3 Shake` : 'rest or ambiguous overlap · no target'}`;
          }
        }
        if (!syncPanel.hidden) syncPanel.querySelector('.lvx-sync-clock').textContent = `${(mediaMs / 1000).toFixed(3)}s · ${media?.paused ? 'paused' : 'playing'}`;
        if (performance.now() - state.lastClockSent > 100) {
          state.lastClockSent = performance.now();
          chrome.runtime.sendMessage({ type: 'LV_SCORE_PLAYBACK', mediaKey: key, mediaMs, paused: media?.paused ?? true, durationMs: Math.round((media?.duration || 0) * 1000) }).catch(() => {});
        }
        if (state.trackDurationMs > 0) progressFill.style.width = `${clamp(mediaMs / state.trackDurationMs * 100, 0, 100)}%`;
        state.rafId = requestAnimationFrame(tick);
        return;
      }
      updateDriftTracking(mediaMs);
      const lyricClockMs = mediaMs - state.syncOffsetMs;
      const nextIndex = findActiveIndex(lyricClockMs);

      // Update song progress bar
      if (state.trackDurationMs > 0) {
        const pct = clamp((mediaMs / state.trackDurationMs) * 100, 0, 100);
        progressFill.style.width = `${pct.toFixed(2)}%`;
      }

      /* ── FLOW THEME: separate render path (teleprompter, runs every frame) ── */
      if (state.theme === 'flow') {
        if (nextIndex !== state.currentIndex) {
          state.currentIndex = nextIndex;
        }
        flowRender(nextIndex, lyricClockMs);
        state.rafId = requestAnimationFrame(tick);
        return;
      }

      if (nextIndex !== state.currentIndex) {
        // SPOTIFY AUTO-CALIBRATION: observe timing errors on the first 12 line transitions
        // and adjust offset so lyrics land closer to the beat
        if (state.isSpotify && nextIndex >= 0 && nextIndex < state.lines.length && !state.autoCalibrated && !state.offsetWasRestored) {
          const expectedMs = state.lines[nextIndex].time;
          const errorMs = lyricClockMs - expectedMs; // positive = we're late
          if (Math.abs(errorMs) < 3000) { // ignore wild outliers
            if (!state.spotifyAutoCalibSamples) state.spotifyAutoCalibSamples = [];
            state.spotifyAutoCalibSamples.push(errorMs);
            // After 8 samples, compute median error and adjust offset
            if (state.spotifyAutoCalibSamples.length >= 8) {
              const sorted = [...state.spotifyAutoCalibSamples].sort((a, b) => a - b);
              const median = sorted[Math.floor(sorted.length / 2)];
              // Only adjust if median error > 100ms (meaningful)
              if (Math.abs(median) > 100) {
                state.syncOffsetMs += Math.round(median * 0.6); // partial correction
              }
              state.autoCalibrated = true;
            }
          }
        }
        renderIndex(nextIndex, lyricClockMs);
      } else if (nextIndex >= 0) {
        const line = state.lines[nextIndex];
        if (state.currentMoment && shouldClearLine(line, lyricClockMs)) {
          clearMoment();
        } else if (!state.currentMoment && !shouldClearLine(line, lyricClockMs)) {
          renderIndex(nextIndex, lyricClockMs);
        }
      }

      state.rafId = requestAnimationFrame(tick);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  function cancelLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function renderCaptureScore() {
    stage.classList.add('lvx-score-stage');
    const phrase=timingPhrase(), take=tapping.take, unit=take.units[take.index];
    if (!phrase) return;
    const signature=`capture:${timing.draft.previewRevision}:${phrase.id}:${take.index}:${tapCount(take)}:${take.pendingStartMs}:${tapping.frameWordId}:${tapping.streamWordId}`;
    if (state.scoreSignature!==signature) {
      stage.replaceChildren();
      const context=document.createElement('div');context.className='lvx-capture-transcript';
      const label=document.createElement('small');label.textContent=wordTake(take)?`WORD PASS · ${take.holds.length} / ${take.units.length} words · hold Space per word`:eventTake(take)?'PERFORMANCE EVENTS · '+take.events.length+' entrances · Space records':streamTake(take)?`PHRASE-GUIDED SYLLABLES · ${take.marks.length} taps · Space at each entrance`:frameTake(take)?`CONTINUOUS SYLLABLES · ${take.marks.length} taps · Space at each entrance`:take.status==='complete'?'PASS COMPLETE · LEFT TO RERECORD':`${take.mode.toUpperCase()} ${take.index+1} / ${take.units.length} · ${take.pendingStartMs===null?'NEXT TO RECORD':'RECORDING'}`;context.append(label);
      const line=document.createElement('p');
      const units=rawTake(take)||frameTake(take)||streamTake(take)?phrase.words.filter(w=>!w.excluded).map(w=>({id:w.id,wordId:w.id,spelling:w.text})):take.mode==='syllable'?phraseSyllableUnits(phrase):wordTimingUnits(phrase.words);
      for(const item of units){
        const span=document.createElement('span');
        span.textContent=item.spelling;span.dataset.unit=item.id;
        span.classList.toggle('lvx-next-record',wordTake(take)?item.wordId===take.units[take.index]?.wordId:eventTake(take)?false:streamTake(take)?item.wordId===tapping.streamWordId:frameTake(take)?item.wordId===tapping.frameWordId:take.mode==='phrase'?unit?.phraseId===phrase.id:unit?.id===item.id);
        span.classList.toggle('lvx-recording-current',span.classList.contains('lvx-next-record'));
        line.append(span);if(units[units.indexOf(item)+1]?.wordId!==item.wordId&&!/[-\u2010\u2011]$/u.test(item.spelling))line.append(document.createTextNode(' '));
      }
      const upcoming=document.createElement('div');upcoming.className='lvx-upcoming-phrases';renderUpcomingLyrics(upcoming,phrase);
      context.append(line,upcoming);stage.append(context);state.scoreSignature=signature;
    }
  }
  // How far a phrase has been authored: recorded in the current take, else the lowest level all its
  // words share (syllables > words > phrase > estimate), plus whether some words are further along.
  const AUTHORING_LABELS={take:'recorded in this take',syllables:'syllables timed',words:'words timed',phrase:'phrase timed',estimate:'estimate'};
  function takePhraseIds(){
    const take=tapping.take,ids=new Set();if(!take||!timing.draft)return ids;
    const phraseOfWord=new Map(timing.draft.score.phrases.flatMap(p=>p.words.map(w=>[w.id,p.id])));
    if(eventTake(take)){for(const u of take.units)if(take.events.some(e=>e.sourceMs>=u.minMs&&e.sourceMs<u.maxMs))ids.add(u.phraseId);}
    else if(wordTake(take)){for(const h of take.holds)ids.add(h.phraseId);}
    else for(const m of take.marks||[]){if(take.mode==='phrase')ids.add(m.id);else{const pid=phraseOfWord.get(m.wordId??m.id);if(pid)ids.add(pid);}}
    return ids;
  }
  function phraseAuthoring(phrase,takeIds=takePhraseIds()){
    if(takeIds.has(phrase.id))return {level:'take',mixed:false};
    const rank=w=>(w.syllables||[]).some(x=>x.provenance==='manual')?3:w.provenance==='manual'&&w.locked?2:w.provenance==='manual'?1:0;
    const ranks=phrase.words.filter(w=>!w.excluded).map(rank);if(!ranks.length)return {level:'estimate',mixed:false};
    const low=Math.min(...ranks);return {level:['estimate','phrase','words','syllables'][low],mixed:Math.max(...ranks)>low};
  }
  // Done is relative to the capture mode: Phrases needs phrase timing, Words needs words, Syllables needs syllables.
  function authoringProgress(authoring){
    if(authoring.level==='take')return 'take';
    const need={phrase:1,word:2,syllable:3}[syncButton('tap-mode').value]??1;
    return ['estimate','phrase','words','syllables'].indexOf(authoring.level)>=need?'done':'todo';
  }
  function renderScore(mediaMs) {
    if (tapping.take && ['armed','complete'].includes(tapping.take.status) && !(tapping.take.mode==='syllable'&&tapping.take.status==='complete') && timing.draft && !syncPanel.hidden) {renderCaptureScore();return;}
    const score = syllableTakeScore() || (timing.draft && timing.view === 'proposed' ? timing.draft.score : state.score);
    const active = LvScore.activeAt(score, mediaMs);
    // Lead-in: an empty lane shows its next phrase dimmed up to 2s early, so a rewind is never a blank screen.
    const atMs = mediaMs - score.offsetMs;
    for (const lane of score.lanes) {
      if (active.phrases.some(p => p.laneId === lane.id)) continue;
      const next = score.phrases.find(p => p.laneId === lane.id && p.startMs > atMs && p.startMs - atMs <= 2000 && p.words.some(w => !w.excluded));
      if (next) active.phrases.push({ ...JSON.parse(JSON.stringify(next)), words: JSON.parse(JSON.stringify(next.words.filter(w => !w.excluded))), activeWords: [], activeSyllables: [], opacity: 1, leadIn: true });
    }
    if (timing.view === 'proposed' && performanceTake.binding === tapBinding()) {
      const operations = new Map(performanceTake.marks.map(m => [m.targetId,m.operation]));
      for (const phrase of active.phrases) for (const word of phrase.words) {
        const op = operations.get(word.id); if (op) word.effects = op.effect ? [op.effect] : [];
        for (const part of word.syllables || []) { const child = operations.get(part.id); if (child) part.effects = child.effect ? [child.effect] : []; }
      }
    }
    const signature = `${score.revision}:${timing.draft?.previewRevision ?? 'saved'}:${timing.view}:${state.theme}:` + active.phrases.map(p => p.id).join('|');
    if (signature !== state.scoreSignature || !stage.classList.contains('lvx-score-stage')) {
      stage.textContent = '';
      stage.classList.add('lvx-score-stage');
      for (const phrase of active.phrases) {
        const line = document.createElement('div');
        const lane = score.lanes.find(l => l.id === phrase.laneId);
        line.className = `lvx-score-phrase lvx-score-${lane?.role || 'lead'}`;
        line.dataset.phrase = phrase.id;
        for (const word of phrase.words) {
          const span = document.createElement('span');
          span.className = 'lvx-score-word';
          span.dataset.word = word.id;
          if (word.syllables?.length && (!word.spokenText||word.spokenText===word.text)) {
            for (const syllable of word.syllables) {
              const part = document.createElement('span');
              part.className = 'lvx-score-syllable';
              part.dataset.syllable = syllable.id;
              part.textContent = syllable.text;
              for (const effect of syllable.effects) {
                part.classList.add(`lvx-effect-${effect.type}`);
                part.style.setProperty('--lvx-strength', effect.strength);
              }
              span.appendChild(part);
            }
            span.appendChild(document.createTextNode(/[-\u2010\u2011]$/u.test(word.text) ? '' : ' '));
          } else span.textContent = `${word.text}${/[-\u2010\u2011]$/u.test(word.text) ? '' : ' '}`;
          for (const effect of word.effects) {
            span.classList.add(`lvx-effect-${effect.type}`);
            span.style.setProperty('--lvx-strength', effect.strength);
          }
          line.appendChild(span);
        }
        stage.appendChild(line);
      }
      state.scoreSignature = signature;
    }
    // Authoring outline only while editing, so you can see where to continue a take while scrubbing.
    const takeIds = syncPanel.hidden ? null : takePhraseIds();
    for (const phrase of active.phrases) {
      const line = [...stage.children].find(el => el.dataset.phrase === phrase.id);
      if (!line) continue;
      line.style.opacity = phrase.opacity;
      if (takeIds) { const a = phraseAuthoring(phrase, takeIds); line.dataset.authored = a.level; line.dataset.progress = authoringProgress(a); line.dataset.mixed = String(a.mixed); line.title = AUTHORING_LABELS[a.level]; }
      else { delete line.dataset.authored; delete line.dataset.progress; delete line.dataset.mixed; line.removeAttribute('title'); }
      for (let index = 0; index < phrase.words.length; index++) {
        const word = phrase.words[index];
        const span = line.children[index];
        span.style.visibility = 'visible'; span.classList.toggle('lvx-score-ahead', mediaMs - score.offsetMs < word.startMs);
        const wordCurrent = phrase.activeWords.includes(word.id), wordPresence = LvScore.presenceAt(word, mediaMs - score.offsetMs);
        span.classList.toggle('lvx-score-current', wordCurrent);
        // Recency trail: sung words keep a fading glow so short final syllables stay readable.
        span.style.setProperty('--lvx-presence', wordPresence);
        span.classList.toggle('lvx-score-recent', !wordCurrent && wordPresence > 0);
        applyReveal(span, word, mediaMs - score.offsetMs);
        for (const syllable of word.syllables || []) {
          const part = [...span.children].find(el => el.dataset.syllable === syllable.id);
          if (!part) continue;
          part.style.visibility = 'visible'; part.classList.toggle('lvx-score-ahead', mediaMs - score.offsetMs < syllable.startMs);
          const syllableCurrent = (phrase.activeSyllables || []).includes(syllable.id), syllablePresence = LvScore.presenceAt(syllable, mediaMs - score.offsetMs);
          part.classList.toggle('lvx-score-current', syllableCurrent);
          part.style.setProperty('--lvx-presence', syllablePresence);
          part.classList.toggle('lvx-score-recent', !syllableCurrent && syllablePresence > 0);
          applyReveal(part, syllable, mediaMs - score.offsetMs);
        }
      }
    }
  }

  function applyReveal(node, item, clockMs) {
    if (item.reveal?.type !== 'sweep') { node.style.clipPath = ''; return; }
    const progress = LvScore.revealProgress(item, clockMs);
    node.style.clipPath = `inset(0 ${(100 * (1 - progress)).toFixed(3)}% 0 0)`;
  }

  /* ══════════════════════════════════════
     MEDIA TIME (supports Spotify DOM polling + standard)
     ══════════════════════════════════════ */
  function getMediaTimeMs() {
    // ─── SPOTIFY: ALWAYS use DOM polling, NEVER trust <video>/<audio> elements ───
    // Spotify has hidden media elements (Canvas loops, DRM playback via EME)
    // whose currentTime is WRONG — it loops, freezes, or reports DRM stream time.
    // This was the root cause of blank screens, 2-line loops, and freeze bugs.
    if (state.isSpotify) {
      if (state.spotifyLastPollWall > 0) {
        if (state.spotifyPauseDetected) {
          return state.spotifyCurrentTimeMs;
        }
        const now = performance.now();
        const wallElapsed = now - state.spotifyLastPollWall;
        // Safety cap: if no fresh poll in 5 seconds, don't keep advancing
        if (wallElapsed > 5000) {
          return state.spotifyCurrentTimeMs + 5000;
        }
        return state.spotifyCurrentTimeMs + wallElapsed;
      }
      // Spotify polling hasn't started yet — use fallback
      return state.fallbackMediaStartMs + (performance.now() - state.fallbackStartMs);
    }

    // ─── NON-SPOTIFY: use standard <video>/<audio> element ───
    const media = getMedia();
    if (media && Number.isFinite(media.currentTime) && media.duration > 0) {
      state.playbackRate = media.playbackRate || 1;
      return media.currentTime * 1000;
    }

    // Pure fallback (no media element found)
    return state.fallbackMediaStartMs + (performance.now() - state.fallbackStartMs);
  }

  /* ── Drift tracking: only correct for playback rate deviation, not base offset ── */
  function updateDriftTracking(mediaMs) {
    const now = performance.now();
    if (state.lastWallTime > 0) {
      const wallDelta = now - state.lastWallTime;
      const mediaDelta = mediaMs - state.lastMediaTime;

      // Only track when both are moving forward in a normal range
      if (wallDelta > 50 && wallDelta < 1500 && mediaDelta > 0 && mediaDelta < 1500) {
        const rate = mediaDelta / wallDelta; // actual playback rate
        if (rate > 0.5 && rate < 2.0) {
          state.mediaDriftSamples.push(rate);
          if (state.mediaDriftSamples.length > 20) state.mediaDriftSamples.shift();

          if (state.mediaDriftSamples.length >= 8) {
            const avgRate = state.mediaDriftSamples.reduce((a, b) => a + b, 0) / state.mediaDriftSamples.length;
            // Only adjust if rate is meaningfully different from 1x (>2% deviation)
            if (Math.abs(avgRate - 1.0) > 0.02) {
              state.playbackRate = avgRate;
            }
          }
        }
      }
    }
    state.lastMediaTime = mediaMs;
    state.lastWallTime = now;
  }

  function findActiveIndex(clockMs) {
    const lines = state.lines;
    if (!lines.length || clockMs < lines[0].time - 500) return -1;

    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].time <= clockMs) low = mid + 1;
      else high = mid - 1;
    }

    return Math.max(0, high);
  }

  function shouldClearLine(line, clockMs) {
    if (!line) return true;
    // Hold until 92% of the line duration or at least 900ms
    const hold = Math.max(Math.round(line.duration * 0.92), 900);
    return clockMs > line.time + hold && line.nextTime - line.time > hold + 200;
  }

  /* ══════════════════════════════════════
     RENDERING
     ══════════════════════════════════════ */
  function renderIndex(index, clockMs) {
    const prevIndex = state.currentIndex; // capture BEFORE overwriting (calibration needs it)
    clearMoment();
    
    // Clear any previous error messages when we start successfully rendering
    const errorMsg = stage.querySelector('.lvx-not-available');
    if (errorMsg) {
      errorMsg.remove();
      setHud('Resynced', false, false);
    }

    state.currentIndex = index;
    updatePreview(index);

    if (index < 0) return;
    const line = state.lines[index];
    if (!line || shouldClearLine(line, clockMs)) return;

    /* ── Real-time auto-calibration ──
       Measure how far ahead/behind we are vs the LRC timestamp each time a line renders.
       If we're consistently early or late, gently shift syncOffsetMs to correct it.
       Target: mediaMs should be within ±60ms of line.time when line renders.
       Skips the first line (often instrumental intro) and lines that are re-renders. */
    if (index > 0 && index !== prevIndex && !state.offsetWasRestored) {
      const currentMediaMs = getMediaTimeMs();
      const timingError = currentMediaMs - line.time;
      // timingError < 0 means we're showing line before LRC time (too early)
      // timingError > 0 means we're showing line after LRC time (too late)
      // Ideal range: [-60, +60]ms — if outside this, collect for correction

      state.timingErrors.push(timingError);
      if (state.timingErrors.length > 6) state.timingErrors.shift();

      if (state.timingErrors.length >= 4) {
        const avg = state.timingErrors.reduce((a, b) => a + b, 0) / state.timingErrors.length;
        // Only auto-correct if consistent error > 80ms
        if (Math.abs(avg) > 80) {
          // Shift syncOffsetMs to correct:
          // syncOffsetMs is subtracted from mediaMs to get lyricClockMs
          // lyricClockMs must reach line.time to trigger render
          // If avg timingError < 0 (too early): mediaMs < line.time at render
          //   → need lyricClockMs to be higher → decrease syncOffsetMs (more negative) — wait
          //   Actually: lyricClockMs = mediaMs - syncOffsetMs
          //   Line renders when lyricClockMs >= line.time → mediaMs - syncOffsetMs >= line.time
          //   → mediaMs >= line.time + syncOffsetMs
          //   If avg < 0: mediaMs at render < line.time, meaning syncOffsetMs is too negative
          //   → increase syncOffsetMs (toward 0) to require higher mediaMs before rendering
          const correction = avg * 0.35; // 35% of error, gentle
          const newOffset = clamp(state.syncOffsetMs + correction, -280, 150);
          state.syncOffsetMs = newOffset;
          state.timingErrors = [];
        }
      }
    }

    const moment = document.createElement('div');
    const animClass = line.animation === 'slam' ? '' : `lvx-anim-${line.animation}`;
    moment.className = `lvx-moment lvx-role-${line.role} ${line.composition.layout} ${animClass}`.trim();

    const revealQueue = [];
    line.composition.layers.forEach((layer) => {
      revealQueue.push(...addTextLayer(moment, layer.text, layer.kind));
    });

    stage.appendChild(moment);
    fitMoment(moment);
    state.currentMoment = moment;

    /* PULSE: apply "drop" class to the moment if this line follows a big gap */
    if (state.theme === 'pulse') {
      pulseApplyDrop(moment, line, index);
    }

    revealWords(revealQueue, line);
  }

  function addTextLayer(moment, text, kind) {
    const layer = document.createElement('div');
    layer.className = `lvx-text lvx-${kind}`;
    layer.style.fontSize = `${estimateFontSize(text, kind)}px`;

    const spans = [];
    splitRows(text, kind).forEach((row) => {
      const rowEl = document.createElement('span');
      rowEl.className = 'lvx-word-row';
      row.forEach((word) => {
        const span = document.createElement('span');
        span.className = 'lvx-word';
        span.textContent = word.toUpperCase();
        spans.push(span);
        rowEl.appendChild(span);
      });
      layer.appendChild(rowEl);
    });

    moment.appendChild(layer);
    return spans;
  }

  function revealWords(spans, line) {
    const total = spans.length;
    if (!total) return;

    const wordCount = total;
    const duration = line.duration || 3000;
    const wordsPerSec = wordCount / (duration / 1000);

    let step;

    if (wordCount <= 2) {
      step = 55;
    } else if (wordsPerSec > 4) {
      // Rap / fast: tight stagger but all words visible before line ends
      step = clamp(duration * 0.45 / (wordCount - 1), 25, 70);
    } else if (wordsPerSec > 2) {
      // Normal pop/rock
      step = clamp(duration * 0.50 / (wordCount - 1), 55, 160);
    } else {
      // Slow ballad: spacious but still spread within the line
      step = clamp(duration * 0.55 / (wordCount - 1), 90, 260);
    }

    // First word at 0ms — appears exactly when line triggers (at LRC timestamp)
    // Subsequent words cascade from there
    const isPulse = state.theme === 'pulse';
    const wordDurMs = isPulse ? (duration / Math.max(1, wordCount)) : 0;
    const isPunchLine = isPulse && (line.role === 'punch' || wordCount <= 3);
    spans.forEach((span, index) => {
      state.revealTimers.push(setTimeout(() => {
        span.classList.add('lvx-in');
        if (isPulse) pulseDecorateWord(span, wordDurMs, isPunchLine);
      }, index * step));
    });
  }

  /* ── Next-line preview: faint upcoming lyric at the bottom of the screen ── */
  function updatePreview(index) {
    const next = index >= 0 ? state.lines[index + 1] : state.lines[0];
    preview.textContent = next ? next.text : '';
  }

  function clearMoment() {
    clearRevealTimers();
    if (!state.currentMoment) return;

    const old = state.currentMoment;
    state.currentMoment = null;
    old.classList.add('lvx-out');
    setTimeout(() => old.remove(), 160);
  }

  function clearRevealTimers() {
    state.revealTimers.forEach(clearTimeout);
    state.revealTimers = [];
  }

  /* ══════════════════════════════════════
     TEXT SIZING & LAYOUT
     ══════════════════════════════════════ */
  function splitRows(text, kind) {
    const list = words(text);
    if (list.length <= 1) return list.length ? [list] : [];

    const joined = list.join(' ');
    let rowCount = 1;
    if (kind === 'support') {
      rowCount = joined.length > 34 || list.length > 6 ? 2 : 1;
    } else if (kind === 'tag') {
      rowCount = joined.length > 18 || list.length > 4 ? 2 : 1;
    } else if (joined.length > 42 || list.length > 8) {
      rowCount = 3;
    } else if (joined.length > 17 || list.length > 4) {
      rowCount = 2;
    }

    rowCount = clamp(rowCount, 1, Math.min(3, list.length));
    const rows = [];
    let index = 0;
    for (let row = 0; row < rowCount; row++) {
      const remainingRows = rowCount - row;
      const remainingWords = list.length - index;
      const take = Math.ceil(remainingWords / remainingRows);
      rows.push(list.slice(index, index + take));
      index += take;
    }
    return rows;
  }

  function estimateFontSize(text, kind) {
    const length = String(text || '').length;
    const wc = words(text).length;
    let size;

    if (kind === 'support') {
      size = length <= 18 ? 62 : length <= 36 ? 54 : 46;
    } else if (kind === 'tag') {
      size = length <= 16 ? 72 : 60;
    } else if (kind === 'punch') {
      if (wc <= 2 || length <= 10) size = 166;
      else if (length <= 22) size = 148;
      else if (length <= 40) size = 118;
      else size = 94;
    } else {
      if (length <= 12) size = 150;
      else if (length <= 24) size = 126;
      else if (length <= 42) size = 100;
      else size = 82;
    }

    return Math.round(size * state.fontScale);
  }

  function fitMoment(moment) {
    [...moment.querySelectorAll('.lvx-text')].forEach((layer) => fitLayer(layer));
  }

  function fitLayer(layer) {
    let size = parseFloat(layer.style.fontSize) || 82;
    const minSize = layer.classList.contains('lvx-support') ? 26 : 36;
    const maxHeight = parseFloat(getComputedStyle(layer).maxHeight) || window.innerHeight * 0.42;

    for (let i = 0; i < 36; i++) {
      const box = layer.getBoundingClientRect();
      const parentWidth = layer.clientWidth || box.width;
      if (layer.scrollWidth <= parentWidth + 2 && layer.scrollHeight <= maxHeight + 2) break;
      size -= 3;
      if (size <= minSize) {
        size = minSize;
        break;
      }
      layer.style.fontSize = `${size}px`;
    }
  }

  /* ══════════════════════════════════════
     KEYBOARD CONTROLS
     ══════════════════════════════════════ */
  function handleKeys(event) {
    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || (target && target.isContentEditable)) return;

    /* Esc closes shortcuts panel first; if panel is closed, Esc closes the overlay */
    if (event.key === 'Escape' && root.isConnected && root.classList.contains('lvx-active')) {
      event.preventDefault();
      if (!syncPanel.hidden) { closeTimingReview(); return; }
      if (shortcutsPanel.classList.contains('lvx-shortcuts-open')) {
        toggleShortcutsPanel(false);
        return;
      }
      try { chrome.runtime?.sendMessage({ type: 'LV_CONTENT_STOP' }).catch(() => {}); } catch (_) {}
      teardown();
      return;
    }

    /* ?/H toggle shortcuts panel — works even on the error screen */
    if ((event.key === '?' || event.key === 'h' || event.key === 'H') && root.isConnected && root.classList.contains('lvx-active')) {
      event.preventDefault();
      toggleShortcutsPanel();
      return;
    }

    if (!state.active) return;

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      cycleTheme(event.shiftKey ? -1 : 1);
    }

    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      if (timing.draft) return;
      nudgeSync(event.key === '[' ? -SYNC_NUDGE_MS : SYNC_NUDGE_MS);
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setFontScale(state.fontScale + 0.1);
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      setFontScale(state.fontScale - 0.1);
    }

    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      toggleLiteMode();
    }
  }

  function handleTapKeys(event) {
    if (!root.isConnected || syncPanel.hidden) return;
    if (event.type==='keydown' && event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft','ArrowRight'].includes(event.key) && tapping.take?.marks.length && tapping.take.status!=='armed' && !event.target?.matches?.('input,textarea,select') && !event.target?.isContentEditable) {
      event.preventDefault();event.stopImmediatePropagation();correctMark((event.key==='ArrowLeft'?-1:1)*(event.shiftKey?50:10));return;
    }
    const space = event.code === 'Space' || event.key === ' ';
    const inputTarget=event.target?.matches?.('input,textarea,select')||event.target?.isContentEditable;
    // F flags the phrase just performed (and keeps YouTube's fullscreen shortcut away while Sync is open).
    if((event.key==='t'||event.key==='T')&&!inputTarget&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&state.score){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat)void tapTempo();
      return;
    }
    if((event.key==='f'||event.key==='F')&&!inputTarget&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&timing.draft){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat)void flagPhraseForRetime();
      return;
    }
    // Free-tap syllables (and phrase syllable takes): Left removes the last tap, like Undo mark.
    if(tapping.take?.status==='armed'&&(eventTake(tapping.take)||tapping.take.mode==='syllable'&&tapping.take.cadence==='entrances')&&!inputTarget&&!event.altKey&&!event.metaKey&&!event.ctrlKey&&event.key==='ArrowLeft'){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat&&tapCount(tapping.take)){
        tapping.take=eventTake(tapping.take)?LvTapTiming.undoEvent(tapping.take):LvTapTiming.undo(tapping.take);
        state.scoreSignature='';refreshTimingPanel();renderScore(getMediaTimeMs());setSyncNotice(`Last tap removed · ${tapCount(tapping.take)} remain. Keep tapping.`);
      }
      return;
    }
    if(wordTake(tapping.take)&&tapping.take.status==='armed'&&!inputTarget&&!event.altKey&&!event.metaKey&&!event.ctrlKey&&['ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat)skipWordHold(event.key==='ArrowLeft'?-1:1);
      return;
    }
    if(streamTake(tapping.take)&&tapping.take.status==='armed'&&!inputTarget&&!event.altKey&&!event.metaKey&&['ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat)recoverStream(event.key==='ArrowLeft'?-1:1,event.ctrlKey);
      return;
    }
    if(tapping.take&&['armed','complete'].includes(tapping.take.status)&&!getMedia()?.paused&&tapping.take.mode!=='syllable'&&!inputTarget&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='keydown'&&!event.repeat)repositionTap(event.key==='ArrowLeft'?backTarget(tapping.take):tapping.take.index+1);
      return;
    }
    // Finish a press we own even if focus or modifier state changed while held.
    if (space && event.type === 'keyup' && (tapping.heldInput === 'keyboard'||tapping.cancelledSpace)) {
      event.preventDefault(); event.stopImmediatePropagation(); if(!tapping.cancelledSpace)markTapTime({release:true}); tapping.heldInput = null;tapping.cancelledSpace=false; return;
    }
    const target = event.target;
    if (target?.matches?.('input,textarea,select') || target?.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
    // Enter activates an explicitly focused review control, even during a take.
    // Keep it away from YouTube shortcuts without canceling button activation.
    if(event.key==='Enter'&&target?.closest?.('button')&&syncPanel.contains(target)){event.stopImmediatePropagation();return;}
    const effect = {'1':'pulse','2':'tilt','3':'shake','0':'clear'}[event.key];
    if (performanceTake.armed && effect) {
      event.preventDefault(); event.stopImmediatePropagation(); if (event.type === 'keydown') markEffect(effect,event); return;
    }
    if (tapping.take?.status !== 'armed' || !(space || event.key === 'Enter')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'keydown' || event.repeat) return;
    if (wordTake(tapping.take)) {
      if (!space || tapping.heldInput || tapping.cancelledSpace || tapping.take.pendingStartMs !== null) return;
      markTapTime();
      if (tapping.take?.status === 'armed' && tapping.take.pendingStartMs !== null) tapping.heldInput = 'keyboard';
      return;
    }
    if (tapping.take.mode === 'syllable') { if (space) markTapTime({shiftKey:event.shiftKey}); return; }
    if (syncButton('tap-cadence').value === 'hold' && space) {
      if (tapping.heldInput || tapping.cancelledSpace || tapping.take.pendingStartMs !== null || event.shiftKey) return;
      markTapTime();
      if (tapping.take?.status === 'armed' && tapping.take.pendingStartMs !== null) tapping.heldInput = 'keyboard';
      return;
    }
    markTapTime({shiftKey:event.shiftKey,release:event.key === 'Enter'});
  }

  function setFontScale(scale) {
    state.fontScale = clamp(Math.round(scale * 10) / 10, 0.6, 1.6);
    stage.style.setProperty('--lvx-score-scale', state.fontScale);
    try { chrome.storage.local.set({ lvxFontScale: state.fontScale }); } catch (_) {}
    setHud(`Text size ${Math.round(state.fontScale * 100)}%  (+ / - to adjust)`);
    // Re-render the current line at the new size
    state.currentIndex = -999;
  }

  function toggleLiteMode() {
    state.liteMode = !state.liteMode;
    root.classList.toggle('lvx-lite', state.liteMode);
    try { chrome.storage.local.set({ lvxLiteMode: state.liteMode }); } catch (_) {}
    setHud(state.liteMode
      ? 'See-through mode ON — video visible behind lyrics (B)'
      : 'See-through mode OFF (B)');
  }

  function toggleShortcutsPanel(forceState) {
    const isOpen = shortcutsPanel.classList.contains('lvx-shortcuts-open');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;
    clearTimeout(shortcutsAutoHideTimer);
    if (shouldOpen) {
      shortcutsPanel.classList.add('lvx-shortcuts-open');
      helpButton.classList.add('lvx-help-active');
      shortcutsAutoHideTimer = setTimeout(() => toggleShortcutsPanel(false), 8000);
    } else {
      shortcutsPanel.classList.remove('lvx-shortcuts-open');
      helpButton.classList.remove('lvx-help-active');
    }
  }

  function nudgeSync(deltaMs) {
    setSyncOffset(state.syncOffsetMs + deltaMs);
  }

  function setSyncOffset(offsetMs) {
    if (!Number.isSafeInteger(offsetMs) || offsetMs === state.syncOffsetMs) return;
    if (state.score) {
      chrome.runtime.sendMessage({ type: 'LV_SCORE_OPERATION', mediaKey: LvScore.mediaKey(state.score.source), expectedRevision: state.score.revision, operation: { type: 'setOffset', offsetMs } }).then(result => {
        if (!result?.ok) setHud(result?.error?.message || 'Timing edit failed', true, true);
      }).catch(() => {});
      return;
    }
    state.syncOffsetMs = offsetMs;
    state.baseOffsetMs = state.syncOffsetMs; // anchor to manual nudge
    state.timingErrors = [];                 // clear calibration history
    state.autoCalibrated = true;             // stop auto-calibration fighting the user
    state.offsetWasRestored = true;
    state.syncPreferenceVersion += 1;
    setHud(`Sync offset ${formatOffset(state.syncOffsetMs)}  ([ earlier / ] later) · saved for this song`);
    state.currentIndex = -999;

    // Remember this song's offset so it's perfect next time
    if (state.trackKey) {
      try {
        chrome.storage.local.set({ [`lvxOffset:${state.trackKey}`]: state.syncOffsetMs });
      } catch (_) {}
    }
  }

  /**
   * Automatic timing recovery for one song. It removes only that song's
   * manual nudge, reapplies the pace-aware baseline, and enables the existing
   * live calibration path to fine-tune later lyric transitions.
   */
  function quickSyncLyrics() {
    if (state.score) {
      openTimingReview();
      return;
    }
    if (!state.active || !state.lines.length) {
      setHud('Auto Sync needs active lyrics first', true, false);
      return;
    }

    const tempoOffset = Number.isFinite(state.detectedSyncOffsetMs)
      ? state.detectedSyncOffsetMs
      : computeAdaptiveSyncOffset(state.lines);

    state.syncPreferenceVersion += 1;
    state.syncOffsetMs = tempoOffset;
    state.baseOffsetMs = tempoOffset;
    state.timingErrors = [];
    state.spotifyAutoCalibSamples = [];
    state.mediaDriftSamples = [];
    state.autoCalibrated = false;
    state.offsetWasRestored = false;
    state.currentIndex = -999;
    clearMoment();

    if (state.theme === 'flow') {
      state._flowLastIndex = -999;
    }

    if (state.trackKey) {
      try { chrome.storage.local.remove(`lvxOffset:${state.trackKey}`); } catch (_) {}
    }

    setHud(`Auto Sync reset · pace-aware offset ${formatOffset(tempoOffset)} · recalibrating`);
  }

  function trackStorageKey(track) {
    const t = String(track.title || '').toLowerCase().trim();
    const a = String(track.artist || '').toLowerCase().trim();
    return t ? `${a}|${t}` : '';
  }

  function pulse() {
    // Subtle smooth glow — no red flash
    stage.classList.remove('lvx-hit');
    void stage.offsetWidth;
    stage.classList.add('lvx-hit');
    setTimeout(() => stage.classList.remove('lvx-hit'), 300);
  }


  /* ══════════════════════════════════════
     FLOW THEME — TELEPROMPTER LYRICS FOLLOWER
     ══════════════════════════════════════
     Renders a smooth scrolling teleprompter with per-word
     highlighting. Designed for learning/following along.

     Line stack (vertically centered):
       line -2/-1: readable previous context
       current:    focus line in the middle
       line +1/+2: readable upcoming context

     Word states in current line:
       upcoming  → soft cream text
       active    → softly glowing cream text
       done      → slightly dimmer cream text

     Data: reuses state.lines[] from prepareLines().
     Timing: reuses the same step formula from revealWords().
     ══════════════════════════════════════ */

  /**
   * Initialize FLOW DOM: create the 5-line container inside stage.
   * Called when switching to flow or when lyrics load while flow is active.
   */
  function flowInit() {
    flowTeardown(); // clean up any previous instance
    clearMoment();  // remove any existing kinetic moment

    const container = document.createElement('div');
    container.className = 'lvx-flow-container';

    // Seven slots buffer the visible five. The hidden top/bottom slots let
    // each lyric physically travel up the screen instead of being replaced.
    for (let i = -3; i <= 3; i++) {
      const lineEl = document.createElement('div');
      lineEl.className = 'lvx-flow-line';
      lineEl.dataset.flowPos = String(i);
      container.appendChild(lineEl);
    }

    stage.appendChild(container);
    state._flowContainer = container;
    state._flowSlots = Array.from(container.querySelectorAll('.lvx-flow-line'));
    state._flowTransitioning = false;
    state._flowLastIndex = -999; // force rebuild on first render
  }

  /**
   * Tear down FLOW DOM. Safe to call even if flow wasn't initialized.
   */
  function flowTeardown() {
    if (state._flowRecycleTimer) {
      clearTimeout(state._flowRecycleTimer);
      state._flowRecycleTimer = 0;
    }
    if (state._flowContainer) {
      state._flowContainer.remove();
      state._flowContainer = null;
    }
    state._flowSlots = null;
    state._flowTransitioning = false;
    state._flowLastIndex = -999;
  }

  const FLOW_SLOT_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
  const FLOW_SCROLL_MS = 620;

  /**
   * Keep a Flow lyric on one clean line. Short lyrics use the larger visual
   * scale; only unusually long lines are reduced enough to stay in the frame.
   */
  function flowFitLine(lineEl, text, position) {
    if (!lineEl || !text) {
      lineEl?.style.removeProperty('--lvx-flow-fit-size');
      return;
    }

    const viewportWidth = Math.max(320, window.innerWidth || 1280);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const compact = viewportWidth <= 760;
    const distance = Math.abs(position);
    let baseSize;
    let minSize;

    if (position === 0) {
      baseSize = compact
        ? clamp(viewportWidth * 0.084, 2.15 * rem, 4.1 * rem)
        : clamp(viewportWidth * 0.052, 2.55 * rem, 6.2 * rem);
      minSize = compact ? 1.7 * rem : 1.35 * rem;
    } else if (distance === 1) {
      baseSize = compact
        ? clamp(viewportWidth * 0.049, 1.2 * rem, 2 * rem)
        : clamp(viewportWidth * 0.0345, 1.75 * rem, 4.1 * rem);
      minSize = compact ? 0.9 * rem : 1.05 * rem;
    } else {
      baseSize = compact
        ? clamp(viewportWidth * 0.035, 0.95 * rem, 1.45 * rem)
        : clamp(viewportWidth * 0.0255, 1.35 * rem, 3 * rem);
      minSize = compact ? 0.72 * rem : 0.85 * rem;
    }

    const canvas = state._flowMeasureCanvas || (state._flowMeasureCanvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    if (!context) return;

    context.font = `700 ${baseSize}px "DM Sans", Arial, sans-serif`;
    const wordsInLine = text.trim().split(/\s+/).filter(Boolean).length;
    const currentWordSpacing = position === 0 ? Math.max(0, wordsInLine - 1) * baseSize * 0.12 : 0;
    const measuredWidth = context.measureText(text).width + currentWordSpacing + 12;
    const availableWidth = Math.min(viewportWidth * 0.90, 1720);
    const fittedSize = clamp(baseSize * Math.min(1, availableWidth / Math.max(measuredWidth, 1)), minSize, baseSize);

    lineEl.style.setProperty('--lvx-flow-fit-size', `${Math.floor(fittedSize)}px`);
  }

  function flowFitAllSlots() {
    (state._flowSlots || []).forEach((lineEl) => {
      const lineIndex = Number(lineEl.dataset.flowLineIndex);
      const line = state.lines[lineIndex];
      flowFitLine(lineEl, line ? line.text : '', Number(lineEl.dataset.flowPos));
    });
  }

  /**
   * Fill one physical slot with a lyric and assign its vertical position.
   * The element is retained between lines so CSS can animate it smoothly.
   */
  function flowSetSlot(lineEl, lineIndex, position) {
    if (!lineEl) return;

    lineEl.dataset.flowPos = String(position);
    lineEl.dataset.flowLineIndex = String(lineIndex);

    const line = lineIndex >= 0 && lineIndex < state.lines.length
      ? state.lines[lineIndex]
      : null;

    if (!line) {
      lineEl.textContent = '';
      lineEl.style.visibility = 'hidden';
      lineEl.style.removeProperty('--lvx-flow-fit-size');
      return;
    }

    lineEl.style.visibility = 'visible';
    if (position === 0) {
      flowBuildWordSpans(lineEl, line.text);
    } else {
      lineEl.textContent = line.text;
    }
    flowFitLine(lineEl, line.text, position);
  }

  /** Place all slots without animation, used for first render and seeking. */
  function flowSetStatic(activeIndex) {
    const container = state._flowContainer;
    const slots = state._flowSlots || [];
    if (!container || !slots.length) return;

    if (state._flowRecycleTimer) {
      clearTimeout(state._flowRecycleTimer);
      state._flowRecycleTimer = 0;
    }

    container.classList.add('lvx-flow-snap');
    slots.forEach((lineEl, slotIndex) => {
      const offset = FLOW_SLOT_OFFSETS[slotIndex];
      flowSetSlot(lineEl, activeIndex + offset, offset);
    });
    void container.offsetWidth; // commit the static positions before animating later
    container.classList.remove('lvx-flow-snap');
    state._flowTransitioning = false;
  }

  /**
   * Advance every physical slot one position upward. The future buffer enters
   * through the bottom and the exited top slot is recycled after it is hidden.
   */
  function flowAdvance(previousIndex, nextIndex) {
    const container = state._flowContainer;
    const slots = state._flowSlots || [];
    if (!container || !slots.length) return;

    const outgoing = slots.find((lineEl) => Number(lineEl.dataset.flowPos) === -3);
    if (!outgoing) {
      flowSetStatic(nextIndex);
      return;
    }

    slots.forEach((lineEl) => {
      const oldPosition = Number(lineEl.dataset.flowPos);
      const lineIndex = Number(lineEl.dataset.flowLineIndex);
      flowSetSlot(lineEl, lineIndex, oldPosition - 1);
    });

    state._flowTransitioning = true;
    state._flowRecycleTimer = setTimeout(() => {
      if (!state._flowContainer || state._flowLastIndex !== nextIndex) return;
      // Teleport the departed line back below the stage while it is fully
      // transparent, so the next upward movement always begins cleanly.
      container.classList.add('lvx-flow-snap');
      flowSetSlot(outgoing, nextIndex + 3, 3);
      void outgoing.offsetWidth;
      container.classList.remove('lvx-flow-snap');
      state._flowTransitioning = false;
      state._flowRecycleTimer = 0;
    }, FLOW_SCROLL_MS);
  }

  /**
   * Compute which word is active using the same step formula as revealWords.
   * @param {Object} line - prepared line object with .text, .duration
   * @param {number} clockMs - current lyric clock time
   * @returns {number} word index (0-based), or -1 if before line start
   */
  function flowWordIndex(line, clockMs) {
    if (!line) return -1;
    const elapsed = clockMs - line.time;
    if (elapsed < 0) return -1;

    const lineWords = line.text.split(/\s+/).filter(Boolean);
    const wordCount = lineWords.length;
    if (wordCount <= 0) return -1;
    if (wordCount === 1) return 0;

    const duration = line.duration || 3000;
    const wordsPerSec = wordCount / (duration / 1000);

    let step;
    if (wordCount <= 2) {
      step = 55;
    } else if (wordsPerSec > 4) {
      step = clamp(duration * 0.45 / (wordCount - 1), 25, 70);
    } else if (wordsPerSec > 2) {
      step = clamp(duration * 0.50 / (wordCount - 1), 55, 160);
    } else {
      step = clamp(duration * 0.55 / (wordCount - 1), 90, 260);
    }

    return clamp(Math.floor(elapsed / step), 0, wordCount - 1);
  }

  /**
   * Main FLOW render function. Called every RAF frame when theme === 'flow'.
   * @param {number} activeIndex - current line index from findActiveIndex
   * @param {number} clockMs - lyric clock time (ms)
   */
  function flowRender(activeIndex, clockMs) {
    // Lazy init: create container if it doesn't exist yet
    if (!state._flowContainer) {
      if (!state.lines.length) return;
      flowInit();
    }

    const lines = state.lines;
    const previousIndex = state._flowLastIndex;

    // Move each physical slot upward for a normal next-line transition.
    // Seeks, backwards jumps, and very fast changes settle cleanly in place.
    if (activeIndex !== state._flowLastIndex) {
      state._flowLastIndex = activeIndex;
      const isSequential = previousIndex >= 0 && activeIndex === previousIndex + 1;
      if (isSequential && !state._flowTransitioning) {
        flowAdvance(previousIndex, activeIndex);
      } else {
        flowSetStatic(activeIndex);
      }
    }

    // ── Per-frame: update word highlighting in the centered physical slot ──
    const currentLineEl = state._flowContainer.querySelector('.lvx-flow-line[data-flow-pos="0"]');
    if (!currentLineEl || activeIndex < 0 || activeIndex >= lines.length) return;

    const currentLine = lines[activeIndex];
    const wordIdx = flowWordIndex(currentLine, clockMs);
    const wordSpans = currentLineEl.querySelectorAll('.lvx-flow-word');

    wordSpans.forEach((span, i) => {
      span.classList.remove('lvx-flow-upcoming', 'lvx-flow-active', 'lvx-flow-done');
      if (i < wordIdx) {
        span.classList.add('lvx-flow-done');
      } else if (i === wordIdx) {
        span.classList.add('lvx-flow-active');
      } else {
        span.classList.add('lvx-flow-upcoming');
      }
    });
  }

  /**
   * Build word <span> elements inside a line element for per-word highlighting.
   * @param {HTMLElement} lineEl - the .lvx-flow-line container
   * @param {string} text - raw line text
   */
  function flowBuildWordSpans(lineEl, text) {
    lineEl.textContent = ''; // clear
    const words = text.split(/\s+/).filter(Boolean);
    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'lvx-flow-word lvx-flow-upcoming';
      span.textContent = word;
      lineEl.appendChild(span);
      if (i < words.length - 1) {
        lineEl.appendChild(document.createTextNode(' '));
      }
    });
  }

  /* ══════════════════════════════════════
     PULSE THEME — HEURISTIC KINETIC TYPOGRAPHY
     ══════════════════════════════════════
     Detects text patterns to apply kinetic-typography CSS classes.
     Only called when state.theme === 'pulse'. All visual effects
     are CSS-driven (see content.css PULSE section). JS only
     calculates which classes to apply per word/moment.

     Heuristics (operate on the UPPERCASED text in each span):
     1. ELONGATED — 3+ repeated trailing chars (e.g. "YEAHHHHH")
        → .lvx-pulse-elongated with --lvx-pulse-dur set to word duration
     2. EMPHASIS  — word is ALL-CAPS with ≥2 unique letters, or ends with "!"
        → .lvx-pulse-emphasis (fast punch-in pop)
        Note: since addTextLayer uppercases ALL words, we detect emphasis
        via line role ('punch') or word ending in '!' instead.
     3. SUSTAIN   — word displayed for >800ms (slow line, few words)
        → .lvx-pulse-sustain (breathing scale loop)
     4. DROP      — gap before this line is >2× the song's average gap
        → .lvx-pulse-drop on the moment (bigger entrance)
     ══════════════════════════════════════ */

  /** Regex: word ending with 3+ of the same character (e.g. YEAHHHHH, OHHH, NOOO) */
  const PULSE_ELONGATED_RE = /(.)(\1{2,})$/;

  /**
   * Decorate a single word span with PULSE CSS classes.
   * Called inside the revealWords setTimeout, after lvx-in is added.
   * @param {HTMLElement} span - the .lvx-word span
   * @param {number} wordDurMs - estimated ms this word is displayed
   */
  function pulseDecorateWord(span, wordDurMs, isPunchLine) {
    const text = span.textContent || '';

    // 1. Elongated word detection (e.g. YEAHHHHH, OHHH, NOOO)
    if (PULSE_ELONGATED_RE.test(text)) {
      span.classList.add('lvx-pulse-elongated');
      // Set animation duration to match how long this word is displayed
      span.style.setProperty('--lvx-pulse-dur', `${clamp(wordDurMs, 300, 3000)}ms`);
    }

    // 2. Emphasis: words ending with '!' get a punch-in pop
    //    (ALL-CAPS detection is unreliable since addTextLayer uppercases everything,
    //     so we rely on '!' suffix and short word length as emphasis signals)
    if (isPunchLine || text.endsWith('!') || (text.length <= 3 && text.length >= 1 && /^[A-Z]+$/.test(text))) {
      span.classList.add('lvx-pulse-emphasis');
    }

    // 3. Sustain: word displayed for a long time → breathing pulse
    if (wordDurMs > 800) {
      span.classList.add('lvx-pulse-sustain');
    }
  }

  /**
   * Apply "drop" class to a moment if this line follows a gap
   * significantly longer than the song's average inter-line gap.
   * This simulates a "drop" moment after an instrumental break.
   * @param {HTMLElement} moment - the .lvx-moment div
   * @param {Object} line - the prepared line object
   * @param {number} index - line index in state.lines
   */
  function pulseApplyDrop(moment, line, index) {
    if (index <= 0) return; // first line can't have a preceding gap

    const lines = state.lines;
    const prevLine = lines[index - 1];
    if (!prevLine) return;

    // Compute the gap between previous line's end and this line's start
    const gapBefore = line.time - prevLine.nextTime;
    if (gapBefore <= 0) return; // lines overlap or are contiguous

    // Compute average gap across the song (cached on first call per song)
    if (!state._pulseAvgGap) {
      let totalGap = 0;
      let gapCount = 0;
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i].time - lines[i - 1].nextTime;
        if (g > 0) { totalGap += g; gapCount++; }
      }
      state._pulseAvgGap = gapCount > 0 ? totalGap / gapCount : 2000;
    }

    // If gap before this line is >2× average, it's a "drop" moment
    if (gapBefore > state._pulseAvgGap * 2 && gapBefore > 1500) {
      moment.classList.add('lvx-pulse-drop');
    }
  }

  /* ══════════════════════════════════════
     THEME MANAGEMENT
     ══════════════════════════════════════ */
  function applyTheme(name) {
    const wasFlow = state.theme === 'flow';
    state.theme = name;
    if (wasFlow && name !== 'flow') flowTeardown();
    if (name === 'flow' && state.active && state.lines.length) flowInit();
    if (name === 'samay') {
      root.removeAttribute('data-lvx-theme');
    } else {
      root.setAttribute('data-lvx-theme', name);
    }
    themeButton.textContent = THEME_LABELS[name] || name.toUpperCase();
    try {
      chrome.storage.local.set({ lvxTheme: name });
    } catch (_) {}
  }

  function cycleTheme(direction = 1) {
    const idx = THEMES.indexOf(state.theme);
    const next = THEMES[(idx + direction + THEMES.length) % THEMES.length];
    applyTheme(next);
    setHud(`Theme: ${THEME_LABELS[next]}  (T next · Shift+T back)`, false, false);
  }

  /* ══════════════════════════════════════
     TEARDOWN / SHOW
     ══════════════════════════════════════ */
  function teardown() {
    if (tapping.audio) { tapping.audio.close().catch(() => {}); tapping.audio = null; }
    syncPanel.hidden = true; discardTimingLocal();
    flowTeardown();
    clearRevealTimers();
    cancelLoop();
    stopSpotifyPolling();
    state.active = false;
    state.errorShown = false;
    state.currentIndex = -1;
    state.currentMoment = null;
    state.timingErrors = [];
    state.autoCalibrated = false;
    state.spotifyPauseDetected = false;
    state.spotifyNullCount = 0;
    state.spotifyLastGoodWall = 0;
    state.spotifyAutoCalibSamples = [];
    root.classList.remove('lvx-active');
    stage.textContent = '';
    preview.textContent = '';
    progressFill.style.width = '0%';
    toggleShortcutsPanel(false);
    root.remove();
  }

  function show() {
    if (!root.isConnected) {
      root.append(stage, preview, progress, hud, shortcutsPanel);
      mountRoot();
    }
  }

  function setHud(text, isError = false, sticky = false, isWarning = false) {
    show();
    hud.classList.toggle('lvx-error', isError);
    hud.classList.toggle('lvx-warning', isWarning && !isError);
    hud.classList.remove('lvx-dim');
    if (isWarning && !isError) {
      hudLabel.textContent = 'LYRICVIBE WARNING';
    } else {
      hudLabel.textContent = isError ? 'LYRICVIBE ERROR' : 'LYRICVIBE';
    }
    hudText.textContent = text;
    if (document.activeElement !== offsetInput && !offsetWheelTimer) offsetInput.value = String(state.syncOffsetMs);
    clearTimeout(state.hudTimer);
    if (!sticky) {
      state.hudTimer = setTimeout(() => hud.classList.add('lvx-dim'), 3400);
    }
  }

  /* ══════════════════════════════════════
     UTILITY HELPERS
     ══════════════════════════════════════ */
  function trimWords(text, maxWords) {
    const list = words(text);
    if (list.length <= maxWords) return cleanText(text);
    return list.slice(0, maxWords).join(' ');
  }

  function tailWords(text, count) {
    return words(text).slice(-count).join(' ');
  }

  function formatOffset(ms) {
    return `${ms > 0 ? '+' : ''}${Math.round(ms)}ms`;
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u200b/g, '')
      .trim();
  }

  function normalize(text) {
    return cleanText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(text) {
    return cleanText(text).split(/\s+/).filter(Boolean);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
