(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LvScore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "lyricvibe.score.v1";
  const EFFECTS = new Set(["shake", "tilt", "pulse"]);
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const HASH_RE = /^[a-f0-9]{64}$/i;

  class ScoreError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ScoreError";
      this.code = code;
    }
  }
  function fail(code, message) { throw new ScoreError(code, message); }
  function finiteNonnegative(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("INVALID_TIME", `${label} must be a finite nonnegative number`);
  }
  function integerNonnegative(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_TIME", `${label} must be a nonnegative integer`);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function parseVideoId(value) { return typeof value === "string" && ID_RE.test(value) ? value : ""; }

  function mediaKey(hintsOrSource) {
    const input = hintsOrSource && typeof hintsOrSource === "object" ? hintsOrSource : {};
    const source = input.source && typeof input.source === "object" ? input.source : input;
    const direct = parseVideoId(source.videoId) || parseVideoId(input.videoId);
    if (direct) return `youtube:${direct}`;
    const raw = typeof input.url === "string" ? input.url : (typeof source.url === "string" ? source.url : "");
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      let id = "";
      if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] || "";
      else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
        if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
        else {
          const parts = url.pathname.split("/").filter(Boolean);
          if (["embed", "shorts", "live", "v"].includes(parts[0])) id = parts[1] || "";
        }
      }
      id = parseVideoId(id);
      return id ? `youtube:${id}` : "";
    } catch { return ""; }
  }

  function parseLrc(raw) {
    if (typeof raw !== "string") fail("INVALID_LRC", "LRC input must be text");
    const cues = [];
    const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const matches = [...line.matchAll(timestamp)];
      if (!matches.length) continue;
      const text = line.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length).trim();
      for (const match of matches) {
        const min = Number(match[1]);
        const sec = Number(match[2]);
        const fraction = match[3] || "0";
        if (sec > 59) fail("INVALID_LRC", "LRC seconds must be between 00 and 59");
        const ms = fraction.length === 1 ? Number(fraction) * 100 : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction);
        cues.push({ timeMs: (min * 60 + sec) * 1000 + ms, text });
      }
    }
    cues.sort((a, b) => a.timeMs - b.timeMs);
    return cues;
  }

  function wordsForText(text) {
    const result = [];
    const re = /\([^)]*\)|[^\s]+/gu;
    for (const match of text.matchAll(re)) {
      const token = match[0];
      const backing = token.startsWith("(") && token.endsWith(")") && token.length > 2;
      const body = backing ? token.slice(1, -1).trim() : token;
      if (!body) continue;
      // Keep punctuation attached to its word so the source lyric remains losslessly readable.
      for (const word of body.split(/\s+/u)) if (word) result.push({ text: word, role: backing ? "backing" : "lead" });
    }
    return result;
  }
  function stableId(prefix, n) { return `${prefix}-${n}`; }

  function createScore(source, rawLrc, lyricsMetadata) {
    if (!source || typeof source !== "object") fail("INVALID_SOURCE", "source is required");
    const id = parseVideoId(source.videoId);
    if (!id) fail("INVALID_SOURCE", "source.videoId must be an 11-character YouTube ID");
    if (typeof source.durationMs !== "number" || !Number.isFinite(source.durationMs) || source.durationMs < 0) fail("INVALID_SOURCE", "source.durationMs must be finite and nonnegative");
    const metadata = lyricsMetadata || {};
    const hash = metadata.contentHash;
    if (typeof hash !== "string" || !HASH_RE.test(hash)) fail("INVALID_LYRICS", "lyricsMetadata.contentHash must be a SHA-256 hex digest supplied by the host");
    const cues = parseLrc(rawLrc);
    const laneLead = { id: "lead", role: "lead", label: "Lead" };
    const laneBacking = { id: "backing", role: "backing", label: "Suggested backing (inferred)" };
    const phrases = [];
    let phraseIndex = 0;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (!cue.text) {
        for (const previous of phrases.filter(p => p.startMs <= cue.timeMs && p.endMs >= cue.timeMs)) {
          if (previous.endMs !== cue.timeMs) placePhraseWords(previous, cue.timeMs);
          previous.endEstimated = false;
          previous.fadeOutMs = Math.min(previous.fadeOutMs, Math.max(0, previous.endMs - previous.startMs));
        }
        continue;
      }
      const next = cues.slice(i + 1).find(c => c.timeMs > cue.timeMs);
      const endMs = next ? next.timeMs : source.durationMs;
      if (endMs < cue.timeMs) continue;
      const tokens = wordsForText(cue.text);
      if (!tokens.length) continue;
      const phraseId = stableId("phrase", ++phraseIndex);
      const words = tokens.map((token, n) => ({
        id: `${phraseId}-word-${n + 1}`, text: token.text,
        startMs: cue.timeMs, endMs: cue.timeMs,
        provenance: "estimated", locked: false, effects: [], laneRole: token.role
      }));
      const leadWords = words.filter(w => w.laneRole === "lead");
      const backWords = words.filter(w => w.laneRole === "backing");
      // Parenthetical suggestions are separately addressable while preserving their cue timing.
      for (const [part, subset] of [["lead", leadWords], ["backing", backWords]]) {
        if (!subset.length) continue;
        const phraseWords = subset.map(({ laneRole, ...word }) => word);
        const p = { id: backWords.length && part === "backing" ? `${phraseId}-backing` : phraseId, laneId: part, startMs: cue.timeMs, endMs, endEstimated: true, fadeOutMs: 120, words: phraseWords };
        estimateWordTimes(p, cue.text);
        phrases.push(p);
      }
    }
    phrases.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    return validateScore({
      version: VERSION, revision: 0, offsetMs: 0,
      source: { platform: "youtube", videoId: id, title: String(source.title || ""), artist: String(source.artist || ""), durationMs: source.durationMs },
      lyrics: { provider: String(metadata.provider || ""), entryId: metadata.entryId == null ? null : String(metadata.entryId), contentHash: hash.toLowerCase() },
      lanes: [laneLead, laneBacking], phrases
    });
  }

  function estimateWordTimes(phrase) {
    const words = phrase.words;
    if (!words.length) return;
    const span = Math.max(0, phrase.endMs - phrase.startMs);
    const weights = words.map((word, i) => {
      const chars = Math.max(1, word.text.replace(/[.,!?;:]+$/u, "").length);
      const punctuation = /[.!?…]$/u.test(word.text) ? 0.24 : /[,;:]$/u.test(word.text) ? 0.12 : 0;
      return { base: chars, punctuation };
    });
    const pauses = weights.reduce((sum, item) => sum + item.punctuation, 0);
    const available = Math.max(0, span - Math.min(span * 0.35, pauses * 180));
    const total = weights.reduce((sum, item) => sum + item.base, 0) || 1;
    let previousEnd = phrase.startMs;
    for (let i = 0; i < words.length; i++) {
      const start = phrase.startMs + Math.round(available * weights.slice(0, i).reduce((s, w) => s + w.base, 0) / total) + Math.round(weights.slice(0, i).reduce((s, w) => s + w.punctuation, 0) * 180);
      const end = i === words.length - 1 ? phrase.endMs : phrase.startMs + Math.round(available * weights.slice(0, i + 1).reduce((s, w) => s + w.base, 0) / total) + Math.round(weights.slice(0, i).reduce((s, w) => s + w.punctuation, 0) * 180);
      words[i].startMs = Math.max(previousEnd, Math.min(phrase.endMs, start));
      words[i].endMs = Math.max(words[i].startMs, Math.min(phrase.endMs, end));
      previousEnd = words[i].endMs;
    }
  }
  function placePhraseWords(phrase, endMs) {
    if (!phrase.words.length) return;
    const oldEnd = phrase.endMs;
    phrase.endMs = endMs;
    if (oldEnd <= phrase.startMs) {
      phrase.words.forEach(w => { w.startMs = phrase.startMs; w.endMs = endMs; });
      return;
    }
    for (const word of phrase.words) {
      word.startMs = Math.min(endMs, phrase.startMs + Math.round((word.startMs - phrase.startMs) * (endMs - phrase.startMs) / (oldEnd - phrase.startMs)));
      word.endMs = Math.max(word.startMs, Math.min(endMs, phrase.startMs + Math.round((word.endMs - phrase.startMs) * (endMs - phrase.startMs) / (oldEnd - phrase.startMs))));
    }
  }

  function validateScore(score) {
    const bad = (message) => fail("INVALID_SCORE", message);
    if (!score || typeof score !== "object" || score.version !== VERSION) bad("unsupported score version");
    if (!Number.isSafeInteger(score.revision) || score.revision < 0) bad("revision must be a nonnegative integer");
    if (!Number.isSafeInteger(score.offsetMs)) bad("offsetMs must be an integer");
    const s = score.source;
    if (!s || s.platform !== "youtube" || !ID_RE.test(s.videoId || "") || typeof s.title !== "string" || typeof s.artist !== "string" || typeof s.durationMs !== "number" || !Number.isFinite(s.durationMs) || s.durationMs < 0) bad("invalid source identity or metadata");
    if (!score.lyrics || typeof score.lyrics.provider !== "string" || !(score.lyrics.entryId === null || typeof score.lyrics.entryId === "string") || typeof score.lyrics.contentHash !== "string" || !HASH_RE.test(score.lyrics.contentHash)) bad("invalid lyrics metadata");
    if (!Array.isArray(score.lanes) || !Array.isArray(score.phrases)) bad("lanes and phrases must be arrays");
    const ids = new Set();
    const laneMap = new Map();
    for (const lane of score.lanes) {
      if (!lane || typeof lane.id !== "string" || !lane.id || ids.has(lane.id) || !["lead", "backing"].includes(lane.role) || typeof lane.label !== "string") bad("invalid or duplicate lane");
      ids.add(lane.id); laneMap.set(lane.id, lane);
    }
    for (const phrase of score.phrases) {
      if (!phrase || typeof phrase.id !== "string" || !phrase.id || ids.has(phrase.id) || !laneMap.has(phrase.laneId)) bad("invalid phrase id or unknown lane");
      ids.add(phrase.id);
      if (typeof phrase.startMs !== "number" || !Number.isFinite(phrase.startMs) || phrase.startMs < 0 || typeof phrase.endMs !== "number" || !Number.isFinite(phrase.endMs) || phrase.endMs < 0 || phrase.endMs < phrase.startMs || typeof phrase.endEstimated !== "boolean" || typeof phrase.fadeOutMs !== "number" || !Number.isFinite(phrase.fadeOutMs) || phrase.fadeOutMs < 0 || !Array.isArray(phrase.words)) bad("invalid phrase timing or fields");
      for (const word of phrase.words) {
        if (!word || typeof word.id !== "string" || !word.id || ids.has(word.id) || typeof word.text !== "string" || !word.text.trim()) bad("invalid or duplicate word");
        ids.add(word.id);
        if (typeof word.startMs !== "number" || !Number.isFinite(word.startMs) || word.startMs < 0 || typeof word.endMs !== "number" || !Number.isFinite(word.endMs) || word.endMs < 0 || word.endMs < word.startMs || word.startMs < phrase.startMs || word.endMs > phrase.endMs || !["estimated", "manual", "aligned"].includes(word.provenance) || typeof word.locked !== "boolean" || !Array.isArray(word.effects)) bad("invalid word timing or fields");
        for (const effect of word.effects) if (!effect || !EFFECTS.has(effect.type) || typeof effect.strength !== "number" || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1) bad("invalid effect");
      }
    }
    return score;
  }

  function locateWord(score, wordId) {
    for (const phrase of score.phrases) {
      const word = phrase.words.find(w => w.id === wordId);
      if (word) return { phrase, word };
    }
    fail("UNKNOWN_ID", `unknown word id: ${wordId}`);
  }
  function checkExpected(score, expectedRevision) {
    validateScore(score);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== score.revision) fail("REVISION_CONFLICT", "score revision does not match expectedRevision");
  }
  function applyOperation(score, operation, expectedRevision) {
    checkExpected(score, expectedRevision);
    if (!operation || typeof operation !== "object" || typeof operation.type !== "string") fail("INVALID_OPERATION", "operation must have a type");
    const next = clone(score);
    const op = operation;
    if (op.type === "setWordTiming") {
      const { phrase, word } = locateWord(next, op.wordId);
      if (word.locked) fail("LOCKED", "word timing is locked");
      finiteNonnegative(op.startMs, "startMs"); finiteNonnegative(op.endMs, "endMs");
      if (op.endMs < op.startMs || op.startMs < phrase.startMs || op.endMs > phrase.endMs) fail("INVALID_TIME", "word timing must fit within its phrase");
      word.startMs = op.startMs; word.endMs = op.endMs; word.provenance = "manual"; word.locked = true;
    } else if (op.type === "setWordText") {
      const { word } = locateWord(next, op.wordId);
      if (typeof op.text !== "string" || !op.text.trim()) fail("INVALID_OPERATION", "text must be nonempty");
      word.text = op.text;
    } else if (op.type === "setWordLock") {
      const { word } = locateWord(next, op.wordId);
      if (typeof op.locked !== "boolean") fail("INVALID_OPERATION", "locked must be boolean");
      word.locked = op.locked;
      if (op.locked) word.provenance = "manual";
    } else if (op.type === "setPhraseLane") {
      const phrase = next.phrases.find(p => p.id === op.phraseId);
      if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${op.phraseId}`);
      if (!next.lanes.some(l => l.id === op.laneId)) fail("UNKNOWN_ID", `unknown lane id: ${op.laneId}`);
      phrase.laneId = op.laneId;
    } else if (op.type === "setPhraseTiming") {
      const phrase = next.phrases.find(p => p.id === op.phraseId);
      if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${op.phraseId}`);
      finiteNonnegative(op.startMs, "startMs"); finiteNonnegative(op.endMs, "endMs");
      if (op.endMs < op.startMs) fail("INVALID_TIME", "phrase end precedes start");
      const oldStart = phrase.startMs, oldEnd = phrase.endMs, oldSpan = oldEnd - oldStart, newSpan = op.endMs - op.startMs;
      phrase.startMs = op.startMs; phrase.endMs = op.endMs; phrase.endEstimated = false;
      for (const word of phrase.words) {
        const relStart = oldSpan ? (word.startMs - oldStart) / oldSpan : 0;
        const relEnd = oldSpan ? (word.endMs - oldStart) / oldSpan : 1;
        word.startMs = op.startMs + Math.round(relStart * newSpan);
        word.endMs = op.startMs + Math.round(relEnd * newSpan);
        word.provenance = "manual";
      }
    } else if (op.type === "setOffset") {
      if (!Number.isSafeInteger(op.offsetMs)) fail("INVALID_TIME", "offsetMs must be an integer");
      next.offsetMs = op.offsetMs;
    } else if (op.type === "setWordEffect") {
      const { word } = locateWord(next, op.wordId);
      if (op.effect === null) word.effects = [];
      else {
        if (!op.effect || !EFFECTS.has(op.effect.type) || typeof op.effect.strength !== "number" || !Number.isFinite(op.effect.strength) || op.effect.strength < 0 || op.effect.strength > 1) fail("INVALID_EFFECT", "effect type or strength is invalid");
        word.effects = [clone(op.effect)];
      }
    } else fail("INVALID_OPERATION", `unknown operation type: ${op.type}`);
    next.revision++;
    return validateScore(next);
  }

  function applyAlignment(score, proposals, expectedRevision) {
    checkExpected(score, expectedRevision);
    if (!Array.isArray(proposals)) fail("INVALID_PROPOSALS", "proposals must be an array");
    const next = clone(score);
    const evidenceByWord = new Set();
    for (const proposal of proposals) {
      if (!proposal || typeof proposal !== "object" || typeof proposal.wordId !== "string" || typeof proposal.accepted !== "boolean" || typeof proposal.evidenceId !== "string" || !proposal.evidenceId) fail("INVALID_PROPOSAL", "proposal is malformed");
      if (proposal.confidence !== undefined && (typeof proposal.confidence !== "number" || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) fail("INVALID_PROPOSAL", "confidence must be between 0 and 1");
      if (!proposal.accepted) continue;
      const { phrase, word } = locateWord(next, proposal.wordId);
      finiteNonnegative(proposal.startMs, "startMs"); finiteNonnegative(proposal.endMs, "endMs");
      if (proposal.endMs < proposal.startMs || proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs) fail("INVALID_TIME", "alignment timing must fit within its phrase");
      if (word.locked) continue;
      const seenKey = `${proposal.wordId}\0${proposal.evidenceId}`;
      if (evidenceByWord.has(seenKey)) continue;
      evidenceByWord.add(seenKey);
      word.startMs = proposal.startMs; word.endMs = proposal.endMs; word.provenance = "aligned";
    }
    next.revision++;
    return validateScore(next);
  }

  function activeAt(score, mediaMs) {
    validateScore(score); finiteNonnegative(mediaMs, "mediaMs");
    const at = mediaMs - score.offsetMs;
    const phrases = [];
    for (const phrase of score.phrases) {
      const start = phrase.startMs, end = phrase.endMs;
      if (at < start || at > end) continue;
      const fade = Math.min(phrase.fadeOutMs, Math.max(0, end - start));
      const opacity = fade > 0 && at > end - fade ? Math.max(0, (end - at) / fade) : 1;
      phrases.push({ ...clone(phrase), activeWords: phrase.words.filter(w => at >= w.startMs && at <= w.endMs).map(w => w.id), opacity });
    }
    return { phrases };
  }

  return { VERSION, ScoreError, mediaKey, parseLrc, createScore, validateScore, activeAt, applyOperation, applyAlignment };
});
