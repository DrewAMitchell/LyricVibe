(function (root) {
  'use strict';
  const MAX_SONG_MS = 20 * 60 * 1000;
  const WINDOW_MS = 11500;
  const RATE = 16000;
  // Word timing edits do not change the audio, transcript or phrase frames.
  // Other edits require a fresh capture rather than guessing at compatibility.
  function canRebaseCapture(before, after) {
    if (!before || !after || before.lyrics?.contentHash !== after.lyrics?.contentHash || before.offsetMs !== after.offsetMs || before.source?.durationMs !== after.source?.durationMs) return false;
    const shape = score => score.phrases.map(p => [p.id,p.laneId,p.startMs,p.endMs,p.words.map(w => [w.id,w.text,w.spokenText || null,!!w.excluded])]);
    return JSON.stringify(shape(before)) === JSON.stringify(shape(after));
  }
  function changedTimingPhrases(before,after){
    const original=new Map(before.phrases.map(p=>[p.id,p]));
    const timing=word=>JSON.stringify([word.startMs,word.endMs,word.locked,word.provenance,(word.syllables||[]).map(s=>[s.id,s.startMs,s.endMs,s.locked,s.provenance])]);
    return new Set(after.phrases.filter(p=>{const prior=original.get(p.id);return !prior||p.words.some((w,i)=>(w.provenance==='manual'||w.locked||(w.syllables||[]).some(s=>s.locked||s.provenance==='manual'))&&(!prior.words[i]||timing(w)!==timing(prior.words[i])));}).map(p=>p.id));
  }
  function repeatAnchors(score, target, visible) {
    if(target.endEstimated||target.endMs<=target.startMs)return [];
    const lexical=words=>words.map(w=>root.LvNativeLive.normalizeExpectedWord(w.spokenText||w.text));
    const wanted=JSON.stringify(lexical(visible));
    const matches=score.phrases.filter(p=>p.id!==target.id&&p.laneId===target.laneId&&!p.endEstimated&&p.endMs>p.startMs&&JSON.stringify(lexical(p.words.filter(w=>!w.excluded)))===wanted).map(p=>{
      const words=p.words.filter(w=>!w.excluded),anchors=words.map((word,index)=>({word,index})).filter(({word})=>word.locked&&word.provenance==='manual'&&word.startMs>=p.startMs&&word.endMs<=p.endMs&&word.endMs>word.startMs);
      return {phrase:p,anchors};
    }).filter(x=>x.anchors.length>0&&x.anchors.length<=3&&x.anchors.length<visible.length&&x.anchors.every((a,i)=>!i||x.anchors[i-1].word.endMs<=a.word.startMs));
    if(matches.length!==1)return [];
    const source=matches[0],ratio=(target.endMs-target.startMs)/(source.phrase.endMs-source.phrase.startMs);if(ratio<.5||ratio>2)return [];
    const anchors=source.anchors.map(({word,index})=>({index,word:{...visible[index],startMs:Math.max(target.startMs,Math.round(target.startMs+(word.startMs-source.phrase.startMs)*ratio-100)),endMs:Math.min(target.endMs,Math.round(target.startMs+(word.endMs-source.phrase.startMs)*ratio+100))}}));
    if(!anchors.every((a,i)=>a.word.endMs>a.word.startMs&&(!i||anchors[i-1].word.endMs<=a.word.startMs)))return [];
    anchors.sourcePhraseId=source.phrase.id;return anchors;
  }
  function plan(score) {
    const duration = score.source.durationMs;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_SONG_MS) throw Object.assign(new Error('Whole-song alignment supports recordings up to 20 minutes with a known duration.'), { code: 'SONG_DURATION_UNSUPPORTED' });
    const windows = [], skipped = [];
    for (const phrase of score.phrases) {
      const overlap = score.phrases.some(other => other.id !== phrase.id && other.laneId !== phrase.laneId && other.startMs < phrase.endMs && other.endMs > phrase.startMs);
      const visible=phrase.words.filter(word=>!word.excluded);
      let anchors=visible.map((word,index)=>({word,index})).filter(({word})=>word.locked&&word.provenance==='manual'&&word.startMs>=phrase.startMs&&word.endMs<=phrase.endMs&&word.endMs>word.startMs);
      let prior='manual';if(!anchors.length){anchors=repeatAnchors(score,phrase,visible);prior='repeat';}
      // Corrections bound nearby model windows. Never silently use an anchor
      // from a different vocal lane or from an overlapping/invalid sequence.
      const usable=phrase.endMs-phrase.startMs<=WINDOW_MS&&anchors.length>0&&anchors.length<=3&&anchors.length<visible.length&&anchors.every((a,i)=>!i||anchors[i-1].word.endMs<=a.word.startMs);
      if(usable){
        let begin=phrase.startMs,first=0;
        const add=(start,end,words,anchor)=>{
          const expectedWords=[];for(const word of words){const text=root.LvNativeLive.normalizeExpectedWord(word.spokenText||word.text);if(text)expectedWords.push({wordId:word.id,phraseId:phrase.id,laneId:phrase.laneId,text});else skipped.push({wordId:word.id,reason:'unsupported-text'});}
          if(!expectedWords.length)return;
          const a=Math.max(0,start+(score.offsetMs||0)),b=Math.min(duration,end+(score.offsetMs||0));
          if(b-a<50||expectedWords.length>root.LvNativeLive.MAX_EXPECTED_WORDS){skipped.push(...expectedWords.map(word=>({wordId:word.wordId,reason:'anchor-window-unavailable'})));return;}
          windows.push({phraseId:phrase.id,startMs:a,endMs:b,expectedWords,overlap,segmented:false,anchored:true,anchor,prior,...(prior==='repeat'?{priorSourcePhraseId:anchors.sourcePhraseId}:{})});
        };
        for(const item of anchors){add(begin,item.word.startMs,visible.slice(first,item.index),false);add(item.word.startMs,item.word.endMs,[item.word],true);begin=item.word.endMs;first=item.index+1;}
        add(begin,phrase.endMs,visible.slice(first),false);continue;
      }
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
      if (previous && !previous.anchored && !window.anchored && previous.expectedWords[0].laneId === window.expectedWords[0].laneId && window.startMs >= previous.endMs && window.endMs - previous.startMs <= WINDOW_MS && previous.expectedWords.length + window.expectedWords.length <= root.LvNativeLive.MAX_EXPECTED_WORDS) {
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
  root.LvSongPass = { MAX_SONG_MS, canRebaseCapture, changedTimingPhrases, plan, extract };
  if (typeof module !== 'undefined') module.exports = root.LvSongPass;
})(globalThis);
