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
    return score.phrases.map(phrase => {
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

  function diff(score, text) {
    if (typeof text !== 'string' || text.length > 200000) fail('INVALID_TEXT', 'Transcript text must be a string under 200,000 characters.');
    const lines = linesOf(text), phrases = score.phrases;
    if (lines.length !== phrases.length) {
      const before = linesOf(toText(score));
      let top = 0; while (top < Math.min(lines.length, before.length) && lines[top] === before[top]) top++;
      fail('LINE_COUNT', `Keep one line per phrase: expected ${phrases.length}, found ${lines.length}. The first difference is at line ${top + 1}. Adding, removing, splitting or merging lines is not supported yet.`);
    }
    const operations = [], changes = [];
    phrases.forEach((phrase, index) => {
      const line = index + 1, parsed = parseLine(lines[index], score, phrase.laneId), old = visible(phrase);
      if (parsed.laneId !== phrase.laneId) {
        operations.push({ type: 'setPhraseLane', phraseId: phrase.id, laneId: parsed.laneId });
        changes.push({ line, phraseId: phrase.id, kind: 'lane', from: phrase.laneId, to: parsed.laneId });
      }
      const pairs = lcsPairs(old.map(word => word.text), parsed.tokens);
      if (pairs.length === old.length && pairs.length === parsed.tokens.length) return;
      if (!old.length) fail('NO_ANCHOR', `Line ${line}: this phrase has no visible words to attach new text to.`);
      // Hunks are the gaps between consecutive matched anchors.
      const anchors = [[-1, -1], ...pairs, [old.length, parsed.tokens.length]];
      const insertions = new Map();
      for (let k = 0; k + 1 < anchors.length; k++) {
        const [oi, ti] = anchors[k], [oj, tj] = anchors[k + 1];
        const removed = old.slice(oi + 1, oj), added = parsed.tokens.slice(ti + 1, tj);
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
    });
    return { operations, changes };
  }

  return { toText, diff };
});
