(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTranscriptText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Whole-transcript text editing. One line per phrase; non-lead lanes carry a
  // "[laneId] " prefix. Visible (non-excluded) words are space separated.
  // Diffing maps edits onto existing score operations so unchanged words keep
  // their IDs, timing, syllables and effects.
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const visible = phrase => phrase.words.filter(word => word.excluded !== true);

  function toText(score) {
    const lead = score.lanes.find(lane => lane.role === 'lead')?.id;
    return score.phrases.filter(phrase => visible(phrase).length).map(phrase => {
      const marker = phrase.laneId === lead ? '' : `[${phrase.laneId}] `;
      return (marker + visible(phrase).map(word => word.text).join(' ')).trimEnd();
    }).join('\n');
  }

  function parseLine(line, score, fallbackLaneId) {
    const match = /^\[([A-Za-z0-9_-]+)\]\s*/.exec(line);
    // Only a known lane ID is a lane marker; "[Chorus]" stays lyric text.
    if (match && score.lanes.some(lane => lane.id === match[1])) {
      return { laneId: match[1], tokens: line.slice(match[0].length).trim().split(/\s+/).filter(Boolean) };
    }
    const lead = score.lanes.find(lane => lane.role === 'lead')?.id ?? fallbackLaneId;
    return { laneId: lead, tokens: line.trim().split(/\s+/).filter(Boolean) };
  }

  // Longest common subsequence of exact word texts; returns matched index pairs.
  function lcsPairs(a, b) {
    const rows = a.length + 1, cols = b.length + 1, table = Array.from({ length: rows }, () => new Uint16Array(cols));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    const pairs = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function linesOf(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines;
  }

  // Similarity of two token lists: shared words in order over the longer length.
  const similarity = (a, b) => (a.length || b.length) ? lcsPairs(a, b).length / Math.max(a.length, b.length) : 1;

  // Align transcript lines to phrases, maximizing total similarity; pairs below
  // the threshold are treated as a deleted phrase plus an inserted line.
  function alignLines(oldTokens, newTokens, threshold = 0.5) {
    const n = oldTokens.length, m = newTokens.length;
    const lower = list => list.map(t => t.toLowerCase());
    const sim = oldTokens.map(a => newTokens.map(b => similarity(lower(a), lower(b))));
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], sim[i][j] >= threshold ? best[i + 1][j + 1] + sim[i][j] : -Infinity);
    }
    const anchored = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (sim[i][j] >= threshold && best[i][j] === best[i + 1][j + 1] + sim[i][j]) { anchored.push([i, j]); i++; j++; }
      else if (best[i][j] === best[i + 1][j]) i++;
      else j++;
    }
    // Between anchors, equal runs of unmatched lines are heavy edits of the same lines: pair them by position.
    const pairs = [], bounds = [[-1, -1], ...anchored, [n, m]];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const [i0, j0] = bounds[k], [i1, j1] = bounds[k + 1];
      if (i1 - i0 === j1 - j0) for (let d = 1; d < i1 - i0; d++) pairs.push([i0 + d, j0 + d]);
      if (k + 1 < bounds.length - 1) pairs.push(bounds[k + 1]);
    }
    return pairs;
  }

  function wordEdits(phrase, line, tokens, operations, changes) {
    const old = visible(phrase), pairs = lcsPairs(old.map(word => word.text), tokens);
    if (pairs.length === old.length && pairs.length === tokens.length) return;
    // Hunks are the gaps between consecutive matched anchors.
    const anchors = [[-1, -1], ...pairs, [old.length, tokens.length]];
    const insertions = new Map();
    for (let k = 0; k + 1 < anchors.length; k++) {
      const [oi, ti] = anchors[k], [oj, tj] = anchors[k + 1];
      const removed = old.slice(oi + 1, oj), added = tokens.slice(ti + 1, tj);
      if (!removed.length && !added.length) continue;
      if (removed.length && removed.length === added.length) {
        removed.forEach((word, n) => {
          operations.push({ type: 'setWordText', wordId: word.id, text: added[n] });
          changes.push({ line, phraseId: phrase.id, kind: 'respell', wordId: word.id, from: word.text, to: added[n] });
        });
      } else if (removed.length && added.length) {
        operations.push({ type: 'replaceWords', phraseId: phrase.id, wordIds: removed.map(word => word.id), text: added.join(' ') });
        changes.push({ line, phraseId: phrase.id, kind: 'replace', from: removed.map(word => word.text).join(' '), to: added.join(' ') });
      } else if (removed.length) {
        for (const word of removed) operations.push({ type: 'setWordExcluded', wordId: word.id, excluded: true });
        changes.push({ line, phraseId: phrase.id, kind: 'hide', from: removed.map(word => word.text).join(' '), to: '' });
      } else {
        // Pure insertion merges into a neighboring unchanged word: the previous one, or the next at line start.
        const neighbor = oi >= 0 ? old[oi] : old[oj];
        const entry = insertions.get(neighbor.id) || { word: neighbor, before: [], after: [] };
        (oi >= 0 ? entry.after : entry.before).push(...added);
        insertions.set(neighbor.id, entry);
      }
    }
    for (const { word, before, after } of insertions.values()) {
      const text = [...before, word.text, ...after].join(' ');
      operations.push({ type: 'replaceWords', phraseId: phrase.id, wordIds: [word.id], text });
      changes.push({ line, phraseId: phrase.id, kind: 'insert', from: word.text, to: text });
    }
  }

  function diff(score, text) {
    if (typeof text !== 'string' || text.length > 200000) fail('INVALID_TEXT', 'Transcript text must be a string under 200,000 characters.');
    // Phrases whose words are all hidden are deleted from the transcript's point of view.
    const phrases = score.phrases.filter(phrase => visible(phrase).length);
    const parsed = linesOf(text).map(line => line.trim() ? parseLine(line, score, null) : null);
    const lineIndexes = parsed.map((entry, i) => entry ? i : -1).filter(i => i >= 0);
    const pairs = alignLines(phrases.map(phrase => visible(phrase).map(word => word.text)), lineIndexes.map(i => parsed[i].tokens));
    const operations = [], changes = [], inserts = [];
    const matchedPhrase = new Map(pairs.map(([pi, li]) => [lineIndexes[li], phrases[pi]]));
    const matchedSet = new Set(pairs.map(([pi]) => pi));
    phrases.forEach((phrase, pi) => {
      if (matchedSet.has(pi)) return;
      for (const word of visible(phrase)) operations.push({ type: 'setWordExcluded', wordId: word.id, excluded: true });
      changes.push({ line: null, phraseId: phrase.id, kind: 'delete-line', from: visible(phrase).map(word => word.text).join(' '), to: '' });
    });
    let previous = null, pendingNew = [];
    const flush = nextPhrase => {
      if (!pendingNew.length) return;
      const gapStart = previous ? previous.endMs : 0;
      const gapEnd = nextPhrase ? nextPhrase.startMs : (score.source?.durationMs ?? gapStart + 1500 * pendingNew.length);
      const each = gapEnd - gapStart >= 500 * pendingNew.length ? Math.floor((gapEnd - gapStart) / pendingNew.length) : 1500;
      const planned = pendingNew.map((entry, k) => ({ ...entry, startMs: gapStart + k * each, endMs: gapStart + (k + 1) * each }));
      // Each insert lands directly after the anchor, so emit in reverse to keep line order.
      for (const entry of [...planned].reverse()) {
        inserts.push({ type: 'insertPhrase', afterPhraseId: previous ? previous.id : null, laneId: entry.laneId, text: entry.tokens.join(' '), startMs: entry.startMs, endMs: entry.endMs });
      }
      for (const entry of planned) changes.push({ line: entry.line, phraseId: null, kind: 'add-line', from: '', to: entry.tokens.join(' ') });
      pendingNew = [];
    };
    parsed.forEach((entry, index) => {
      if (!entry) return;
      const line = index + 1, phrase = matchedPhrase.get(index);
      if (!phrase) {
        if (entry.tokens.length) pendingNew.push({ line, laneId: entry.laneId, tokens: entry.tokens });
        return;
      }
      flush(phrase);
      if (entry.laneId !== phrase.laneId) {
        operations.push({ type: 'setPhraseLane', phraseId: phrase.id, laneId: entry.laneId });
        changes.push({ line, phraseId: phrase.id, kind: 'lane', from: phrase.laneId, to: entry.laneId });
      }
      if (!entry.tokens.length) {
        for (const word of visible(phrase)) operations.push({ type: 'setWordExcluded', wordId: word.id, excluded: true });
        changes.push({ line, phraseId: phrase.id, kind: 'delete-line', from: visible(phrase).map(word => word.text).join(' '), to: '' });
      } else wordEdits(phrase, line, entry.tokens, operations, changes);
      previous = phrase;
    });
    flush(null);
    changes.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    return { operations: [...operations, ...inserts], changes };
  }

  return { toText, diff };
});
