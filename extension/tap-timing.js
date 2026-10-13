/* Immutable source-time tap take state machine for word or syllable timing. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTapTiming = api;
})(globalThis, function() {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const integerTime = n => Number.isSafeInteger(n) && n >= 0;

  function begin(units, options = {}) {
    if (!Array.isArray(units) || units.length === 0) fail('INVALID_UNITS', 'Provide at least one timing unit.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Timing options must be an object.');
    const mode = options.mode === undefined ? 'word' : options.mode;
    if (mode !== 'word' && mode !== 'phrase' && mode !== 'syllable') fail('INVALID_MODE', 'Mode must be word, phrase, or syllable.');
    const cadence = options.cadence === undefined ? 'pairs' : options.cadence;
    if (cadence !== 'pairs' && cadence !== 'flow' && cadence !== 'subdivide' && cadence !== 'entrances' && cadence !== 'word-frames' && cadence !== 'phrase-stream') fail('INVALID_CADENCE', 'Cadence must be pairs, flow, subdivide, entrances, word-frames, or phrase-stream.');
    if (['subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(cadence) && mode !== 'syllable') fail('INVALID_CADENCE', 'Subdivide, entrances, word-frames, and phrase-stream cadences require syllable mode.');
    const bpm = options.bpm === undefined || options.bpm === null ? null : options.bpm;
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
    if (!['flow', 'subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(previous.cadence)) return next;
    const history = [...(previous.actionHistory || []), flowSnapshot(previous)].slice(-FLOW_HISTORY_LIMIT);
    return { ...next, actionHistory: history };
  }

  function acceptedTime(take, scoreMs, unit, firstStart) {
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Tap time must be a nonnegative integer number of milliseconds.');
    if (scoreMs < unit.minMs || scoreMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Tap is outside the current unit bounds.');
    let originMs = take.originMs;
    if (firstStart && originMs === null) originMs = scoreMs;
    let acceptedMs = scoreMs;
    if (take.bpm !== null && !(firstStart && take.originMs === null)) {
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
      return take.cadence === 'flow' ? withFlowHistory(take, next) : next;
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
    return take.cadence === 'flow' ? withFlowHistory(take, next) : next;
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
    return take.cadence === 'flow' ? withFlowHistory(take, next) : next;
  }

  function undo(take) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (['flow', 'subdivide', 'entrances', 'word-frames', 'phrase-stream'].includes(take.cadence) && take.actionHistory && take.actionHistory.length) {
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

  return { begin, mark, release, undo, stop, adjust, reposition, moveCursor, reassignLast, restoreWordFrameTake, rewindToPhrase, restorePhraseStreamTake };
});
