(function (root, factory) {
  const score = root.LvScore || (typeof module === "object" && module.exports ? require("./score-core.js") : null);
  const api = factory(score);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LvReviewQueue = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (LvScore) {
  "use strict";

  const VERSION = "lyricvibe.review-queue.v1";
  const DIAGNOSTIC_KIND = "anomaly-cues-only";

  class ReviewQueueError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ReviewQueueError";
      this.code = code;
    }
  }

  function fail(code, message) { throw new ReviewQueueError(code, message); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

  function validateScore(score) {
    if (!LvScore || typeof LvScore.validateScore !== "function") fail("SCORE_VALIDATOR_UNAVAILABLE", "LyricVibe score validation is unavailable");
    LvScore.validateScore(score);
  }

  function targetFor(score, wordId) {
    for (const phrase of score.phrases) {
      const word = phrase.words.find(item => item.id === wordId);
      if (word) return { phrase, word };
    }
    return null;
  }

  function validateProposal(score, proposal) {
    if (!isRecord(proposal) || proposal.accepted !== false || typeof proposal.wordId !== "string" ||
        typeof proposal.evidenceId !== "string" || !proposal.evidenceId ||
        !Number.isSafeInteger(proposal.startMs) || !Number.isSafeInteger(proposal.endMs) ||
        proposal.startMs < 0 || proposal.endMs < proposal.startMs) {
      fail("INVALID_REVIEW_PROPOSAL", "Review proposals must be valid, unaccepted word timings with evidence");
    }
    const target = targetFor(score, proposal.wordId);
    if (!target) fail("INVALID_REVIEW_PROPOSAL", "Review proposal names a word outside this score");
    return target;
  }

  function validateQueue(queue) {
    if (!isRecord(queue) || queue.version !== VERSION || !Number.isSafeInteger(queue.expectedRevision) ||
        typeof queue.mediaKey !== "string" || !queue.mediaKey || typeof queue.lyricsHash !== "string" ||
        !Array.isArray(queue.proposals) || !Array.isArray(queue.wordIds) || !Array.isArray(queue.selectedWordIds)) {
      fail("INVALID_REVIEW_QUEUE", "Review queue is malformed");
    }
    const ids = queue.proposals.map(proposal => proposal && proposal.wordId);
    if (ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length ||
        queue.wordIds.length !== ids.length || queue.wordIds.some((id, index) => id !== ids[index]) ||
        queue.selectedWordIds.some(id => !ids.includes(id)) || new Set(queue.selectedWordIds).size !== queue.selectedWordIds.length) {
      fail("INVALID_REVIEW_QUEUE", "Review queue proposal identities are malformed");
    }
  }

  function assertCurrent(queue, score) {
    validateQueue(queue);
    validateScore(score);
    if (score.revision !== queue.expectedRevision) fail("REVISION_CONFLICT", "Review queue belongs to a different score revision");
    if (LvScore.mediaKey(score.source) !== queue.mediaKey) fail("SOURCE_MISMATCH", "Review queue belongs to another source video");
    if (score.lyrics.contentHash !== queue.lyricsHash) fail("LYRIC_REVISION_MISMATCH", "Review queue belongs to another lyrics revision");
  }

  function assertSelectable(score, proposal) {
    const { phrase, word } = validateProposal(score, proposal);
    if (word.locked) fail("LOCKED", "Word timing is locked");
    if ((word.syllables || []).some(syllable => syllable.locked)) fail("LOCKED", "Word contains a protected syllable");
    if (!phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs)) {
      fail("INVALID_TIME", "Proposal timing must fit within its explicit phrase boundary");
    }
    return { phrase, word };
  }

  function create(score, proposals) {
    validateScore(score);
    if (!Array.isArray(proposals)) fail("INVALID_REVIEW_PROPOSAL", "Proposals must be an array");
    const copied = clone(proposals);
    const ids = [];
    for (const proposal of copied) {
      validateProposal(score, proposal);
      if (ids.includes(proposal.wordId)) fail("INVALID_REVIEW_PROPOSAL", "Only one pending proposal per word is supported");
      ids.push(proposal.wordId);
    }
    return {
      version: VERSION,
      expectedRevision: score.revision,
      mediaKey: LvScore.mediaKey(score.source),
      lyricsHash: score.lyrics.contentHash,
      wordIds: ids,
      proposals: copied,
      selectedWordIds: [],
    };
  }

  function toggle(queue, wordId, checked, score) {
    assertCurrent(queue, score);
    if (typeof wordId !== "string" || !queue.wordIds.includes(wordId)) fail("UNKNOWN_REVIEW_WORD", "Word is not in this review queue");
    if (typeof checked !== "boolean") fail("INVALID_SELECTION", "Selection state must be boolean");
    if (checked) assertSelectable(score, queue.proposals.find(proposal => proposal.wordId === wordId));
    const selectedWordIds = queue.selectedWordIds.filter(id => id !== wordId);
    if (checked) selectedWordIds.push(wordId);
    return { ...clone(queue), selectedWordIds };
  }

  function selected(queue, score) {
    assertCurrent(queue, score);
    return queue.selectedWordIds.map(wordId => {
      const proposal = queue.proposals.find(item => item.wordId === wordId);
      assertSelectable(score, proposal);
      return { ...clone(proposal), accepted: true };
    });
  }

  function diagnosticsForProposal(score, proposal) {
    validateScore(score);
    const { phrase, word } = validateProposal(score, proposal);
    const flags = [];
    const proposedDuration = proposal.endMs - proposal.startMs;
    if (proposedDuration < 60) flags.push("SHORT_WORD");
    if (proposedDuration > 3000) flags.push("LONG_WORD");
    if (Math.max(Math.abs(proposal.startMs - word.startMs), Math.abs(proposal.endMs - word.endMs)) > 500) flags.push("LARGE_SHIFT");
    if (proposedDuration > 0) {
      const overlaps = score.phrases.some(otherPhrase => otherPhrase.laneId === phrase.laneId &&
        otherPhrase.words.some(otherWord => otherWord.id !== word.id && proposal.startMs < otherWord.endMs && proposal.endMs > otherWord.startMs));
      if (overlaps) flags.push("SAME_LANE_OVERLAP");
    }
    return { kind: DIAGNOSTIC_KIND, flags };
  }

  return { VERSION, ReviewQueueError, DIAGNOSTIC_KIND, create, toggle, selected, diagnosticsForProposal };
});
