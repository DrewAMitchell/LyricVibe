/* Catalog timing migration builds previews; it does not align acoustic evidence. */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./score-core.js') : root.LvScore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTimingVariant = api;
})(globalThis, function(core) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const protectedWord = w => w.excluded === true || w.locked || w.provenance !== 'estimated' || (w.syllables || []).some(s => s.locked || s.provenance !== 'estimated');
  function merge(base, candidate) {
    core.validateScore(base); core.validateScore(candidate);
    if (core.mediaKey(base.source) !== core.mediaKey(candidate.source)) fail('SOURCE_MISMATCH', 'Timing source belongs to another video.');
    if (base.phrases.length !== candidate.phrases.length) fail('LYRICS_CHANGED', 'The lyric structure changed. Keep the saved score and review the text separately.');
    const next = clone(base), protectedIds = [], preservedPhraseIds = [];
    let changedWords = 0;
    for (const phrase of next.phrases) {
      const proposed = candidate.phrases.find(p => p.id === phrase.id);
      if (!proposed || !sameWordsOrHyphenSplit(phrase.words, proposed.words)) fail('LYRICS_CHANGED', 'Timing migration requires the same words and grouping.');
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
  function sameWordsOrHyphenSplit(savedWords, proposedWords) {
    let i = 0, j = 0;
    while (i < savedWords.length && j < proposedWords.length) {
      const saved = savedWords[i], proposed = proposedWords[j];
      if (saved.id === proposed.id && saved.text === proposed.text) { i++; j++; continue; }
      const parts = core.hyphenWordParts(proposed.text);
      if (parts.length < 2 || saved.id !== proposed.id || saved.text !== parts[0]) return false;
      for (let k = 0; k < parts.length; k++) {
        const fragment = savedWords[i + k];
        if (!fragment || fragment.id !== `${proposed.id}${k ? `-hyphen-${k + 1}` : ''}` || fragment.text !== parts[k] || !fragment.locked || fragment.provenance !== 'manual') return false;
      }
      i += parts.length; j++;
    }
    return i === savedWords.length && j === proposedWords.length;
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
      if (change.hyphenParts !== undefined) {
        const expected = core.hyphenWordParts(word.text);
        const parts = change.hyphenParts;
        if (expected.length < 2 || !Array.isArray(parts) || parts.length !== expected.length || parts.some((part, i) => !part || part.text !== expected[i])) fail('INVALID_TIMING', 'Hyphen parts must match the complete source word exactly.');
        if ((word.syllables || []).length) fail('INVALID_SYLLABLES', 'Clear authored syllables before splitting a word into hyphen parts.');
        if (![change.startMs, change.endMs].every(n => Number.isSafeInteger(n) && n >= 0) || change.endMs <= change.startMs || change.endMs > next.source.durationMs || parts[0].startMs !== change.startMs || parts.at(-1).endMs !== change.endMs) fail('INVALID_TIMING', 'Hyphen part bounds must match the parent timing and fit within the video.');
        let priorEnd = change.startMs;
        for (const part of parts) {
          if (!Number.isSafeInteger(part.startMs) || !Number.isSafeInteger(part.endMs) || part.startMs < change.startMs || part.endMs > change.endMs || part.startMs < priorEnd || part.endMs <= part.startMs) fail('INVALID_TIMING', 'Hyphen parts need positive ordered nonoverlapping whole-millisecond timings.');
          priorEnd = part.endMs;
        }
        const generatedIds = parts.slice(1).map((_, i) => `${word.id}-hyphen-${i + 2}`);
        const ids = new Set(next.phrases.flatMap(p => p.words.map(w => w.id)));
        if (generatedIds.some(id => ids.has(id))) fail('INVALID_TIMING', 'A generated hyphen part ID already exists.');
        const replacements = parts.map((part, i) => ({ ...clone(word), id: i ? generatedIds[i - 1] : word.id, text: part.text, startMs: part.startMs, endMs: part.endMs, provenance: 'manual', locked: true }));
        const at = phrase.words.findIndex(item => item.id === word.id);
        phrase.words.splice(at, 1, ...replacements);
        phrase.startMs = Math.min(...phrase.words.map(w => w.startMs)); phrase.endMs = Math.max(...phrase.words.map(w => w.endMs)); phrase.endEstimated = false;
        continue;
      }
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
    if (!operations.length || operations.length > 5000) fail('INVALID_OPERATION', 'Provide one to 5000 score operations.');
    // Apply against a private copy so a failed batch cannot leave a partial preview.
    let score = clone(draft.score);
    for (const submitted of operations) {
      if (!submitted || !['setStageRegion','deleteStageRegion','setWordAppearance','setOffset', 'shiftPhrases', 'setWordDisplayMode', 'setBeatCue', 'deleteBeatCue', 'setPhrasePersistence', 'setPhraseTiming', 'setPhraseLane', 'insertPhrase', 'setWordText', 'setWordSyllables', 'setSyllableTiming', 'setSyllableLock', 'setWordEffect', 'setSyllableEffect', 'setWordExcluded', 'replaceWords', 'setPhraseSyllableTimings', 'setPhraseSyllablePerformance'].includes(submitted.type)) fail('INVALID_OPERATION', 'This operation is not supported in the timing preview.');
      const op = clone(submitted);
      let wordId = op.wordId;
      const effectOnly = ['setStageRegion','deleteStageRegion','setWordAppearance','setWordDisplayMode','setBeatCue','deleteBeatCue','setPhrasePersistence'].includes(op.type) || op.type === 'setWordEffect' || op.type === 'setSyllableEffect' || op.type === 'setPhraseLane';
      if (!allowProtected && (op.type === 'setOffset' || op.type === 'shiftPhrases') && score.phrases.some(p => (op.type === 'setOffset' || op.phraseIds?.includes(p.id)) && p.words.some(w => draft.protectedIds.includes(w.id)))) fail('MANUAL_PROTECTED', 'Enable editing saved timings before moving protected phrases.');
      if (op.type === 'replaceWords' && !allowProtected && Array.isArray(op.wordIds) && op.wordIds.some(id => draft.protectedIds.includes(id))) fail('MANUAL_PROTECTED', 'Enable editing saved timings before replacing words in this protected phrase.');
      if (op.type === 'setPhraseSyllableTimings' && !allowProtected && Array.isArray(op.marks)) {
        const syllableIds = new Set(op.marks.map(mark => mark?.syllableId));
        const phrase = score.phrases.find(item => item.id === op.phraseId);
        if (phrase?.words.some(word => draft.protectedIds.includes(word.id) && (word.syllables || []).some(syllable => syllableIds.has(syllable.id)))) fail('MANUAL_PROTECTED', 'Enable editing saved timings before changing syllables in this protected phrase.');
      }
      if (op.type === 'setPhraseSyllablePerformance' && !allowProtected && Array.isArray(op.words) && op.words.some(item => draft.protectedIds.includes(item?.wordId))) fail('MANUAL_PROTECTED', 'Enable editing saved timings before replacing performance timings in this protected phrase.');
      if (op.type === 'setPhraseTiming') {
        const phrase=score.phrases.find(p=>p.id===op.phraseId);
        if (!phrase) fail('UNKNOWN_ID','Choose a phrase from this preview.');
        if (!Number.isSafeInteger(op.startMs)||!Number.isSafeInteger(op.endMs)||op.endMs<=op.startMs) fail('INVALID_TIME','Use whole milliseconds with a positive phrase interval.');
        if (!allowProtected && phrase.words.some(w=>draft.protectedIds.includes(w.id))) fail('MANUAL_PROTECTED','Enable editing saved timings before changing this protected phrase.');
      }
      if (op.type === 'setSyllableTiming' || op.type === 'setSyllableLock' || op.type === 'setSyllableEffect') {
        wordId = score.phrases.flatMap(p => p.words).find(w => (w.syllables || []).some(s => s.id === op.syllableId))?.id;
        if (!wordId) fail('UNKNOWN_ID', 'Choose a syllable from this preview.');
        if (op.type === 'setSyllableTiming' && (!Number.isSafeInteger(op.startMs) || !Number.isSafeInteger(op.endMs) || op.endMs <= op.startMs)) fail('INVALID_TIME', 'Use whole milliseconds with a positive syllable interval.');
      }
      if (!effectOnly && draft.protectedIds.includes(wordId) && !allowProtected) fail('MANUAL_PROTECTED', 'Enable editing saved timings before changing this protected phrase.');
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
  function copyToRecording(draft, saved, deltaMs = 0) {
    core.validateScore(draft.score); core.validateScore(saved);
    if (!saved.phrases.some(p => p.words.length)) fail('LYRICS_MISSING', 'That saved synchronization has no lyric phrases to copy.');
    if (core.mediaKey(draft.score.source) === core.mediaKey(saved.source)) fail('SOURCE_MISMATCH', 'Choose a synchronization from another video.');
    if (!Number.isSafeInteger(deltaMs) || !Number.isSafeInteger(saved.offsetMs + deltaMs)) fail('INVALID_TIME', 'Enter a whole-millisecond offset.');
    const score = clone(saved);
    score.source = clone(draft.score.source); score.revision = draft.score.revision;
    score.offsetMs += deltaMs;
    // Beat observations belong to the source recording's separately owned tempo
    // map. Lyric timing and word/syllable appearance can be copied independently.
    delete score.beatCues;
    score.lyrics.timingCopy = { mediaKey: core.mediaKey(saved.source), title: saved.source.title, revision: saved.revision, lyricsHash: saved.lyrics.contentHash };
    const protectedIds = score.phrases.flatMap(p => p.words.filter(protectedWord).map(w => w.id));
    return { ...draft, score: core.validateScore(score), protectedIds, preservedPhraseIds: [], changedWords: score.phrases.reduce((n,p) => n+p.words.length,0) };
  }
  return { merge, tune, operate, copyToRecording };
});
