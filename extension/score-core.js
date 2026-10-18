(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LvScore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "lyricvibe.score.v1";
  const DISPLAY_CATALOG = Object.freeze({
    version: 'lyricvibe.display.v1',
    looks: Object.freeze(['samay','flow','fire','neon','glass','hype','soft','clean','retro','elegant','aurora','matrix','vinyl','cosmic']),
    motions: Object.freeze(['off','mix','tip','flex','bounce','launch','rock','float']),
    wordArt: Object.freeze(['off','rays','sunglasses','fire','bills','champagne','disco']),
    wordEffects: Object.freeze(['shake','tilt','pulse','bounce','glow','groove','echo','glitch']),
    beatEffects: Object.freeze(['pulse','breath','color','bounce','glow','groove','echo','glitch']),
    landings: Object.freeze(['settle','glide','drop','still']),
    layouts: Object.freeze(['classic','fall','puzzle','vinyl'])
  });
  const EFFECTS = new Set(["shake", "tilt", "pulse", "bounce", "glow", "groove", "echo", "glitch"]);
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
  function validEmoji(value){return typeof value==='string'&&(value===''||value.length<=32&&/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)&&!/[^\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\u20e3\p{M}]/u.test(value)&&[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(value)].length===1);}
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
  function doubledText(text){return {doubled:/^\s*\(doubled\)(?:\s|$)/i.test(text),text:String(text).replace(/^\s*\(doubled\)(?:\s+|$)/i,'').replace(/(\S)\s+\(d\)(?=\s|$|[.,!?;:])/gi,'$1(d)')};}
  function displayToken(token){const doubled=/\(d\)(?=[.,!?;:]*$)/i.test(token);token=token.replace(/\(d\)(?=[.,!?;:]*$)/i,'');const value=displaySpelling(token);return doubled?{...value,doubled:true}:value;}
  function displaySpelling(token){return token.startsWith('==')?{text:token.slice(1)}:token.startsWith('=')&&token.length>1?{text:token.slice(1),displayMode:'whole'}:{text:token};}
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
    let singerHeader='';
    for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const matches = [...line.matchAll(timestamp)];
      if (!matches.length) {if(/^\s*\[[^\[\]:]+\]\s*$/.test(line)&&!parseVocalText(line,[{id:'lead',role:'lead',label:'Lead'},{id:'backing',role:'backing',label:'Backing'}]).entries.length)singerHeader=line.trim();continue;}
      const body = line.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length).trim();
      const text=body?singerHeader+body:body;
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
    const re = /\((?:[^()]|\(d\))*\)|[^\s]+/giu;
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

  // Standalone singer headers persist; inline markers affect the remainder of
  // their line. Known section labels remain literal, as in existing transcripts.
  function parseVocalText(text, existingLanes) {
    const lanes=clone(existingLanes), entries=[];
    const defaultLane=lanes.find(l=>l.role==='lead')?.id||lanes[0]?.id;
    let header=defaultLane;
    const resolve=name=>{
      name=name.trim();const key=name.toLowerCase();
      const identity=value=>value.split(/\s*&\s*/).map(part=>part.trim().toLowerCase()).sort().join(' & ');
      const known=lanes.find(l=>l.id.toLowerCase()===key||identity(l.label)===identity(name));
      if(known)return known.id;
      if(/^(chorus|verse(?:\s+\d+)?|intro|outro|bridge|pre-chorus|instrumental)$/i.test(name))return null;
      if(!name||name.length>80||name.includes(':'))return null;
      let n=1;while(lanes.some(l=>l.id===`vocal-${n}`))n++;
      const lane={id:`vocal-${n}`,role:'lead',label:name};lanes.push(lane);return lane.id;
    };
    String(text).replace(/\r\n?/g,'\n').split('\n').forEach((line,index)=>{
      const only=/^\s*\[([^\[\]]+)\]\s*$/.exec(line);
      if(only){const id=resolve(only[1]);if(id){header=id;return;}}
      let laneId=header,cursor=0,buffer='';
      const flush=()=>{if(buffer.trim())entries.push({laneId,text:buffer.trim(),line:index+1});buffer='';};
      for(const match of line.matchAll(/\[([^\[\]]+)\]/g)){
        buffer+=line.slice(cursor,match.index);const id=resolve(match[1]);
        if(id){flush();laneId=id;}else buffer+=match[0];
        cursor=match.index+match[0].length;
      }
      buffer+=line.slice(cursor);flush();
    });
    return {lanes,entries};
  }

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
    let lanes=[laneLead,laneBacking];
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
      const vocal=parseVocalText(cue.text,lanes);lanes=vocal.lanes;
      const tokens = vocal.entries.flatMap(entry=>{const annotation=doubledText(entry.text);return wordsForText(annotation.text).map(token=>({...token,...displayToken(token.text),phraseDoubled:annotation.doubled,laneId:token.role==='backing'?'backing':entry.laneId}));});
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
        id: `${phraseId}-word-${n + 1}`, text: token.text, ...(token.doubled?{doubled:true}:{}), ...(token.displayMode?{displayMode:token.displayMode}:{}),
        startMs: cue.timeMs, endMs: cue.timeMs,
        provenance: "estimated", locked: false, effects: [], laneId: token.laneId
      }));
      const parts=[...new Set(words.map(w=>w.laneId))];
      // Independent singers can share a cue and overlap without conflating identity.
      for (const part of parts) {
        const subset=words.filter(w=>w.laneId===part);
        if (!subset.length) continue;
        const phraseWords = subset.map(({ laneId, ...word }) => word);
        const p = { id: part==='backing'||parts.indexOf(part)>0 ? `${phraseId}-${part}` : phraseId, laneId: part, startMs: cue.timeMs, endMs, endEstimated, fadeOutMs: 120, words: phraseWords };
        if(tokens.filter(t=>t.laneId===part).every(t=>t.phraseDoubled))p.doubled=true;
        estimateWordTimes(p, cue.text);
        phrases.push(p);
      }
    }
    phrases.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    return validateScore({
      version: VERSION, revision: 0, offsetMs: 0,
      source: { platform: "youtube", videoId: id, title: String(source.title || ""), artist: String(source.artist || ""), durationMs: source.durationMs },
      lyrics: { provider: String(metadata.provider || ""), entryId: metadata.entryId == null ? null : String(metadata.entryId), contentHash: hash.toLowerCase() },
      lanes, phrases
    });
  }

  function createPlainScore(source, rawText, lyricsMetadata) {
    if(typeof rawText!=="string"||!rawText.trim()||rawText.length>200000)fail("INVALID_LYRICS","Provide nonempty plain lyrics, at most 200000 characters.");
    if(!Number.isFinite(source?.durationMs)||source.durationMs<=0)fail("SOURCE_UNREADY","Wait for the main video duration before recording lyrics.");
    const rawLines=rawText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),lines=[];let header='';
    for(const line of rawLines){const parsed=parseVocalText(line,[{id:'lead',role:'lead',label:'Lead'},{id:'backing',role:'backing',label:'Backing'}]);if(!parsed.entries.length){header=line;continue;}lines.push(header+line);}
    // This is an editor layout only. No catalog or acoustic timing is implied.
    const lrc=lines.map((line,index)=>{const ms=Math.floor(source.durationMs*index/lines.length);return `[${Math.floor(ms/60000)}:${((ms%60000)/1000).toFixed(3).padStart(6,'0')}]${line.replace(/\[\d+:\d+(?:\.\d+)?\]/g,'')}`;}).join('\n');
    const score=createScore(source,lrc,lyricsMetadata);
    if(!score.phrases.length)fail("INVALID_LYRICS","The plain lyrics contain no words to record.");
    score.lyrics.timingBasis='plain-text';
    for(const phrase of score.phrases)phrase.endEstimated=true;
    return validateScore(score);
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
    if (score.lyrics.timingCopy !== undefined) {
      const copy = score.lyrics.timingCopy;
      if (!copy || typeof copy.mediaKey !== 'string' || !copy.mediaKey.startsWith('youtube:') || !ID_RE.test(copy.mediaKey.slice(8)) || typeof copy.title !== 'string' || !Number.isSafeInteger(copy.revision) || copy.revision < 0 || !HASH_RE.test(copy.lyricsHash || '')) bad('invalid copied timing source');
    }
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
      if(phrase.doubled!==undefined&&typeof phrase.doubled!=="boolean")bad("phrase doubled must be boolean");
      if (typeof phrase.startMs !== "number" || !Number.isFinite(phrase.startMs) || phrase.startMs < 0 || typeof phrase.endMs !== "number" || !Number.isFinite(phrase.endMs) || phrase.endMs < 0 || phrase.endMs < phrase.startMs || typeof phrase.endEstimated !== "boolean" || typeof phrase.fadeOutMs !== "number" || !Number.isFinite(phrase.fadeOutMs) || phrase.fadeOutMs < 0 || !Array.isArray(phrase.words)) bad("invalid phrase timing or fields");
      if(phrase.persistBeats!==undefined&&(!Number.isFinite(phrase.persistBeats)||phrase.persistBeats<0||phrase.persistBeats>64))bad('phrase persistence must be 0–64 beats');
      for (const word of phrase.words) {
        if (!word || typeof word.id !== "string" || !word.id || ids.has(word.id) || typeof word.text !== "string" || !word.text.trim()) bad("invalid or duplicate word");
        ids.add(word.id);
        if(word.doubled!==undefined&&typeof word.doubled!=="boolean")bad("word doubled must be boolean");
        if (typeof word.startMs !== "number" || !Number.isFinite(word.startMs) || word.startMs < 0 || typeof word.endMs !== "number" || !Number.isFinite(word.endMs) || word.endMs < 0 || word.endMs < word.startMs || word.startMs < phrase.startMs || word.endMs > phrase.endMs || !["estimated", "manual", "aligned"].includes(word.provenance) || typeof word.locked !== "boolean" || !Array.isArray(word.effects)) bad("invalid word timing or fields");
        if (word.excluded !== undefined && typeof word.excluded !== "boolean") bad("word excluded must be boolean when present");
        if(word.landing!==undefined&&!DISPLAY_CATALOG.landings.includes(word.landing))bad('invalid word landing');
        if(word.displayMode!==undefined&&word.displayMode!=='whole')bad('invalid word displayMode');
        if(word.appearance!==undefined){
          const a=word.appearance;
          if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['look','motion','art','emoji'].includes(k))||!Object.keys(a).length||a.look!==undefined&&!DISPLAY_CATALOG.looks.includes(a.look)||a.motion!==undefined&&!DISPLAY_CATALOG.motions.includes(a.motion)||a.art!==undefined&&!DISPLAY_CATALOG.wordArt.includes(a.art)||a.emoji!==undefined&&!validEmoji(a.emoji))bad('invalid word appearance');
        }
        if (word.spokenText !== undefined && (typeof word.spokenText !== "string" || !word.spokenText.trim() || word.spokenText.length > 256 || word.spokenText.includes("|"))) bad("invalid spokenText");
        for (const effect of word.effects) if (!effect || !EFFECTS.has(effect.type) || typeof effect.strength !== "number" || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1 || effect.axis !== undefined && (effect.type !== "groove" || !["horizontal","vertical"].includes(effect.axis))) bad("invalid effect");
        if (word.reveal !== undefined && !validReveal(word.reveal)) bad("invalid word reveal");
        if (word.syllables !== undefined) {
          if (!Array.isArray(word.syllables) || word.syllables.some(syllable => !syllable || Object.prototype.hasOwnProperty.call(syllable, "syllables"))) bad("invalid syllables");
          if (word.syllables.length && word.syllables.map(syllable => typeof syllable.text === "string" ? syllable.text : "").join("") !== (word.spokenText || word.text)) bad("syllable text must concatenate exactly to the spoken word");
          for (const syllable of word.syllables) {
            if (typeof syllable.id !== "string" || !syllable.id || ids.has(syllable.id) || typeof syllable.text !== "string" || !syllable.text) bad("invalid or duplicate syllable");
            ids.add(syllable.id);
            if (typeof syllable.startMs !== "number" || !Number.isFinite(syllable.startMs) || syllable.startMs < word.startMs || typeof syllable.endMs !== "number" || !Number.isFinite(syllable.endMs) || syllable.endMs < syllable.startMs || syllable.endMs > word.endMs || !["estimated", "manual", "aligned"].includes(syllable.provenance) || typeof syllable.locked !== "boolean" || !Array.isArray(syllable.effects)) bad("invalid syllable timing or fields");
            if (syllable.effects.some(effect => !effect || !EFFECTS.has(effect.type) || typeof effect.strength !== "number" || !Number.isFinite(effect.strength) || effect.strength < 0 || effect.strength > 1 || effect.axis !== undefined && (effect.type !== "groove" || !["horizontal","vertical"].includes(effect.axis)))) bad("invalid syllable effect");
            if(syllable.landing!==undefined&&!DISPLAY_CATALOG.landings.includes(syllable.landing))bad('invalid syllable landing');
            if (syllable.reveal !== undefined && !validReveal(syllable.reveal)) bad("invalid syllable reveal");
          }
        }
      }
    }
    if(score.stageItems!==undefined){
      if(!Array.isArray(score.stageItems)||score.stageItems.length>128)bad('stage items must be a bounded list');
      const ids=new Set();for(const item of score.stageItems){const r=item?.rect;
        if(!item||typeof item.id!=='string'||!item.id||item.id.length>128||ids.has(item.id)||!['pulse','speakers'].includes(item.type)||item.provenance!=='manual')bad('invalid performance item');ids.add(item.id);
        if(!Number.isSafeInteger(item.startMs)||item.startMs<0||!Number.isSafeInteger(item.endMs)||item.endMs<=item.startMs)bad('performance interval must use increasing source milliseconds');
        if(typeof item.strength!=='number'||!Number.isFinite(item.strength)||item.strength<0||item.strength>1||![1,2,4].includes(item.beatsPerPulse))bad('invalid performance intensity or beat spacing');
        if(!r||['x','y','width','height'].some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<.02||r.height<.02||r.x+r.width>1.000001||r.y+r.height>1.000001)bad('performance area must fit inside the normalized video surface');
      }
    }
    if(score.stageRegions!==undefined){
      if(!Array.isArray(score.stageRegions)||score.stageRegions.length>512)bad('stage regions must be a bounded list');
      const seen=new Set();
      for(const region of score.stageRegions){
        const r=region?.rect;
        if(!region||typeof region.id!=='string'||!region.id||region.id.length>128||seen.has(region.id)||region.provenance!=='manual'||region.target?.kind!=='phrase'||!score.phrases.some(p=>p.id===region.target.id))bad('invalid stage region identity or target');
        seen.add(region.id);
        if(!Number.isSafeInteger(region.startMs)||region.startMs<0||!Number.isSafeInteger(region.endMs)||region.endMs<=region.startMs)bad('stage interval must use increasing source milliseconds');
        if(!r||['x','y','width','height'].some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<.02||r.height<.02||r.x+r.width>1.000001||r.y+r.height>1.000001)bad('stage rectangle must fit inside the normalized video surface');
      }
      for(let i=0;i<score.stageRegions.length;i++)for(let j=i+1;j<score.stageRegions.length;j++){
        const a=score.stageRegions[i],b=score.stageRegions[j];
        if(a.target.id===b.target.id&&a.startMs<b.endMs&&b.startMs<a.endMs)bad('overlapping stage intervals for the same phrase');
      }
    }
    if(score.beatCues!==undefined){
      if(!Array.isArray(score.beatCues)||score.beatCues.length>5000)bad('beat cues must be a bounded list');
      const cueIds=new Set();
      for(const cue of score.beatCues){
        if(!cue||typeof cue.id!=='string'||!cue.id||cueIds.has(cue.id)||!Number.isFinite(cue.beat)||!Number.isFinite(cue.durationBeats)||cue.durationBeats<=0||cue.durationBeats>64||!['pulse','breath','color','bounce','glow','groove','echo','glitch'].includes(cue.effect)||!Number.isFinite(cue.strength)||cue.strength<0||cue.strength>1||cue.provenance!=='manual'||cue.axis!==undefined&&(cue.effect!=='groove'||!['horizontal','vertical'].includes(cue.axis)))bad('invalid beat cue');
        cueIds.add(cue.id);const target=cue.target;
        if(!target||!['screen','active','lane','phrase','word','syllable'].includes(target.kind))bad('invalid beat target');
        if(['lane','phrase','word','syllable'].includes(target.kind)&&!ids.has(target.id))bad('unknown beat target');
        if(target.kind==='lane'&&!laneMap.has(target.id))bad('beat lane target must be a lane');
        if(target.kind==='phrase'&&!score.phrases.some(p=>p.id===target.id))bad('beat phrase target must be a phrase');
        if(target.kind==='word'&&!score.phrases.some(p=>p.words.some(w=>w.id===target.id)))bad('beat word target must be a word');
        if(target.kind==='syllable'&&!score.phrases.some(p=>p.words.some(w=>(w.syllables||[]).some(s=>s.id===target.id))))bad('beat syllable target must be a syllable');
        for(const field of ['rawSourceMs','snappedSourceMs'])if(cue[field]!==undefined&&(!Number.isSafeInteger(cue[field])||cue[field]<0))bad('beat observations must be whole source milliseconds');
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
    if(op.type==='setLane'){
      if(typeof op.laneId!=='string'||!/^[A-Za-z0-9_-]+$/.test(op.laneId)||typeof op.label!=='string'||!op.label.trim()||op.label.length>80||/[\[\]\r\n]/.test(op.label)||!['lead','backing'].includes(op.role))fail('INVALID_OPERATION','A vocal track needs an ID, name and Main or Backing role.');
      if(next.lanes.some(l=>l.id!==op.laneId&&(l.label.toLowerCase()===op.label.trim().toLowerCase()||l.id.toLowerCase()===op.label.trim().toLowerCase())))fail('INVALID_OPERATION','Use a distinct name for each vocal track.');
      const lane=next.lanes.find(l=>l.id===op.laneId),value={id:op.laneId,label:op.label.trim(),role:op.role};
      if(lane)Object.assign(lane,value);else next.lanes.push(value);
    }else if(op.type==='splitPhraseLanes'){
      const index=next.phrases.findIndex(p=>p.id===op.phraseId),phrase=next.phrases[index];
      if(!phrase)fail('UNKNOWN_ID','Unknown phrase');
      if(!Array.isArray(op.parts)||op.parts.length<2||op.parts.some(p=>!next.lanes.some(l=>l.id===p.laneId)||!Array.isArray(p.wordIds)||!p.wordIds.length)||JSON.stringify(op.parts.flatMap(p=>p.wordIds))!==JSON.stringify(phrase.words.map(w=>w.id)))fail('INVALID_OPERATION','Vocal parts must partition every word once, in its original order.');
      const used=new Set(next.phrases.map(p=>p.id));let serial=1;
      const parts=op.parts.map((part,i)=>{
        let id=phrase.id;if(i){while(used.has(`${phrase.id}-vocal-${serial}`))serial++;id=`${phrase.id}-vocal-${serial++}`;used.add(id);}
        const words=phrase.words.filter(w=>part.wordIds.includes(w.id));
        return {...phrase,id,laneId:part.laneId,words,startMs:Math.min(...words.map(w=>w.startMs)),endMs:Math.max(...words.map(w=>w.endMs))};
      });
      next.phrases.splice(index,1,...parts);
    }else if(op.type==='setStageItem'){
      if(!op.item||typeof op.item.id!=='string')fail('INVALID_OPERATION','Provide a timed performance item');
      next.stageItems=[...(next.stageItems||[]).filter(item=>item.id!==op.item.id),clone(op.item)];
    }else if(op.type==='deleteStageItem'){
      if(!(next.stageItems||[]).some(item=>item.id===op.itemId))fail('UNKNOWN_ID','Unknown performance item');
      next.stageItems=next.stageItems.filter(item=>item.id!==op.itemId);
    }else if(op.type==='setStageRegion'){
      if(!op.region||typeof op.region.id!=='string')fail('INVALID_OPERATION','Provide a timed stage region');
      next.stageRegions=[...(next.stageRegions||[]).filter(r=>r.id!==op.region.id),clone(op.region)];
    }else if(op.type==='deleteStageRegion'){
      if(!(next.stageRegions||[]).some(r=>r.id===op.regionId))fail('UNKNOWN_ID','Unknown stage region');
      next.stageRegions=next.stageRegions.filter(r=>r.id!==op.regionId);
    }else if(op.type==='setWordAppearance'){
      const {word}=locateWord(next,op.wordId);
      if(op.appearance===null)delete word.appearance;else word.appearance=clone(op.appearance);
    }else if(op.type==='setBeatCue'){
      if(!op.cue||typeof op.cue.id!=='string')fail('INVALID_OPERATION','Provide a beat cue');
      next.beatCues=[...(next.beatCues||[]).filter(c=>c.id!==op.cue.id),clone(op.cue)];
    }else if(op.type==='deleteBeatCue'){
      if(!(next.beatCues||[]).some(c=>c.id===op.cueId))fail('UNKNOWN_ID','Unknown beat cue');
      next.beatCues=next.beatCues.filter(c=>c.id!==op.cueId);
    }else if(op.type==='setPhrasePersistence'){
      const phrase=next.phrases.find(p=>p.id===op.phraseId);if(!phrase)fail('UNKNOWN_ID','Unknown phrase');if(op.beats===null)delete phrase.persistBeats;else{if(!Number.isFinite(op.beats)||op.beats<0||op.beats>64)fail('INVALID_OPERATION','Persistence must be 0–64 beats.');phrase.persistBeats=op.beats;}
    }else if (op.type === "setWordTiming") {
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
      const tokens = doubledText(op.text).text.trim().split(/\s+/);
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
        id: `${prefix}-${suffix}-${i + 1}`, ...displayToken(text),
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
      if(op.doubled!==undefined&&typeof op.doubled!=="boolean")fail("INVALID_OPERATION","Doubled must be boolean.");
      const phrase = { id, laneId: op.laneId, startMs: op.startMs, endMs: op.endMs, endEstimated: true, fadeOutMs: 120,
        ...(op.doubled||doubledText(op.text).doubled?{doubled:true}:{}),
        words: doubledText(op.text).text.trim().split(/\s+/).map((text, i) => ({ id: `${id}-word-${i + 1}`, ...displayToken(text), startMs: op.startMs, endMs: op.startMs, provenance: "estimated", locked: false, effects: [] })) };
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
    } else if(op.type==='setWordDoubled'||op.type==='setPhraseDoubled'){
      if(typeof op.doubled!=='boolean')fail('INVALID_OPERATION','Doubled must be true or false.');
      const item=op.type==='setWordDoubled'?next.phrases.flatMap(p=>p.words).find(w=>w.id===op.wordId):next.phrases.find(p=>p.id===op.phraseId);
      if(!item)fail('UNKNOWN_ID','Unknown doubled target.');if(op.doubled)item.doubled=true;else delete item.doubled;
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
    } else if (op.type === "shiftPhrases") {
      if (!Array.isArray(op.phraseIds) || !op.phraseIds.length || new Set(op.phraseIds).size !== op.phraseIds.length || !Number.isSafeInteger(op.deltaMs)) fail("INVALID_OPERATION", "Choose distinct phrases and a whole-millisecond shift.");
      const selected = op.phraseIds.map(id => {
        const phrase = next.phrases.find(p => p.id === id);
        if (!phrase) fail("UNKNOWN_ID", `unknown phrase id: ${id}`);
        return phrase;
      });
      for (const phrase of selected) {
        for (const item of [phrase, ...phrase.words.flatMap(w => [w, ...(w.syllables || [])])]) {
          if (!Number.isSafeInteger(item.startMs + op.deltaMs) || !Number.isSafeInteger(item.endMs + op.deltaMs) || item.startMs + op.deltaMs < 0) fail("INVALID_TIME", "The selection cannot move before the timing origin.");
          item.startMs += op.deltaMs; item.endMs += op.deltaMs;
        }
      }
    } else if (op.type === "setOffset") {
      if (!Number.isSafeInteger(op.offsetMs)) fail("INVALID_TIME", "offsetMs must be an integer");
      next.offsetMs = op.offsetMs;
    } else if (op.type === 'setWordLanding' || op.type === 'setSyllableLanding') {
      if(op.style!==null&&!DISPLAY_CATALOG.landings.includes(op.style))fail('INVALID_LANDING','Choose a supported landing style or use the default.');
      const unit=op.type==='setWordLanding'?locateWord(next,op.wordId).word:locateSyllable(next,op.syllableId).syllable;
      if(op.style===null)delete unit.landing;else unit.landing=op.style;
    } else if (op.type === "setWordEffect") {
      const { word } = locateWord(next, op.wordId);
      if (op.effect === null) word.effects = [];
      else {
        if (!op.effect || !EFFECTS.has(op.effect.type) || typeof op.effect.strength !== "number" || !Number.isFinite(op.effect.strength) || op.effect.strength < 0 || op.effect.strength > 1 || op.effect.axis !== undefined && (op.effect.type !== "groove" || !["horizontal","vertical"].includes(op.effect.axis))) fail("INVALID_EFFECT", "effect type or strength is invalid");
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
        const startMs=submitted.startMs??syllables[0].startMs,endMs=submitted.endMs??syllables.at(-1).endMs;
        if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<phrase.startMs||endMs>phrase.endMs||endMs<=startMs||syllables.some(s=>s.startMs<startMs||s.endMs>endMs))fail('INVALID_TIME','Syllables must fit inside their recorded word bounds.');
        pending.push({ word, syllables, spokenText: submitted.spokenText, startMs, endMs });
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
        if (!op.effect || !EFFECTS.has(op.effect.type) || typeof op.effect.strength !== "number" || !Number.isFinite(op.effect.strength) || op.effect.strength < 0 || op.effect.strength > 1 || op.effect.axis !== undefined && (op.effect.type !== "groove" || !["horizontal","vertical"].includes(op.effect.axis))) fail("INVALID_EFFECT", "effect type or strength is invalid");
        syllable.effects = [clone(op.effect)];
      }
    } else if(op.type==='setWordDisplayMode'){
      const {word}=locateWord(next,op.wordId);if(!['whole','syllables'].includes(op.mode))fail('INVALID_OPERATION','Choose whole or syllables display.');
      if(op.mode==='whole')word.displayMode='whole';else delete word.displayMode;
    } else if (op.type === "setWordReveal") {
      const { word } = locateWord(next, op.wordId);
      if (!validReveal(op.reveal)) fail("INVALID_REVEAL", "reveal must be null or a supported sweep configuration");
      word.reveal = op.reveal === null ? null : clone(op.reveal);
    } else if (op.type === "setSyllableReveal") {
      const { syllable } = locateSyllable(next, op.syllableId);
      if (!validReveal(op.reveal)) fail("INVALID_REVEAL", "reveal must be null or a supported sweep configuration");
      syllable.reveal = op.reveal === null ? null : clone(op.reveal);
    } else fail("INVALID_OPERATION", `unknown operation type: ${op.type}`);
    // Text replacement can remove a target. Keep its beat gesture on the surviving
    // parent rather than making the lyric correction impossible to save.
    if(['replaceWords','setWordText','setWordSyllables','setPhraseSyllablePerformance'].includes(op.type))for(const cue of next.beatCues||[]){
      const target=cue.target;if(!['word','syllable'].includes(target.kind))continue;
      const present=next.phrases.some(p=>p.words.some(w=>target.kind==='word'?w.id===target.id:(w.syllables||[]).some(s=>s.id===target.id)));if(present)continue;
      const parent=score.phrases.find(p=>p.words.some(w=>target.kind==='word'?w.id===target.id:(w.syllables||[]).some(s=>s.id===target.id)));
      if(!parent)continue;
      const word=parent.words.find(w=>(w.syllables||[]).some(s=>s.id===target.id));
      cue.target=word&&next.phrases.some(p=>p.words.some(w=>w.id===word.id))?{kind:'word',id:word.id}:{kind:'phrase',id:parent.id};
    }
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

  function activeAt(score, mediaMs, {displayEnds={}}={}) {
    validateScore(score); finiteNonnegative(mediaMs, "mediaMs");
    const at = mediaMs - score.offsetMs;
    const phrases = [];
    for (const phrase of score.phrases) {
      const start = phrase.startMs, requestedEnd=displayEnds[phrase.id],end=Number.isFinite(requestedEnd)&&requestedEnd>=phrase.endMs?requestedEnd:phrase.endMs;
      if (at < start || at > end || (end>phrase.endMs&&at>=end)) continue;
      const fade = phrase.persistBeats>0||end>phrase.endMs?0:Math.min(phrase.fadeOutMs, Math.max(0, end - start));
      const opacity = fade > 0 && at > end - fade ? Math.max(0, (end - at) / fade) : 1;
      const visibleWords = phrase.words.filter(w => !w.excluded);
      if (!visibleWords.length) continue;
      const activeWords = visibleWords.filter(w => at >= w.startMs && at <= w.endMs);
      phrases.push({ ...clone(phrase),...(end>phrase.endMs?{displayEndMs:end,persisted:at>phrase.endMs}:{}),words: clone(visibleWords), activeWords: activeWords.map(w => w.id), activeSyllables: activeWords.flatMap(w => (w.syllables || []).filter(syllable => at >= syllable.startMs && at <= syllable.endMs).map(syllable => syllable.id)), opacity });
    }
    return { phrases };
  }

  // Display presence of a timed word or syllable: 1 while sung, held for a
  // minimum visible time, then fading over an afterglow. It is a rendering
  // value only; timings are never changed. Before its start it is 0.
  function presenceAt(item, clockMs, { minVisibleMs = 180, afterglowMs = 450 } = {}) {
    if (!item || typeof item.startMs !== "number" || typeof item.endMs !== "number" || !Number.isFinite(clockMs)) return 0;
    if (clockMs < item.startMs) return 0;
    const holdUntil = Math.max(item.endMs, item.startMs + minVisibleMs);
    if (clockMs < holdUntil) return 1;
    if (afterglowMs <= 0) return 0;
    const fade = 1 - (clockMs - holdUntil) / afterglowMs;
    return fade > 0 ? Math.round(fade * fade * 1000) / 1000 : 0;
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

  function stageRegionAt(score,phraseId,sourceMs){return (score.stageRegions||[]).find(r=>r.target.id===phraseId&&sourceMs>=r.startMs&&sourceMs<r.endMs)||null;}
  // Authored timing only: estimates and buffered input do not establish completion.
  function phraseTimingCoverage(phrase) {
    const words=phrase.words.filter(w=>!w.excluded),timed=x=>x.provenance==='manual'&&x.endMs>x.startMs;
    const units={phrase:words.map(w=>({wordId:w.id,done:timed(w)})),word:words.map(w=>({wordId:w.id,done:timed(w)&&w.locked})),syllable:words.flatMap(w=>w.syllables?.length?w.syllables.map(s=>({wordId:w.id,done:timed(s)&&s.locked})):[{wordId:w.id,done:false}])};
    return Object.fromEntries(Object.entries(units).map(([mode,items])=>{
      const done=items.filter(x=>x.done).length,total=items.length;
      return [mode,{done,total,status:!total?'empty':done===total?'complete':done?'partial':'unstarted',nextWordId:items.find(x=>!x.done)?.wordId||null}];
    }));
  }
  function timingCoverage(score) {
    return score.lanes.map(lane=>{
      const phrases=score.phrases.filter(p=>p.laneId===lane.id&&p.words.some(w=>!w.excluded)).map(p=>({id:p.id,startMs:p.startMs,...phraseTimingCoverage(p)})).sort((a,b)=>a.startMs-b.startMs);
      return {...lane,phrases,modes:Object.fromEntries(['phrase','word','syllable'].map(mode=>{
        const done=phrases.filter(p=>p[mode].status==='complete').length,total=phrases.length;
        return [mode,{done,total,status:!total?'empty':done===total?'complete':phrases.some(p=>p[mode].done>0)?'partial':'unstarted'}];
      }))};
    });
  }
  return { VERSION, DISPLAY_CATALOG, validEmoji, stageRegionAt, ScoreError, mediaKey, parseLrc, parseVocalText, doubledText, displayToken, hyphenWordParts, createScore, createPlainScore, validateScore, validateAlignmentReceipt, activeAt, revealProgress, presenceAt, applyOperation, applyAlignment, phraseTimingCoverage, timingCoverage };
});
