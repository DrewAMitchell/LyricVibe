/* Lexical pronunciation hints; spelling cuts are deliberately marked heuristic. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LvPronunciation = api;
})(globalThis, function() {
  const VOWELS = new Set('aeiouy');
  const ONSETS = new Set([
    'bl', 'br', 'ch', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'kl', 'kr',
    'kw', 'ph', 'pl', 'pr', 'sc', 'sh', 'sk', 'sl', 'sm', 'sn', 'sp', 'st',
    'sw', 'th', 'tr', 'tw', 'wh', 'wr', 'sch', 'shr', 'spl', 'spr', 'squ',
    'str', 'thr', 'scr',
  ]);
  const SMALL_NUMBERS = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
  ];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const CURATED_TWO_PARTS = Object.freeze({ hour: 'hou', hours: 'hou', our: 'ou', fire: 'fi' });

  function failure(status, spokenText, syllableCounts, method, reason) {
    return { status, spokenText, syllableCounts, parts: [], method, reason };
  }

  function dictionaryEntries(countsIndex) {
    if (!countsIndex || typeof countsIndex !== 'object' || Array.isArray(countsIndex)) return null;
    const entries = countsIndex.entries && typeof countsIndex.entries === 'object' && !Array.isArray(countsIndex.entries)
      ? countsIndex.entries : countsIndex;
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : null;
  }

  function countsFor(index, word) {
    const entries = dictionaryEntries(index);
    if (!entries) return null;
    const value = entries[word.toLowerCase().replace(/’/g, "'")];
    if (!Array.isArray(value) || value.length === 0 ||
        value.some(count => !Number.isSafeInteger(count) || count <= 0)) return null;
    return [...new Set(value)].sort((a, b) => a - b);
  }

  function numberWords(number) {
    if (number < 20) return [SMALL_NUMBERS[number]];
    const tens = Math.floor(number / 10), ones = number % 10;
    return ones ? [TENS[tens], SMALL_NUMBERS[ones]] : [TENS[tens]];
  }

  function shell(text) {
    const match = /^([^A-Za-z0-9]*)([A-Za-z]+(?:['’][A-Za-z]+)*)([^A-Za-z0-9]*)$/.exec(text);
    return match ? { prefix: match[1], core: match[2], suffix: match[3] } : null;
  }

  // A small maximal-onset spelling heuristic. It proposes cuts only; the
  // number and uniqueness of cuts must agree with CMUdict before they escape.
  function spellingParts(word, expectedCount) {
    if (expectedCount === 1) return [word];
    if (!/^[A-Za-z]+$/.test(word)) return null;
    const lower = word.toLowerCase();
    const nuclei = [];
    for (let i = 0; i < lower.length;) {
      if (!VOWELS.has(lower[i])) { i++; continue; }
      const start = i++;
      while (i < lower.length && VOWELS.has(lower[i])) i++;
      nuclei.push([start, i]);
    }
    if (nuclei.length !== expectedCount) return null;
    const cuts = [];
    for (let i = 0; i + 1 < nuclei.length; i++) {
      const betweenStart = nuclei[i][1], betweenEnd = nuclei[i + 1][0];
      const cluster = lower.slice(betweenStart, betweenEnd);
      if (!/^[b-df-hj-np-tv-xz]*$/.test(cluster)) return null;
      let onsetLength = 1;
      for (let size = Math.min(3, cluster.length); size >= 1; size--) {
        if (ONSETS.has(cluster.slice(-size))) { onsetLength = size; break; }
      }
      const cut = betweenEnd - onsetLength;
      if (cut <= (cuts[cuts.length - 1] || 0) || cut >= word.length) return null;
      cuts.push(cut);
    }
    const parts = [];
    let start = 0;
    for (const cut of cuts) { parts.push(word.slice(start, cut)); start = cut; }
    parts.push(word.slice(start));
    return parts.length === expectedCount && parts.every(Boolean) ? parts : null;
  }

  function withPunctuation(parts, prefix, suffix) {
    if (!parts || !parts.length) return [];
    const result = [...parts];
    result[0] = prefix + result[0];
    result[result.length - 1] += suffix;
    return result;
  }

  function alternativesFor(word, counts, prefix, suffix) {
    const alternatives = [];
    for (const count of counts) {
      const curatedPrefix = count === 2 ? CURATED_TWO_PARTS[word.toLowerCase()] : null;
      const parts = curatedPrefix ? [word.slice(0, curatedPrefix.length), word.slice(curatedPrefix.length)] : spellingParts(word, count);
      if (!parts) continue;
      alternatives.push({
        count,
        parts: withPunctuation(parts, prefix, suffix),
        method: curatedPrefix ? 'dictionary-count+curated-spelling' : 'orthographic-heuristic',
      });
    }
    return alternatives;
  }

  function graphemes(text) {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment); } catch {}
    }
    return Array.from(text);
  }

  function fallbackParts(text, count) {
    const units = graphemes(text);
    if (count > units.length) return [];
    const result = [];
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const size = Math.floor(units.length / count) + (i < units.length % count ? 1 : 0);
      result.push(units.slice(offset, offset + size).join(''));
      offset += size;
    }
    return result;
  }

  function partsForCount(text, count, options = {}) {
    if (typeof text !== 'string' || !text.trim()) return { parts: [], method: 'none', estimated: true, reason: 'empty-or-invalid-text' };
    if (!Number.isSafeInteger(count) || count < 1 || count > 64) return { parts: [], method: 'none', estimated: true, reason: 'invalid-count' };
    const { spokenText, existingParts, countsIndex } = options && typeof options === 'object' ? options : {};
    let segmentationText = typeof spokenText === 'string' && spokenText.trim() ? spokenText : text;
    if(!spokenText && countsIndex && /^[^A-Za-z0-9]*\d{1,2}[^A-Za-z0-9]*$/.test(text)){
      const numeric=suggest(text,countsIndex);
      if(numeric.status==='suggested')segmentationText=numeric.spokenText;
    }
    if (Array.isArray(existingParts) && existingParts.length === count && existingParts.every(part => typeof part === 'string' && part.trim()) && existingParts.join('') === segmentationText) {
      return { parts: [...existingParts], method: 'existing', estimated: false };
    }
    if (countsIndex) {
      const candidates = [];
      for (const lookupText of new Set([text, segmentationText])) {
        const suggestion = suggest(lookupText, countsIndex);
        if (suggestion.status === 'suggested') candidates.push({ count: suggestion.syllableCounts[0], parts: suggestion.parts, method: suggestion.method });
        for (const alternative of suggestion.alternatives || []) candidates.push(alternative);
      }
      const candidate = candidates.find(item => item.count === count && Array.isArray(item.parts) && item.parts.length === count && item.parts.every(part => typeof part === 'string' && part.length) && item.parts.join('') === segmentationText);
      if (candidate) return { parts: [...candidate.parts], method: candidate.method, estimated: true };
    }
    const parts = fallbackParts(segmentationText, count);
    if (!parts.length) return { parts: [], method: 'orthographic-count-fallback', estimated: true, reason: 'count-exceeds-graphemes' };
    return { parts, method: 'orthographic-count-fallback', estimated: true };
  }

  function suggest(text, countsIndex, spokenOverride) {
    if (typeof text !== 'string' || !text.length) {
      return failure('invalid', '', [], 'none', 'empty-or-invalid-text');
    }
    const matchNumber = /^([^A-Za-z0-9]*)(\d{1,2})([^A-Za-z0-9]*)$/.exec(text);
    const isNumber = !!matchNumber && Number(matchNumber[2]) <= 99;
    let prefix = '', suffix = '', spokenText, lookupWords, method;
    if (spokenOverride !== undefined && spokenOverride !== null) {
      const overrideShell = typeof spokenOverride === 'string' ? shell(spokenOverride) : null;
      if (!overrideShell) {
        return failure('invalid', '', [], 'spoken-override', 'spoken-override-must-be-one-ascii-word');
      }
      const wrapped = shell(text);
      prefix = overrideShell.prefix || wrapped?.prefix || '';
      suffix = overrideShell.suffix || wrapped?.suffix || '';
      spokenText = overrideShell.core;
      lookupWords = [overrideShell.core];
      method = 'cmudict-count+orthographic-heuristic+spoken-override';
    } else if (isNumber) {
      prefix = matchNumber[1]; suffix = matchNumber[3];
      lookupWords = numberWords(Number(matchNumber[2]));
      spokenText = lookupWords.join('');
      method = 'cmudict-count+number-spelling';
    } else {
      const wrapped = shell(text);
      if (!wrapped) return failure('unknown', text, [], 'cmudict-count', 'unsupported-token-shape');
      ({ prefix, core: spokenText, suffix } = wrapped);
      lookupWords = [spokenText];
      method = 'cmudict-count+orthographic-heuristic';
    }

    const componentCounts = lookupWords.map(word => countsFor(countsIndex, word));
    if (componentCounts.some(counts => !counts)) {
      return failure('unknown', spokenText, [], method, 'word-not-in-pronunciation-index');
    }
    const syllableCounts = componentCounts.length === 1
      ? componentCounts[0]
      : [componentCounts.reduce((sum, counts) => sum + (counts.length === 1 ? counts[0] : 0), 0)];
    if (componentCounts.some(counts => counts.length !== 1)) {
      const result = failure('ambiguous', spokenText, syllableCounts, method, 'multiple-dictionary-syllable-counts');
      if (lookupWords.length === 1) result.alternatives = alternativesFor(spokenText, componentCounts[0], prefix, suffix);
      return result;
    }

    if (lookupWords.length > 1) {
      const parts = [];
      for (const word of lookupWords) {
        const split = spellingParts(word, countsFor(countsIndex, word)[0]);
        if (!split) return failure('unavailable', spokenText, syllableCounts, method, 'orthographic-split-unavailable');
        parts.push(...split);
      }
      const punctuatedParts = withPunctuation(parts, prefix, suffix);
      return { status: 'suggested', spokenText: punctuatedParts.join(''), syllableCounts, parts: punctuatedParts, method, reason: null };
    }

    const count = componentCounts[0][0];
    const parts = spellingParts(spokenText, count);
    if (!parts) return failure('unavailable', spokenText, syllableCounts, method, 'orthographic-split-unavailable');
    const punctuatedParts = withPunctuation(parts, prefix, suffix);
    return { status: 'suggested', spokenText: punctuatedParts.join(''), syllableCounts, parts: punctuatedParts, method, reason: null };
  }

  return { suggest, partsForCount };
});
