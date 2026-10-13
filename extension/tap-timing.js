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
    if (cadence !== 'pairs' && cadence !== 'flow' && cadence !== 'subdivide' && cadence !== 'entrances' && cadence !== 'word-frames') fail('INVALID_CADENCE', 'Cadence must be pairs, flow, subdivide, entrances, or word-frames.');
    if (['subdivide', 'entrances', 'word-frames'].includes(cadence) && mode !== 'syllable') fail('INVALID_CADENCE', 'Subdivide, entrances, and word-frames cadences require syllable mode.');
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
      ...(['flow', 'subdivide', 'entrances', 'word-frames'].includes(cadence) ? { actionHistory: [] } : {}),
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
    if (!['flow', 'subdivide', 'entrances', 'word-frames'].includes(previous.cadence)) return next;
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

  function mark(take, scoreMs, options = {}) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Mark options must be an object.');
    const repeat = options.repeat === true;
    if (repeat) return take;
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Tap time must be a nonnegative integer number of milliseconds.');
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'This take is no longer accepting taps.');
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
    if (['subdivide', 'entrances'].includes(take.cadence)) fail('RELEASE_UNSUPPORTED', 'This cadence closes at syllable entrances and the parent end.');
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
    if (['flow', 'subdivide', 'entrances', 'word-frames'].includes(take.cadence) && take.actionHistory && take.actionHistory.length) {
      const previous = take.actionHistory[take.actionHistory.length - 1];
      return { ...previous, actionHistory: take.actionHistory.slice(0, -1) };
    }
    if (take.cadence === 'word-frames') return take;
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
    if (take.cadence === 'word-frames') {
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

  return { begin, mark, release, undo, stop, adjust, reposition };
});
