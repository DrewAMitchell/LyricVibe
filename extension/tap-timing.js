/* Immutable source-time tap take state machine for word or syllable timing. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTapTiming = api;
})(globalThis, function() {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const integerTime = n => Number.isSafeInteger(n) && n >= 0;

  // Lead-in guidance is derived from source-media time so pause, seek, and
  // playback-rate changes are handled by the caller's current media clock.
  function leadInProgress(nowMs, startMs, leadInMs) {
    if (![nowMs, startMs, leadInMs].every(Number.isFinite) || leadInMs < 0) {
      fail('INVALID_LEAD_IN', 'Lead-in times must be finite and the duration cannot be negative.');
    }
    const remainingMs = Math.max(0, startMs - nowMs);
    const progress = leadInMs === 0 ? 1 : Math.max(0, Math.min(1, (leadInMs - remainingMs) / leadInMs));
    return { remainingMs, progress };
  }

  function captureProgress(take, phrase, offsetMs = 0) {
    if (!take || typeof take !== 'object' || !phrase || typeof phrase !== 'object' ||
        !Number.isFinite(offsetMs)) return { phraseRecorded: false, wordIds: [], eventCount: 0 };
    const words = Array.isArray(phrase.words) ? phrase.words.filter(word => word && !word.excluded) : [];
    const wordIds = new Set(words.map(word => word.id).filter(id => typeof id === 'string'));
    const recordedWords = new Set();
    let eventCount = 0;
    if (take.mode === 'phrase') {
      const marks = Array.isArray(take.marks) ? take.marks : [];
      const recorded = marks.some(mark => mark && mark.id === phrase.id);
      return { phraseRecorded: recorded, wordIds: recorded ? words.map(word => word.id).filter(id => typeof id === 'string') : [], eventCount: recorded ? 1 : 0 };
    }
    if (Array.isArray(take.holds)) {
      for (const hold of take.holds) {
        if (!hold || hold.phraseId !== phrase.id || !wordIds.has(hold.wordId)) continue;
        recordedWords.add(hold.wordId);
        eventCount++;
      }
      return { phraseRecorded: eventCount > 0, wordIds: [...recordedWords], eventCount };
    }
    if (take.cadence === 'performance-events' || Array.isArray(take.events)) {
      const startMs = phrase.startMs + offsetMs, endMs = phrase.endMs + offsetMs;
      const events = Array.isArray(take.events) ? take.events : [];
      eventCount = events.filter(event => event && Number.isFinite(event.sourceMs) &&
        event.sourceMs >= startMs && event.sourceMs < endMs).length;
      return { phraseRecorded: eventCount > 0, wordIds: [], eventCount };
    }
    const marks = Array.isArray(take.marks) ? take.marks : [];
    for (const mark of marks) {
      if (!mark) continue;
      if (wordIds.has(mark.wordId) && (mark.phraseId === undefined || mark.phraseId === phrase.id)) {
        recordedWords.add(mark.wordId);
        eventCount++;
      }
    }
    return { phraseRecorded: eventCount > 0, wordIds: [...recordedWords], eventCount };
  }

  function begin(units, options = {}) {
    if (!Array.isArray(units) || units.length === 0) fail('INVALID_UNITS', 'Provide at least one timing unit.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Timing options must be an object.');
    const mode = options.mode === undefined ? 'word' : options.mode;
    if (mode !== 'word' && mode !== 'phrase' && mode !== 'syllable') fail('INVALID_MODE', 'Mode must be word, phrase, or syllable.');
    const cadence = options.cadence === undefined ? 'pairs' : options.cadence;
    if (cadence !== 'pairs' && cadence !== 'flow' && cadence !== 'subdivide' && cadence !== 'entrances' && cadence !== 'word-frames' && cadence !== 'phrase-stream') fail('INVALID_CADENCE', 'Cadence must be pairs, flow, subdivide, entrances, word-frames, or phrase-stream.');
    if (['subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(cadence) && mode !== 'syllable') fail('INVALID_CADENCE', 'Subdivide, entrances, word-frames, and phrase-stream cadences require syllable mode.');
    const bpm = options.bpm === undefined || options.bpm === null ? null : options.bpm;
    if(options.tempoMap && options.tempoOffsetMs!==undefined && !Number.isSafeInteger(options.tempoOffsetMs))fail('INVALID_OFFSET','Tempo offset must be whole milliseconds.');
    if (bpm !== null && !(typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400)) {
      fail('INVALID_BPM', 'BPM must be between 20 and 400.');
    }
    const ids = new Set();
    const safeUnits = units.map(unit => {
      if (!unit || typeof unit !== 'object' || Array.isArray(unit) || typeof unit.id !== 'string' || !unit.id.trim() ||
          ids.has(unit.id) || typeof unit.wordId !== 'string' || !unit.wordId.trim() ||
          (unit.syllableId !== undefined && (typeof unit.syllableId !== 'string' || !unit.syllableId.trim())) ||
          (unit.phraseId !== undefined && (typeof unit.phraseId !== 'string' || !unit.phraseId.trim())) ||
          typeof unit.text !== 'string' || !integerTime(unit.minMs) || !integerTime(unit.maxMs) || unit.maxMs < unit.minMs) {
        fail('INVALID_UNITS', 'Each unit needs a unique id, word id, text, and ordered integer millisecond bounds.');
      }
      ids.add(unit.id);
      return clone(unit);
    });
    if (cadence === 'subdivide' && (safeUnits[0].maxMs <= safeUnits[0].minMs ||
        safeUnits.some(unit => unit.minMs !== safeUnits[0].minMs || unit.maxMs !== safeUnits[0].maxMs))) {
      fail('INVALID_UNITS', 'Subdivide units must share a positive parent interval.');
    }
    if (cadence === 'entrances' && (safeUnits[0].maxMs <= safeUnits[0].minMs ||
        safeUnits.some(unit => unit.minMs !== safeUnits[0].minMs || unit.maxMs !== safeUnits[0].maxMs))) {
      fail('INVALID_UNITS', 'Entrance units must share a positive parent interval.');
    }
    if (cadence === 'word-frames') {
      const wordIds = new Set();
      for (const unit of safeUnits) {
        if (wordIds.has(unit.wordId)) fail('INVALID_UNITS', 'Word-frame cadence needs exactly one frame per word.');
        if (unit.maxMs <= unit.minMs) fail('INVALID_UNITS', 'Word frames must have positive intervals.');
        wordIds.add(unit.wordId);
      }
    }
    if (cadence === 'phrase-stream') {
      const phraseFrames = new Map();
      const wordIds = new Set();
      let currentPhraseId = null;
      const closedPhraseIds = new Set();
      for (const unit of safeUnits) {
        if (typeof unit.phraseId !== 'string' || !unit.phraseId.trim() ||
            !Number.isSafeInteger(unit.expectedCount) || unit.expectedCount < 1 ||
            unit.maxMs <= unit.minMs || wordIds.has(unit.wordId)) {
          fail('INVALID_UNITS', 'Phrase-stream units need unique words, a phrase id, positive phrase bounds, and expectedCount >= 1.');
        }
        wordIds.add(unit.wordId);
        if (currentPhraseId !== unit.phraseId) {
          if (closedPhraseIds.has(unit.phraseId)) fail('INVALID_UNITS', 'Words from each phrase must be contiguous.');
          if (currentPhraseId !== null) closedPhraseIds.add(currentPhraseId);
          currentPhraseId = unit.phraseId;
        }
        const frame = phraseFrames.get(unit.phraseId);
        if (frame && (frame.minMs !== unit.minMs || frame.maxMs !== unit.maxMs)) {
          fail('INVALID_UNITS', 'Words in one phrase must share the same phrase frame.');
        }
        if (!frame) phraseFrames.set(unit.phraseId, { phraseId: unit.phraseId,
          minMs: unit.minMs, maxMs: unit.maxMs });
      }
    }
    if (cadence === 'subdivide' && safeUnits.length === 1) {
      return { status: 'complete', index: 1, pendingStartMs: null,
        marks: [markEntry(safeUnits[0], safeUnits[0].minMs, safeUnits[0].maxMs)],
        lastMs: safeUnits[0].maxMs, units: safeUnits, mode, cadence, bpm,
        originMs: safeUnits[0].minMs, actionHistory: [] };
    }
    return { status: 'armed', index: 0,
      pendingStartMs: cadence === 'subdivide' ? safeUnits[0].minMs : null,
      marks: [], lastMs: cadence === 'subdivide' ? safeUnits[0].minMs : null,
      units: safeUnits, mode, cadence, bpm,
      ...(options.tempoMap ? {tempoMap:validateTempoMap(options.tempoMap),tempoOffsetMs:options.tempoOffsetMs||0} : {}),
      originMs: ['subdivide', 'entrances'].includes(cadence) ? safeUnits[0].minMs : null,
      ...(cadence === 'entrances' ? { entranceCount: 0 } : {}),
      ...(cadence === 'word-frames' ? { wordFrameTapCounts: {} } : {}),
      ...(cadence === 'phrase-stream' ? { activePhraseId: null, acknowledgedPhraseIds: [], wordTapCounts: {}, openTailId: null } : {}),
      ...(['flow', 'subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(cadence) ? { actionHistory: [] } : {}),
    };
  }

  // Flow/subdivide/entrance actions can close one unit and open the next with
  // one keypress. Keep bounded, nonrecursive snapshots for one-action Undo.
  const FLOW_HISTORY_LIMIT = 128;
  function flowSnapshot(take) {
    const { actionHistory, ...snapshot } = take;
    return snapshot;
  }
  function withFlowHistory(previous, next) {
    if (!['pairs', 'flow', 'subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(previous.cadence)) return next;
    const history = [...(previous.actionHistory || []), flowSnapshot(previous)].slice(-FLOW_HISTORY_LIMIT);
    return { ...next, actionHistory: history };
  }

  function acceptedTime(take, scoreMs, unit, firstStart) {
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Tap time must be a nonnegative integer number of milliseconds.');
    if (scoreMs < unit.minMs || scoreMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Tap is outside the current unit bounds.');
    let originMs = take.originMs;
    if (firstStart && originMs === null) originMs = scoreMs;
    let acceptedMs = scoreMs;
    if (take.tempoMap && take.bpm !== null) {
      const beat=tempoAt(take.tempoMap,scoreMs+take.tempoOffsetMs)?.beat;
      const source=beat===undefined?null:tempoTimeAtBeat(take.tempoMap,Math.round(beat*4)/4);
      acceptedMs=source===null?scoreMs:Math.round(source-take.tempoOffsetMs);
      if (acceptedMs < unit.minMs || acceptedMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Snapped tap is outside the current unit bounds.');
    } else if (take.bpm !== null && !(firstStart && take.originMs === null)) {
      const quantum = 60000 / take.bpm / 4;
      acceptedMs = Math.round((scoreMs - originMs) / quantum) * quantum + originMs;
      acceptedMs = Math.round(acceptedMs);
      if (acceptedMs < unit.minMs || acceptedMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Snapped tap is outside the current unit bounds.');
    }
    return { acceptedMs, originMs };
  }

  function markEntry(unit, startMs, endMs) {
    return { id: unit.id, wordId: unit.wordId,
      ...(unit.syllableId === undefined ? {} : { syllableId: unit.syllableId }),
      startMs, endMs };
  }

  function markEntrance(take, scoreMs) {
    const parentStart = take.units[0].minMs, parentEnd = take.units[0].maxMs;
    const count = take.entranceCount || 0;
    const record = next => withFlowHistory(take, next);

    // The first press acknowledges the fixed phrase start; it is not itself a
    // timing boundary. Continued takes use a null pending start to acknowledge
    // the next syllable at the current source time instead.
    if (count === 0 && take.pendingStartMs === null) {
      if (scoreMs < parentStart || scoreMs > parentEnd || take.units.length > 1 && scoreMs === parentEnd) {
        fail('OUT_OF_BOUNDS', 'Tap is outside the parent phrase bounds.');
      }
      if (take.units.length === 1) {
        const next = { ...take, marks: [markEntry(take.units[0], parentStart, parentEnd)],
          index: 1, entranceCount: 1, pendingStartMs: null, lastMs: parentEnd, status: 'complete' };
        return record(next);
      }
      return record({ ...take, index: 1, entranceCount: 1, pendingStartMs: parentStart, lastMs: parentStart });
    }

    if (take.pendingStartMs === null) {
      if (count >= take.units.length) fail('TAKE_CLOSED', 'Every timing unit is already complete.');
      const unit = take.units[count];
      const { acceptedMs } = acceptedTime(take, scoreMs, unit, false);
      if (acceptedMs <= parentStart || acceptedMs >= parentEnd) fail('OUT_OF_BOUNDS', 'Syllable entrances must be strictly inside the parent phrase bounds.');
      if (take.marks.length && acceptedMs < take.marks[take.marks.length - 1].endMs) {
        fail('OVERLAP', 'A continued syllable cannot start before the previous syllable ends.');
      }
      const entranceCount = count + 1;
      if (entranceCount === take.units.length) {
        const marks = [...take.marks, markEntry(unit, acceptedMs, parentEnd)];
        return record({ ...take, marks, index: entranceCount, entranceCount,
          pendingStartMs: null, lastMs: parentEnd, status: 'complete' });
      }
      return record({ ...take, index: entranceCount, entranceCount,
        pendingStartMs: acceptedMs, lastMs: acceptedMs });
    }

    const unitIndex = count - 1;
    if (unitIndex < 0 || unitIndex >= take.units.length - 1) fail('TAKE_CLOSED', 'No later syllable entrance is available.');
    const unit = take.units[unitIndex];
    const { acceptedMs } = acceptedTime(take, scoreMs, unit, false);
    if (acceptedMs <= parentStart || acceptedMs >= parentEnd) fail('OUT_OF_BOUNDS', 'Syllable entrances must be strictly inside the parent phrase bounds.');
    if (acceptedMs <= take.pendingStartMs) fail('INVALID_INTERVAL', 'Syllable entrances must produce positive intervals.');
    const marks = [...take.marks, markEntry(unit, take.pendingStartMs, acceptedMs)];
    const entranceCount = count + 1;
    if (entranceCount === take.units.length) {
      const last = markEntry(take.units[entranceCount - 1], acceptedMs, parentEnd);
      return record({ ...take, marks: [...marks, last], index: entranceCount, entranceCount,
        pendingStartMs: null, lastMs: parentEnd, status: 'complete' });
    }
    return record({ ...take, marks, index: entranceCount, entranceCount,
      pendingStartMs: acceptedMs, lastMs: acceptedMs });
  }

  function markWordFrame(take, scoreMs) {
    // Frames are half-open: a shared endpoint belongs to the frame on its
    // right, and a gap or overlap never gets guessed through.
    const matches = take.units.filter(unit => scoreMs >= unit.minMs && scoreMs < unit.maxMs);
    if (matches.length !== 1) fail('OUT_OF_BOUNDS', matches.length ?
      'Tap falls in overlapping word frames.' : 'Tap is outside every word frame.');
    if (take.lastMs !== null && scoreMs < take.lastMs) fail('NON_MONOTONIC_TIME', 'Word-frame taps must follow source-time order.');
    const unit = matches[0];
    const unitIndex = take.units.findIndex(item => item.id === unit.id);
    const wordFrameTapCounts = { ...(take.wordFrameTapCounts || {}) };
    const count = wordFrameTapCounts[unit.wordId] || 0;
    const id = `${unit.wordId}-syllable-${count + 1}`;
    const phraseId = unit.phraseId === undefined ? {} : { phraseId: unit.phraseId };
    const marks = take.marks.map(item => ({ ...item }));
    if (count === 0) {
      marks.push({ id, syllableId: id, wordId: unit.wordId, ...phraseId,
        startMs: unit.minMs, endMs: unit.maxMs });
    } else {
      let lastForWord = -1;
      for (let i = marks.length - 1; i >= 0; i--) {
        if (marks[i].wordId === unit.wordId) { lastForWord = i; break; }
      }
      const trailing = marks[lastForWord];
      if (!trailing || scoreMs <= trailing.startMs || scoreMs >= trailing.endMs) {
        fail('INVALID_INTERVAL', 'A later tap must split the remaining interval of its word.');
      }
      trailing.endMs = scoreMs;
      marks.splice(lastForWord + 1, 0, { id, syllableId: id, wordId: unit.wordId, ...phraseId,
        startMs: scoreMs, endMs: unit.maxMs });
    }
    wordFrameTapCounts[unit.wordId] = count + 1;
    const next = { ...take, marks, wordFrameTapCounts, index: unitIndex,
      lastMs: scoreMs, status: 'armed' };
    return withFlowHistory(take, next);
  }

  function phraseStreamGroups(units) {
    const groups = [];
    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      let group = groups[groups.length - 1];
      if (!group || group.phraseId !== unit.phraseId) {
        group = { phraseId: unit.phraseId, minMs: unit.minMs, maxMs: unit.maxMs,
          startIndex: index, endIndex: index };
        groups.push(group);
      } else group.endIndex = index;
    }
    return groups;
  }

  function phraseGroupById(take, phraseId) {
    return phraseStreamGroups(take.units).find(group => group.phraseId === phraseId);
  }

  function markPhraseStream(take, scoreMs) {
    const matches = phraseStreamGroups(take.units).filter(group => scoreMs >= group.minMs && scoreMs < group.maxMs);
    if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_PHRASE' : 'OUT_OF_BOUNDS', matches.length ?
      'Tap belongs to overlapping phrase frames.' : 'Tap is outside every phrase frame or in a rest.');
    if (take.lastMs !== null && scoreMs < take.lastMs) fail('NON_MONOTONIC_TIME', 'Phrase-stream taps must follow source-time order.');
    const phrase = matches[0];
    const previousTake = take;
    const record = next => withFlowHistory(previousTake, next);

    // The first press in each phrase acknowledges its fixed start and creates
    // the first full-frame syllable tail in the same action.
    const acknowledgedPhraseIds = take.acknowledgedPhraseIds || [];
    const selectedIndex = take.activePhraseId === phrase.phraseId && take.index >= phrase.startIndex && take.index <= phrase.endIndex ?
      take.index : phrase.startIndex;
    if (take.activePhraseId !== phrase.phraseId) {
      take = { ...take, activePhraseId: phrase.phraseId, index: selectedIndex,
        pendingStartMs: phrase.minMs, openTailId: null,
        acknowledgedPhraseIds: acknowledgedPhraseIds.includes(phrase.phraseId) ? acknowledgedPhraseIds :
          [...acknowledgedPhraseIds, phrase.phraseId] };
    } else if (!acknowledgedPhraseIds.includes(phrase.phraseId)) {
      take = { ...take, acknowledgedPhraseIds: [...acknowledgedPhraseIds, phrase.phraseId] };
    }

    const unitIndex = take.index;
    const unit = take.units[unitIndex];
    if (!unit || unit.phraseId !== phrase.phraseId || unitIndex < phrase.startIndex || unitIndex > phrase.endIndex) {
      fail('INVALID_CURSOR', 'Phrase-stream cursor must identify a word in the active phrase.');
    }
    const marks = take.marks.map(item => ({ ...item }));
    const latestMark = marks.length ? marks[marks.length - 1] : null;
    if (latestMark) {
      const latestOwnerIndex = take.units.findIndex(item => item.wordId === latestMark.wordId);
      if (unitIndex < latestOwnerIndex) fail('NON_MONOTONIC_OWNER', 'A tap cannot be assigned before the latest owner.');
    }
    let lastPhraseMark = -1;
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].phraseId === phrase.phraseId) { lastPhraseMark = i; break; }
    }
    if (lastPhraseMark < 0) {
      const actualCount = (take.wordTapCounts?.[unit.wordId] || 0) + 1;
      const id = `${unit.wordId}-syllable-${actualCount}`;
      marks.push({ id, syllableId: id,
        wordId: unit.wordId, phraseId: unit.phraseId, startMs: phrase.minMs, endMs: phrase.maxMs });
      const wordTapCounts = { ...(take.wordTapCounts || {}), [unit.wordId]: actualCount };
      let nextIndex = unitIndex;
      if (actualCount >= unit.expectedCount && unitIndex < phrase.endIndex) nextIndex++;
      return record({ ...take, marks, wordTapCounts, index: nextIndex, openTailId: id,
        pendingStartMs: phrase.minMs, lastMs: scoreMs, status: 'armed' });
    } else {
      const previous = marks[lastPhraseMark];
      if (scoreMs <= previous.startMs || scoreMs >= previous.endMs) {
        fail('INVALID_INTERVAL', 'Phrase-stream taps must split a positive trailing interval.');
      }
      previous.endMs = scoreMs;
      let count = 0;
      for (const item of marks) if (item.wordId === unit.wordId) count++;
      const id = `${unit.wordId}-syllable-${count + 1}`;
      marks.push({ id, syllableId: id, wordId: unit.wordId, phraseId: unit.phraseId,
        startMs: scoreMs, endMs: phrase.maxMs });
      const wordTapCounts = { ...(take.wordTapCounts || {}) };
      const actualCount = (wordTapCounts[unit.wordId] || 0) + 1;
      wordTapCounts[unit.wordId] = actualCount;
      let nextIndex = unitIndex;
      if (actualCount >= unit.expectedCount && unitIndex < phrase.endIndex) nextIndex++;
      const next = { ...take, marks, wordTapCounts, index: nextIndex, openTailId: id,
        pendingStartMs: scoreMs, lastMs: scoreMs, status: 'armed' };
      return record(next);
    }
  }

  function moveCursor(take, direction, scoreMs) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.cadence !== 'phrase-stream') fail('CURSOR_UNSUPPORTED', 'Live cursor movement is supported only for phrase-stream cadence.');
    if (direction !== -1 && direction !== 1) fail('INVALID_DIRECTION', 'Cursor direction must be -1 or 1.');
    let baseIndex = take.index;
    let phrase = phraseGroupById(take, take.activePhraseId);
    if (scoreMs !== undefined) {
      if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Cursor source time must be a nonnegative integer number of milliseconds.');
      const matches = phraseStreamGroups(take.units).filter(group => scoreMs >= group.minMs && scoreMs < group.maxMs);
      if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_PHRASE' : 'OUT_OF_BOUNDS', matches.length ?
        'Cursor time belongs to overlapping phrase frames.' : 'Cursor time is outside every phrase frame or in a rest.');
      phrase = matches[0];
      if (phrase.phraseId !== take.activePhraseId) baseIndex = phrase.startIndex;
    }
    if (!phrase) fail('NO_ACTIVE_PHRASE', 'A phrase must be active before moving its cursor.');
    const nextIndex = baseIndex + direction;
    if (nextIndex < phrase.startIndex || nextIndex > phrase.endIndex) fail('CURSOR_BOUNDS', 'Cursor cannot leave the active phrase.');
    const lastMark = take.marks.length ? take.marks[take.marks.length - 1] : null;
    if (lastMark) {
      const lastOwnerIndex = take.units.findIndex(unit => unit.wordId === lastMark.wordId);
      if (nextIndex < lastOwnerIndex) fail('NON_MONOTONIC_OWNER', 'Cursor cannot assign the next tap before the latest owner.');
    }
    const phraseChanged = phrase.phraseId !== take.activePhraseId;
    return withFlowHistory(take, { ...take, activePhraseId: phrase.phraseId, index: nextIndex,
      ...(phraseChanged ? { pendingStartMs: phrase.minMs, openTailId: null } : {}) });
  }

  function reassignLast(take, direction) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.cadence !== 'phrase-stream') fail('REASSIGN_UNSUPPORTED', 'Last-tap reassignment is supported only for phrase-stream cadence.');
    if (direction !== -1 && direction !== 1) fail('INVALID_DIRECTION', 'Reassignment direction must be -1 or 1.');
    const lastIndex = take.marks.length - 1;
    const last = take.marks[lastIndex];
    if (!last) fail('NO_RECENT_TAP', 'There is no syllable tap to reassign.');
    const group = phraseGroupById(take, last.phraseId);
    const ownerIndex = take.units.findIndex(unit => unit.wordId === last.wordId);
    const targetIndex = ownerIndex + direction;
    if (targetIndex < group.startIndex || targetIndex > group.endIndex) fail('CURSOR_BOUNDS', 'Reassignment cannot leave the active phrase.');
    if (lastIndex > 0 && take.marks[lastIndex - 1].phraseId === last.phraseId) {
      const previousOwnerIndex = take.units.findIndex(unit => unit.wordId === take.marks[lastIndex - 1].wordId);
      if (targetIndex < previousOwnerIndex) fail('NON_MONOTONIC_OWNER', 'Reassignment would put a tap before the previous owner.');
    }

    const marks = take.marks.map(item => ({ ...item }));
    marks[lastIndex].wordId = take.units[targetIndex].wordId;
    const wordTapCounts = {};
    const counters = {};
    for (const item of marks) {
      const count = (counters[item.wordId] || 0) + 1;
      counters[item.wordId] = count;
      item.id = `${item.wordId}-syllable-${count}`;
      item.syllableId = item.id;
      wordTapCounts[item.wordId] = count;
    }
    const newOwner = take.units[targetIndex];
    let index = take.index;
    if (last.phraseId === take.activePhraseId) {
      index = targetIndex;
      if ((wordTapCounts[newOwner.wordId] || 0) >= newOwner.expectedCount && targetIndex < group.endIndex) index++;
    }
    const openTailId = take.openTailId === last.id ? marks[lastIndex].id : take.openTailId;
    return withFlowHistory(take, { ...take, marks, wordTapCounts, index, openTailId });
  }

  function mark(take, scoreMs, options = {}) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Mark options must be an object.');
    const repeat = options.repeat === true;
    if (repeat) return take;
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Tap time must be a nonnegative integer number of milliseconds.');
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'This take is no longer accepting taps.');
    if (take.cadence === 'phrase-stream') return markPhraseStream(take, scoreMs);
    if (take.cadence === 'word-frames') return markWordFrame(take, scoreMs);
    if (take.cadence === 'entrances') return markEntrance(take, scoreMs);
    const unit = take.units[take.index];
    if (!unit) fail('TAKE_CLOSED', 'Every timing unit is already complete.');
    const firstStart = take.pendingStartMs === null;
    if (firstStart && take.marks.length && scoreMs < take.marks[take.marks.length - 1].endMs) {
      fail('OVERLAP', 'A unit cannot start before the previous unit ends.');
    }
    const { acceptedMs, originMs } = acceptedTime(take, scoreMs, unit, firstStart);
    if (firstStart && take.marks.length && acceptedMs < take.marks[take.marks.length - 1].endMs) {
      fail('OVERLAP', 'A unit cannot start before the previous unit ends.');
    }
    if (firstStart) {
      const next = { ...take, pendingStartMs: acceptedMs, originMs, lastMs: acceptedMs };
      return take.cadence === 'flow' || take.actionHistory?.length ? withFlowHistory(take, next) : next;
    }
    if (acceptedMs <= take.pendingStartMs) fail('INVALID_INTERVAL', 'End tap must be strictly after the start tap.');
    if (take.cadence === 'subdivide') {
      const parentStart = take.units[0].minMs, parentEnd = take.units[0].maxMs;
      if (acceptedMs <= parentStart || acceptedMs >= parentEnd) {
        fail('OUT_OF_BOUNDS', 'Subdivision taps must be strictly inside the parent bounds.');
      }
      const marks = [...take.marks, markEntry(unit, take.pendingStartMs, acceptedMs)];
      const index = take.index + 1;
      if (index === take.units.length - 1) {
        const lastUnit = take.units[index];
        const lastMark = markEntry(lastUnit, acceptedMs, parentEnd);
        const next = { ...take, marks: [...marks, lastMark], index: index + 1,
          pendingStartMs: null, lastMs: parentEnd, status: 'complete' };
        return withFlowHistory(take, next);
      }
      const next = { ...take, marks, index, pendingStartMs: acceptedMs,
        lastMs: acceptedMs, status: 'armed' };
      return withFlowHistory(take, next);
    }
    const entry = markEntry(unit, take.pendingStartMs, acceptedMs);
    const marks = [...take.marks, entry], index = take.index + 1;
    if (take.cadence === 'flow' && index < take.units.length) {
      const nextUnit = take.units[index];
      if (acceptedMs < nextUnit.minMs || acceptedMs > nextUnit.maxMs) {
        fail('OUT_OF_BOUNDS', 'Flow boundary is outside the next unit bounds.');
      }
      const next = { ...take, marks, index, pendingStartMs: acceptedMs, lastMs: acceptedMs,
        status: 'armed' };
      return withFlowHistory(take, next);
    }
    const next = { ...take, marks, index, pendingStartMs: null, lastMs: acceptedMs,
      status: index === take.units.length ? 'complete' : 'armed' };
    return take.cadence === 'flow' || take.actionHistory?.length ? withFlowHistory(take, next) : next;
  }

  function release(take, scoreMs, options = {}) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Release options must be an object.');
    if (options.repeat === true) return take;
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Release time must be a nonnegative integer number of milliseconds.');
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'This take is no longer accepting taps.');
    if (['subdivide', 'entrances', 'phrase-stream'].includes(take.cadence)) fail('RELEASE_UNSUPPORTED', 'This cadence closes at syllable entrances and the parent end.');
    if (take.pendingStartMs === null) fail('NO_PENDING_START', 'There is no open unit to release.');
    const unit = take.units[take.index];
    if (!unit) fail('TAKE_CLOSED', 'Every timing unit is already complete.');
    const { acceptedMs } = acceptedTime(take, scoreMs, unit, false);
    if (acceptedMs <= take.pendingStartMs) fail('INVALID_INTERVAL', 'Release time must be strictly after the start tap.');
    const marks = [...take.marks, markEntry(unit, take.pendingStartMs, acceptedMs)];
    const index = take.index + 1;
    const next = { ...take, marks, index, pendingStartMs: null, lastMs: acceptedMs,
      status: index === take.units.length ? 'complete' : 'armed' };
    return take.cadence === 'flow' || take.actionHistory?.length ? withFlowHistory(take, next) : next;
  }

  function undo(take) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.actionHistory && take.actionHistory.length) {
      const previous = take.actionHistory[take.actionHistory.length - 1];
      return { ...previous, actionHistory: take.actionHistory.slice(0, -1) };
    }
    if (['word-frames', 'phrase-stream'].includes(take.cadence)) return take;
    if (take.cadence === 'subdivide' && take.units.length === 1) return take;
    if (['subdivide', 'entrances'].includes(take.cadence)) return take;
    if (take.pendingStartMs !== null) {
      return { ...take, pendingStartMs: null, lastMs: take.marks.length ? take.marks[take.marks.length - 1].endMs : null,
        originMs: take.marks.length ? take.originMs : null, status: 'armed' };
    }
    if (!take.marks.length) return take;
    const removed = take.marks[take.marks.length - 1];
    const index = take.units.findIndex(unit => unit.id === removed.id);
    const marks = take.marks.slice(0, -1);
    return { ...take, marks, index, pendingStartMs: null, lastMs: marks.length ? marks[marks.length - 1].endMs : null,
      originMs: marks.length ? take.originMs : null, status: 'armed' };
  }

  // Move the live recording cursor without seeking the source clock. Marks at
  // or after the selected unit are discarded; earlier marks remain intact.
  function reposition(take, index) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (!Number.isSafeInteger(index) || index < 0 || index >= take.units.length) {
      fail('INVALID_INDEX', 'Cursor index must identify a timing unit.');
    }
    if (take.mode !== 'word' && take.mode !== 'phrase') {
      fail('REPOSITION_UNSUPPORTED', 'Live cursor recovery is supported only for word and phrase modes.');
    }
    const positionById = new Map(take.units.map((unit, position) => [unit.id, position]));
    const marks = take.marks.filter(mark => positionById.get(mark.id) < index);
    return { ...take, index, marks, pendingStartMs: null,
      lastMs: marks.length ? marks[marks.length - 1].endMs : null,
      originMs: marks.length ? take.originMs : null,
      status: take.status === 'complete' ? 'stopped' : take.status,
      actionHistory: [] };
  }

  function stop(take) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.status === 'stopped' && take.pendingStartMs === null) return take;
    if (['word-frames', 'phrase-stream'].includes(take.cadence)) {
      return { ...take, pendingStartMs: null, status: 'stopped' };
    }
    if (take.cadence === 'entrances') {
      const completedCount = take.marks.length;
      return { ...take, index: completedCount, entranceCount: completedCount,
        pendingStartMs: null, status: 'stopped',
        lastMs: take.marks.length ? take.marks[take.marks.length - 1].endMs : null,
        actionHistory: [] };
    }
    return { ...take, pendingStartMs: null, status: 'stopped',
      lastMs: take.marks.length ? take.marks[take.marks.length - 1].endMs : null,
      originMs: take.marks.length ? take.originMs : null };
  }

  // Retake a phrase after the source clock moves backward. Keep the retained
  // prefix and record the complete stopped take as the immediately undoable action.
  function rewindToPhrase(take, phraseId) {
    if (!take || take.status !== 'stopped') fail('TAKE_NOT_STOPPED', 'Phrase rewind requires a stopped take.');
    if (take.cadence !== 'phrase-stream') fail('CADENCE_UNSUPPORTED', 'Phrase rewind requires phrase-stream cadence.');
    const groups = phraseStreamGroups(take.units);
    const phraseIndex = groups.findIndex(group => group.phraseId === phraseId);
    if (phraseIndex < 0) fail('UNKNOWN_PHRASE', 'No phrase has that id.');
    const retainedIds = new Set(groups.slice(0, phraseIndex).map(group => group.phraseId));
    const marks = take.marks.filter(mark => retainedIds.has(mark.phraseId)).map(mark => ({ ...mark }));
    const wordTapCounts = {};
    for (const mark of marks) wordTapCounts[mark.wordId] = (wordTapCounts[mark.wordId] || 0) + 1;
    const acknowledgedPhraseIds = groups.slice(0, phraseIndex)
      .filter(group => marks.some(mark => mark.phraseId === group.phraseId)).map(group => group.phraseId);
    return withFlowHistory(take, { ...take, status: 'stopped', marks,
      index: groups[phraseIndex].startIndex, activePhraseId: null,
      pendingStartMs: null, openTailId: null, wordTapCounts, acknowledgedPhraseIds,
      lastMs: marks.length ? marks[marks.length - 1].startMs : null });
  }

  function restorePhraseStreamTake(snapshot) {
    const invalid = message => fail('INVALID_SNAPSHOT', message);
    const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const keys = new Set(['status','index','pendingStartMs','marks','lastMs','units','mode','cadence','bpm',
      'originMs','activePhraseId','acknowledgedPhraseIds','wordTapCounts','openTailId','actionHistory','stoppedScoreMs']);
    const required = ['status','index','pendingStartMs','marks','lastMs','units','mode','cadence','bpm',
      'originMs','activePhraseId','acknowledgedPhraseIds','wordTapCounts','openTailId'];
    const validate = (state, statuses, main) => {
      if (!plain(state) || !statuses.includes(state.status) || Object.keys(state).some(k => !keys.has(k)) ||
          required.some(k => !Object.hasOwn(state,k)) || (!main && 'actionHistory' in state) ||
          Object.hasOwn(state, 'stoppedScoreMs') && !Number.isSafeInteger(state.stoppedScoreMs) ||
          state.mode !== 'syllable' || state.cadence !== 'phrase-stream' || !Array.isArray(state.units) ||
          !state.units.length || state.units.length > 5000 || !Array.isArray(state.marks) || state.marks.length > 5000 ||
          (main ? state.pendingStartMs !== null : !(state.pendingStartMs === null || integerTime(state.pendingStartMs))) || state.originMs !== null ||
          !(state.bpm === null || typeof state.bpm === 'number' && Number.isFinite(state.bpm) && state.bpm >= 20 && state.bpm <= 400) ||
          !Number.isSafeInteger(state.index) || state.index < 0 || state.index >= state.units.length ||
          !Array.isArray(state.acknowledgedPhraseIds) || !plain(state.wordTapCounts) ||
          !(state.activePhraseId === null || typeof state.activePhraseId === 'string') ||
          !(state.openTailId === null || typeof state.openTailId === 'string')) invalid(`Phrase-stream state shape is invalid (index ${state.index}, units ${state.units?.length}, active ${state.activePhraseId}, tail ${state.openTailId}).`);
      let initial;
      try { initial = begin(state.units, {mode: state.mode, cadence: state.cadence, bpm: state.bpm}); }
      catch (_) { invalid('Phrase-stream units are invalid.'); }
      if (!same(initial.units,state.units)) invalid('Phrase-stream units are not canonical.');
      const groups = phraseStreamGroups(state.units), groupById = new Map(groups.map(g => [g.phraseId,g]));
      if (state.activePhraseId !== null) {
        const active = groupById.get(state.activePhraseId);
        if (!active || state.index < active.startIndex || state.index > active.endIndex) invalid('Active phrase and cursor disagree.');
      }
      if (new Set(state.acknowledgedPhraseIds).size !== state.acknowledgedPhraseIds.length ||
          state.acknowledgedPhraseIds.some(id => !groupById.has(id))) invalid('Acknowledged phrase ids are invalid.');
      const counts = Object.create(null); let lastPhrase = -1, currentPhrase = null, prev = null, closed = new Set();
      for (const mark of state.marks) {
        if (!plain(mark) || Object.keys(mark).some(k => !['id','syllableId','wordId','phraseId','startMs','endMs'].includes(k)) ||
            typeof mark.wordId !== 'string' || typeof mark.phraseId !== 'string' || mark.id !== mark.syllableId ||
            !integerTime(mark.startMs) || !integerTime(mark.endMs) || mark.endMs <= mark.startMs) invalid('Mark identity or interval is invalid.');
        const g = groupById.get(mark.phraseId); if (!g) invalid('Mark phrase is unknown.');
        const pi = groups.indexOf(g), wordIndex = state.units.findIndex(u => u.wordId === mark.wordId);
        const unit = state.units[wordIndex];
        if (!unit || unit.phraseId !== mark.phraseId || mark.startMs < g.minMs || mark.endMs > g.maxMs) invalid('Mark owner or frame is invalid.');
        counts[mark.wordId] = (counts[mark.wordId] || 0) + 1;
        if (mark.id !== `${mark.wordId}-syllable-${counts[mark.wordId]}`) invalid('Dynamic syllable id is invalid.');
        if (pi !== lastPhrase) {
          if (closed.has(mark.phraseId) || pi < lastPhrase || mark.startMs !== g.minMs) invalid('Phrase mark order or start is invalid.');
          if (currentPhrase !== null && prev.endMs !== groups[lastPhrase].maxMs) invalid('Completed phrase marks must close at the phrase end.');
          if (currentPhrase !== null) closed.add(currentPhrase);
          currentPhrase = mark.phraseId; lastPhrase = pi;
        } else if (prev.endMs !== mark.startMs) invalid('Phrase marks must partition their frame.');
        if (prev && pi === lastPhrase && wordIndex < prev.wordIndex) invalid('Mark word order is invalid.');
        prev = {endMs:mark.endMs, wordIndex};
      }
      if (prev && prev.endMs !== groups[lastPhrase].maxMs) invalid('Final phrase marks must close at the phrase end.');
      if (Object.keys(state.wordTapCounts).length !== Object.keys(counts).length ||
          Object.keys(counts).some(id => state.wordTapCounts[id] !== counts[id]) ||
          Object.values(state.wordTapCounts).some(n => !Number.isSafeInteger(n) || n < 1)) invalid('Word tap counts do not match marks.');
      const markedPhrases = groups.filter(g => state.marks.some(m => m.phraseId === g.phraseId)).map(g => g.phraseId);
      if (!same(state.acknowledgedPhraseIds, markedPhrases)) invalid('Acknowledgements do not match marked phrase prefix.');
      if (state.marks.length === 0 ? state.lastMs !== null : !integerTime(state.lastMs)) invalid('Last source time is invalid.');
      if (state.marks.length && (state.lastMs < state.marks.at(-1).startMs || state.lastMs >= groups[lastPhrase].maxMs)) invalid('Last source time is outside the final marked phrase.');
      const finalMark = state.marks.at(-1);
      if (state.status === 'armed' && state.activePhraseId === (finalMark?.phraseId ?? null) &&
          state.openTailId !== (finalMark ? finalMark.id : null) ||
          state.openTailId !== null && state.openTailId !== (state.marks.length ? state.marks.at(-1).id : null)) invalid('Open tail does not match the final mark.');
      return groups;
    };
    if (!plain(snapshot) || snapshot.status !== 'stopped' || !Array.isArray(snapshot.actionHistory) || snapshot.actionHistory.length > FLOW_HISTORY_LIMIT) invalid('Only a bounded stopped phrase-stream take can be restored.');
    let groups;
    try { groups = validate(snapshot, ['stopped'], true); } catch (error) { if (error.code === 'INVALID_SNAPSHOT') throw error; invalid('Snapshot is invalid.'); }
    for (const entry of snapshot.actionHistory) {
      const entryGroups = validate(entry, ['armed','stopped'], false);
      if (!same(entry.units,snapshot.units) || entry.mode !== snapshot.mode || entry.cadence !== snapshot.cadence || entry.bpm !== snapshot.bpm || !same(entryGroups,groups)) invalid('Undo history configuration differs from take.');
    }
    try { return clone(snapshot); } catch (_) { invalid('Snapshot is not serializable.'); }
  }

  function restoreWordFrameTake(snapshot) {
    const invalid = message => fail('INVALID_SNAPSHOT', message);
    const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const allowedKeys = new Set(['status', 'index', 'pendingStartMs', 'marks', 'lastMs', 'units',
      'mode', 'cadence', 'bpm', 'originMs', 'wordFrameTapCounts', 'actionHistory', 'stoppedScoreMs']);
    const requiredKeys = ['status', 'index', 'pendingStartMs', 'marks', 'lastMs', 'units',
      'mode', 'cadence', 'bpm', 'originMs', 'wordFrameTapCounts'];
    const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    if (!plainObject(snapshot) || snapshot.status !== 'stopped' || snapshot.mode !== 'syllable' ||
        snapshot.cadence !== 'word-frames' || !Array.isArray(snapshot.units) || snapshot.units.length > 5000 ||
        !Array.isArray(snapshot.marks) || snapshot.marks.length > 5000 ||
        !Array.isArray(snapshot.actionHistory) || snapshot.actionHistory.length > FLOW_HISTORY_LIMIT) {
      invalid('Only a bounded stopped word-frames syllable take can be restored.');
    }

    function validateState(state, allowedStatuses, includeHistory) {
      if (!plainObject(state) || !allowedStatuses.includes(state.status)) invalid('Take status or snapshot shape is invalid.');
      if (requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(state, key)) ||
          includeHistory && !Object.prototype.hasOwnProperty.call(state, 'actionHistory')) invalid('Take is missing required state metadata.');
      for (const key of Object.keys(state)) {
        if (!allowedKeys.has(key) || (!includeHistory && ['actionHistory', 'stoppedScoreMs'].includes(key))) invalid('Take contains unknown or nested state metadata.');
      }
      if (state.mode !== 'syllable' || state.cadence !== 'word-frames' || !Array.isArray(state.units) ||
          state.units.length === 0 || state.units.length > 5000 || !Array.isArray(state.marks) || state.marks.length > 5000 ||
          state.pendingStartMs !== null || state.originMs !== null ||
          !(state.bpm === null || typeof state.bpm === 'number' && Number.isFinite(state.bpm) && state.bpm >= 20 && state.bpm <= 400) ||
          !Array.isArray(state.actionHistory) && includeHistory) {
        invalid('Word-frame take metadata is invalid.');
      }
      let initial;
      try {
        initial = begin(state.units, { mode: state.mode, cadence: state.cadence, bpm: state.bpm });
      } catch (_) {
        invalid('Word-frame units or BPM are invalid.');
      }
      if (!sameJson(initial.units, state.units)) invalid('Word-frame units must retain their validated source shape.');
      if (!Number.isSafeInteger(state.index) || state.index < 0 || state.index >= state.units.length) invalid('Take cursor is invalid.');
      if (!plainObject(state.wordFrameTapCounts)) invalid('Word-frame tap counts are invalid.');

      const unitByWord = new Map(state.units.map((unit, index) => [unit.wordId, { unit, index }]));
      const countByWord = Object.create(null);
      const seenWordGroups = new Set();
      let currentWordId = null;
      let currentUnit = null;
      let previousEndMs = null;
      let previousUnitIndex = -1;
      let previousUnitMinMs = null;
      for (const mark of state.marks) {
        if (!plainObject(mark)) invalid('Mark shape is invalid.');
        const markKeys = Object.keys(mark);
        if (markKeys.some(key => !['id', 'syllableId', 'wordId', 'phraseId', 'startMs', 'endMs'].includes(key)) ||
            typeof mark.id !== 'string' || typeof mark.syllableId !== 'string' || mark.syllableId !== mark.id ||
            typeof mark.wordId !== 'string' || !integerTime(mark.startMs) || !integerTime(mark.endMs) || mark.endMs <= mark.startMs) {
          invalid('Mark identity or interval is invalid.');
        }
        const matched = unitByWord.get(mark.wordId);
        if (!matched) invalid('Mark refers to an unknown word.');
        const { unit, index } = matched;
        if (Object.prototype.hasOwnProperty.call(unit, 'phraseId') ? mark.phraseId !== unit.phraseId :
            Object.prototype.hasOwnProperty.call(mark, 'phraseId')) invalid('Mark phrase id does not match its word frame.');
        if (mark.startMs < unit.minMs || mark.endMs > unit.maxMs) invalid('Mark is outside its word frame.');
        const count = (countByWord[mark.wordId] || 0) + 1;
        if (mark.id !== `${mark.wordId}-syllable-${count}`) invalid('Dynamic syllable ids are invalid.');
        countByWord[mark.wordId] = count;

        if (mark.wordId !== currentWordId) {
          if (seenWordGroups.has(mark.wordId)) invalid('A word appears in multiple mark groups.');
          if (currentUnit && previousEndMs !== currentUnit.maxMs) invalid('Word syllables do not partition the full word frame.');
          if (index <= previousUnitIndex || previousUnitMinMs !== null &&
              (unit.minMs < previousUnitMinMs || unit.maxMs < currentUnit.maxMs)) {
            invalid('Word groups do not follow unit and source order.');
          }
          if (mark.startMs !== unit.minMs) invalid('The first syllable must start at the word-frame start.');
          seenWordGroups.add(mark.wordId);
          currentWordId = mark.wordId;
          currentUnit = unit;
          previousUnitIndex = index;
          previousUnitMinMs = unit.minMs;
        } else if (mark.startMs !== previousEndMs) invalid('Syllable marks must form a gapless word partition.');
        previousEndMs = mark.endMs;
      }
      if (currentUnit && previousEndMs !== currentUnit.maxMs) invalid('Word syllables do not partition the full word frame.');

      const countKeys = Object.keys(state.wordFrameTapCounts);
      if (countKeys.length !== Object.keys(countByWord).length ||
          countKeys.some(wordId => !Object.prototype.hasOwnProperty.call(countByWord, wordId) ||
            state.wordFrameTapCounts[wordId] !== countByWord[wordId]) ||
          Object.values(state.wordFrameTapCounts).some(count => !Number.isSafeInteger(count) || count < 1)) {
        invalid('Word-frame tap counts do not match the mark partitions.');
      }
      if (state.marks.length === 0) {
        if (state.index !== 0 || state.lastMs !== null) invalid('An empty take must have cursor zero and no last source time.');
      } else {
        const latest = state.marks[state.marks.length - 1];
        const latestUnit = unitByWord.get(latest.wordId);
        if (state.index !== latestUnit.index || !integerTime(state.lastMs) ||
            state.lastMs < latestUnit.unit.minMs || state.lastMs >= latestUnit.unit.maxMs ||
            state.lastMs < latest.startMs) invalid('Cursor or last source time does not match the latest word frame.');
      }
      if (includeHistory && (!Array.isArray(state.actionHistory) || state.actionHistory.length > FLOW_HISTORY_LIMIT)) {
        invalid('Undo history is not a bounded array.');
      }
      return { unitShape: initial.units };
    }

    const main = validateState(snapshot, ['stopped'], true);
    const history = snapshot.actionHistory;
    let previousHistoryMarkCount = null;
    let previousHistoryLastMs = null;
    for (const entry of history) {
      if (!plainObject(entry) || Object.prototype.hasOwnProperty.call(entry, 'actionHistory')) invalid('Undo entries must be nonrecursive snapshots.');
      const validated = validateState(entry, ['armed', 'stopped'], false);
      if (entry.mode !== snapshot.mode || entry.cadence !== snapshot.cadence || entry.bpm !== snapshot.bpm ||
          !sameJson(entry.units, snapshot.units) || !sameJson(validated.unitShape, main.unitShape)) {
        invalid('Undo entries must use the same take configuration and units.');
      }
      if (previousHistoryMarkCount !== null && entry.marks.length !== previousHistoryMarkCount + 1) {
        invalid('Undo entries are not a consecutive tap history.');
      }
      if (previousHistoryLastMs !== null && entry.lastMs !== null && entry.lastMs < previousHistoryLastMs) {
        invalid('Undo entries do not preserve source-time order.');
      }
      previousHistoryMarkCount = entry.marks.length;
      previousHistoryLastMs = entry.lastMs;
    }
    if (history.length && (snapshot.marks.length !== history[history.length - 1].marks.length + 1 ||
        history.length > snapshot.marks.length)) invalid('Undo history does not lead to the current take.');
    if (history.length && history[history.length - 1].lastMs !== null &&
        snapshot.lastMs < history[history.length - 1].lastMs) invalid('Current source time precedes its undo history.');
    try { JSON.stringify(snapshot); } catch (_) { invalid('Snapshot must be JSON-serializable.'); }
    return clone(snapshot);
  }

  // Late keyboard corrections operate on the immutable completed mark list.
  // A subdivided child edge is the parent's shared boundary, so update both
  // adjacent children atomically to keep the partition gapless.
  function adjust(take, change) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.status !== 'complete' && take.status !== 'stopped') fail('TAKE_OPEN', 'Only stopped or complete takes can be adjusted.');
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        typeof change.id !== 'string' || !['start', 'end', 'move'].includes(change.edge) ||
        !Number.isSafeInteger(change.deltaMs)) fail('INVALID_ADJUSTMENT', 'Adjustment needs an id, start/end/move edge, and integer deltaMs.');
    const index = take.marks.findIndex(item => item.id === change.id);
    if (index < 0) fail('UNKNOWN_MARK', 'No completed mark has that id.');
    const marks = take.marks.map(item => ({ ...item }));
    const current = marks[index];
    const delta = change.deltaMs;
    if (take.cadence === 'word-frames') {
      if (change.edge === 'move') fail('ADJUST_UNSUPPORTED', 'Word-frame syllables can only adjust a shared boundary.');
      const neighborIndex = change.edge === 'start' ? index - 1 : index + 1;
      const neighbor = marks[neighborIndex];
      if (!neighbor || neighbor.wordId !== current.wordId) {
        if (delta !== 0) fail('OUT_OF_BOUNDS', 'Word-frame endpoints are fixed.');
      } else if (change.edge === 'start') {
        neighbor.endMs += delta;
        current.startMs += delta;
      } else {
        current.endMs += delta;
        neighbor.startMs += delta;
      }
      const unit = take.units.find(item => item.wordId === current.wordId);
      for (let i = 0; i < marks.length; i++) {
        const item = marks[i];
        if (item.wordId === current.wordId && (item.startMs < unit.minMs || item.endMs > unit.maxMs)) {
          fail('OUT_OF_BOUNDS', 'Adjusted syllable is outside its word frame.');
        }
        if (item.endMs <= item.startMs) fail('INVALID_INTERVAL', 'Adjusted mark must have a positive interval.');
        if (i && item.wordId === marks[i - 1].wordId && item.startMs !== marks[i - 1].endMs) {
          fail('INVALID_INTERVAL', 'Adjusted syllables must partition their word frame.');
        }
      }
      return { ...take, marks, actionHistory: [] };
    }
    if (take.cadence === 'phrase-stream') {
      if (change.edge === 'move') fail('ADJUST_UNSUPPORTED', 'Phrase-stream syllables can only adjust a shared boundary.');
      const samePhrase = item => item.phraseId === current.phraseId;
      const phrase = phraseGroupById(take, current.phraseId);
      const phraseMarks = marks.filter(samePhrase);
      const phrasePosition = phraseMarks.findIndex(item => item.id === current.id);
      const neighbor = change.edge === 'start' ? phraseMarks[phrasePosition - 1] : phraseMarks[phrasePosition + 1];
      if (!neighbor) {
        if (delta !== 0) fail('OUT_OF_BOUNDS', 'Phrase endpoints are fixed.');
      } else if (change.edge === 'start') {
        neighbor.endMs += delta;
        current.startMs += delta;
      } else {
        current.endMs += delta;
        neighbor.startMs += delta;
      }
      const updatedPhraseMarks = marks.filter(samePhrase);
      for (let i = 0; i < updatedPhraseMarks.length; i++) {
        const item = updatedPhraseMarks[i];
        if (item.startMs < phrase.minMs || item.endMs > phrase.maxMs) fail('OUT_OF_BOUNDS', 'Adjusted mark is outside its phrase bounds.');
        if (item.endMs <= item.startMs) fail('INVALID_INTERVAL', 'Adjusted mark must have a positive interval.');
        if (i && item.startMs !== updatedPhraseMarks[i - 1].endMs) fail('INVALID_INTERVAL', 'Phrase-stream marks must remain contiguous.');
      }
      return { ...take, marks, actionHistory: [] };
    }
    const partitionedCadence = ['subdivide', 'entrances'].includes(take.cadence);
    if (partitionedCadence && delta !== 0 && (change.edge === 'start' && index === 0 || change.edge === 'end' && index === take.units.length - 1)) fail('OUT_OF_BOUNDS', 'The first syllable start and final release are fixed by the parent interval.');
    if (partitionedCadence && change.edge === 'move') fail('ADJUST_UNSUPPORTED', 'Move adjustment is not supported for partitioned syllables. Adjust a shared boundary instead.');
    if (partitionedCadence && change.edge === 'start' && index > 0) {
      marks[index - 1].endMs += delta;
      current.startMs += delta;
    } else if (partitionedCadence && change.edge === 'end' && index + 1 < marks.length) {
      current.endMs += delta;
      marks[index + 1].startMs += delta;
    } else if (change.edge === 'start') current.startMs += delta;
    else if (change.edge === 'end') current.endMs += delta;
    else { current.startMs += delta; current.endMs += delta; }

    const unitById = new Map(take.units.map(unit => [unit.id, unit]));
    for (let i = 0; i < marks.length; i++) {
      const item = marks[i], unit = unitById.get(item.id);
      if (item.startMs < unit.minMs || item.endMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Adjusted mark is outside its unit bounds.');
      if (item.endMs <= item.startMs) fail('INVALID_INTERVAL', 'Adjusted mark must have a positive interval.');
      if (i && item.startMs < marks[i - 1].endMs) fail('OVERLAP', 'Adjusted marks cannot overlap.');
    }
    return { ...take, marks, lastMs: marks.length ? marks[marks.length - 1].endMs : null,
      actionHistory: take.actionHistory ? [] : undefined };
  }

  // Event capture deliberately stores only source-clock observations. Lexical
  // ownership and syllable segmentation are a later, reviewable operation.
  function beginEvents(units, { kind = 'syllable-entrance', inputMode = 'tap' } = {}) {
    if (!Array.isArray(units) || !units.length || units.length > 5000) fail('INVALID_UNITS', 'Provide 1–5000 event units.');
    if (typeof kind !== 'string' || !kind.trim()) fail('INVALID_KIND', 'Event kind must be a nonempty string.');
    if (!['tap','hold'].includes(inputMode)) fail('INVALID_INPUT_MODE','Syllable input must be tap or hold.');
    const ids = new Set();
    const safeUnits = units.map(unit => {
      if (!unit || typeof unit !== 'object' || typeof unit.id !== 'string' || !unit.id.trim() || ids.has(unit.id) ||
          typeof unit.wordId !== 'string' || !unit.wordId.trim() || typeof unit.phraseId !== 'string' || !unit.phraseId.trim() ||
          typeof unit.text !== 'string' || !integerTime(unit.minMs) || !integerTime(unit.maxMs) || unit.maxMs < unit.minMs ||
          !(unit.expectedCount === null || unit.expectedCount === undefined || Number.isSafeInteger(unit.expectedCount) && unit.expectedCount > 0)) {
        fail('INVALID_UNITS', 'Event units need unique ids, word/phrase ids, text, ordered bounds, and a positive or unknown expected count.');
      }
      ids.add(unit.id); return clone(unit);
    });
    return { status: 'armed', cadence: 'performance-events', mode: 'syllable', kind, inputMode,
      units: safeUnits, events: [], marks: [], index: 0, pendingStartMs: null, lastMs: null, actionHistory: [] };
  }
  function markEvent(take, scoreMs) {
    if (!take || take.cadence !== 'performance-events') fail('CADENCE_UNSUPPORTED', 'Expected a performance-events take.');
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'Event take is not armed.');
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Event time must be a nonnegative integer number of milliseconds.');
    if (take.lastMs !== null && scoreMs < take.lastMs) fail('NON_MONOTONIC_TIME', 'Events must follow source-time order.');
    if (take.events.length >= 5000) fail('TAKE_LIMIT', 'An event take is limited to 5000 taps.');
    const event = { id: `event-${take.events.length + 1}`, kind: take.kind, sourceMs: scoreMs };
    const snapshot = { events: take.events, index: take.index, lastMs: take.lastMs };
    return { ...take, events: [...take.events, event], lastMs: scoreMs,
      actionHistory: [...take.actionHistory, snapshot].slice(-128) };
  }
  function stopEvents(take) {
    if (!take || take.cadence !== 'performance-events') fail('CADENCE_UNSUPPORTED', 'Expected a performance-events take.');
    return take.status === 'stopped' ? take : { ...take, status: 'stopped', pendingStartMs:null };
  }
  function pressEventHold(take, scoreMs) {
    if(take?.inputMode!=='hold')fail('CADENCE_UNSUPPORTED','Expected syllable holds.');
    if(take.pendingStartMs!==null)fail('ALREADY_HELD','Release the current syllable first.');
    markEvent(take,scoreMs); // Validate without committing an unfinished duration.
    return {...take,pendingStartMs:scoreMs};
  }
  function releaseEventHold(take, scoreMs) {
    if(take?.inputMode!=='hold')fail('CADENCE_UNSUPPORTED','Expected syllable holds.');
    if(take.pendingStartMs===null)fail('NOT_HELD','Press at the syllable beginning first.');
    if(!integerTime(scoreMs)||scoreMs<=take.pendingStartMs)fail('INVALID_TIME','Release must be after the syllable beginning.');
    const next=markEvent({...take,pendingStartMs:null},take.pendingStartMs);
    return {...next,lastMs:scoreMs,events:next.events.map((e,i)=>i===next.events.length-1?{...e,releaseMs:scoreMs}:e)};
  }
  function undoEvent(take) {
    if (!take || take.cadence !== 'performance-events') fail('CADENCE_UNSUPPORTED', 'Expected a performance-events take.');
    if(take.pendingStartMs!==null)return {...take,pendingStartMs:null};
    if (!take.actionHistory?.length) return take;
    const previous = take.actionHistory.at(-1);
    return { ...take, events: previous.events, index: previous.index, lastMs: previous.lastMs,
      units: previous.units || take.units,
      actionHistory: take.actionHistory.slice(0, -1) };
  }
  function rewindEvents(take, phraseId) {
    if (!take || take.cadence !== 'performance-events') fail('CADENCE_UNSUPPORTED', 'Expected a performance-events take.');
    if (take.status !== 'stopped') fail('TAKE_NOT_STOPPED', 'Event rewind requires a stopped take.');
    const phraseUnits = take.units.filter(u => u.phraseId === phraseId);
    if (!phraseUnits.length) fail('UNKNOWN_PHRASE', `Unknown phrase: ${phraseId}`);
    const cutoff = Math.min(...phraseUnits.map(u => u.minMs));
    const events = take.events.filter(e => e.sourceMs < cutoff);
    const snapshot = { events: take.events, index: take.index, lastMs: take.lastMs };
    return { ...take, events, index: take.units.findIndex(u => u.phraseId === phraseId),
      lastMs: events.length ? events.at(-1).releaseMs??events.at(-1).sourceMs : null,
      actionHistory: [...(take.actionHistory || []), snapshot].slice(-128) };
  }
  function associateEvents(take, { counts = {}, gapRatio = 2.5, gapMinMs = 450 } = {}) {
    if (!take || take.cadence !== 'performance-events') fail('CADENCE_UNSUPPORTED', 'Expected a performance-events take.');
    if (!(gapRatio > 1) || !integerTime(gapMinMs)) fail('INVALID_GAP', 'Gap ratio must exceed 1 and the minimum gap must be whole milliseconds.');
    const phrases = [...new Set(take.units.map(u => u.phraseId))].map(phraseId => {
      const units = take.units.filter(u => u.phraseId === phraseId);
      const start = Math.min(...units.map(u => u.minMs)), end = Math.max(...units.map(u => u.maxMs));
      const candidates = take.events.filter(e => e.kind === 'syllable-entrance' && e.sourceMs >= start && e.sourceMs < end);
      const ambiguous = candidates.filter(e => take.units.some(u => u.phraseId !== phraseId && e.sourceMs >= u.minMs && e.sourceMs < u.maxMs));
      const assigned = candidates.filter(e => !ambiguous.includes(e));
      const duplicateTimes = new Set(assigned.filter((e,i) => i > 0 && assigned[i-1].sourceMs === e.sourceMs).map(e=>e.sourceMs));
      const incomplete = take.status === 'stopped' && Number.isSafeInteger(take.stoppedScoreMs) && take.stoppedScoreMs < end;
      const expected = units.map(u => u.expectedCount);
      // A word pass can leave one whole-word syllable as a timing placeholder.
      // New performed entrances establish their count when every entrance has
      // exactly one measured word owner. Never fit gaps or overlapping bounds.
      const bounded = units.every((u,i) => u.referenceManual && integerTime(u.referenceStartMs) && integerTime(u.referenceEndMs) &&
        u.referenceEndMs > u.referenceStartMs && (!i || units[i-1].referenceEndMs <= u.referenceStartMs));
      const owners = bounded ? assigned.map(e => units.findIndex(u => e.sourceMs >= u.referenceStartMs && e.sourceMs < u.referenceEndMs)) : [];
      const observed = units.map((u,i) => owners.filter(owner => owner === i).length);
      const boundaryCounts = bounded && owners.every(i=>i>=0) && observed.every(n=>n>0) ? observed : null;
      const unknownCounts = units.some(u=>u.expectedCount == null && counts[u.wordId] === undefined && !boundaryCounts);
      const options = units.map(u => (u.countOptions || []).map(x => Number.isSafeInteger(x) ? x : x && x.count).filter(x => Number.isSafeInteger(x) && x > 0));
      if (assigned.length === 0 && ambiguous.length === 0) return { phraseId, eventCount: 0,
        expectedCount: expected.every(v=>v!=null)?expected.reduce((a,b)=>a+b,0):null,
        counts: units.map(u=>({wordId:u.wordId,text:u.text,count:null,source:'none',changed:false,uncertain:true})),
        marks:[], gaps:[], issues:[], ready:true };
      let lexicalCounts = expected.map(n=>n || 1), ambiguousCounts = false;
      const supplied = units.map(u => counts[u.wordId]);
      const hasSupplied = supplied.some(v => v !== undefined);
      if (hasSupplied && supplied.some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 1))) fail('INVALID_COUNTS', 'Edited counts must be positive integers.');
      const chosen = units.map((u,i)=>supplied[i] ?? boundaryCounts?.[i] ?? expected[i] ?? 1);
      if (!chosen.every(n=>Number.isSafeInteger(n)&&n>0) || chosen.reduce((a,b)=>a+b,0)!==assigned.length) {
        const alternatives = units.map((u,i) => supplied[i] !== undefined ? [supplied[i]] : boundaryCounts ? [boundaryCounts[i]] : [...new Set([expected[i], ...options[i]].filter(n=>Number.isSafeInteger(n)&&n>0))]);
        const states = new Map([[0, [[]]]]);
        for (const choices of alternatives) {
          const next = new Map();
          for (const [sum, paths] of states) for (const n of choices) if (sum+n <= assigned.length) {
            const list = next.get(sum+n) || [];
            for (const path of paths) if (list.length < 2) list.push([...path,n]);
            next.set(sum+n,list);
          }
          states.clear(); for (const [sum,paths] of next) states.set(sum,paths);
        }
        const solutions = states.get(assigned.length) || [];
        if (solutions.length) { lexicalCounts = solutions[0]; ambiguousCounts = solutions.length > 1 && !hasSupplied; }
        else lexicalCounts = chosen;
      } else lexicalCounts = chosen;
      const finalCounts = lexicalCounts;
      const matched = finalCounts.every(v => Number.isSafeInteger(v) && v > 0) && finalCounts.reduce((a,b)=>a+b,0) === assigned.length;
      const suggested = boundaryCounts ? [...boundaryCounts] : expected.map(n=>n || 1);
      while (suggested.reduce((a,b)=>a+b,0) < assigned.length) {
        const i = units.map((u,j)=>({j,weight:Number.isFinite(u.referenceEndMs-u.referenceStartMs)?Math.max(1,u.referenceEndMs-u.referenceStartMs):1})).sort((a,b)=>b.weight-a.weight)[0].j; suggested[i]++;
      }
      while (suggested.reduce((a,b)=>a+b,0) > assigned.length && suggested.some(n=>n>1)) {
        const i = suggested.findIndex(n=>n>1); suggested[i]--;
      }
      const needsReview = !matched || ambiguous.length > 0 || duplicateTimes.size > 0 || incomplete || ambiguousCounts || unknownCounts;
      const marks = [];
      if (!needsReview) {
        let cursor = 0;
        units.forEach((u, i) => { for (let n=0;n<finalCounts[i];n++) {
          const e = assigned[cursor++], next = assigned[cursor], last = n === finalCounts[i]-1;
          // A word's first entrance is its onset. Its last entrance says nothing
          // about where the word releases: the next tap only bounds it. A manual
          // word end inside that window is kept; otherwise the end stays
          // provisional for word-boundary cleanup.
          let endMs = next ? next.sourceMs : end, endSource = next ? 'next-entrance' : 'phrase-end';
          if (Number.isSafeInteger(e.releaseMs)&&e.releaseMs>e.sourceMs) {endMs=e.releaseMs;endSource='syllable-release';}
          else if (last) {
            const manualEnd = u.referenceManual && Number.isSafeInteger(u.referenceEndMs) && u.referenceEndMs > e.sourceMs && u.referenceEndMs <= endMs;
            if (manualEnd) { endMs = u.referenceEndMs; endSource = 'manual-word-boundary'; }
            else endSource = next ? 'provisional-next-entrance' : 'provisional-phrase-end';
          }
          marks.push({ id: `${u.wordId}-syllable-${n+1}`, syllableId: `${u.wordId}-syllable-${n+1}`, wordId: u.wordId,
            phraseId, startMs: e.sourceMs, endMs, endSource, eventId: e.id });
        }});
      }
      // A long silence between entrances can be a held syllable or a rest. If
      // it lands on a proposed word boundary, the entrance after it may belong
      // to the current word; if it lands inside a word, the word may have
      // ended before it. Either way the boundary is flagged, never fitted.
      const gaps = [];
      if (assigned.length > 2) {
        const intervals = assigned.slice(1).map((e,i) => e.sourceMs - assigned[i].sourceMs).sort((a,b)=>a-b);
        const median = intervals[Math.floor((intervals.length-1)/2)];
        const threshold = Math.max(gapMinMs, Math.round(median * gapRatio));
        for (let i = 1; i < assigned.length; i++) {
          if(Number.isSafeInteger(assigned[i-1].releaseMs))continue; // A measured release already distinguishes sustain from silence.
          const gapMs = assigned[i].sourceMs - assigned[i-1].sourceMs;
          if (gapMs < threshold) continue;
          const before = marks.find(m => m.eventId === assigned[i-1].id), after = marks.find(m => m.eventId === assigned[i].id);
          gaps.push({ afterEventId: assigned[i-1].id, beforeEventId: assigned[i].id, gapMs, thresholdMs: threshold,
            previousWordId: before?.wordId ?? null, nextWordId: after?.wordId ?? null,
            atWordBoundary: before && after ? before.wordId !== after.wordId : null });
        }
      }
      const issues = [];
      if (!matched) issues.push('count-mismatch');
      if (ambiguous.length) issues.push('ambiguous-phrase');
      if (duplicateTimes.size) issues.push('duplicate-time');
      if (incomplete) issues.push('phrase-incomplete');
      if (ambiguousCounts) issues.push('ambiguous-counts');
      if (unknownCounts) issues.push('unknown-count');
      if (gaps.length) issues.push('long-gap-boundary');
      if (matched && units.some((u,i) => u.expectedCount != null && finalCounts[i] < u.expectedCount)) issues.push('count-squished');
      if (matched && units.some((u,i) => u.expectedCount != null && finalCounts[i] !== u.expectedCount) && !issues.includes('count-squished')) issues.push('count-modified');
      return { phraseId, eventCount: assigned.length, expectedCount: expected.every(v=>v!=null)?expected.reduce((a,b)=>a+b,0):null,
        counts: units.map((u,i)=>({ wordId:u.wordId, text:u.text, count:matched?finalCounts[i]:null,
          ...(needsReview ? { suggestedCount:suggested[i] } : {}), source:hasSupplied && supplied[i] !== undefined?'human':boundaryCounts?'manual-word-boundaries':u.countSource==='authored'?'authored':(options[i].includes(finalCounts[i])?'dictionary-alternative':'dictionary'),
          changed: finalCounts[i] != null && finalCounts[i] !== u.expectedCount, uncertain: (u.expectedCount == null && !boundaryCounts && supplied[i] === undefined) || needsReview })),
        marks, gaps, issues, ready: !needsReview };
    });
    const inFrames = new Set(phrases.flatMap(p => take.events.filter(e => e.kind === 'syllable-entrance' && e.sourceMs >= Math.min(...take.units.filter(u=>u.phraseId===p.phraseId).map(u=>u.minMs)) && e.sourceMs < Math.max(...take.units.filter(u=>u.phraseId===p.phraseId).map(u=>u.maxMs))).map(e=>e.id)));
    const unassigned = take.events.filter(e => !inFrames.has(e.id));
    const ready = phrases.every(p=>p.eventCount===0 || p.ready) && !unassigned.some(e=>e.kind==='syllable-entrance');
    return { phrases, unassigned, ready };
  }

  // Word pass over an existing syllable-event recording. Holding a word claims
  // the recorded syllable entrances from its press until the next word's
  // press; its release is the end of its last syllable. Syllable entrance times
  // stay authoritative and are never moved by the word pass.
  function beginWordHolds(units, syllableEvents) {
    if (!Array.isArray(units) || !units.length || units.length > 5000) fail('INVALID_UNITS', 'Provide 1–5000 word units.');
    const ids = new Set();
    const safeUnits = units.map(unit => {
      if (!unit || typeof unit.wordId !== 'string' || !unit.wordId.trim() || ids.has(unit.wordId) || typeof unit.phraseId !== 'string' ||
          typeof unit.text !== 'string' || !integerTime(unit.minMs) || !integerTime(unit.maxMs) || unit.maxMs < unit.minMs) {
        fail('INVALID_UNITS', 'Word units need unique word ids, phrase ids, text and ordered phrase bounds.');
      }
      ids.add(unit.wordId); return clone(unit);
    });
    if (!Array.isArray(syllableEvents) || syllableEvents.length > 5000 ||
        syllableEvents.some(e => !e || typeof e.id !== 'string' || !integerTime(e.sourceMs))) fail('INVALID_EVENTS', 'Syllable events need ids and whole-millisecond source times.');
    const events = clone(syllableEvents).filter(e => (e.kind ?? 'syllable-entrance') === 'syllable-entrance').sort((a, b) => a.sourceMs - b.sourceMs);
    return { status: 'armed', cadence: 'word-holds', mode: 'syllable', units: safeUnits, syllableEvents: events,
      holds: [], marks: [], index: 0, pendingStartMs: null, lastMs: null, actionHistory: [] };
  }
  const holdSnapshot = take => ({ holds: take.holds, index: take.index, pendingStartMs: take.pendingStartMs, lastMs: take.lastMs, status: take.status, retime: take.retime ?? null });
  function assertHoldTake(take) { if (!take || take.cadence !== 'word-holds') fail('CADENCE_UNSUPPORTED', 'Expected a word-holds take.'); }
  function pressWord(take, scoreMs) {
    assertHoldTake(take);
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'Word pass is not armed.');
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Press time must be whole milliseconds.');
    if (take.pendingStartMs !== null) fail('PRESS_PENDING', 'Release the current word first.');
    if (take.lastMs !== null && scoreMs < take.lastMs) fail('NON_MONOTONIC_TIME', 'Word presses must follow source-time order.');
    if (take.index >= take.units.length) fail('TAKE_COMPLETE', 'Every word already has a hold.');
    return { ...take, pendingStartMs: scoreMs, lastMs: scoreMs, actionHistory: [...take.actionHistory, holdSnapshot(take)].slice(-256) };
  }
  function releaseWord(take, scoreMs) {
    assertHoldTake(take);
    if (take.pendingStartMs === null) fail('NO_PRESS', 'Press before releasing.');
    if (!integerTime(scoreMs) || scoreMs < take.pendingStartMs) fail('INVALID_TIME', 'Release must not precede its press.');
    const unit = take.units[take.index];
    const holds = [...take.holds.filter(h => h.wordId !== unit.wordId), { wordId: unit.wordId, phraseId: unit.phraseId, pressMs: take.pendingStartMs, releaseMs: scoreMs }];
    const index = take.index + 1;
    // Retiming one phrase stops after its last word and returns the cursor to where the pass was.
    if (take.retime && (index >= take.units.length || take.units[index].phraseId !== take.retime.phraseId)) {
      return { ...take, holds, index: take.retime.resumeIndex, pendingStartMs: null, retime: null, status: 'stopped',
        lastMs: Math.max(...holds.map(h => h.releaseMs)) };
    }
    return { ...take, holds, index, pendingStartMs: null, lastMs: scoreMs, status: index >= take.units.length ? 'complete' : take.status };
  }
  // Replace only one phrase's holds; every other phrase is kept as recorded.
  function retimePhraseHolds(take, phraseId) {
    assertHoldTake(take);
    if (take.status === 'armed') fail('TAKE_ARMED', 'Stop the pass before retiming a phrase.');
    const at = take.units.findIndex(u => u.phraseId === phraseId);
    if (at < 0) fail('UNKNOWN_PHRASE', `Unknown phrase: ${phraseId}`);
    const holds = take.holds.filter(h => h.phraseId !== phraseId), earlier = new Set(take.units.slice(0, at).map(u => u.wordId));
    const before = holds.filter(h => earlier.has(h.wordId));
    return { ...take, holds, index: at, pendingStartMs: null, status: 'stopped',
      retime: { phraseId, resumeIndex: take.retime?.resumeIndex ?? take.index, previousHolds: take.holds.filter(h => h.phraseId === phraseId) },
      lastMs: before.length ? Math.max(...before.map(h => h.releaseMs)) : null,
      actionHistory: [...take.actionHistory, holdSnapshot(take)].slice(-256) };
  }
  function skipWords(take, delta) {
    assertHoldTake(take);
    if (take.pendingStartMs !== null) fail('PRESS_PENDING', 'Release the current word first.');
    let minIndex = 0, maxIndex = take.units.length - 1;
    if (take.retime) {
      minIndex = take.units.findIndex(unit => unit.phraseId === take.retime.phraseId);
      if (minIndex < 0) fail('UNKNOWN_PHRASE', `Unknown phrase: ${take.retime.phraseId}`);
      maxIndex = minIndex;
      while (maxIndex + 1 < take.units.length && take.units[maxIndex + 1].phraseId === take.retime.phraseId) maxIndex++;
    }
    const index = Math.max(minIndex, Math.min(maxIndex, take.index + delta));
    // Moving back un-claims the words from the new cursor onward so they can be re-held.
    const keep = new Set(take.units.slice(0, index).map(u => u.wordId));
    const holds = delta < 0 ? take.holds.filter(h => take.retime
      ? h.phraseId !== take.retime.phraseId || keep.has(h.wordId)
      : keep.has(h.wordId)) : take.holds;
    // Future holds outside a retimed phrase are retained, but cannot constrain
    // the source time of a new press within that phrase.
    const prior = take.retime ? holds.filter(h => keep.has(h.wordId)) : holds;
    return { ...take, index, holds, lastMs: prior.length ? Math.max(...prior.map(h => h.releaseMs)) : null,
      actionHistory: [...take.actionHistory, holdSnapshot(take)].slice(-256) };
  }
  function undoWordHold(take) {
    assertHoldTake(take);
    if (!take.actionHistory.length) return take;
    const previous = take.actionHistory.at(-1);
    return { ...take, ...previous, status: previous.status === 'complete' ? 'armed' : previous.status, actionHistory: take.actionHistory.slice(0, -1) };
  }
  function stopWordHolds(take) {
    assertHoldTake(take);
    // Stopping mid-retime restores that phrase's earlier holds for any word not yet re-held.
    if (take.retime) {
      const redone = new Set(take.holds.filter(h => h.phraseId === take.retime.phraseId).map(h => h.wordId));
      const holds = [...take.holds, ...take.retime.previousHolds.filter(h => !redone.has(h.wordId))];
      return { ...take, holds, index: take.retime.resumeIndex, retime: null, status: 'stopped', pendingStartMs: null,
        lastMs: holds.length ? Math.max(...holds.map(h => h.releaseMs)) : null };
    }
    return { ...take, status: 'stopped', pendingStartMs: null };
  }
  function rewindWordHolds(take, phraseId) {
    assertHoldTake(take);
    const at = take.units.findIndex(u => u.phraseId === phraseId);
    if (at < 0) fail('UNKNOWN_PHRASE', `Unknown phrase: ${phraseId}`);
    const keep = new Set(take.units.slice(0, at).map(u => u.wordId)), holds = take.holds.filter(h => keep.has(h.wordId));
    return { ...take, holds, index: at, pendingStartMs: null, lastMs: holds.length ? Math.max(...holds.map(h => h.releaseMs)) : null,
      actionHistory: [...take.actionHistory, holdSnapshot(take)].slice(-256) };
  }
  // Tap-tempo: fit a beat grid (period and phase) to source-clock taps.
  // Skipped beats are tolerated by rounding each tap to its nearest beat
  // index before a least-squares fit; residual reports how steady the taps were.
  function estimateTempo(taps, { minBpm = 40, maxBpm = 240 } = {}) {
    if (!Array.isArray(taps) || taps.some(t => !integerTime(t))) fail('INVALID_TAPS', 'Tempo taps must be whole milliseconds.');
    const times = [...taps].sort((a, b) => a - b);
    if (times.length < 4) return null;
    const intervals = times.slice(1).map((t, i) => t - times[i]).filter(d => d > 0).sort((a, b) => a - b);
    if (!intervals.length) return null;
    let period = intervals[Math.floor(intervals.length / 2)];
    if (period < 60000 / maxBpm || period > 60000 / minBpm) return null;
    let anchor = times[0], beats = [];
    for (let pass = 0; pass < 3; pass++) {
      beats = times.map(t => Math.round((t - anchor) / period));
      const n = beats.length, mx = beats.reduce((a, b) => a + b, 0) / n, my = times.reduce((a, b) => a + b, 0) / n;
      const sxx = beats.reduce((a, b) => a + (b - mx) ** 2, 0);
      if (!sxx) return null;
      period = beats.reduce((a, b, i) => a + (b - mx) * (times[i] - my), 0) / sxx;
      anchor = my - period * mx;
    }
    const residualMs = Math.sqrt(times.reduce((a, t, i) => a + (t - (anchor + period * beats[i])) ** 2, 0) / times.length);
    // Report the anchor as the earliest nonnegative beat so it is a valid source time.
    const firstBeatMs = anchor - Math.floor(anchor / period) * period;
    return { bpm: Math.round(60000 / period * 100) / 100, periodMs: Math.round(period * 100) / 100,
      anchorMs: Math.round(firstBeatMs), residualMs: Math.round(residualMs), count: times.length };
  }
  // Tempo is integrated in source time. A linear segment ramps its BPM to the
  // following point; the final point stays constant. Beat phase is continuous.
  function validateTempoMap(map) {
    if (!map || map.version !== 1 || !integerTime(map.anchorMs) || !Array.isArray(map.segments) || !map.segments.length || map.segments.length > 256) fail('INVALID_TEMPO_MAP', 'Tempo needs an anchor and 1–256 sections.');
    let prior = -1;
    if(map.beatsPerBar!==undefined&&(!Number.isSafeInteger(map.beatsPerBar)||map.beatsPerBar<1||map.beatsPerBar>12))fail('INVALID_TEMPO_MAP','Beats per bar must be 1–12.');
    for (const s of map.segments) {
      if (!s || typeof s!=='object' || Array.isArray(s) || !integerTime(s.startMs) || s.startMs <= prior || !Number.isFinite(s.bpm) || s.bpm < 20 || s.bpm > 400 || !['step','linear'].includes(s.transition) || !['manual','tapped','estimated'].includes(s.provenance) || (s.taps!==undefined&&(!Array.isArray(s.taps)||s.taps.length>64||s.taps.some(t=>!integerTime(t))))) fail('INVALID_TEMPO_MAP', 'Tempo sections need increasing source times, 20–400 BPM, a transition and provenance; optional raw taps are bounded whole milliseconds.');
      prior = s.startMs;
    }
    if (map.segments[0].startMs !== 0) fail('INVALID_TEMPO_MAP', 'The first tempo section must start at zero.');
    return JSON.parse(JSON.stringify(map));
  }
  function tempoMapFromEstimate(estimate, taps = []) {
    if (!estimate) return null;
    return validateTempoMap({ version:1, anchorMs:estimate.anchorMs, segments:[{ startMs:0, bpm:estimate.bpm, transition:'step', provenance:'tapped', taps:[...taps] }] });
  }
  function setTempoPoint(map, point) {
    const next = validateTempoMap(map), at = next.segments.findIndex(s => s.startMs === point.startMs);
    if (at >= 0) next.segments[at] = { ...point };
    else next.segments.push({ ...point });
    next.segments.sort((a,b) => a.startMs-b.startMs);
    return validateTempoMap(next);
  }
  function removeTempoPoint(map, startMs) {
    if (startMs === 0) fail('INVALID_TEMPO_MAP', 'Keep the first tempo section.');
    const next = validateTempoMap(map);
    if(!next.segments.some(s=>s.startMs===startMs))fail('INVALID_TEMPO_MAP','Select an existing tempo point to remove.');
    next.segments = next.segments.filter(s => s.startMs !== startMs);
    return validateTempoMap(next);
  }
  function tempoIntegral(map, sourceMs) {
    let beats = 0;
    for (let i = 0; i < map.segments.length; i++) {
      const s = map.segments[i], next = map.segments[i+1];
      if (sourceMs <= s.startMs) break;
      const duration = Math.min(sourceMs, next?.startMs ?? sourceMs)-s.startMs;
      const slope = next && s.transition === 'linear' ? (next.bpm-s.bpm)/(next.startMs-s.startMs) : 0;
      beats += (s.bpm*duration + .5*slope*duration*duration)/60000;
    }
    return beats;
  }
  // Callers validate at mutation/load boundaries; frame reads allocate no map clone.
  function tempoAt(map, sourceMs) {
    if (!map || !Number.isFinite(sourceMs) || sourceMs < 0) return null;
    let index = 0;while(index+1 < map.segments.length && map.segments[index+1].startMs <= sourceMs) index++;
    const s = map.segments[index], next = map.segments[index+1];
    const fraction = next && s.transition === 'linear' ? (sourceMs-s.startMs)/(next.startMs-s.startMs) : 0;
    const bpm = s.bpm + (next ? (next.bpm-s.bpm)*fraction : 0);
    const beat = tempoIntegral(map,sourceMs)-tempoIntegral(map,map.anchorMs);
    return { bpm, beat, phase:beat-Math.floor(beat), index, periodMs:60000/bpm };
  }
  function tempoTimeAtBeat(map, beat) {
    if (!Number.isFinite(beat)) fail('INVALID_BEAT', 'Beat must be finite.');
    const target = beat+tempoIntegral(map,map.anchorMs);
    if (target < 0) return null;
    let low = 0, high = Math.max(map.anchorMs, map.segments.at(-1).startMs, target*3000+1);
    for (let i=0;i<50;i++) { const mid=(low+high)/2;if(tempoIntegral(map,mid)<target)low=mid;else high=mid; }
    return (low+high)/2;
  }
  // Reinterpret a Words-mode hold take (press/release pairs, score clock) as a
  // word pass over recorded syllable taps (source clock). Hyphen parts of one
  // word merge into a single hold from the first press to the last release.
  function wordHoldsFromPairs(pairsTake, units, syllableEvents, offsetMs = 0) {
    if (!pairsTake || pairsTake.cadence !== 'pairs' || !Array.isArray(pairsTake.marks)) fail('CADENCE_UNSUPPORTED', 'Expected a Words hold take.');
    if (!Number.isSafeInteger(offsetMs)) fail('INVALID_OFFSET', 'Offset must be whole milliseconds.');
    const byWord = new Map();
    for (const mark of pairsTake.marks) {
      if (!integerTime(mark.startMs) || !Number.isSafeInteger(mark.endMs) || mark.endMs < mark.startMs) continue;
      const wordId = mark.wordId ?? mark.id, prior = byWord.get(wordId);
      byWord.set(wordId, prior ? { pressMs: Math.min(prior.pressMs, mark.startMs), releaseMs: Math.max(prior.releaseMs, mark.endMs) } : { pressMs: mark.startMs, releaseMs: mark.endMs });
    }
    let take = beginWordHolds(units, syllableEvents);
    const holds = take.units.filter(u => byWord.has(u.wordId)).map(u => {
      const h = byWord.get(u.wordId);
      return { wordId: u.wordId, phraseId: u.phraseId, pressMs: Math.max(0, h.pressMs + offsetMs), releaseMs: Math.max(0, h.releaseMs + offsetMs) };
    });
    const lastHeld = take.units.reduce((at, u, i) => byWord.has(u.wordId) ? i : at, -1);
    return { ...take, holds, index: Math.min(take.units.length - 1, lastHeld + 1), status: 'stopped',
      lastMs: holds.length ? Math.max(...holds.map(h => h.releaseMs)) : null, adoptedFrom: 'words-hold-take' };
  }
  function associateWordHolds(take, { leadMs = 150 } = {}) {
    assertHoldTake(take);
    if (!integerTime(leadMs) || leadMs > 1000) fail('INVALID_LEAD', 'Press lead must be 0–1000 whole milliseconds.');
    const holdFor = new Map(take.holds.map(h => [h.wordId, h]));
    // Presses in source order define claim windows across phrases; a reaction
    // lead lets an entrance just before a press still belong to that word.
    const pressOrder = take.units.filter(u => holdFor.has(u.wordId)).map(u => holdFor.get(u.wordId)).sort((a, b) => a.pressMs - b.pressMs);
    const claimed = new Set();
    // Each tap's owner: the word whose hold contains it; between holds, the
    // next word when its press follows within the reaction lead, otherwise
    // the previous word (flagged as a tap after its release).
    const ownerOf = new Map();
    for (const e of take.syllableEvents) {
      let inside = null, previous = null, next = null;
      for (const h of pressOrder) {
        if (h.pressMs <= e.sourceMs && e.sourceMs <= h.releaseMs) inside = h;
        if (h.pressMs <= e.sourceMs) previous = h;
        else if (!next) next = h;
      }
      const owner = inside || (next && next.pressMs - e.sourceMs <= leadMs ? next : previous || next);
      if (owner) ownerOf.set(e.id, owner.wordId);
    }
    const phrases = [...new Set(take.units.map(u => u.phraseId))].map(phraseId => {
      const units = take.units.filter(u => u.phraseId === phraseId);
      const end = Math.max(...units.map(u => u.maxMs));
      const held = units.filter(u => holdFor.has(u.wordId));
      if (!held.length) return { phraseId, heldCount: 0, words: [], marks: [], issues: [], ready: false };
      const issues = new Set(), words = [], marks = [];
      for (const u of units) {
        const hold = holdFor.get(u.wordId);
        if (!hold) { issues.add('word-not-held'); words.push({ wordId: u.wordId, text: u.text, held: false, count: 0, issues: ['word-not-held'] }); continue; }
        const candidates = take.syllableEvents.filter(e => ownerOf.get(e.id) === u.wordId && !claimed.has(e.id));
        const own=candidates.filter(e=>e.sourceMs<hold.releaseMs);
        own.forEach(e => claimed.add(e.id));
        const wordIssues = [];
        if (!own.length) wordIssues.push('no-syllable-claimed');
        if (candidates.length!==own.length) wordIssues.push('syllable-after-release');
        if (Number.isSafeInteger(u.expectedCount) && own.length && own.length !== u.expectedCount) wordIssues.push('count-differs');
        const entrances = own.length ? own : [{ id: `press-${u.wordId}`, sourceMs: hold.pressMs, synthetic: true }];
        entrances.forEach((e, i) => {
          const last = i === entrances.length - 1;
          const startMs=Math.max(hold.pressMs,e.sourceMs);
          const bound=last?hold.releaseMs:Math.min(hold.releaseMs,Math.max(hold.pressMs,entrances[i+1].sourceMs));
          const measured=Number.isSafeInteger(e.releaseMs)&&e.releaseMs>startMs&&e.releaseMs<=bound;
          const endMs=measured?e.releaseMs:bound,endSource=measured?'syllable-release':last?'word-release':'next-entrance';
          if(endMs<=startMs)wordIssues.push('collapsed-syllables');
          marks.push({ id: `${u.wordId}-syllable-${i + 1}`, syllableId: `${u.wordId}-syllable-${i + 1}`, wordId: u.wordId, phraseId,
            startMs, endMs, endSource, eventId: e.synthetic ? null : e.id, startSource: e.synthetic ? 'word-press' : startMs!==e.sourceMs?'word-start-bound':'syllable-entrance' });
        });
        wordIssues.forEach(i => issues.add(i));
        words.push({ wordId: u.wordId, text: u.text, held: true, pressMs: hold.pressMs, releaseMs: hold.releaseMs, count: own.length,
          expectedCount: u.expectedCount ?? null, issues: wordIssues });
      }
      // A word must start after the previous word's last entrance.
      for (let i = 1; i < marks.length; i++) if (marks[i].startMs <= marks[i - 1].startMs) issues.add('order-conflict');
      // Legato releases often run into the next word; the next entrance wins and the trim is flagged.
      for (let i = 0; i + 1 < marks.length; i++) {
        if (marks[i].endMs <= marks[i + 1].startMs || marks[i + 1].startMs <= marks[i].startMs) continue;
        marks[i].endMs = marks[i + 1].startMs;
        if (marks[i].endSource === 'word-release') {
          marks[i].endSource = 'word-release-trimmed';
          const word = words.find(w => w.wordId === marks[i].wordId);
          if (word && !word.issues.includes('release-overlaps-next')) word.issues.push('release-overlaps-next');
          issues.add('release-overlaps-next');
        }
      }
      const blocking = ['word-not-held', 'order-conflict','collapsed-syllables'];
      return { phraseId, heldCount: held.length, words, marks, issues: [...issues], ready: !blocking.some(b => issues.has(b)) };
    });
    const unclaimed = take.syllableEvents.filter(e => !claimed.has(e.id));
    return { phrases, unclaimed, ready: phrases.every(p => p.heldCount === 0 || p.ready) };
  }

  // Listening moves only the cursor. It never creates marks, removes a take,
  // or advances a word that is currently held by the performer.
  function followPlayback(take, nowMs, { rewind = false } = {}) {
    if (!take || take.status !== 'armed' || !integerTime(nowMs) || take.pendingStartMs !== null ||
        !(take.cadence === 'word-holds' || take.mode === 'word' || take.mode === 'phrase')) return take;
    const recordedEnds=new Map(take.cadence==='word-holds'?(take.holds||[]).map(h=>[h.wordId,h.releaseMs]):(take.marks||[]).map(m=>[m.id,m.endMs]));
    const recordedStarts=new Map(take.cadence==='word-holds'?(take.holds||[]).map(h=>[h.wordId,h.pressMs]):(take.marks||[]).map(m=>[m.id,m.startMs]));
    const eligible = take.units.map((unit,index)=>({unit,index})).filter(({unit})=>!take.retime||unit.phraseId===take.retime.phraseId);
    // A recorded entrance supersedes an earlier word's stale estimated end.
    const entered=eligible.filter(({unit})=>nowMs>=(recordedStarts.get(take.cadence==='word-holds'?unit.wordId:unit.id)??Infinity)).at(-1)?.index??0;
    const candidates=eligible.filter(({index})=>index>=entered);
    const found = candidates.find(({unit})=>nowMs < (recordedEnds.get(take.cadence==='word-holds'?unit.wordId:unit.id) ?? unit.referenceEndMs ?? unit.estimatedEndMs ?? unit.maxMs)) || candidates.at(-1);
    if (!found) return take;
    const index = rewind ? found.index : Math.max(take.index,found.index);
    return index === take.index ? take : {...take,index};
  }

  // Seek/listen is lossless. Only the first new press replaces the suffix,
  // with a snapshot so Undo can recover the original recorded evidence.
  function punchIn(take, nowMs, { phraseId = null } = {}) {
    if (!take || !integerTime(nowMs)) fail('INVALID_TIME','Punch-in needs a nonnegative source-clock time.');
    if (take.cadence === 'performance-events') {
      const events = take.events.filter(event=>event.sourceMs < nowMs&&(event.releaseMs??event.sourceMs)<=nowMs);
      const units = take.units.map(unit=>unit.phraseId===phraseId&&nowMs<unit.minMs?{...unit,minMs:nowMs}:unit);
      return {...take,units,events,pendingStartMs:null,lastMs:events.at(-1)?.releaseMs??events.at(-1)?.sourceMs??null,status:'armed',
        actionHistory:[...take.actionHistory,{events:take.events,index:take.index,lastMs:take.lastMs,units:take.units}].slice(-128)};
    }
    if (take.cadence === 'word-holds') {
      const earlier = new Set(take.units.slice(0,take.index).map(unit=>unit.wordId));
      const holds = take.holds.filter(hold=>earlier.has(hold.wordId)&&hold.releaseMs<=nowMs||take.retime&&hold.phraseId!==take.retime.phraseId);
      const prior = holds.filter(hold=>earlier.has(hold.wordId));
      return {...take,holds,pendingStartMs:null,lastMs:prior.length?Math.max(...prior.map(h=>h.releaseMs)):null,status:'armed',
        actionHistory:[...take.actionHistory,holdSnapshot(take)].slice(-256)};
    }
    if (take.mode === 'word' || take.mode === 'phrase') {
      const next=reposition(take,take.index),marks=next.marks.filter(mark=>mark.endMs<=nowMs);
      return withFlowHistory(take,{...next,marks,lastMs:marks.at(-1)?.endMs??null,status:'armed'});
    }
    let next=take;
    while(next.lastMs!==null&&next.lastMs>=nowMs){const prior=undo(next);if(prior===next)break;next=prior;}
    return {...next,status:'armed'};
  }

  return { begin, mark, release, undo, stop, adjust, reposition, followPlayback, punchIn, moveCursor, reassignLast, restoreWordFrameTake, rewindToPhrase, restorePhraseStreamTake,
    beginEvents, markEvent, pressEventHold, releaseEventHold, stopEvents, undoEvent, rewindEvents, associateEvents,
    beginWordHolds, pressWord, releaseWord, skipWords, undoWordHold, stopWordHolds, rewindWordHolds, retimePhraseHolds, associateWordHolds, wordHoldsFromPairs, estimateTempo,
    leadInProgress, captureProgress, validateTempoMap, tempoMapFromEstimate, setTempoPoint, removeTempoPoint, tempoAt, tempoTimeAtBeat };
});
