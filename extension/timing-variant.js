/* Catalog timing migration builds previews; it does not align acoustic evidence. */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./score-core.js') : root.LvScore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTimingVariant = api;
})(globalThis, function(core) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const protectedWord = w => w.locked || w.provenance !== 'estimated' || (w.syllables || []).some(s => s.locked || s.provenance !== 'estimated');
  function merge(base, candidate) {
    core.validateScore(base); core.validateScore(candidate);
    if (core.mediaKey(base.source) !== core.mediaKey(candidate.source)) fail('SOURCE_MISMATCH', 'Timing source belongs to another video.');
    if (base.phrases.length !== candidate.phrases.length) fail('LYRICS_CHANGED', 'The lyric structure changed. Keep the saved score and review the text separately.');
    const next = clone(base), protectedIds = [], preservedPhraseIds = [];
    let changedWords = 0;
    for (const phrase of next.phrases) {
      const proposed = candidate.phrases.find(p => p.id === phrase.id);
      if (!proposed || proposed.words.length !== phrase.words.length || phrase.words.some((w, i) => w.id !== proposed.words[i].id || w.text !== proposed.words[i].text)) fail('LYRICS_CHANGED', 'Timing migration requires the same words and grouping.');
      // Preserve the whole phrase to avoid a long display spanning two timelines.
      if (phrase.words.some(protectedWord)) {
        protectedIds.push(...phrase.words.map(w => w.id)); preservedPhraseIds.push(phrase.id); continue;
      }
      phrase.startMs = proposed.startMs; phrase.endMs = proposed.endMs; phrase.endEstimated = proposed.endEstimated;
      for (let i = 0; i < phrase.words.length; i++) {
        const word = phrase.words[i], replacement = proposed.words[i];
        const oldStart = word.startMs, oldSpan = word.endMs - oldStart;
        if (word.startMs !== replacement.startMs || word.endMs !== replacement.endMs) changedWords++;
        for (const s of word.syllables || []) {
          const span = replacement.endMs - replacement.startMs;
          s.startMs = replacement.startMs + Math.round((oldSpan ? (s.startMs - oldStart) / oldSpan : 0) * span);
          s.endMs = replacement.startMs + Math.round((oldSpan ? (s.endMs - oldStart) / oldSpan : 1) * span);
        }
        word.startMs = replacement.startMs; word.endMs = replacement.endMs; word.provenance = 'estimated';
      }
    }
    next.lyrics = clone(candidate.lyrics); next.revision = base.revision + 1;
    return { score: core.validateScore(next), protectedIds, preservedPhraseIds, changedWords };
  }
  function tune(draft, changes, allowProtected = false) {
    if (!Array.isArray(changes) || changes.length > 5000) fail('INVALID_TIMING', 'Provide a bounded list of word timings.');
    const next = clone(draft.score), seen = new Set();
    for (const change of changes) {
      if (!change || seen.has(change.wordId)) fail('INVALID_TIMING', 'Each word may occur once per adjustment.');
      seen.add(change.wordId);
      const phrase = next.phrases.find(p => p.words.some(w => w.id === change.wordId));
      const word = phrase?.words.find(w => w.id === change.wordId);
      if (!word) fail('UNKNOWN_ID', 'Choose a word from this preview.');
      if (draft.protectedIds.includes(word.id) && !allowProtected) fail('MANUAL_PROTECTED', 'Enable editing saved timings before changing this protected phrase.');
      if (![change.startMs, change.endMs].every(n => Number.isSafeInteger(n) && n >= 0) || change.endMs < change.startMs || change.endMs > next.source.durationMs) fail('INVALID_TIMING', 'Use whole milliseconds within the video, with end after start.');
      const oldSpan = word.endMs - word.startMs;
      for (const s of word.syllables || []) {
        const span = change.endMs - change.startMs;
        s.startMs = change.startMs + Math.round((oldSpan ? (s.startMs - word.startMs) / oldSpan : 0) * span);
        s.endMs = change.startMs + Math.round((oldSpan ? (s.endMs - word.startMs) / oldSpan : 1) * span);
      }
      word.startMs = change.startMs; word.endMs = change.endMs; word.provenance = 'manual'; word.locked = true;
      phrase.startMs = Math.min(...phrase.words.map(w => w.startMs)); phrase.endMs = Math.max(...phrase.words.map(w => w.endMs)); phrase.endEstimated = false;
    }
    return { ...draft, score: core.validateScore(next) };
  }
  function operate(draft, operation, allowProtected = false) {
    const operations = Array.isArray(operation) ? operation : [operation];
    if (!operations.length || operations.length > 128) fail('INVALID_OPERATION', 'Provide one to 128 syllable operations.');
    // Apply against a private copy so a failed batch cannot leave a partial preview.
    let score = clone(draft.score);
    for (const submitted of operations) {
      if (!submitted || !['setWordSyllables', 'setSyllableTiming'].includes(submitted.type)) fail('INVALID_OPERATION', 'Only syllable segmentation and timing may be changed in this preview.');
      const op = clone(submitted);
      let wordId = op.wordId;
      if (op.type === 'setSyllableTiming') {
        wordId = score.phrases.flatMap(p => p.words).find(w => (w.syllables || []).some(s => s.id === op.syllableId))?.id;
        if (!wordId) fail('UNKNOWN_ID', 'Choose a syllable from this preview.');
        if (!Number.isSafeInteger(op.startMs) || !Number.isSafeInteger(op.endMs) || op.endMs <= op.startMs) fail('INVALID_TIME', 'Use whole milliseconds with a positive syllable interval.');
      }
      if (draft.protectedIds.includes(wordId) && !allowProtected) fail('MANUAL_PROTECTED', 'Enable editing saved timings before changing this protected phrase.');
      // This explicit mode is used for newly split children that will be tapped;
      // preserve the core operation as the authority for IDs, text and bounds.
      if (op.type === 'setWordSyllables' && op.startTapping === true) {
        delete op.startTapping;
        if (Array.isArray(op.syllables)) op.syllables = op.syllables.map(s => ({ ...s, provenance: 'estimated', locked: false }));
      }
      score = core.applyOperation(score, op, score.revision);
      score.revision = draft.score.revision;
    }
    return { ...draft, score: core.validateScore(score) };
  }
  return { merge, tune, operate };
});
