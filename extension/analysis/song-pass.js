(function (root) {
  'use strict';
  const MAX_SONG_MS = 20 * 60 * 1000;
  const WINDOW_MS = 11500;
  const RATE = 16000;
  function plan(score) {
    const duration = score.source.durationMs;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_SONG_MS) throw Object.assign(new Error('Whole-song alignment supports recordings up to 20 minutes with a known duration.'), { code: 'SONG_DURATION_UNSUPPORTED' });
    const windows = [], skipped = [];
    for (const phrase of score.phrases) {
      const overlap = score.phrases.some(other => other.id !== phrase.id && other.laneId !== phrase.laneId && other.startMs < phrase.endMs && other.endMs > phrase.startMs);
      for (let start = phrase.startMs; start < phrase.endMs; start += WINDOW_MS) {
        const end = Math.min(phrase.endMs, start + WINDOW_MS);
        const words = phrase.words.filter(word => !word.excluded && (word.startMs + word.endMs) / 2 >= start && ((word.startMs + word.endMs) / 2 < end || end === phrase.endMs && (word.startMs + word.endMs) / 2 === end));
        const expectedWords = [];
        for (const word of words) {
          const text = root.LvNativeLive.normalizeExpectedWord(word.spokenText || word.text);
          if (!text) { skipped.push({ wordId: word.id, reason: 'unsupported-text' }); continue; }
          expectedWords.push({ wordId: word.id, phraseId: phrase.id, laneId: phrase.laneId, text });
        }
        if (expectedWords.length > root.LvNativeLive.MAX_EXPECTED_WORDS) { skipped.push(...expectedWords.map(word => ({ wordId: word.wordId, reason: 'too-many-words' }))); continue; }
        if (expectedWords.length) windows.push({ phraseId: phrase.id, startMs: Math.max(0, start + (score.offsetMs || 0)), endMs: Math.min(duration, end + (score.offsetMs || 0)), expectedWords, overlap, segmented: phrase.endMs - phrase.startMs > WINDOW_MS });
      }
    }
    // Reuse one model call for adjacent, nonoverlapping phrases in the same
    // vocal lane. The native host otherwise starts a fresh model per phrase.
    const grouped = [];
    for (const window of windows.filter(window => window.endMs > window.startMs).sort((a, b) => a.expectedWords[0].laneId.localeCompare(b.expectedWords[0].laneId) || a.startMs - b.startMs || a.endMs - b.endMs)) {
      const previous = grouped[grouped.length - 1];
      if (previous && previous.expectedWords[0].laneId === window.expectedWords[0].laneId && window.startMs >= previous.endMs && window.endMs - previous.startMs <= WINDOW_MS && previous.expectedWords.length + window.expectedWords.length <= root.LvNativeLive.MAX_EXPECTED_WORDS) {
        previous.endMs = window.endMs; previous.expectedWords.push(...window.expectedWords);
        previous.overlap ||= window.overlap; previous.segmented ||= window.segmented;
      } else grouped.push({ ...window, expectedWords: [...window.expectedWords] });
    }
    grouped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return { windows: grouped, skipped };
  }
  function extract(pcm, used, originMs, window) {
    const startMs = Math.max(window.startMs, originMs), endMs = Math.min(window.endMs, originMs + used * 1000 / RATE);
    if (endMs - startMs < 50) return null;
    const from = Math.max(0, Math.ceil((startMs - originMs) * RATE / 1000)), to = Math.min(used, Math.floor((endMs - originMs) * RATE / 1000));
    if (to <= from) return null;
    const samples = new Float32Array(to - from);
    for (let i = from; i < to; i++) samples[i - from] = pcm[i] / 32768;
    return { audioStartMs: Math.round(originMs + from * 1000 / RATE), samples, clipped: window.startMs < originMs - 1 || window.endMs > originMs + used * 1000 / RATE + 1 };
  }
  root.LvSongPass = { MAX_SONG_MS, plan, extract };
  if (typeof module !== 'undefined') module.exports = root.LvSongPass;
})(globalThis);
