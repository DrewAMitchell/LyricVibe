(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./score-core.js') : root.LvScore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvTranscriptText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  // Whole-transcript editing. One line per phrase; singer markers carry lane
  // identity while visible (non-excluded) words stay space separated.
  // Diffing maps edits onto existing score operations so unchanged words keep
  // their IDs, timing, syllables and effects.
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const visible = phrase => phrase.words.filter(word => word.excluded !== true);
  const tokenText=token=>token.startsWith('==')?token.slice(1):token.startsWith('=')&&token.length>1?token.slice(1):token;
  const whole=token=>token.startsWith('=')&&!token.startsWith('==')&&token.length>1;
  const encode=word=>word.displayMode==='whole'?'='+word.text:word.text.startsWith('=')?'='+word.text:word.text;

  function toText(score) {
    const lead = score.lanes.find(lane => lane.role === 'lead')?.id;
    return score.phrases.filter(phrase => visible(phrase).length).map(phrase => {
      const lane=score.lanes.find(l=>l.id===phrase.laneId);
      const marker = phrase.laneId === lead && lane.id==='lead' ? '' : `[${lane.id==='backing'?'backing':lane.label}] `;
      return (marker + visible(phrase).map(encode).join(' ')).trimEnd();
    }).join('\n');
  }

  // Only complete, balanced groups are shorthand; unfinished typing stays literal.
  function parentheticalParts(text) {
    let main = '', flattened = '', found = false;
    const backing = [];
    for (let i = 0; i < text.length;) {
      if (text[i] !== '(') { main += text[i]; flattened += text[i++]; continue; }
      let depth = 1, end = i + 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === '(') depth++;
        if (text[end] === ')') depth--;
      }
      if (depth) { main += text.slice(i); flattened += text.slice(i); break; }
      const body = text.slice(i + 1, end - 1).replace(/[()]/g, ' ').trim();
      if (body) backing.push(body);
      main += ' '; flattened += ` ${body} `; found = true; i = end;
    }
    const tokens = value => value.replace(/\s+([,.;:!?])/g, '$1').trim().split(/\s+/).filter(Boolean);
    return { main: tokens(main), backing: tokens(backing.join(' ')), flattened: tokens(flattened), found };
  }

  function parseText(text, score) {
    const parsed = [], backingLane = score.lanes.find(lane => lane.role === 'backing');
    let previousMain = null;
    core.parseVocalText(text,score.lanes).entries.forEach(segment => {
      const entry = { laneId:segment.laneId,tokens:segment.text.split(/\s+/),line:segment.line };
      const parts = parentheticalParts(entry.tokens.join(' '));
      if (!parts.found) {
        if (score.lanes.find(lane => lane.id === entry.laneId)?.role === 'lead') previousMain = parsed.length;
        parsed.push(entry); return;
      }
      if (!backingLane && parts.backing.length) fail('MISSING_BACKING_LANE', 'This score needs a backing lane before parenthesized lyrics can be added.');
      if (score.lanes.find(lane => lane.id === entry.laneId)?.role === 'backing') {
        parsed.push({ ...entry, tokens: parts.flattened }); return;
      }
      if (parts.main.length) {
        previousMain = parsed.length;
        parsed.push({ ...entry, tokens: parts.main, hasBacking: parts.backing.length > 0 });
      }
      if (parts.backing.length) parsed.push({ laneId: backingLane.id, tokens: parts.backing, line: entry.line, autoBacking: true, anchorIndex: previousMain });
    });
    return parsed;
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

  // Similarity of two token lists: shared words in order over the longer length.
  const similarity = (a, b) => (a.length || b.length) ? lcsPairs(a, b).length / Math.max(a.length, b.length) : 1;

  // Align transcript lines to phrases, maximizing total similarity; pairs below
  // the threshold are treated as a deleted phrase plus an inserted line.
  function alignLines(oldTokens, newTokens, canPair = () => true, threshold = 0.5) {
    const n = oldTokens.length, m = newTokens.length;
    const lower = list => list.map(t => t.toLowerCase());
    const sim = oldTokens.map((a, i) => newTokens.map((b, j) => canPair(i, j) ? similarity(lower(a), lower(b)) : -Infinity));
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
      if (i1 - i0 === j1 - j0) for (let d = 1; d < i1 - i0; d++) if (canPair(i0 + d, j0 + d)) pairs.push([i0 + d, j0 + d]);
      if (k + 1 < bounds.length - 1) pairs.push(bounds[k + 1]);
    }
    return pairs;
  }

  function wordEdits(phrase, line, tokens, operations, changes) {
    const old = visible(phrase), pairs = lcsPairs(old.map(word => word.text), tokens.map(tokenText));
    const displayEdit=(word,token)=>{if((word.displayMode==='whole')!==whole(token)){operations.push({type:'setWordDisplayMode',wordId:word.id,mode:whole(token)?'whole':'syllables'});changes.push({line,phraseId:phrase.id,kind:'display',wordId:word.id,from:word.displayMode==='whole'?'whole word':'syllables',to:whole(token)?'whole word':'syllables'});}};
    for(const [oi,ti]of pairs)displayEdit(old[oi],tokens[ti]);
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
          operations.push({ type: 'setWordText', wordId: word.id, text: tokenText(added[n]) });displayEdit(word,added[n]);
          changes.push({ line, phraseId: phrase.id, kind: 'respell', wordId: word.id, from: word.text, to: tokenText(added[n]) });
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
      const at=pairs.find(([oi])=>old[oi].id===word.id)?.[1];
      const text = [...before, at===undefined?encode(word):tokens[at], ...after].join(' ');
      operations.push({ type: 'replaceWords', phraseId: phrase.id, wordIds: [word.id], text });
      changes.push({ line, phraseId: phrase.id, kind: 'insert', from: word.text, to: text });
    }
  }

  function diff(score, text, {backingStart='beginning',laneEdits=[]} = {}) {
    if(!['beginning','near-end'].includes(backingStart))fail('INVALID_BACKING_START','Choose beginning or near-end backing placement.');
    if (typeof text !== 'string' || text.length > 200000) fail('INVALID_TEXT', 'Transcript text must be a string under 200,000 characters.');
    const vocal=core.parseVocalText(text,score.lanes),prefix=[],changesBefore=[];
    for(const lane of vocal.lanes){
      const old=score.lanes.find(l=>l.id===lane.id),edit=laneEdits.find(l=>l.id===lane.id),value=edit?{...lane,...edit}:lane;
      if(!old||old.label!==value.label||old.role!==value.role){prefix.push({type:'setLane',laneId:value.id,label:value.label,role:value.role});changesBefore.push({kind:'track',from:old?.label||'',to:`${value.label} (${value.role==='lead'?'Main':'Backing'})`});}
    }
    // Resolve text against the pre-rename labels, then apply metadata and splits.
    const parsed = parseText(text, {...score,lanes:vocal.lanes});
    let working=score;
    for(const op of prefix)working=core.applyOperation(working,op,working.revision);
    const groups=new Map();for(const entry of parsed){if(!groups.has(entry.line))groups.set(entry.line,[]);groups.get(entry.line).push(entry);}
    const used=new Set();
    for(const entries of groups.values()){
      if(entries.length<2||entries.some(e=>e.autoBacking||e.hasBacking))continue;
      const tokens=entries.flatMap(e=>e.tokens.map(tokenText));
      const phrase=working.phrases.find(p=>!used.has(p.id)&&JSON.stringify(visible(p).map(w=>w.text))===JSON.stringify(tokens));
      if(!phrase)continue;used.add(phrase.id);
      let offset=0;const visibleWords=visible(phrase),parts=entries.map(e=>{const words=visibleWords.slice(offset,offset+e.tokens.length);offset+=e.tokens.length;return {laneId:e.laneId,wordIds:words.map(w=>w.id)};});
      // Hidden words remain attached to the preceding visible part.
      let part=0;for(const word of phrase.words){const at=parts.findIndex(p=>p.wordIds.includes(word.id));if(at>=0)part=at;else parts[part].wordIds.push(word.id);}
      for(const p of parts)p.wordIds.sort((a,b)=>phrase.words.findIndex(w=>w.id===a)-phrase.words.findIndex(w=>w.id===b));
      const op={type:'splitPhraseLanes',phraseId:phrase.id,parts};prefix.push(op);working=core.applyOperation(working,op,working.revision);
      changesBefore.push({line:entries[0].line,kind:'split-track',from:visible(phrase).map(w=>w.text).join(' '),to:'Separate vocal tracks; timing preserved'});
    }
    score=working;
    // Phrases whose words are all hidden are deleted from the transcript's point of view.
    const phrases = score.phrases.filter(phrase => visible(phrase).length);
    const lineIndexes = parsed.map((entry, i) => entry ? i : -1).filter(i => i >= 0);
    const pairs = alignLines(phrases.map(phrase => visible(phrase).map(word => word.text)), lineIndexes.map(i => parsed[i].tokens.map(tokenText)), (pi, li) => {
      const entry = parsed[lineIndexes[li]], role = score.lanes.find(lane => lane.id === phrases[pi].laneId)?.role;
      return entry.autoBacking ? role === 'backing' : entry.hasBacking ? role === 'lead' : true;
    });
    const operations = [], changes = [], inserts = [];
    const matchedPhrase = new Map(pairs.map(([pi, li]) => [lineIndexes[li], phrases[pi]]));
    const timings = new Map(matchedPhrase);
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
      const ordinaryCount = pendingNew.filter(entry => entry.anchorIndex == null).length;
      const each = ordinaryCount && gapEnd - gapStart >= 500 * ordinaryCount ? Math.floor((gapEnd - gapStart) / ordinaryCount) : 1500;
      let ordinaryIndex = 0;
      const planned = pendingNew.map(entry => {
        const anchor = timings.get(entry.anchorIndex);
        const startMs = anchor ? backingStart==='near-end'?(anchor.words?visible(anchor).at(-1)?.startMs??anchor.startMs:Math.max(anchor.startMs,anchor.endMs-800)):anchor.startMs : gapStart + ordinaryIndex++ * each;
        const duration = anchor ? Math.max(1500, Math.min(8000, entry.tokens.length * 650)) : each;
        const result = { ...entry, startMs, endMs: startMs + duration };
        timings.set(entry.index, result); return result;
      });
      // Each insert lands directly after the anchor, so emit in reverse to keep line order.
      for (const entry of [...planned].reverse()) {
        inserts.push({ type: 'insertPhrase', afterPhraseId: previous ? previous.id : null, laneId: entry.laneId, text: entry.tokens.join(' '), startMs: entry.startMs, endMs: entry.endMs });
      }
      for (const entry of planned) changes.push({ line: entry.line, phraseId: null, kind: entry.autoBacking ? 'add-backing' : 'add-line', from: '', to: entry.tokens.join(' ') });
      pendingNew = [];
    };
    parsed.forEach((entry, index) => {
      if (!entry) return;
      const line = entry.line, phrase = matchedPhrase.get(index);
      if (!phrase) {
        if (entry.tokens.length) pendingNew.push({ ...entry, index });
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
    return { operations: [...prefix,...operations, ...inserts], changes:[...changesBefore,...changes] };
  }

  return { toText, diff };
});
