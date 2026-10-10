/* Pure transcription-anchor matching; no ASR or calibrated probabilities here. */
(function (root) {
  'use strict';
  const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim();

  // Smith-Waterman local sequence matching. Expected and heard omissions are allowed.
  // Keep several distinct paths so a repeated chorus cannot silently win a tie.
  function paths(expected, heard) {
    const cols = heard.length + 1;
    const dp = new Float32Array((expected.length + 1) * cols);
    const endpoints = [];
    for (let i = 1; i <= expected.length; i++) {
      for (let j = 1; j <= heard.length; j++) {
        const exact = expected[i - 1].token === heard[j - 1].token;
        const value = Math.max(0, dp[(i - 1) * cols + j - 1] + (exact ? 3 : -2), dp[(i - 1) * cols + j] - 1.25, dp[i * cols + j - 1] - 1.25);
        dp[i * cols + j] = value;
        if (exact && value >= 6) endpoints.push({ i, j, value });
      }
    }
    endpoints.sort((a, b) => b.value - a.value);
    const results = [];
    for (const endpoint of endpoints.slice(0, 512)) {
      let { i, j } = endpoint;
      const matches = [];
      while (i && j && dp[i * cols + j] > 0) {
        const value = dp[i * cols + j];
        const exact = expected[i - 1].token === heard[j - 1].token;
        if (Math.abs(value - (dp[(i - 1) * cols + j - 1] + (exact ? 3 : -2))) < 0.01) {
          if (exact) matches.push({ expected: expected[i - 1], heard: heard[j - 1], ei: i - 1, hi: j - 1 });
          i--; j--;
        } else if (Math.abs(value - (dp[(i - 1) * cols + j] - 1.25)) < 0.01) i--;
        else j--;
      }
      matches.reverse();
      if (matches.length < 2) continue;
      const ids = new Set(matches.map(m => m.expected.id));
      if (results.some(r => r.matches.filter(m => ids.has(m.expected.id)).length / Math.min(r.matches.length, matches.length) > 0.5)) continue;
      results.push({ value: endpoint.value, matches });
      if (results.length >= 8) break;
    }
    return results;
  }

  function matchAnchors(score, chunks, window) {
    const heard = (chunks || []).map(chunk => {
      const token = normalize(chunk.text);
      const [a, b] = chunk.timestamp || [];
      // Never interpolate phrase-level output into purported word evidence.
      if (!token || /\s/u.test(token) || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > window.durationSec + 0.1) return null;
      return { token, startMs: Math.round(window.mediaStartMs + a * 1000 * window.playbackRate - (score.offsetMs || 0)), endMs: Math.round(window.mediaStartMs + b * 1000 * window.playbackRate - (score.offsetMs || 0)) };
    }).filter(Boolean).slice(0, 128);
    const allPaths = [];
    for (const lane of score.lanes) {
      const expected = score.phrases.filter(p => p.laneId === lane.id).sort((a, b) => a.startMs - b.startMs).flatMap(p => p.words.map(w => ({ ...w, token: normalize(w.text), phraseId: p.id, laneId: lane.id }))).filter(w => w.token && !/\s/u.test(w.token)).slice(0, 1500);
      allPaths.push(...paths(expected, heard));
    }
    allPaths.sort((a, b) => b.value - a.value);
    const best = allPaths[0];
    if (!best) return { proposals: [], diagnostics: { method: 'top-one-transcription-anchors', reason: 'NO_NEIGHBORING_ANCHORS', heardWords: heard.length, unmatchedWords: heard.length, confidenceValidated: false } };
    const competitor = allPaths.find(p => p !== best && !p.matches.some(m => best.matches.some(n => n.expected.id === m.expected.id)));
    const ambiguous = Boolean(competitor && competitor.value >= best.value - 1.5);
    const proposals = best.matches.map((match, index) => {
      const adjacent = best.matches.some((other, j) => j !== index && Math.abs(other.ei - match.ei) <= 2 && Math.abs(other.hi - match.hi) <= 2);
      // This is a lexical/context heuristic, NOT a model probability.
      const confidence = ambiguous ? 0.25 : Math.min(0.9, 0.45 + best.matches.length * 0.06 + (adjacent ? 0.1 : 0));
      return { wordId: match.expected.id, startMs: Math.max(0, match.heard.startMs), endMs: Math.max(1, match.heard.endMs), accepted: false, evidenceId: `${window.evidenceId}:${match.hi}`, confidence, reviewReason: ambiguous ? 'REPEATED_SEQUENCE_AMBIGUOUS' : !adjacent ? 'NO_NEIGHBORING_ANCHOR' : 'SINGING_CONFIDENCE_UNVALIDATED' };
    }).filter(p => p.endMs > p.startMs);
    return { proposals, diagnostics: { method: 'top-one-transcription-anchors', heardWords: heard.length, matchedWords: proposals.length, unmatchedWords: heard.length - proposals.length, repeatedSequenceAmbiguous: ambiguous, provisionalThreshold: 0.85, confidenceValidated: false, automaticAdmissionEnabled: false, overlapSeparation: false } };
  }

  class MediaClock {
    constructor() { this.reset(); }
    reset() { this.anchor = null; this.epoch = (this.epoch || 0) + 1; }
    update(snapshot, contextSec) {
      const usable = snapshot && Number.isFinite(snapshot.currentTimeMs) && Number.isFinite(snapshot.playbackRate) && snapshot.playbackRate > 0 && !snapshot.paused && !snapshot.seeking;
      const old = this.anchor;
      const discontinuity = !usable || !old || snapshot.mediaKey !== old.mediaKey || snapshot.playbackRate !== old.playbackRate || contextSec < old.contextSec || Math.abs(snapshot.currentTimeMs - old.mediaMs - (contextSec - old.contextSec) * 1000 * old.playbackRate) > 250;
      if (discontinuity) this.reset();
      if (usable) this.anchor = { mediaKey: snapshot.mediaKey, mediaMs: snapshot.currentTimeMs, contextSec, playbackRate: snapshot.playbackRate };
      return { discontinuity, epoch: this.epoch, usable };
    }
    mediaAt(contextSec) { return this.anchor ? this.anchor.mediaMs + (contextSec - this.anchor.contextSec) * 1000 * this.anchor.playbackRate : null; }
  }

  const api = { normalize, matchAnchors, MediaClock };
  root.LvAnchors = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
