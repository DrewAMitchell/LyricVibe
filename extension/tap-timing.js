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
    if (mode !== 'word' && mode !== 'syllable') fail('INVALID_MODE', 'Mode must be word or syllable.');
    const cadence = options.cadence === undefined ? 'pairs' : options.cadence;
    if (cadence !== 'pairs' && cadence !== 'flow' && cadence !== 'subdivide') fail('INVALID_CADENCE', 'Cadence must be pairs, flow, or subdivide.');
    if (cadence === 'subdivide' && mode !== 'syllable') fail('INVALID_CADENCE', 'Subdivide cadence requires syllable mode.');
    const bpm = options.bpm === undefined || options.bpm === null ? null : options.bpm;
    if (bpm !== null && !(typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400)) {
      fail('INVALID_BPM', 'BPM must be between 20 and 400.');
    }
    const ids = new Set();
    const safeUnits = units.map(unit => {
      if (!unit || typeof unit !== 'object' || Array.isArray(unit) || typeof unit.id !== 'string' || !unit.id.trim() ||
          ids.has(unit.id) || typeof unit.wordId !== 'string' || !unit.wordId.trim() ||
          (unit.syllableId !== undefined && (typeof unit.syllableId !== 'string' || !unit.syllableId.trim())) ||
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
      originMs: cadence === 'subdivide' ? safeUnits[0].minMs : null,
      ...(['flow', 'subdivide'].includes(cadence) ? { actionHistory: [] } : {}),
    };
  }

  // Flow/subdivide actions can close one unit and open the next with one
  // keypress. Keep bounded, nonrecursive snapshots for one-action Undo.
  const FLOW_HISTORY_LIMIT = 128;
  function flowSnapshot(take) {
    const { actionHistory, ...snapshot } = take;
    return snapshot;
  }
  function withFlowHistory(previous, next) {
    if (!['flow', 'subdivide'].includes(previous.cadence)) return next;
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

  function mark(take, scoreMs, options = {}) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'Mark options must be an object.');
    const repeat = options.repeat === true;
    if (repeat) return take;
    if (!integerTime(scoreMs)) fail('INVALID_TIME', 'Tap time must be a nonnegative integer number of milliseconds.');
    if (take.status !== 'armed') fail('TAKE_CLOSED', 'This take is no longer accepting taps.');
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
    if (take.cadence === 'subdivide') fail('RELEASE_UNSUPPORTED', 'Subdivide cadence closes at internal taps and the parent end.');
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
    if (['flow', 'subdivide'].includes(take.cadence) && take.actionHistory && take.actionHistory.length) {
      const previous = take.actionHistory[take.actionHistory.length - 1];
      return { ...previous, actionHistory: take.actionHistory.slice(0, -1) };
    }
    if (take.cadence === 'subdivide' && take.units.length === 1) return take;
    if (take.cadence === 'subdivide') return take;
    if (take.pendingStartMs !== null) {
      return { ...take, pendingStartMs: null, lastMs: take.marks.length ? take.marks[take.marks.length - 1].endMs : null,
        originMs: take.marks.length ? take.originMs : null, status: 'armed' };
    }
    if (!take.marks.length) return take;
    const marks = take.marks.slice(0, -1), index = marks.length;
    return { ...take, marks, index, pendingStartMs: null, lastMs: marks.length ? marks[marks.length - 1].endMs : null,
      originMs: marks.length ? take.originMs : null, status: 'armed' };
  }

  function stop(take) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
    if (take.status === 'stopped' && take.pendingStartMs === null) return take;
    return { ...take, pendingStartMs: null, status: 'stopped',
      lastMs: take.marks.length ? take.marks[take.marks.length - 1].endMs : null,
      originMs: take.marks.length ? take.originMs : null };
  }

  return { begin, mark, release, undo, stop };
});
