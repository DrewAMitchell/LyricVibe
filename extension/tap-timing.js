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
    return { status: 'armed', index: 0, pendingStartMs: null, marks: [], lastMs: null,
      units: safeUnits, mode, bpm, originMs: null };
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
    if (firstStart && scoreMs < unit.minMs || firstStart && scoreMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Tap is outside the current unit bounds.');
    if (!firstStart && (scoreMs < unit.minMs || scoreMs > unit.maxMs)) fail('OUT_OF_BOUNDS', 'Tap is outside the current unit bounds.');
    if (firstStart && take.marks.length && scoreMs < take.marks[take.marks.length - 1].endMs) {
      fail('OVERLAP', 'A unit cannot start before the previous unit ends.');
    }
    let originMs = take.originMs;
    if (firstStart && originMs === null) originMs = scoreMs;
    let acceptedMs = scoreMs;
    if (take.bpm !== null && !(firstStart && take.originMs === null)) {
      const quantum = 60000 / take.bpm / 4;
      acceptedMs = Math.round((scoreMs - originMs) / quantum) * quantum + originMs;
      acceptedMs = Math.round(acceptedMs);
      if (acceptedMs < unit.minMs || acceptedMs > unit.maxMs) fail('OUT_OF_BOUNDS', 'Snapped tap is outside the current unit bounds.');
    }
    if (firstStart) {
      if (take.marks.length && acceptedMs < take.marks[take.marks.length - 1].endMs) fail('OVERLAP', 'A unit cannot start before the previous unit ends.');
      return { ...take, pendingStartMs: acceptedMs, originMs, lastMs: acceptedMs };
    }
    if (acceptedMs <= take.pendingStartMs) fail('INVALID_INTERVAL', 'End tap must be strictly after the start tap.');
    const entry = { id: unit.id, wordId: unit.wordId,
      ...(unit.syllableId === undefined ? {} : { syllableId: unit.syllableId }),
      startMs: take.pendingStartMs, endMs: acceptedMs };
    const marks = [...take.marks, entry], index = take.index + 1;
    return { ...take, marks, index, pendingStartMs: null, lastMs: acceptedMs,
      status: index === take.units.length ? 'complete' : 'armed' };
  }

  function undo(take) {
    if (!take || !['armed', 'complete', 'stopped'].includes(take.status)) fail('INVALID_TAKE', 'Provide a take returned by begin.');
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

  return { begin, mark, undo, stop };
});
