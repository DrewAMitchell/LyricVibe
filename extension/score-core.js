(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LvScore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "lyricvibe.score.v1";
  const EFFECTS = new Set(["shake", "tilt", "pulse"]);
  const REVEAL_EASINGS = new Set(["linear", "ease-out", "ease-in-out"]);
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
  function validReveal(reveal) {
    return reveal === null || (reveal && typeof reveal === "object" && reveal.type === "sweep" && REVEAL_EASINGS.has(reveal.easing));
  }
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

  // Return display-ready pieces of a compound word, keeping each joiner on
  // the preceding piece so joining the result always recovers the source.
  function hyphenWordParts(text) {
    if (typeof text !== "string") fail("INVALID_TEXT", "word text must be a string");
    // Scan code points so Unicode letters and digits work without changing
    // any source spelling.
    const result = [];
    let part = "";
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i], prev = chars[i - 1], next = chars[i + 1];
      part += ch;
      if ((ch === "-" || ch === "\u2010" || ch === "\u2011") && /[\p{L}\p{N}]/u.test(prev || "") && /[\p{L}\p{N}]/u.test(next || "")) {
        result.push(part); part = "";
      }
    }
    if (part) result.push(part);
    return result.length > 1 ? result : [text];
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
  // LRC line starts do not prove that a phrase spans the entire gap to the next cue.
  // Keep inferred phrase duration plausible: 1.5s minimum, 650ms per word, 8s maximum.
  function estimatedPhraseDurationMs(wordCount) {
    return Math.max(1500, Math.min(8000, wordCount * 650));
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
      const tokens = wordsForText(cue.text);
      if (!tokens.length) continue;
      const inferredEndMs = cue.timeMs + estimatedPhraseDurationMs(tokens.length);
      const proposedEndMs = next ? next.timeMs : source.durationMs;
      const endMs = Math.min(proposedEndMs, inferredEndMs);
      // A nearby blank cue is an explicit phrase boundary. If the cue is far away,
      // the bounded estimate wins so lyrics do not occupy a long instrumental gap.
      const explicitEndIsPlausible = Boolean(next && !next.text && next.timeMs <= inferredEndMs);
      const endEstimated = !explicitEndIsPlausible;
      if (endMs < cue.timeMs) continue;
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
        const p = { id: backWords.length && part === "backing" ? `${phraseId}-backing` : phraseId, laneId: part, startMs: cue.timeMs, endMs, endEstimated, fadeOutMs: 120, words: phraseWords };
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
    const weights = [];
    const requestedPauses = [];
    let totalWeight = 0, totalRequestedPause = 0;
    for (let i = 0; i < words.length; i++) {
      const text = words[i].text;
      const weight = Math.max(1, text.replace(/[.,!?;:…]+$/u, "").length);
      const pause = i === words.length - 1 ? 0 : /[.!?…]+$/u.test(text) ? 180 : /[,;:]+$/u.test(text) ? 120 : 0;
      weights.push(weight);
      requestedPauses.push(pause);
      totalWeight += weight;
      totalRequestedPause += pause;
    }
    const pauseBudget = Math.min(totalRequestedPause, span * 0.35);
    const pauseBudgetMs = Math.floor(pauseBudget);
    const available = Math.max(0, span - pauseBudgetMs);
    totalWeight ||= 1;
    // Round cumulative allocations so individual gaps stay proportional and their sum
    // never exceeds the capped integer budget.
    const pauses = [];
    let requestedPrefix = 0, allocatedPrefix = 0;
    for (const requested of requestedPauses) {
      requestedPrefix += requested;
      const nextAllocatedPrefix = totalRequestedPause
        ? Math.round(pauseBudgetMs * requestedPrefix / totalRequestedPause)
        : 0;
      pauses.push(nextAllocatedPrefix - allocatedPrefix);
      allocatedPrefix = nextAllocatedPrefix;
    }
    let weightBefore = 0, pauseBefore = 0;
    for (let i = 0; i < words.length; i++) {
      const startOffset = available * weightBefore / totalWeight + pauseBefore;
      const endOffset = available * (weightBefore + weights[i]) / totalWeight + pauseBefore;
      words[i].startMs = phrase.startMs + Math.round(startOffset);
      words[i].endMs = i === words.length - 1 ? phrase.endMs : phrase.startMs + Math.round(endOffset);
      weightBefore += weights[i];
      pauseBefore += pauses[i];
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
        if (word.excluded !== undefined && typeof word.excluded !== "boolean") bad("word excluded must be boolean when present");
        if (word.spokenText !== undefined && (typeof word.spokenText !== "string" || !word.spokenText.trim() || word.spokenText.length > 256 || word.spokenText.includes("|"))) bad("invalid spokenText");
        for (const effect of word.effects) if (!effect || !EFFECTS.has(effect.type) || typeof effect.strength !== "number" || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1) bad("invalid effect");
        if (word.reveal !== undefined && !validReveal(word.reveal)) bad("invalid word reveal");
        if (word.syllables !== undefined) {
          if (!Array.isArray(word.syllables) || word.syllables.some(syllable => !syllable || Object.prototype.hasOwnProperty.call(syllable, "syllables"))) bad("invalid syllables");
          if (word.syllables.length && word.syllables.map(syllable => typeof syllable.text === "string" ? syllable.text : "").join("") !== (word.spokenText || word.text)) bad("syllable text must concatenate exactly to the spoken word");
          for (const syllable of word.syllables) {
            if (typeof syllable.id !== "string" || !syllable.id || ids.has(syllable.id) || typeof syllable.text !== "string" || !syllable.text) bad("invalid or duplicate syllable");
            ids.add(syllable.id);
            if (typeof syllable.startMs !== "number" || !Number.isFinite(syllable.startMs) || syllable.startMs < word.startMs || typeof syllable.endMs !== "number" || !Number.isFinite(syllable.endMs) || syllable.endMs < syllable.startMs || syllable.endMs > word.endMs || !["estimated", "manual", "aligned"].includes(syllable.provenance) || typeof syllable.locked !== "boolean" || !Array.isArray(syllable.effects)) bad("invalid syllable timing or fields");
            if (syllable.effects.some(effect => !effect || !EFFECTS.has(effect.type) || typeof effect.strength !== "number" || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1)) bad("invalid syllable effect");
            if (syllable.reveal !== undefined && !validReveal(syllable.reveal)) bad("invalid syllable reveal");
          }
        }
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
  function locateSyllable(score, syllableId) {
    for (const phrase of score.phrases) for (const word of phrase.words) {
      const syllable = (word.syllables || []).find(item => item.id === syllableId);
      if (syllable) return { phrase, word, syllable };
    }
    fail("UNKNOWN_ID", `unknown syllable id: ${syllableId}`);
  }
  function rescaleSyllables(word, oldStart, oldEnd, newStart, newEnd, shouldRescale = () => true) {
    const oldSpan = oldEnd - oldStart, newSpan = newEnd - newStart;
    for (const syllable of word.syllables || []) {
      if (!shouldRescale(syllable)) continue;
      const startRatio = oldSpan ? (syllable.startMs - oldStart) / oldSpan : 0;
      const endRatio = oldSpan ? (syllable.endMs - oldStart) / oldSpan : 1;
      syllable.startMs = newStart + Math.round(startRatio * newSpan);
      syllable.endMs = newStart + Math.round(endRatio * newSpan);
    }
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
      finiteNonnegative(op.startMs, "startMs"); finiteNonnegative(op.endMs, "endMs");
      if (op.endMs < op.startMs || op.startMs < phrase.startMs || op.endMs > phrase.endMs) fail("INVALID_TIME", "word timing must fit within its phrase");
      rescaleSyllables(word, word.startMs, word.endMs, op.startMs, op.endMs);
      word.startMs = op.startMs; word.endMs = op.endMs; word.provenance = "manual"; word.locked = true;
    } else if (op.type === "setWordText") {
      const { word } = locateWord(next, op.wordId);
      if (typeof op.text !== "string" || !op.text.trim()) fail("INVALID_OPERATION", "text must be nonempty");
      if (op.text !== word.text) { delete word.spokenText; if (word.syllables) delete word.syllables; }
      word.text = op.text;
    } else if (op.type === "replaceWords") {
      const phrase = next.phrases.find(item => item.id === op.phraseId);
      if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${op.phraseId}`);
      if (!Array.isArray(op.wordIds) || !op.wordIds.length || op.wordIds.length > 5000 || op.wordIds.some(id => typeof id !== "string") || new Set(op.wordIds).size !== op.wordIds.length) fail("INVALID_OPERATION", "wordIds must be a bounded nonempty list of distinct word IDs");
      if (typeof op.text !== "string" || !op.text.trim() || op.text.length > 10000) fail("INVALID_OPERATION", "replacement text must be nonempty and at most 10000 characters");
      const tokens = op.text.trim().split(/\s+/);
      const firstIndex = phrase.words.findIndex(word => word.id === op.wordIds[0]);
      if (firstIndex < 0) fail("UNKNOWN_ID", "selected words must belong to the specified phrase");
      const selected = phrase.words.slice(firstIndex, firstIndex + op.wordIds.length);
      if (selected.length !== op.wordIds.length || selected.some((word, i) => word.id !== op.wordIds[i])) fail("INVALID_OPERATION", "selected word IDs must be one contiguous phrase interval in source order");
      const startMs = Math.min(...selected.map(word => word.startMs));
      const endMs = Math.max(...selected.map(word => word.endMs));
      const prefix = `${phrase.id}-replace-${selected[0].id}-${selected.at(-1).id}`;
      const usedIds = new Set(next.lanes.map(item => item.id));
      for (const item of next.phrases) {
        usedIds.add(item.id);
        for (const word of item.words) {
          if (!selected.some(chosen => chosen.id === word.id)) usedIds.add(word.id);
          for (const syllable of word.syllables || []) usedIds.add(syllable.id);
        }
      }
      let suffix = 1;
      while (tokens.some((_, i) => usedIds.has(`${prefix}-${suffix}-${i + 1}`))) suffix++;
      const span = endMs - startMs;
      const replacements = tokens.map((text, i) => ({
        id: `${prefix}-${suffix}-${i + 1}`, text,
        startMs: startMs + Math.round(span * i / tokens.length),
        endMs: startMs + Math.round(span * (i + 1) / tokens.length),
        provenance: "estimated", locked: false, effects: [],
      }));
      phrase.words.splice(firstIndex, selected.length, ...replacements);
    } else if (op.type === "insertPhrase") {
      // A transcript line with no existing phrase: estimated timing, placed in source order after afterPhraseId.
      if (!next.lanes.some(lane => lane.id === op.laneId)) fail("UNKNOWN_ID", `unknown lane id: ${op.laneId}`);
      if (typeof op.text !== "string" || !op.text.trim() || op.text.length > 10000) fail("INVALID_OPERATION", "phrase text must be nonempty and at most 10000 characters");
      if (!Number.isSafeInteger(op.startMs) || !Number.isSafeInteger(op.endMs) || op.startMs < 0 || op.endMs <= op.startMs) fail("INVALID_TIME", "an inserted phrase needs a positive whole-millisecond interval");
      const after = op.afterPhraseId == null ? -1 : next.phrases.findIndex(item => item.id === op.afterPhraseId);
      if (op.afterPhraseId != null && after < 0) fail("UNKNOWN_ID", `unknown phrase id: ${op.afterPhraseId}`);
      const usedIds = new Set(next.lanes.map(item => item.id));
      for (const item of next.phrases) { usedIds.add(item.id); for (const word of item.words) usedIds.add(word.id); }
      let n = 1;
      while (usedIds.has(`phrase-added-${n}`)) n++;
      const id = `phrase-added-${n}`;
      const phrase = { id, laneId: op.laneId, startMs: op.startMs, endMs: op.endMs, endEstimated: true, fadeOutMs: 120,
        words: op.text.trim().split(/\s+/).map((text, i) => ({ id: `${id}-word-${i + 1}`, text, startMs: op.startMs, endMs: op.startMs, provenance: "estimated", locked: false, effects: [] })) };
      estimateWordTimes(phrase);
      next.phrases.splice(after + 1, 0, phrase);
    } else if (op.type === "setWordLock") {
      const { word } = locateWord(next, op.wordId);
      if (typeof op.locked !== "boolean") fail("INVALID_OPERATION", "locked must be boolean");
      word.locked = op.locked;
      if (op.locked) word.provenance = "manual";
    } else if (op.type === "setWordExcluded") {
      const { word } = locateWord(next, op.wordId);
      if (typeof op.excluded !== "boolean") fail("INVALID_OPERATION", "excluded must be boolean");
      word.excluded = op.excluded;
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
        const oldWordStart = word.startMs, oldWordEnd = word.endMs;
        const relStart = oldSpan ? (word.startMs - oldStart) / oldSpan : 0;
        const relEnd = oldSpan ? (word.endMs - oldStart) / oldSpan : 1;
        word.startMs = op.startMs + Math.round(relStart * newSpan);
        word.endMs = op.startMs + Math.round(relEnd * newSpan);
        rescaleSyllables(word, oldWordStart, oldWordEnd, word.startMs, word.endMs);
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
    } else if (op.type === "setWordSyllables") {
      const { word } = locateWord(next, op.wordId);
      if ((word.syllables || []).some(item => item.locked)) fail("LOCKED", "unlock existing syllables before replacing their segmentation");
      if (!Array.isArray(op.syllables)) fail("INVALID_SYLLABLES", "syllables must be an array");
      if (op.spokenText !== undefined && op.spokenText !== null && (typeof op.spokenText !== "string" || !op.spokenText.trim() || op.spokenText.length > 256 || op.spokenText.includes("|"))) fail("INVALID_SYLLABLES", "spokenText must be nonempty, at most 256 characters, and contain no | separator");
      const spokenText = op.spokenText === null ? undefined : op.spokenText === undefined ? word.spokenText : op.spokenText;
      const children = op.syllables.map(item => {
        if (!item || typeof item !== "object") fail("INVALID_SYLLABLES", "syllable must be an object");
        const provenance = item.provenance === undefined ? "manual" : item.provenance;
        const locked = item.locked === undefined ? provenance === "manual" : item.locked;
        return {
          id: item.id, text: item.text, startMs: item.startMs, endMs: item.endMs,
          provenance, locked, effects: item.effects === undefined ? [] : clone(item.effects),
        };
      });
      if (children.length && children.map(item => item.text).join("") !== (spokenText || word.text)) fail("INVALID_SYLLABLES", "syllable text must concatenate exactly to the spoken word");
      word.syllables = children;
      if (op.spokenText === null) delete word.spokenText;
      else if (op.spokenText !== undefined) word.spokenText = op.spokenText;
    } else if (op.type === "setSyllableTiming") {
      const { word, syllable } = locateSyllable(next, op.syllableId);
      finiteNonnegative(op.startMs, "startMs"); finiteNonnegative(op.endMs, "endMs");
      if (op.endMs < op.startMs || op.startMs < word.startMs || op.endMs > word.endMs) fail("INVALID_TIME", "syllable timing must fit within its word");
      syllable.startMs = op.startMs; syllable.endMs = op.endMs; syllable.provenance = "manual"; syllable.locked = true;
    } else if (op.type === "setPhraseSyllableTimings") {
      const phrase = next.phrases.find(item => item.id === op.phraseId);
      if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${op.phraseId}`);
      if (!Array.isArray(op.marks) || op.marks.length > 5000) fail("INVALID_OPERATION", "marks must be a bounded array");
      const units = phrase.words.filter(word => word.excluded !== true).flatMap(word => (word.syllables || []).map(syllable => ({ word, syllable })));
      if (!units.length || op.marks.length !== units.length) fail("INVALID_OPERATION", "marks must include every authored syllable in the phrase exactly once");
      for (let i = 0; i < units.length; i++) {
        const mark = op.marks[i], { word, syllable } = units[i];
        if (!mark || mark.syllableId !== syllable.id) fail("INVALID_OPERATION", "marks must follow phrase syllable source order with each ID exactly once");
        if (!Number.isSafeInteger(mark.startMs) || !Number.isSafeInteger(mark.endMs) || mark.startMs < phrase.startMs || mark.endMs > phrase.endMs || mark.endMs <= mark.startMs) fail("INVALID_TIME", "syllable marks must be positive whole-millisecond intervals inside the phrase");
        if (i === 0 && mark.startMs !== phrase.startMs) fail("INVALID_TIME", "the first syllable must begin at the phrase boundary");
        if (i > 0 && mark.startMs !== op.marks[i - 1].endMs) fail("INVALID_TIME", "consecutive syllable marks must be contiguous");
        syllable.startMs = mark.startMs; syllable.endMs = mark.endMs; syllable.provenance = "manual"; syllable.locked = true;
        const prior = units[i - 1];
        const nextUnit = units[i + 1];
        if (!prior || prior.word !== word) word.startMs = mark.startMs;
        if (!nextUnit || nextUnit.word !== word) word.endMs = mark.endMs;
        word.provenance = "manual"; word.locked = true;
      }
      if (op.marks.at(-1).endMs !== phrase.endMs) fail("INVALID_TIME", "the final syllable must end at the phrase boundary");
    } else if (op.type === "setPhraseSyllablePerformance") {
      const phrase = next.phrases.find(item => item.id === op.phraseId);
      if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${op.phraseId}`);
      if (!Array.isArray(op.words) || !op.words.length || op.words.length > phrase.words.length) fail("INVALID_OPERATION", "words must be a nonempty bounded list of observed phrase words");
      const seenWords = new Set(), seenChildren = new Set();
      const indices = new Map(phrase.words.map((word, index) => [word.id, index]));
      let previousWordIndex = -1, previousEndMs = phrase.startMs;
      const pending = [];
      for (const submitted of op.words) {
        if (!submitted || typeof submitted.wordId !== "string" || seenWords.has(submitted.wordId)) fail("INVALID_OPERATION", "each observed word must occur once");
        const wordIndex = indices.get(submitted.wordId);
        if (wordIndex === undefined) fail("UNKNOWN_ID", `unknown word id: ${submitted.wordId}`);
        if (wordIndex <= previousWordIndex) fail("INVALID_OPERATION", "observed words must follow phrase source order");
        const word = phrase.words[wordIndex];
        if (word.excluded === true) fail("INVALID_OPERATION", "excluded words cannot receive phrase performance timings");
        if ((word.syllables || []).some(syllable => syllable.locked)) fail("LOCKED", "unlock existing syllables before replacing their performance timings");
        if (!Array.isArray(submitted.syllables) || !submitted.syllables.length || submitted.syllables.length > 128) fail("INVALID_SYLLABLES", "each observed word needs one to 128 syllables");
        if (submitted.spokenText !== undefined && submitted.spokenText !== null && (typeof submitted.spokenText !== "string" || !submitted.spokenText.trim() || submitted.spokenText.length > 256 || submitted.spokenText.includes("|"))) fail("INVALID_SYLLABLES", "spokenText must be nonempty, at most 256 characters, and contain no | separator");
        const spokenText = submitted.spokenText === undefined ? word.spokenText : submitted.spokenText;
        if (submitted.syllables.map(item => typeof item?.text === "string" ? item.text : "").join("") !== (spokenText || word.text)) fail("INVALID_SYLLABLES", "syllable text must concatenate exactly to the spoken word");
        const oldSyllables = new Map((word.syllables || []).map(syllable => [syllable.id, syllable]));
        const syllables = [];
        for (const item of submitted.syllables) {
          if (!item || typeof item.id !== "string" || !item.id || seenChildren.has(item.id) || typeof item.text !== "string" || !item.text) fail("INVALID_SYLLABLES", "each new syllable needs a unique ID and nonempty text");
          if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.startMs < phrase.startMs || item.endMs > phrase.endMs || item.endMs <= item.startMs) fail("INVALID_TIME", "performance syllables must be positive whole-millisecond intervals inside the phrase");
          if (item.startMs < previousEndMs) fail("INVALID_TIME", "performance timings must follow word and syllable source order without overlap");
          const prior = oldSyllables.get(item.id);
          const syllable = {
            ...(prior ? clone(prior) : {}), id: item.id, text: item.text, startMs: item.startMs, endMs: item.endMs,
            provenance: "manual", locked: true,
            effects: item.effects === undefined ? clone(prior?.effects || []) : clone(item.effects),
          };
          syllables.push(syllable); seenChildren.add(item.id); previousEndMs = item.endMs;
        }
        pending.push({ word, syllables, spokenText: submitted.spokenText, startMs: syllables[0].startMs, endMs: syllables.at(-1).endMs });
        seenWords.add(submitted.wordId); previousWordIndex = wordIndex;
      }
      for (const { word, syllables, spokenText, startMs, endMs } of pending) {
        word.startMs = startMs; word.endMs = endMs; word.provenance = "manual"; word.locked = true; word.syllables = syllables;
        if (spokenText === null) delete word.spokenText;
        else if (spokenText !== undefined) word.spokenText = spokenText;
      }
    } else if (op.type === "setSyllableLock") {
      const { syllable } = locateSyllable(next, op.syllableId);
      if (typeof op.locked !== "boolean") fail("INVALID_OPERATION", "locked must be boolean");
      syllable.locked = op.locked;
      if (op.locked) syllable.provenance = "manual";
    } else if (op.type === "setSyllableEffect") {
      const { syllable } = locateSyllable(next, op.syllableId);
      if (op.effect === null) syllable.effects = [];
      else {
        if (!op.effect || !EFFECTS.has(op.effect.type) || typeof op.effect.strength !== "number" || !Number.isFinite(op.effect.strength) || op.effect.strength < 0 || op.effect.strength > 1) fail("INVALID_EFFECT", "effect type or strength is invalid");
        syllable.effects = [clone(op.effect)];
      }
    } else if (op.type === "setWordReveal") {
      const { word } = locateWord(next, op.wordId);
      if (!validReveal(op.reveal)) fail("INVALID_REVEAL", "reveal must be null or a supported sweep configuration");
      word.reveal = op.reveal === null ? null : clone(op.reveal);
    } else if (op.type === "setSyllableReveal") {
      const { syllable } = locateSyllable(next, op.syllableId);
      if (!validReveal(op.reveal)) fail("INVALID_REVEAL", "reveal must be null or a supported sweep configuration");
      syllable.reveal = op.reveal === null ? null : clone(op.reveal);
    } else fail("INVALID_OPERATION", `unknown operation type: ${op.type}`);
    next.revision++;
    return validateScore(next);
  }

  function applyAlignment(score, proposals, expectedRevision) {
    checkExpected(score, expectedRevision);
    if (!Array.isArray(proposals)) fail("INVALID_PROPOSALS", "proposals must be an array");
    const next = clone(score);
    const evidenceByWord = new Set();
    const alignedPhrases = new Set();
    for (const proposal of proposals) {
      if (!proposal || typeof proposal !== "object" || typeof proposal.wordId !== "string" || typeof proposal.accepted !== "boolean" || typeof proposal.evidenceId !== "string" || !proposal.evidenceId) fail("INVALID_PROPOSAL", "proposal is malformed");
      if (proposal.confidence !== undefined && (typeof proposal.confidence !== "number" || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) fail("INVALID_PROPOSAL", "confidence must be between 0 and 1");
      if (!proposal.accepted) continue;
      const { phrase, word } = locateWord(next, proposal.wordId);
      finiteNonnegative(proposal.startMs, "startMs"); finiteNonnegative(proposal.endMs, "endMs");
      if (proposal.endMs < proposal.startMs) fail("INVALID_TIME", "alignment end precedes start");
      if (word.locked || (word.syllables || []).some(syllable => syllable.locked)) continue;
      if (!phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs)) fail("INVALID_TIME", "alignment timing must fit within its explicit phrase boundary");
      if ((word.syllables || []).some(syllable => syllable.provenance !== "estimated" && (syllable.startMs < proposal.startMs || syllable.endMs > proposal.endMs))) fail("INVALID_TIME", "alignment would exclude a non-estimated syllable boundary");
      const seenKey = `${proposal.wordId}\0${proposal.evidenceId}`;
      if (evidenceByWord.has(seenKey)) continue;
      evidenceByWord.add(seenKey);
      rescaleSyllables(word, word.startMs, word.endMs, proposal.startMs, proposal.endMs, syllable => syllable.provenance === "estimated" && !syllable.locked);
      word.startMs = proposal.startMs; word.endMs = proposal.endMs; word.provenance = "aligned";
      alignedPhrases.add(phrase.id);
      if (phrase.endEstimated) {
        phrase.startMs = phrase.words.reduce((min, item) => Math.min(min, item.startMs), phrase.startMs);
        phrase.endMs = phrase.words.reduce((max, item) => Math.max(max, item.endMs), phrase.endMs);
        phrase.fadeOutMs = Math.min(phrase.fadeOutMs, phrase.endMs - phrase.startMs);
      }
    }
    // A complete accepted word path replaces the old estimated display window.
    // Partial paths keep their existing bounds around still-estimated words.
    for (const phrase of next.phrases) {
      if (!alignedPhrases.has(phrase.id) || !phrase.endEstimated || !phrase.words.length || !phrase.words.every(word => word.provenance === "aligned")) continue;
      phrase.startMs = Math.min(...phrase.words.map(word => word.startMs));
      phrase.endMs = Math.max(...phrase.words.map(word => word.endMs));
      phrase.fadeOutMs = Math.min(phrase.fadeOutMs, phrase.endMs - phrase.startMs);
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
      const visibleWords = phrase.words.filter(w => !w.excluded);
      if (!visibleWords.length) continue;
      const activeWords = visibleWords.filter(w => at >= w.startMs && at <= w.endMs);
      phrases.push({ ...clone(phrase), words: clone(visibleWords), activeWords: activeWords.map(w => w.id), activeSyllables: activeWords.flatMap(w => (w.syllables || []).filter(syllable => at >= syllable.startMs && at <= syllable.endMs).map(syllable => syllable.id)), opacity });
    }
    return { phrases };
  }

  function revealProgress(item, mediaMs, offsetMs = 0) {
    if (!item || typeof item !== "object") fail("INVALID_REVEAL", "timed item is required");
    finiteNonnegative(mediaMs, "mediaMs");
    if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs)) fail("INVALID_TIME", "offsetMs must be finite");
    if (typeof item.startMs !== "number" || !Number.isFinite(item.startMs) || typeof item.endMs !== "number" || !Number.isFinite(item.endMs) || item.endMs < item.startMs) fail("INVALID_TIME", "item timing must be finite and ordered");
    const time = mediaMs - offsetMs;
    const reveal = item.reveal;
    if (reveal == null) return time >= item.startMs ? 1 : 0;
    if (!validReveal(reveal)) fail("INVALID_REVEAL", "reveal must be null or a supported sweep configuration");
    const duration = item.endMs - item.startMs;
    if (duration === 0) return time >= item.endMs ? 1 : 0;
    const x = Math.max(0, Math.min(1, (time - item.startMs) / duration));
    if (reveal.easing === "ease-out") return 1 - (1 - x) ** 3;
    if (reveal.easing === "ease-in-out") return x * x * (3 - 2 * x);
    return x;
  }

  function validateAlignmentReceipt(score, receipt) {
    validateScore(score);
    const bad = message => fail("INVALID_ALIGNMENT_RECEIPT", message);
    if (!receipt || receipt.version !== 'lyricvibe.alignment.v1' || receipt.automaticAdmissionEnabled !== false) bad('A review-only native alignment receipt is required');
    if (receipt.mediaKey !== mediaKey(score.source)) fail('SOURCE_MISMATCH', 'Alignment belongs to another video');
    if (receipt.lyricsHash !== score.lyrics.contentHash) fail('LYRIC_REVISION_MISMATCH', 'Alignment belongs to another lyric source revision');
    checkExpected(score, receipt.expectedRevision);
    for (const key of ['adapter', 'model']) if (typeof receipt[key] !== 'string' || !receipt[key].trim() || receipt[key].length > 300) bad(`Invalid ${key}`);
    if (!Array.isArray(receipt.proposals) || receipt.proposals.length > 5000) bad('At most 5000 proposals are allowed');
    const words = new Set(score.phrases.flatMap(phrase => phrase.words.map(word => word.id)));
    const seen = new Set();
    const proposals = receipt.proposals.map(proposal => {
      if (!proposal || !words.has(proposal.wordId) || seen.has(proposal.wordId)) bad('Each proposal must name a distinct word in this score');
      seen.add(proposal.wordId);
      if (proposal.accepted !== false || typeof proposal.evidenceId !== 'string' || !proposal.evidenceId || proposal.evidenceId.length > 500) bad('Proposal requires review-only evidence');
      if (!Number.isSafeInteger(proposal.startMs) || !Number.isSafeInteger(proposal.endMs) || proposal.startMs < 0 || proposal.endMs < proposal.startMs) bad('Word intervals must be ordered integer milliseconds');
      if (score.source.durationMs > 0 && proposal.endMs + score.offsetMs > score.source.durationMs + 1000) bad('Proposal exceeds the source video duration');
      if (proposal.confidence !== undefined && (typeof proposal.confidence !== 'number' || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) bad('Invalid proposal confidence');
      return { wordId: proposal.wordId, startMs: proposal.startMs, endMs: proposal.endMs, accepted: false, evidenceId: proposal.evidenceId, ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }), reviewReason: 'Native supplied-lyrics alignment; audition before accepting.' };
    });
    return { version: receipt.version, mediaKey: receipt.mediaKey, lyricsHash: receipt.lyricsHash, expectedRevision: receipt.expectedRevision, adapter: receipt.adapter, model: receipt.model, proposals, automaticAdmissionEnabled: false };
  }

  return { VERSION, ScoreError, mediaKey, parseLrc, hyphenWordParts, createScore, validateScore, validateAlignmentReceipt, activeAt, revealProgress, applyOperation, applyAlignment };
});
