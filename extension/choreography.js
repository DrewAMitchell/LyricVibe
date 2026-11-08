/* Deterministic presentation only: no score edits or wall-clock ownership. */
(function(root){
  const emojiApi=typeof module==='object'&&module.exports?require('./emoji-tags.js'):root.LvEmojiTags;
  const scoreApi=typeof module==='object'&&module.exports?require('./score-core.js'):root.LvScore;
  const clamp=x=>Math.max(0,Math.min(1,x));
  const median=values=>{const sorted=values.filter(n=>n>0&&Number.isFinite(n)).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:0;};
  const token=text=>String(text).toLowerCase().replace(/[^a-z']/g,'');
  const lightWords=new Set(['a','an','the','and','or','of','to','in','it','is','as','at','on','for']);
  const wordRuleMotions=Object.freeze({off:'Still',rock:'Rock in an arc',float:'Levitate',tip:'Backward fall',flex:'Flex',bounce:'Bounce',launch:'Launch'});
  const wordRuleEffects=Object.freeze({rays:'Sun rays',sunglasses:'Lifting sunglasses',fire:'Fire texture',bills:'Flying dollar bills',champagne:'Champagne pop',disco:'Disco ball & lights',glow:'Glow',echo:'Echo',glitch:'Glitch',spin:'Coin spin',rotor:'Rotor · flat 360°',groove:'Groove',shake:'Shake',pulse:'Pulse'});
  const starter=(words,motion,...effects)=>words.split('|').map(word=>({word,motion,effects}));
  const defaultWordRules=Object.freeze([
    ...starter('baby','rock'),...starter('air|flow|levitate','float'),...starter('bright|shine|sunshine','off','rays'),...starter('cool','off','sunglasses'),
    ...starter('fire|burn|burning|flame|flames|reignite','off','fire'),...starter('lay down|fall|falling|fell','tip'),
    ...starter('groove|funk|disco','off','disco'),...starter('money|cash','off','bills'),...starter('champagne','off','champagne'),
    ...starter('glow|glowing','off','glow'),...starter('echo|echoes','off','echo'),...starter('dance|dancing','flex'),...starter('jump|bounce','bounce')
  ].map(r=>Object.freeze({...r,effects:Object.freeze(r.effects)})));
  const ruleWord=text=>String(text).normalize('NFKC').toLowerCase().trim().split(/\s+/u).map(part=>part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'')).filter(Boolean).join(' ');
  function validateWordRules(rules){
    if(!Array.isArray(rules)||rules.length>200)throw Error('Use at most 200 word rules.');
    const seen=new Set();return rules.map(rule=>{
      const word=ruleWord(rule?.word??'');
      if(!word||word.length>64||word.split(' ').length>4)throw Error('Enter one word or a phrase of up to four words (64 characters).');
      if(seen.has(word))throw Error('A rule for “'+word+'” already exists.');seen.add(word);
      if(!Object.hasOwn(wordRuleMotions,rule.motion)||!Array.isArray(rule.effects)||rule.effects.some(effect=>!Object.hasOwn(wordRuleEffects,effect)))throw Error('Choose a supported motion and effects.');
      if(rule.emoji!==undefined&&!scoreApi.validEmoji(rule.emoji))throw Error('Choose one emoji, Automatic, or No emoji.');
      return {word,motion:rule.motion,effects:[...new Set(rule.effects)],...(rule.emoji!==undefined?{emoji:rule.emoji}:{})};
    });
  }
  function validEmojiMapTag(value){
    if(typeof value!=='string'||value.length>64)return false;
    if(value==='')return true;
    const tags=glyphParts(value);
    return tags.length<=2&&tags.every(tag=>scoreApi.validEmoji(tag));
  }
  function validateEmojiMap(groups){
    if(!Array.isArray(groups)||groups.length>200)throw Error('Use at most 200 emoji groups.');
    const seen=new Set(),merged=new Map();let count=0;
    for(const group of groups){
      if(!group||!validEmojiMapTag(group.emoji)||!Array.isArray(group.terms)||!group.terms.length)throw Error('Each group needs one emoji or two adjacent emojis and at least one word or phrase.');
      const terms=merged.get(group.emoji)||[];
      for(const raw of group.terms){if(typeof raw!=='string')throw Error('Map terms must be text.');const term=ruleWord(raw);if(!term||term.length>64||term.split(' ').length>4)throw Error('Use words or phrases of up to four words (64 characters).');if(seen.has(term))throw Error('“'+term+'” appears more than once in the map.');seen.add(term);terms.push(term);if(++count>2000)throw Error('Use at most 2,000 map terms.');}
      merged.set(group.emoji,terms);
    }
    return [...merged].map(([emoji,terms])=>({emoji,terms}));
  }
  function parseEmojiMap(text){
    if(typeof text!=='string'||text.length>150000)throw Error('Keep the map under 150,000 characters.');
    const groups=[];
    for(const [index,raw]of text.split(/\r?\n/).entries()){
      const line=raw.trim();if(!line||line.startsWith('#'))continue;
      try{
        const match=line.match(/^(.+?)\s*(?:=|\bequals\b)\s*\((.*)\)\s*$/iu);if(!match)throw Error('Use 🌊 = (flow, water, "take a dip").');
        const emoji=match[1].trim().toLowerCase()==='none'?'':match[1].trim(),tokens=[];let token='',quoted=false,escaped=false;
        for(const ch of match[2]){if(escaped){token+=ch;escaped=false;continue;}if(ch==='\\'&&quoted){token+=ch;escaped=true;continue;}if(ch==='"'){quoted=!quoted;token+=ch;continue;}if(ch===','&&!quoted){tokens.push(token);token='';}else token+=ch;}
        if(quoted||escaped)throw Error('Close the quoted phrase.');tokens.push(token);
        const terms=tokens.map(value=>{value=value.trim();if(!value)throw Error('Remove the empty term.');if(value.startsWith('"')){const parsed=JSON.parse(value);if(typeof parsed!=='string')throw Error('Use a quoted phrase.');return parsed;}if(value.includes('"'))throw Error('Quote the entire phrase.');return value;});
        groups.push(...validateEmojiMap([{emoji,terms}]));
      }catch(error){throw Error('Line '+(index+1)+': '+error.message);}
    }
    return validateEmojiMap(groups);
  }
  function formatEmojiMap(groups){return validateEmojiMap(groups).map(group=>(group.emoji||'none')+' = ('+group.terms.map(term=>/[\s,"\\()]/u.test(term)?JSON.stringify(term):term).join(', ')+')').join('\n');}
  // Frozen bases are shared by value; each song records replacements and removals.
  function emojiMapDelta(base,map){
    const before=new Map(validateEmojiMap(base).flatMap(g=>g.terms.map(t=>[t,g.emoji]))),after=new Map(validateEmojiMap(map).flatMap(g=>g.terms.map(t=>[t,g.emoji])));
    return {remove:[...before.keys()].filter(t=>!after.has(t)),set:validateEmojiMap(map).map(g=>({...g,terms:g.terms.filter(t=>before.get(t)!==g.emoji)})).filter(g=>g.terms.length)};
  }
  function applyEmojiMapDelta(base,delta){
    if(!delta||!Array.isArray(delta.remove)||delta.remove.length>2000||delta.remove.some(t=>typeof t!=='string'||ruleWord(t)!==t))throw Error('Invalid emoji map removals.');
    const values=new Map(validateEmojiMap(base).flatMap(g=>g.terms.map(t=>[t,g.emoji])));
    for(const term of delta.remove)values.delete(term);
    for(const group of validateEmojiMap(delta.set))for(const term of group.terms)values.set(term,group.emoji);
    const groups=new Map();for(const [term,emoji]of values){if(!groups.has(emoji))groups.set(emoji,[]);groups.get(emoji).push(term);}
    return validateEmojiMap([...groups].map(([emoji,terms])=>({emoji,terms})));
  }
  function resolveWordSet(value,set){
    if(!set.emojiMapBaseId)return set;
    const {emojiMapBaseId,emojiMapDelta:delta,...rest}=set;
    return {...rest,emojiMap:applyEmojiMapDelta(value.emojiMapBases[emojiMapBaseId],delta)};
  }
  function validateWordRuleSets(value){
    if(!value||value.version!==1||!Array.isArray(value.sets)||!value.sets.length||value.sets.length>2020||value.sets.filter(s=>!s.songKey).length>20||value.sets.filter(s=>s.songKey).length>2000)throw Error('Keep at most 20 shared presets and 2,000 song presets.');
    const emojiMapBases={};if(value.emojiMapBases){if(typeof value.emojiMapBases!=='object'||Array.isArray(value.emojiMapBases))throw Error('Invalid emoji map bases.');for(const [id,map]of Object.entries(value.emojiMapBases)){if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid frozen map identity.');emojiMapBases[id]=validateEmojiMap(map);}}
    const ids=new Set(),names=new Set();const sets=value.sets.map(set=>{
      const name=String(set.name||'').trim();if(!name||name.length>48||names.has(name.toLowerCase()))throw Error('Use a unique set name, up to 48 characters.');if(typeof set.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(set.id)||ids.has(set.id))throw Error('Invalid word-effect set identity.');ids.add(set.id);names.add(name.toLowerCase());
      for(const key of ['emojiTags','emojiDictionary'])if(set[key]!==undefined&&typeof set[key]!=='boolean')throw Error('Emoji settings must be on or off.');
      if(set.emojiHold!==undefined&&!['word','phrase'].includes(set.emojiHold))throw Error('Hold emojis for the word or until the phrase ends.');
      if(set.songKey!==undefined&&!/^youtube:[A-Za-z0-9_-]{11}$/.test(set.songKey))throw Error('Invalid song preset identity.');
      if(set.emojiMapBaseId){if(!emojiMapBases[set.emojiMapBaseId])throw Error('The frozen emoji map base is missing.');applyEmojiMapDelta(emojiMapBases[set.emojiMapBaseId],set.emojiMapDelta);}
      return {id:set.id,name,...(set.songKey?{songKey:set.songKey}:{}),...(set.emojiMapBaseId?{emojiMapBaseId:set.emojiMapBaseId,emojiMapDelta:{remove:[...new Set(set.emojiMapDelta.remove)],set:validateEmojiMap(set.emojiMapDelta.set)}}:{}),rules:validateWordRules(set.rules),...(set.emojiTags!==undefined?{emojiTags:set.emojiTags}:{}),...(set.emojiHold!==undefined?{emojiHold:set.emojiHold}:{}),...(set.emojiDictionary!==undefined?{emojiDictionary:set.emojiDictionary}:{}),...(!set.emojiMapBaseId&&set.emojiMap!==undefined?{emojiMap:validateEmojiMap(set.emojiMap)}:{})};
    });
    if(sets.some(s=>s.id===value.activeId&&s.songKey))throw Error('A song preset cannot be the shared default.');
    if(!ids.has(value.activeId))throw Error('Choose an existing default set.');
    let songSets;if(value.songSets!==undefined){if(!value.songSets||typeof value.songSets!=='object'||Array.isArray(value.songSets)||Object.keys(value.songSets).length>2000)throw Error('Keep at most 2,000 song preset assignments.');songSets={};for(const [key,id]of Object.entries(value.songSets)){if(!/^youtube:[A-Za-z0-9_-]{11}$/.test(key)||!ids.has(id))throw Error('Song presets need an exact video and an existing set.');if(sets.find(s=>s.id===id).songKey&&sets.find(s=>s.id===id).songKey!==key)throw Error('This preset belongs to another song.');songSets[key]=id;}}
    return {version:1,activeId:value.activeId,sets,...(songSets?{songSets}:{}),...(Object.keys(emojiMapBases).length?{emojiMapBases}:{})};
  }
  function wordSetFor(value,source){const key=typeof source==='string'?source:source?scoreApi.mediaKey(source):null;return resolveWordSet(value,value.sets.find(set=>set.id===(value.songSets?.[key]||value.activeId))||value.sets[0]);}
  function phraseMatches(words,map){
    const matches=new Map(),ends=new Map();
    // Timed compound pieces keep the joiner on the preceding piece, just as
    // playback does. Normalize after rejoining so five- + two stays five-two.
    for(let i=0;i<words.length;i++){if(matches.has(i))continue;for(let count=Math.min(4,words.length-i);count>=1;count--){const pieces=words.slice(i,i+count),key=ruleWord(pieces.reduce((text,word,j)=>text+(j&&!/[-\u2010\u2011]$/u.test(pieces[j-1].text)?' ':'')+word.text,'')),value=map.get(key);if(value!==undefined){for(let j=0;j<count;j++){matches.set(i+j,value);ends.set(i+j,i+count-1);}break;}}}
    return {matches,ends};
  }
  function wordRuleAt(cue,now,{reduced=false}={}){
    if(!cue?.rule||now<cue.startMs||now>=cue.endMs)return null;
    const elapsed=now-cue.startMs,duration=Math.max(1,cue.endMs-cue.startMs),phase=elapsed/1000;
    const ease=x=>{x=clamp(x);return x*x*(3-2*x);};
    return {word:cue.rule.word,motion:cue.rule.motion,effects:cue.rule.effects,
      presence:reduced?1:ease(elapsed/Math.min(160,duration*.2))*ease((cue.endMs-now)/Math.min(160,duration*.2)),
      raysTurn:reduced?0:Math.sin(phase*1.3)*7,raysScale:reduced?1:1+.07*Math.sin(phase*2.2),
      glassesLift:reduced?1:ease(elapsed/Math.min(750,duration*.65)),
      champagneFlip:reduced?180:180*ease((elapsed/duration-.04)/.28),champagnePop:reduced?.7:ease((elapsed/duration-.38)/.5),
      disco:cue.rule.effects.includes('disco')?{beams:Array.from({length:5},(_,i)=>({x:100+(reduced?Math.sin(i*1.4):Math.sin(phase*1.7+i*1.4))*92,opacity:reduced?.24:.19+.11*(.5+.5*Math.sin(phase*2+i))})),
        facets:Array.from({length:36},(_,i)=>reduced?.35+(i%5)*.12:.25+.7*(.5+.5*Math.sin(phase*2.8+(i%6)*.9+Math.floor(i/6)*.45))),
        glints:Array.from({length:9},(_,i)=>({x:100+(reduced?Math.sin(i*2.4):Math.sin(phase*.8+i*2.4))*92,y:55+(i%3)*28,opacity:reduced?.5:.25+.55*(.5+.5*Math.sin(phase*2+i*1.8))}))}:null,
      bills:Array.from({length:7},(_,i)=>{const u=clamp((elapsed-i*40)/Math.min(1350,duration*.8));return {x:reduced?(i-3)*.36:(i-3)*.52*u,y:reduced?-.65:-1.6*Math.sin(u*Math.PI*.8)+.25*u,turn:reduced?(i-3)*8:(i-3)*18+Math.sin(u*9+i)*35,opacity:reduced?.8:Math.sin(Math.PI*u)};})};
  }
  // Unknown syllable counts remain estimates; they never become timing evidence.
  function syllableCount(word){return word.syllables?.length||Math.max(1,(token(word.text).replace(/e$/,'').match(/[aeiouy]+/g)||[]).length);}
  function compose(score,rules=defaultWordRules,{emojiMap=[],emojiDictionary=true,emojiHold='word',heldRule='relative',heldMinMs=800}={}){
    const ruleMap=new Map(validateWordRules(rules).map(rule=>[rule.word,rule]));
    const emojiRules=new Map(validateEmojiMap(emojiMap).flatMap(group=>group.terms.map(term=>[term,group.emoji])));
    const phrases=score.phrases.map(phrase=>{
      const words=phrase.words.filter(w=>!w.excluded),start=words[0]?.startMs,end=Math.max(...words.map(w=>w.endMs));
      return {phrase,words,start,end,rate:words.reduce((n,w)=>n+syllableCount(w),0)*1000/Math.max(1,end-start)};
    }).filter(p=>p.words.length);
    const typical=median(phrases.map(p=>p.rate)),cues={};
    for(const p of phrases){
      const next=phrases.filter(n=>n.phrase.laneId===p.phrase.laneId&&n.start>p.start).sort((a,b)=>a.start-b.start)[0];
      const gap=next?next.start-p.end:Math.max(0,(score.source?.durationMs??p.end)-(score.offsetMs||0)-p.end);
      const fast=p.rate>=4.5||p.rate>=3&&p.rate>=typical*1.3;
      const perSyllable=median(p.words.map(w=>(w.endMs-w.startMs)/syllableCount(w)));
      const {matches,ends:matchEnds}=phraseMatches(p.words,ruleMap),tags=phraseMatches(p.words,emojiRules);
      p.words.forEach((word,i)=>{
        const count=syllableCount(word),duration=word.endMs-word.startMs;
        const units=word.syllables?.length?word.syllables:[word];
        const threshold=heldRule==='duration'?heldMinMs:Math.min(1100,Math.max(600,perSyllable*1.65));
        const sustained=units.filter(u=>word.appearance?.held==='never'?false:word.appearance?.held==='always'?true:heldRule==='off'?false:u.endMs-u.startMs>=threshold*(u===word?count:1));
        const text=token(word.text),previous=p.words.slice(Math.max(0,i-2),i).map(w=>token(w.text));
        const direction=text==='up'?[0,-1]:text==='down'?[0,1]:['left','right'].includes(text)&&previous.includes('the')&&previous.includes('to')?[text==='left'?-1:1,0]:null;
        const impact=fast&&gap>=550&&i===p.words.length-1;
        const rule=matches.get(i);
        const emoji=word.appearance?.emoji!==undefined?word.appearance.emoji:rule?.emoji!==undefined?(i===matchEnds.get(i)?rule.emoji:''):tags.matches.has(i)?(i===tags.ends.get(i)?tags.matches.get(i):''):(emojiDictionary?emojiApi?.match(word.text)?.emoji||'':'');
        const reasons=[...(sustained.length?['sustained']:[]),...(impact?['fast-then-stop']:[]),...(direction?['direction-'+text]:[]),...(rule?['word-rule:'+rule.word]:[])];
        cues[word.id]={emoji,emojiCount:glyphParts(emoji).length,emojiEndMs:emojiHold==='phrase'?Math.max(word.endMs,p.end,p.phrase.endMs??p.end):word.endMs,doubled:!!(word.doubled||p.phrase.doubled),wordId:word.id,phraseId:p.phrase.id,startMs:word.startMs,endMs:word.endMs,
          weight:(lightWords.has(text)?.78:1)+Math.min(.25,text.length*.018)+Math.min(.16,(count-1)*.06)+(impact?.4:0)+(sustained.length?.18:0),
          sustained:sustained.map(u=>({id:u.id,startMs:u.startMs,endMs:u.endMs})),impact,direction,reasons,...(rule?{rule}:{}),
          evidence:{phraseSyllablesPerSecond:p.rate,pauseAfterMs:gap,syllableBasis:word.syllables?.length?'authored':'estimated-from-spelling',heldRule,heldThresholdMs:threshold,heldOverride:word.appearance?.held||'auto'}};
      });
    }
    return cues;
  }
  // Bounded painted copies: no cloned DOM, random state or wall-clock animation.
  function accentShadow(type,phase,strength,reduced=false){
    if(reduced||strength<=0)return '';
    if(type==='echo'){
      const drift=(.07+.055*(1-Math.cos(phase*2*Math.PI)))*strength;
      return [1,2,3].map(i=>`${(-drift*i).toFixed(4)}em ${(drift*i*.3).toFixed(4)}em 0 color-mix(in srgb,currentColor ${[30,17,8][i-1]}%,transparent)`).join(',');
    }
    if(type==='glitch'){
      // Two brief splits per second-equivalent phase; no opacity flashing.
      const step=Math.floor(phase*8),burst=step%4===0;
      const d=(burst?.11:.018)*strength*(step%2?-1:1);
      return `${d.toFixed(4)}em 0 0 #47e8ed,${(-d).toFixed(4)}em .015em 0 #f16dbc`;
    }
    return '';
  }
  // One eased full turn, held face-on at either end; source clock owns replay.
  function coinSpin(progress){const u=clamp((progress-.1)/.8);return 360*u*u*(3-2*u);}
  // Geometry, expression, and authored beat accents use separate transform layers.
  function expressionAt(cue,now,{mode='classic',reduced=false,effects=[],automatic=true,heldEffect='breathe'}={}){
    const out={x:0,y:0,turn:0,scale:1,color:null,brightness:1,wave:0,wavePhase:0,spin:0,reason:''};
    if(!cue||now<cue.startMs||now>=cue.endMs)return out;
    const elapsed=now-cue.startMs,t=elapsed/1000,duration=cue.endMs-cue.startMs;
    const envelope=Math.min(1,elapsed/90,(cue.endMs-now)/100),intensity=mode==='puzzle'?1:mode==='fall'?.72:.55;
    if(effects.some(e=>e._layer)){
      const base=expressionAt(cue,now,{mode,reduced,automatic,heldEffect,effects:effects.filter(e=>!e._layer)}),added=expressionAt(cue,now,{mode,reduced,automatic:false,effects:effects.filter(e=>e._layer).map(({_layer,...e})=>e)});
      return {...base,x:base.x+added.x,y:base.y+added.y,turn:base.turn+added.turn,scale:base.scale*added.scale,spin:(base.spin||0)+(added.spin||0),brightness:base.brightness*added.brightness,wave:Math.max(base.wave,added.wave),wavePhase:added.wave?added.wavePhase:base.wavePhase,waveAxis:added.wave?added.waveAxis:base.waveAxis,shadow:[base.shadow,added.shadow].filter(Boolean).join(','),reason:(base.reason?base.reason+' + ':'')+'layer'};
    }
    if(effects.length){
      out.reason='authored';
      for(const effect of effects){const strength=Math.max(0,Math.min(1,effect.strength??.3));
        if(!reduced&&effect.type==='spin'&&strength>0)out.spin=coinSpin(elapsed/Math.max(1,duration));
        if(!reduced&&effect.type==='rotor'&&strength>0)out.turn+=coinSpin(elapsed/Math.max(1,duration));
        if(!reduced&&effect.type==='groove'){out.wave=.16*strength*envelope;out.wavePhase=t*Math.PI*2/1.2;out.waveAxis=effect.axis||'vertical';}
        if(['echo','glitch'].includes(effect.type))out.shadow=accentShadow(effect.type,t,strength*envelope,reduced);
        if(effect.type==='glow')out.brightness=1+strength*(reduced?.2:.5*envelope);
        if(!reduced&&effect.type==='bounce')out.y-=Math.abs(Math.sin(t*Math.PI*2))*strength*12*envelope;
        if(!reduced&&effect.type==='shake')out.x+=Math.sin(t*Math.PI*12.5)*strength*2;
        if(!reduced&&effect.type==='tilt')out.turn+=Math.sin(t*Math.PI/0.6)*strength*2;
        if(!reduced&&effect.type==='pulse')out.scale+=((1-Math.cos(t*Math.PI/.5))/2)*strength*.025;
      }
      return out;
    }
    if(!automatic)return out;
    if(cue.rule){
      const value=expressionAt({...cue,rule:null},now,{mode,reduced,automatic:false,effects:cue.rule.effects.filter(type=>!['rays','sunglasses','fire','bills','champagne','disco'].includes(type)).map(type=>({type,strength:.5}))});
      return {...value,reason:'word-rule:'+cue.rule.word};
    }
    const held=cue.sustained?.find(u=>now>=u.startMs&&now<u.endMs);
    if(held&&heldEffect!=='off'&&heldEffect!=='breathe'){
      Object.assign(out,expressionAt({...cue,startMs:held.startMs,endMs:held.endMs},now,{mode,reduced,automatic:false,effects:[{type:heldEffect,strength:.55}]}),{reason:'sustained'});
    }
    if(held&&heldEffect==='breathe'){
      const phase=(now-held.startMs)/1000,breath=reduced?.5:(1-Math.cos(phase*Math.PI*2/1.15))/2;
      out.scale+=reduced?0:breath*.055*intensity*envelope;
      out.color=`hsl(${(42+breath*24).toFixed(2)} 92% ${(83-breath*15).toFixed(2)}%)`;
      out.brightness=1+breath*.12*envelope;out.reason='sustained';
      if(!reduced){const ramp=clamp(Math.min(now-held.startMs,held.endMs-now)/280);out.wave=.045*(.65+.35*intensity)*ramp*ramp*(3-2*ramp);out.wavePhase=phase*Math.PI*2/2.8;}
    }
    if(cue.impact){
      const hit=clamp(1-elapsed/Math.min(360,duration));
      if(!reduced){out.scale+=hit*.11*intensity;out.y+=Math.sin(t*88)*hit*2*intensity;out.x+=Math.sin(t*113)*hit*1.5*intensity;}
      out.color='hsl(38 95% 78%)';out.brightness=1+hit*.2;out.reason='fast-then-stop';
    }
    if(cue.direction&&!reduced){const travel=Math.sin(Math.PI*clamp(elapsed/duration))*7*intensity;out.x+=cue.direction[0]*travel;out.y+=cue.direction[1]*travel;out.reason+=(out.reason?' + ':'')+'direction';}
    return out;
  }

  const dances=['tip','flex','bounce','launch'];
  function danceAt(cue,now,{kind='off',reduced=false,authored=false}={}){
    const out={kind:'off',x:0,y:0,turn:0,tip:0,flex:0,phase:0,scaleX:1,scaleY:1};
    if(!cue||now<cue.startMs||reduced||authored||kind==='off')return out;
    if(kind==='mix'){let hash=0;for(const ch of cue.wordId)hash=(hash*31+ch.charCodeAt(0))>>>0;kind=dances[hash%4];}
    if(!dances.includes(kind)&&!['rock','float'].includes(kind))return out;
    const u=clamp((now-cue.startMs)/Math.max(1,cue.endMs-cue.startMs)),t=u*4.2;
    const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};out.kind=kind;
    if(kind==='float'){
      const elapsed=now-cue.startMs,duration=Math.max(1,cue.endMs-cue.startMs),edge=Math.min(280,duration*.22),envelope=smooth(Math.min(elapsed,cue.endMs-now)/edge),phase=elapsed/2400*Math.PI*2;
      out.x=.16*Math.sin(phase*.75)*envelope;out.y=-(.26+.07*Math.sin(phase))*envelope;out.turn=1.4*Math.sin(phase*.65)*envelope;
    }else if(kind==='rock'){
      const elapsed=now-cue.startMs,envelope=smooth(Math.min(elapsed,cue.endMs-now)/180),angle=Math.sin(elapsed/1600*Math.PI*2)*18*envelope;
      out.turn=angle;out.x=.9*Math.sin(angle*Math.PI/180);out.y=.9*(Math.cos(angle*Math.PI/180)-1);
    }else if(kind==='tip'){
      if(t<2.45)out.tip=0;
      else if(t<2.56)out.tip=-6*Math.sin(Math.PI*(t-2.45)/.11);
      else if(t<3.04)out.tip=82*smooth((t-2.56)/.48);
      else {const s=t-3.04;out.tip=s<.6?82-14*Math.exp(-6.5*s)*Math.abs(Math.sin(2*Math.PI*2.2*s)):82;}
    }else if(kind==='flex'){
      out.flex=Math.sin(t*4.3)*Math.sin(Math.min(1,t/1.9)*Math.PI)*(1-smooth((t-1.15)/1.4))*.20||0;out.phase=t*3.8;
    }else if(kind==='bounce'){
      const flights=[.60,.44,.32,.23,.17],heights=[.62,.34,.19,.10,.05];
      if(t<.68)out.y=-.78*(1-t/.68)**2;
      else {let elapsed=t-.68;for(let i=0;i<flights.length;i++){if(elapsed<flights[i]){const p=elapsed/flights[i];out.y=-heights[i]*4*p*(1-p);break;}elapsed-=flights[i];}}
      if(t>.64&&t<.83){out.scaleY=1-.17*Math.sin(Math.PI*(t-.64)/.19);out.scaleX=1+(1-out.scaleY)*.4;}
    }else if(kind==='launch'){
      const p=clamp(t/1.4);out.x=p===1?0:-.9*(1-p);out.y=-1.05*4*p*(1-p);out.turn=(-10+32*p)*Math.sin(Math.PI*p);
    }
    return out;
  }
  const landingStyles=Object.freeze({settle:'Soft settle',glide:'Glide',drop:'Drop',still:'Still'});
  function landingAt(now,start,{style='settle',reduced=false}={}){
    if(!Object.hasOwn(landingStyles,style))style='settle';
    if(reduced||style==='still'||now>=start)return {x:0,y:0,opacity:1};
    const lead=style==='glide'?650:style==='drop'?500:520,p=clamp((now-start+lead)/lead);
    // Soft settle has zero velocity and acceleration at both ends, with no bounce.
    const progress=style==='settle'?p*p*p*(p*(p*6-15)+10):1-Math.pow(1-p,3),left=1-progress;
    return {x:style==='glide'?-left*.65:0,y:style==='settle'?-left*.18:style==='drop'?-left*2.5:0,opacity:.15+.85*progress};
  }
  function arrival(now,start,lead=500,reduced=false){return reduced?1:1-Math.pow(1-clamp((now-start+lead)/lead),3);}
  function puzzle(words,width,height,measure,{upsideDown,maxFont,minFont=0,weights}){
    const weight=word=>Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
    let font=Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8);
    for(let attempt=0;attempt<90;attempt++,font*=.94){
      const gap=font*.12;
      const boxes=words.map((word,index)=>{
        const size=Math.min(maxFont,Math.max(minFont,font*weight(word))),angle=upsideDown&&index%5===2?180:0;
        const w=Math.max(size*.2,measure(word.text,size,word))+size*.08,h=size*1.3,vertical=angle===90;
        return {index,width:w,height:h,boxWidth:vertical?h:w,boxHeight:vertical?w:h,font:size,angle};
      }).sort((a,b)=>b.boxWidth*b.boxHeight-a.boxWidth*a.boxHeight||a.index-b.index);
      let free=[{x:0,y:0,w:width,h:height}],slots=[],failed=false;
      for(const box of boxes){
        const bw=box.boxWidth+gap,bh=box.boxHeight+gap;
        const candidates=free.filter(r=>r.w>=bw&&r.h>=bh).map(r=>{
          // Fit tightly around the existing words instead of constructing reading rows.
          const cost=Math.min(r.w-bw,r.h-bh)+.15*Math.max(r.w-bw,r.h-bh);
          return {r,cost};
        }).sort((a,b)=>a.cost-b.cost||a.r.y-b.r.y||a.r.x-b.r.x);
        if(!candidates.length){failed=true;break;}
        const r=candidates[0].r;
        // The largest word anchors the composition; subsequent words occupy its pockets.
        const x=slots.length?r.x:r.x+(r.w-bw)*.52,y=slots.length?r.y:r.y+(r.h-bh)*.56;
        const used={x,y,w:bw,h:bh};
        slots.push({...box,x:x+bw/2,y:y+bh/2});
        const split=[];
        for(const f of free){
          if(used.x>=f.x+f.w||used.x+used.w<=f.x||used.y>=f.y+f.h||used.y+used.h<=f.y){split.push(f);continue;}
          if(used.x>f.x)split.push({x:f.x,y:f.y,w:used.x-f.x,h:f.h});
          if(used.x+used.w<f.x+f.w)split.push({x:used.x+used.w,y:f.y,w:f.x+f.w-used.x-used.w,h:f.h});
          if(used.y>f.y)split.push({x:f.x,y:f.y,w:f.w,h:used.y-f.y});
          if(used.y+used.h<f.y+f.h)split.push({x:f.x,y:used.y+used.h,w:f.w,h:f.y+f.h-used.y-used.h});
        }
        free=split.filter((a,i)=>!split.some((b,j)=>i!==j&&a.x>=b.x&&a.y>=b.y&&a.x+a.w<=b.x+b.w&&a.y+a.h<=b.y+b.h&&(a.x>b.x||a.y>b.y||a.w<b.w||a.h<b.h||j<i)));
      }
      if(!failed)return slots.sort((a,b)=>a.index-b.index);
      if(font*1.8<=minFont)break;
    }
    return null;
  }
  function ordered(words,width,height,measure,{maxFont,minFont=0,weights}){
    // Measure at the actual font: fixed-pixel tracking must not be scaled a second time.
    const weight=word=>Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1));
    let best=null;
    for(let count=1;count<=Math.min(4,words.length);count++){
      const rows=Array.from({length:count},()=>[]);
      words.forEach((word,index)=>rows[Math.min(count-1,Math.floor(index*count/words.length))].push({word,index}));
      for(let scale=maxFont/Math.max(1,...words.map(weight)),attempt=0;attempt<90;attempt++,scale*=.94){
        if(best&&scale<=best.scale)break;
        const boxes=rows.map(row=>row.map(({word,index})=>{const font=Math.min(maxFont,Math.max(minFont,scale*weight(word)));return {index,font,width:Math.max(font*.2,measure(word.text,font,word))+font*.08,height:font*1.3,angle:0};}));
        const gap=scale*.16,rowGap=scale*.12,rowWidths=boxes.map(row=>row.reduce((n,b)=>n+b.width,0)+gap*(row.length-1)),rowHeights=boxes.map(row=>Math.max(...row.map(b=>b.height))),totalHeight=rowHeights.reduce((a,b)=>a+b,0)+rowGap*(count-1);
        if(Math.max(...rowWidths)>width||totalHeight>height){if(scale*1.8<=minFont)break;continue;}
        let y=(height-totalHeight)/2;const slots=[];
        boxes.forEach((row,r)=>{let x=0;for(const b of row){slots[b.index]={...b,boxWidth:b.width,boxHeight:b.height,x:x+b.width/2,y:y+rowHeights[r]-b.height/2};x+=b.width+gap;}y+=rowHeights[r]+rowGap;});
        best={scale,slots};break;
      }
    }
    return best?.slots;
  }
  function stagePerformanceAt(items,sourceMs,{beat=sourceMs/500,reduced=false,bass=0}={}){
    const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
    return (items||[]).filter(item=>sourceMs>=item.startMs&&sourceMs<item.endMs).map(item=>{
      const envelope=smooth((sourceMs-item.startMs)/Math.min(250,(item.endMs-item.startMs)*.2))*smooth((item.endMs-sourceMs)/Math.min(250,(item.endMs-item.startMs)*.2));
      const pulse=reduced?.35:item.response==='bass'?clamp(Number.isFinite(bass)?bass:0):Math.pow((1+Math.cos(2*Math.PI*beat/item.beatsPerPulse))/2,3),energy=pulse*item.strength;
      return {id:item.id,type:item.type,rect:item.rect,opacity:envelope,energy,scale:1+.13*energy,cone:1+.16*energy,glow:.16+.42*energy};
    });
  }
  const layoutOrigins=Object.freeze({'top-left':'Top left','top-right':'Top right','bottom-left':'Bottom left','bottom-right':'Bottom right','center-out-cw':'Center outward · CW','center-out-ccw':'Center outward · CCW','center-in-cw':'Center inward · CW','center-in-ccw':'Center inward · CCW'});
  function perimeter(words,width,height,measure,{origin,upsideDown,maxFont,weights}){
    const short=Math.min(width,height),clockwise=origin.endsWith('-cw'),outward=origin.startsWith('center-out-'),edges=clockwise?['top','right','bottom','left']:['top','left','bottom','right'];
    // Two thin rails frame a protected center. Inner words are deliberately smaller.
    const split=Math.ceil(words.length/2),rings=[words.slice(0,split),words.slice(split)],slots=[];
    let offset=0;
    for(let ring=0;ring<rings.length;ring++){
      const group=rings[ring];if(!group.length)continue;
      const inner=outward?ring===0:ring===1,inset=short*(inner?.20:.06),corner=short*.065;
      const lengths={top:Math.max(1,width-2*(inset+corner)),bottom:Math.max(1,width-2*(inset+corner)),left:Math.max(1,height-2*(inset+corner)),right:Math.max(1,height-2*(inset+corner))},total=edges.reduce((sum,e)=>sum+lengths[e],0);
      let font=Math.min(maxFont,short*.07)*(inner?.65:1),placed;
      for(let attempt=0;attempt<100;attempt++,font*=.92){
        const boxes=group.map((word,i)=>{const size=font*Math.max(.8,Math.min(1.15,weights[word.id]?.weight??1));return {index:offset+i,font:size,width:Math.max(size*.2,measure(word.text,size,word))+size*.08,height:size*1.3};}),gap=font*.22,run=boxes.reduce((sum,b)=>sum+b.width+gap,0),bins=Object.fromEntries(edges.map(e=>[e,[]]));let at=0;
        for(const box of boxes){let target=(at+box.width/2)/run*total,edge=edges.at(-1);for(const e of edges){if(target<=lengths[e]){edge=e;break;}target-=lengths[e];}bins[edge].push(box);at+=box.width+gap;}
        if(edges.some(e=>bins[e].reduce((sum,b)=>sum+b.width,0)+gap*Math.max(0,bins[e].length-1)>lengths[e]))continue;
        placed=[];
        for(const edge of edges){const row=bins[edge],used=row.reduce((sum,b)=>sum+b.width,0)+gap*Math.max(0,row.length-1);let along=(lengths[edge]-used)/2;
          for(const box of row){const distance=corner+along+box.width/2,vertical=edge==='left'||edge==='right',forward=vertical?(clockwise?edge==='right':edge==='left'):(edge==='bottom'||!upsideDown);let x,y;
            if(vertical){x=edge==='left'?inset:width-inset;y=forward?inset+distance:height-inset-distance;}else{x=forward?inset+distance:width-inset-distance;y=edge==='top'?inset:height-inset;}
            const angle=edge==='bottom'?0:edge==='top'?(upsideDown?180:0):(forward?90:270);
            placed.push({...box,x,y,angle,edge,ring:inner?'inner':'outer',boxWidth:vertical?box.height:box.width,boxHeight:vertical?box.width:box.height});along+=box.width+gap;
          }
        }
        break;
      }
      if(!placed)return null;slots.push(...placed);offset+=group.length;
    }
    return slots.sort((a,b)=>a.index-b.index);
  }
  function layout(words,width,height,measure,{mode='fall',upsideDown=false,maxFont=80,minFont=0,weights={},arrangement='chaotic',origin='top-left'}={}){
    width=Math.max(1,width);height=Math.max(1,height);minFont=Math.max(0,minFont);maxFont=Math.max(minFont,maxFont);
    if(!words.length)return [];
    if(mode==='puzzle'&&Object.hasOwn(layoutOrigins,origin)&&origin.startsWith('center-')){const framed=perimeter(words,width,height,measure,{origin,upsideDown,maxFont,weights});if(framed)return framed;}
    if(mode==='puzzle'&&height>=140&&width>=180&&words.length>=3){
      const packed=arrangement==='ordered'?ordered(words,width,height,measure,{maxFont,minFont,weights}):puzzle(words,width,height,measure,{upsideDown,maxFont,minFont,weights});
      if(packed)return packed.map(slot=>({...slot,x:origin.endsWith('right')?width-slot.x:slot.x,y:origin.startsWith('bottom')?height-slot.y:slot.y}));
    }
    // A shallow strip gets a single readable line, never a squeezed word cloud.
    const singleLine=mode==='puzzle'&&height<140;mode=mode==='puzzle'?'fall':mode;
    const weight=word=>mode==='puzzle'?Math.max(.65,Math.min(1.8,weights[word.id]?.weight??1)):1;
    let font=Math.max(minFont,mode==='puzzle'?Math.min(maxFont/Math.max(1,...words.map(weight)),height*.8):Math.min(maxFont,height*.28)),rows,used;
    for(let attempt=0;attempt<80;attempt++,font=Math.max(minFont,font*.9)){
      rows=[];let row={items:[],width:0,height:0};const gap=font*.22;
      for(let i=0;i<words.length;i++){
        const angle=0;
        const size=font*weight(words[i]),w=Math.max(size*.2,measure(words[i].text,size,words[i]))+size*.08,h=size*1.3,vertical=Math.abs(angle)===90,bw=vertical?h:w,bh=vertical?w:h;
        if(!singleLine&&row.items.length&&row.width+gap+bw>width){rows.push(row);row={items:[],width:0,height:0};}
        const x=row.width+(row.items.length?gap:0);row.items.push({index:i,width:w,height:h,boxWidth:bw,boxHeight:bh,x,angle,font:size});row.width=x+bw;row.height=Math.max(row.height,bh);
      }
      if(row.items.length)rows.push(row);used=rows.reduce((sum,r)=>sum+r.height,0)+gap*Math.max(0,rows.length-1);
      if(used<=height&&rows.every(r=>r.width<=width)||font<=minFont)break;
    }
    let y=(height-used)/2;const slots=[];
    for(const row of rows){for(const item of row.items)slots[item.index]={...item,x:(width-row.width)/2+item.x+item.boxWidth/2,y:y+row.height/2};y+=row.height+font*.22;}
    return slots;
  }

  // Prefer the minimum, but keep the complete phrase visible when it cannot fit.
  function readablePages(words,width,height,measure,options={}){
    const fits=slots=>slots.every(s=>s.x-s.boxWidth/2>=-.01&&s.x+s.boxWidth/2<=width+.01&&s.y-s.boxHeight/2>=-.01&&s.y+s.boxHeight/2<=height+.01);
    let slots=layout(words,width,height,measure,options);
    if(!fits(slots))slots=layout(words,width,height,measure,{...options,minFont:0});
    return [{start:0,end:words.length,slots}];
  }
  // The newest word keeps a fixed readable size. Only accumulated history compresses.
  const emojiSegments=new Intl.Segmenter('en',{granularity:'grapheme'}),glyphParts=text=>[...emojiSegments.segment(text)].map(s=>s.segment);
  function vinylTrack(score,measure,{emojiTags=false,cues={}}={}){
    const tokens=[];let order=0;const preserveCase=score.lyrics?.timingBasis==='caption-segments';
    for(const phrase of score.phrases){
      const words=phrase.words.filter(word=>!word.excluded);if(!words.length)continue;
      const parts=words.map(word=>({word,text:preserveCase?String(word.text).trim():String(word.text).trim().toUpperCase(),tag:emojiTags?cues[word.id]?.emoji||'':''}));
      if(score.lanes?.find(lane=>lane.id===phrase.laneId)?.role==='backing'){
        // One phrase enters and leaves the shared feed as a single block. Keep
        // the source words and their timing intact; this is presentation only.
        const text=parts.map(p=>p.text+(p.tag?' '+p.tag:'')).join(' ').replace(/^\((.*)\)$/,'$1');
        let at=1;const emojiRanges=[],doubledRanges=parts.map(p=>{const start=at,end=at+glyphParts(p.text).length;if(p.tag)emojiRanges.push({start:end+1,end:end+1+glyphParts(p.tag).length,startMs:p.word.startMs,endMs:cues[p.word.id]?.emojiEndMs??p.word.endMs});at+=glyphParts(p.text+(p.tag?' '+p.tag:'')).length+1;return p.word.doubled?[start,end]:null;}).filter(Boolean);
        tokens.push({doubled:!!phrase.doubled,doubledRanges,emojiRanges,id:words[0].id,wordIds:words.map(word=>word.id),phraseId:phrase.id,laneId:phrase.laneId,backing:true,text:'('+text+')',startMs:Math.min(...words.map(w=>w.startMs)),endMs:Math.max(...words.map(w=>w.endMs)),order:order++});
      }else for(const part of parts){const {word,text,tag}=part,start=glyphParts(text).length+1;tokens.push({doubled:!!(phrase.doubled||word.doubled),id:word.id,phraseId:phrase.id,laneId:phrase.laneId,text:text+(tag?' '+tag:''),emojiRanges:tag?[{start,end:start+glyphParts(tag).length,startMs:word.startMs,endMs:cues[word.id]?.emojiEndMs??word.endMs}]:[],startMs:word.startMs,endMs:word.endMs,order:order++});}
    }
    tokens.sort((a,b)=>a.startMs-b.startMs||a.order-b.order);let total=0;
    for(const token of tokens){let x=0;token.chars=glyphParts(token.text).map((text,index)=>{const hold=token.emojiRanges?.find(r=>index>=r.start&&index<r.end),emoji=!!hold||emojiTags&&/\p{Extended_Pictographic}/u.test(text),width=Math.max(.05,measure(text))*(emoji?.55:1);const char={text,emoji,...(hold?{emojiStartMs:hold.startMs,emojiEndMs:hold.endMs}:{}),center:x+width/2,width,doubled:token.doubled||token.doubledRanges?.some(([start,end])=>index>=start&&index<end)||false};x+=width+.015;return char;});token.offset=total;token.textWidth=x;token.width=x+Math.max(.35,measure(' '));token.center=total+x/2;total+=token.width;}
    const decay=-Math.log(.78)/(2*Math.PI),capacity=Math.log(1/.18)/decay,entryFont=.21;
    // Integral of entryFont/(1+d/compression) gives the angle traveled. Capacity
    // affects distant history, never the font size of the word at the feed mouth.
    let low=.001,high=1e8;
    for(let i=0;i<64;i++){const k=(low+high)/2;if(entryFont*k*Math.log1p(total/k)>capacity)high=k;else low=k;}
    const rows=[],knots=[];
    tokens.forEach((token,i)=>{let row=rows.findIndex(end=>end<=token.startMs);if(row<0)row=rows.length;rows[row]=token.endMs;token.feedRow=row;token.departMs=token.endMs;const last=knots.at(-1);if(last?.time===token.startMs)last.value=token.center;else knots.push({time:token.startMs,value:token.center,slope:0});});
    for(let i=1;i<knots.length-1;i++){const a=(knots[i].value-knots[i-1].value)/(knots[i].time-knots[i-1].time),b=(knots[i+1].value-knots[i].value)/(knots[i+1].time-knots[i].time);knots[i].slope=a>0&&b>0?2*a*b/(a+b):0;}
    return {tokens,total,decay,entryFont,compression:low,knots,pipeWidth:Math.max(.65,...tokens.map(t=>Math.min(1.65,t.textWidth*entryFont)))+.14};
  }
  function vinylAt(track,clock,{reduced=false}={}){
    const smooth=x=>{const t=clamp(x);return t*t*t*(10+t*(-15+6*t));};
    const started=track.tokens.filter(t=>clock>=t.startMs),knots=track.knots,glyphs=[];
    let head=knots[0]?.value||0;
    for(let i=1;i<knots.length;i++){const a=knots[i-1],b=knots[i];if(clock>=b.time){head=b.value;continue;}if(clock>a.time){const span=b.time-a.time,t=(clock-a.time)/span,t2=t*t,t3=t2*t;head=(2*t3-3*t2+1)*a.value+(t3-2*t2+t)*span*a.slope+(-2*t3+3*t2)*b.value+(t3-t2)*span*b.slope;}break;}
    for(const token of started){
      const current=clock<token.endMs,duration=Math.max(1,Math.min(260,(token.endMs-token.startMs)*.35)),feed=reduced?1:smooth((clock-token.startMs)/duration),handoff=reduced?(clock>=token.departMs?1:0):smooth((clock-token.departMs)/260),fit=Math.min(1,1.65/(track.entryFont*Math.max(.1,token.textWidth))),age=Math.max(0,head-token.center)*handoff,flatten=smooth(age/Math.max(6,token.width));
      const centerW=track.entryFont*track.compression*Math.log1p(age/track.compression),centerR=Math.exp(-track.decay*centerW),centerA=-Math.PI/2-centerW,centerFont=track.entryFont*centerR/(1+age/track.compression)*fit;
      for(const ch of token.chars){
        if(ch.emojiStartMs!==undefined&&(clock<ch.emojiStartMs||clock>=ch.emojiEndMs))continue;
        const d=Math.max(0,age+token.textWidth/2-ch.center),winding=track.entryFont*track.compression*Math.log1p(d/track.compression),curveR=Math.exp(-track.decay*winding),curveA=-Math.PI/2-winding,curveFont=track.entryFont*curveR/(1+d/track.compression)*fit;
        const radius=centerR+(curveR-centerR)*flatten,font=centerFont+(curveFont-centerFont)*flatten,flatX=centerR*Math.cos(centerA)+(ch.center-token.textWidth/2)*centerFont,flatY=centerR*Math.sin(centerA),x=flatX+(curveR*Math.cos(curveA)-flatX)*flatten,y=flatY+(curveR*Math.sin(curveA)-flatY)*flatten-(token.feedRow*.25+(1-feed)*.48)*(1-handoff),angle=-Math.PI/2+(curveA+Math.PI/2)*flatten;
        glyphs.push({wordId:token.id,emoji:ch.emoji,doubled:ch.doubled,text:ch.text,radius,angle,font:font*(ch.emoji?.55:1),x,y,current,feed:feed<1,top:handoff===0});
      }
    }
    return {head,words:started.flatMap(t=>t.wordIds||[t.id]),text:started.map(t=>t.text).join(' '),glyphs,pipeWidth:track.pipeWidth};
  }
  function paintVinyl(ctx,track,clock,width,height,{reduced=false,ink='#f5f0e7',accent='#d9543e'}={}){
    const frame=vinylAt(track,clock,{reduced}),R=Math.max(1,Math.min(height*.345,width*.4)),cx=width*.5,cy=height*.59,head=-Math.PI/2;
    ctx.clearRect(0,0,width,height);ctx.save();ctx.fillStyle='#141416';ctx.beginPath();ctx.arc(cx,cy,R*1.09,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#414146';ctx.lineWidth=1;ctx.stroke();
    ctx.strokeStyle='rgba(232,223,208,.08)';ctx.beginPath();for(let f=0;f<80;f+=.08){const r=R*1.07*Math.exp(-track.decay*f),a=head-f;if(r<R*.13)break;f?ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a)):ctx.moveTo(cx+r*Math.cos(a),cy+r*Math.sin(a));}ctx.stroke();
    ctx.fillStyle=accent;ctx.beginPath();ctx.arc(cx,cy,R*.12,0,Math.PI*2);ctx.fill();ctx.fillStyle='#101113';ctx.beginPath();ctx.arc(cx,cy,Math.max(2,R*.014),0,Math.PI*2);ctx.fill();
    // Open-ended feed sleeve above twelve o'clock. Words travel between the rails.
    const mouth=cy-R,pipeTop=Math.max(height*.025,mouth-R*.64),pipeHalf=R*frame.pipeWidth/2;
    const shade=ctx.createLinearGradient(0,pipeTop,0,mouth);shade.addColorStop(0,'rgba(245,240,231,.015)');shade.addColorStop(1,'rgba(245,240,231,.09)');ctx.fillStyle=shade;ctx.fillRect(cx-pipeHalf,pipeTop,pipeHalf*2,mouth-pipeTop);ctx.strokeStyle='#77736d';ctx.lineWidth=Math.max(1,R*.004);ctx.beginPath();for(const side of [-1,1]){ctx.moveTo(cx+side*pipeHalf,pipeTop);ctx.lineTo(cx+side*pipeHalf,mouth-R*.02);ctx.lineTo(cx+side*(pipeHalf+R*.045),mouth+R*.035);}ctx.stroke();ctx.strokeStyle=accent;ctx.lineWidth=Math.max(2,R*.009);ctx.beginPath();ctx.moveTo(cx-pipeHalf-R*.04,mouth+R*.045);ctx.lineTo(cx-pipeHalf+R*.04,mouth+R*.045);ctx.moveTo(cx+pipeHalf-R*.04,mouth+R*.045);ctx.lineTo(cx+pipeHalf+R*.04,mouth+R*.045);ctx.stroke();
    const atlas=ctx.__lvVinylGlyphs||(ctx.__lvVinylGlyphs=new Map());
    for(const glyph of frame.glyphs){const color=glyph.current?ink:'#d0cbc3',key=color+'|'+Boolean(glyph.emoji)+'|'+glyph.text;let sprite=atlas.get(key);
      if(!sprite){const tile=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(1,1):ctx.canvas.ownerDocument.createElement('canvas'),brush=tile.getContext('2d');brush.font=glyph.emoji?'100px Segoe UI Emoji, sans-serif':'800 100px Arial Narrow, Impact, sans-serif';tile.width=Math.ceil(brush.measureText(glyph.text).width)+12;tile.height=150;brush.font=glyph.emoji?'100px Segoe UI Emoji, sans-serif':'800 100px Arial Narrow, Impact, sans-serif';brush.textAlign='center';brush.textBaseline='middle';brush.fillStyle=color;brush.fillText(glyph.text,tile.width/2,75);sprite=tile;if(atlas.size<512)atlas.set(key,sprite);}
      const scale=R*glyph.font/100;ctx.save();ctx.translate(cx+R*glyph.x,cy+R*glyph.y);ctx.rotate(glyph.angle+Math.PI/2);ctx.globalAlpha=glyph.top?1:.52+.48*glyph.radius;if(glyph.doubled&&glyph.current){const alpha=ctx.globalAlpha;ctx.globalAlpha*=.45;ctx.drawImage(sprite,-sprite.width*scale/2+6.5*scale,-72.5*scale,sprite.width*scale,150*scale);ctx.globalAlpha=alpha;}ctx.drawImage(sprite,-sprite.width*scale/2,-75*scale,sprite.width*scale,150*scale);ctx.restore();}
    ctx.restore();return frame;
  }
  // Display-only repetition plans never rewrite the authoritative lyric or timings.
  function dejaGroups(words){
    const groups=[];for(let i=0;i<words.length;i++){const word=words[i],key=ruleWord(word.text),last=groups.at(-1),prev=last&&words[last.at(-1)];if(key&&last&&key===ruleWord(prev.text)&&prev.endMs>prev.startMs&&word.endMs>word.startMs&&word.startMs>=prev.endMs)last.push(i);else groups.push([i]);}return groups;
  }
  function dejaIds(score){
    const used=new Set((score.lanes||[]).map(l=>l.id));for(const phrase of score.phrases||[]){used.add(phrase.id);for(const word of phrase.words||[]){used.add(word.id);for(const syllable of word.syllables||[])used.add(syllable.id);}}
    const result=new Map();for(const phrase of score.phrases||[])for(const word of phrase.words||[]){const pieces=scoreApi.hyphenWordParts(word.text),keys=pieces.map(ruleWord);if(pieces.length<2||pieces.length>32||!keys[0]||!keys.every(key=>key===keys[0])||word.endMs-word.startMs<pieces.length)continue;const ids=pieces.map((_,i)=>{let id=`${word.id}-deja-${i+1}`;while(used.has(id))id+='-';used.add(id);return id;});result.set(word.id,ids);}
    return result;
  }
  function dejaPhrase(phrase,ids){
    const words=phrase.words.flatMap(word=>{const virtual=ids.get(word.id);if(!virtual)return [word];const pieces=scoreApi.hyphenWordParts(word.text),span=word.endMs-word.startMs,parts=[];let cursor=0,valid=Boolean(word.syllables?.length)&&(!word.spokenText||word.spokenText===word.text);
      if(valid){for(const piece of pieces){let text='',list=[];while(cursor<word.syllables.length&&text.length<piece.length){const syl=word.syllables[cursor++];text+=syl.text;list.push({...syl});}if(text!==piece){valid=false;break;}const last=list.at(-1);last.text=last.text.replace(/[-\u2010\u2011]$/u,'');if(!last.text){valid=false;break;}parts.push(list);}if(cursor!==word.syllables.length)valid=false;}
      return pieces.map((piece,index)=>{const syllables=valid?parts[index]:[],text=piece.replace(/[-\u2010\u2011]$/u,''),startMs=valid?syllables[0].startMs:word.startMs+Math.round(span*index/pieces.length),endMs=valid?syllables.at(-1).endMs:word.startMs+Math.round(span*(index+1)/pieces.length);return {...word,id:virtual[index],_sourceId:word.id,_dejaEstimated:!valid||syllables.some(part=>part.provenance==='estimated'),text,spokenText:undefined,startMs,endMs,syllables};});
    });for(const group of dejaGroups(words))if(group.length>1)for(const index of group){const word=words[index];if(!/[-\u2010\u2011]$/u.test(word.text))continue;const text=word.text.replace(/[-\u2010\u2011]$/u,''),syllables=word.syllables?.map(part=>({...part}));if(syllables?.length&&syllables.at(-1).text.length>1)syllables.at(-1).text=syllables.at(-1).text.replace(/[-\u2010\u2011]$/u,'');words[index]={...word,text,...(word.spokenText===word.text?{spokenText:undefined}:{}),...(syllables?{syllables}:{})};}return {...phrase,words};
  }
  // Reserve a stable slot for each voice that can be visible simultaneously.
  // Lead-ins are included so the first singer does not move when another is previewed.
  // Non-overlapping voices may share a slot. Authored stage regions remain separate.
  function leadTrackPlan(score,displayEnds={},leadInMs=2000,exclusiveEnds=false,role='lead'){
    const lanes=(score.lanes||[]).filter(l=>l.role===role),nodes=[],byPhrase=new Map();
    for(const lane of lanes){
      const phrases=(score.phrases||[]).filter(p=>p.laneId===lane.id&&p.words?.some(w=>!w.excluded)).sort((a,b)=>a.startMs-b.startMs||a.id.localeCompare(b.id));
      const voices=[];
      for(const phrase of phrases){
        // A pile is per singer: overlapping phrases from the same lane share
        // its physics rather than creating a second pile for that singer.
        let voice=exclusiveEnds?voices[0]:voices.find(v=>v.until<phrase.startMs);
        if(!voice){voice={laneId:lane.id,index:voices.length,until:-1,intervals:[],neighbors:new Set()};voices.push(voice);nodes.push(voice);}
        const end=Math.max(phrase.endMs,Number.isFinite(displayEnds[phrase.id])?displayEnds[phrase.id]:phrase.endMs);
        voice.until=Math.max(voice.until,end);voice.intervals.push({start:Math.max(0,phrase.startMs-leadInMs),end});byPhrase.set(phrase.id,voice);
      }
    }
    const overlaps=(a,b)=>{const aa=a.intervals.slice().sort((x,y)=>x.start-y.start),bb=b.intervals.slice().sort((x,y)=>x.start-y.start);let i=0,j=0;while(i<aa.length&&j<bb.length){if(exclusiveEnds?aa[i].start<bb[j].end&&bb[j].start<aa[i].end:aa[i].start<=bb[j].end&&bb[j].start<=aa[i].end)return true;if(exclusiveEnds?aa[i].end<=bb[j].end:aa[i].end<bb[j].end)i++;else j++;}return false;};
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)if(overlaps(nodes[i],nodes[j])){nodes[i].neighbors.add(nodes[j]);nodes[j].neighbors.add(nodes[i]);}
    nodes.sort((a,b)=>a.intervals[0].start-b.intervals[0].start||lanes.findIndex(l=>l.id===a.laneId)-lanes.findIndex(l=>l.id===b.laneId)||a.index-b.index);
    for(const node of nodes){const used=new Set([...node.neighbors].map(n=>n.slot).filter(Number.isInteger));let slot=0;while(used.has(slot))slot++;node.slot=slot;}
    const count=Math.max(1,...nodes.map(n=>n.slot+1));
    return {count,slots:Object.fromEntries([...byPhrase].map(([id,node])=>[id,node.slot])),laneColors:Object.fromEntries(lanes.map((lane,index)=>[lane.id,index])),multi:count>1};
  }
  // Pile history belongs to the current singers, not every voice in the song.
  // Between phrases, keep the last singer visible until another one begins.
  function pileVoicesAt(score,clock){
    const lanes=(score.lanes||[]).filter(l=>l.role==='lead'),eligible=(score.phrases||[]).filter(p=>lanes.some(l=>l.id===p.laneId)&&p.words?.some(w=>!w.excluded));
    let current=eligible.filter(p=>p.startMs<=clock&&clock<p.endMs);
    if(!current.length){const previous=eligible.filter(p=>p.startMs<=clock).sort((a,b)=>b.endMs-a.endMs||b.startMs-a.startMs)[0];if(previous)current=[previous];}
    const active=new Set(current.map(p=>p.laneId)),selected=lanes.filter(l=>active.has(l.id));
    return {count:1,slots:Object.fromEntries(eligible.filter(p=>active.has(p.laneId)).map(p=>[p.id,0])),laneColors:Object.fromEntries(lanes.map((l,i)=>[l.id,i])),laneOrder:selected.map(l=>l.id),multi:selected.length>1,key:selected.map(l=>l.id).join('|')};
  }
  // Precompute a bounded, source-clock physics pass. Frames are deterministic,
  // so a seek or pause never depends on an animation loop's wall clock.
  function pileTrack(words,width,height,measure,{font=48,maxWords=32}={}){
    width=Math.max(1,width);height=Math.max(1,height);font=Math.max(4,Math.min(font,height*.38));maxWords=Math.max(1,Math.min(64,maxWords));
    const pages=[],ordered=[...words].sort((a,b)=>a.startMs-b.startMs||String(a.id).localeCompare(String(b.id)));
    const reuseWidths=new Map();for(const word of ordered)if(word._dejaReuse)reuseWidths.set(word._dejaReuse,Math.max(reuseWidths.get(word._dejaReuse)||0,measure(word.text,font,word)));
    const hash=text=>{let n=2166136261;for(const ch of String(text)){n^=ch.codePointAt(0);n=Math.imul(n,16777619);}return n>>>0;};
    let page=null,area=0;
    for(const word of ordered){
      const measured=word._dejaReuse?reuseWidths.get(word._dejaReuse):measure(word.text,font,word),size=Math.max(4,Math.min(font,font*(width*.92/Math.max(1,measured)))),w=Math.min(width,Math.max(1,measured*size/font+size*.04)),h=Math.min(height,Math.max(1,size*1.15)),padX=Math.min((width-w)/2,1),padY=Math.min((height-h)/2,1),seed=hash(word.id);
      const repeated=word._dejaReuse&&page?.items.at(-1)?.reuseKey===word._dejaReuse;
      if(!page||page.items.length>=maxWords||!repeated&&page.items.length&&area+(w+padX*2)*(h+padY*2)>width*height*.8){page={startMs:word.startMs,items:[]};pages.push(page);area=0;}
      const previous=page.items.at(-1),reuse=word._dejaReuse&&previous?.reuseKey===word._dejaReuse;
      const glyphs=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word.text)].map(x=>x.segment):Array.from(word.text);
      const item={id:word.id,phraseId:word.phraseId,laneId:word.laneId,startMs:word.startMs,width:w,height:h,padX,padY,font:size,edge:0,seed,reuseKey:word._dejaReuse,breakApart:!word._dejaReuse&&seed%4===0&&glyphs.length>1&&glyphs.length<=16,glyphs,frames:[]};
      if(reuse)item.reuseId=previous.reuseId||previous.id;else area+=(w+padX*2)*(h+padY*2);
      page.items.push(item);
    }
    for(let index=0;index<pages.length;index++){
      const current=pages[index],overflow=[];
      for(;;){
        let previous=null;for(const item of current.items){item.frames=[];delete item.impact;delete item.fragments;delete item.reuseId;if(item.reuseKey&&previous?.reuseKey===item.reuseKey)item.reuseId=previous.reuseId||previous.id;previous=item;}
        simulatePile(current,width,height);
        if(current.items.length<=1||current.items.every(item=>item.fragments?.length?item.fragments.every(f=>f.y>=-.5):item.y>=-.5))break;
        overflow.unshift(current.items.pop());
      }
      if(overflow.length)pages.splice(index+1,0,{startMs:overflow[0].startMs,items:overflow});
    }
    return {width,height,pages};
  }
  function simulatePile(page,width,height){
    const step=1000/30,bodies=[],byId=new Map(),lastStart=page.items.at(-1)?.startMs??page.startMs;
    let next=0,now=page.startMs,lastSpawn=now;
    const record=(b,t)=>{const target=b.fragment||b.item;target.frames.push(t,b.x+(b.fragment?0:b.item.padX),b.y+(b.fragment?0:b.item.padY),b.angle);};
    while(next<page.items.length||now<lastStart+2200){
      if(next<page.items.length&&now-lastSpawn>2200&&page.items[next].startMs>now+step){now=page.items[next].startMs;for(const b of bodies){b.vx=0;b.vy=0;b.spin=0;record(b,now);}}
      while(next<page.items.length&&page.items[next].startMs<=now+.001){
        const item=page.items[next++];lastSpawn=now;
        if(item.reuseId){const base=byId.get(item.reuseId);if(base){base.x=Math.max(0,Math.min(width-base.w,(width-base.w)*(.28+.44*(item.seed%997)/997)));base.y=-base.h-2;base.vx=((item.seed>>>10)%161)-80;base.vy=220+(item.seed>>>18)%130;base.spin=((item.seed>>>15)%81)-40;base.impactItem=item;item.frames=base.item.frames;record(base,now);continue;}}
        const w=item.width+item.padX*2,h=item.height+item.padY*2,span=Math.max(0,width-w),f=(item.seed%997)/997,body={item,impactItem:item,w,h,x:span*(.28+.44*f),y:-h-2,vx:((item.seed>>>10)%161)-80,vy:220+(item.seed>>>18)%130,angle:((item.seed>>>5)%15)-7,spin:((item.seed>>>15)%81)-40};
        bodies.push(body);byId.set(item.id,body);record(body,item.startMs);
      }
      if(!bodies.length){if(next>=page.items.length)break;now=page.items[next].startMs;continue;}
      const dt=step/1000;now+=step;
      for(const b of bodies){b.vy+=850*dt;b.x+=b.vx*dt;b.y+=b.vy*dt;b.angle=Math.max(-9,Math.min(9,b.angle+b.spin*dt));b.spin*=.96;b.vx*=.995;
        if(b.x<0){b.x=0;b.vx=Math.abs(b.vx)*.18;}if(b.x+b.w>width){b.x=Math.max(0,width-b.w);b.vx=-Math.abs(b.vx)*.18;}
        if(b.y+b.h>=height){b.y=height-b.h;if(b.vy>45)b.vy=-b.vy*.18;else b.vy=0;b.vx*=.8;b.spin*=.8;if(!b.fragment&&b.impactItem.impact==null)b.impactItem.impact=now;}}
      for(let pass=0;pass<14;pass++)for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
        const a=bodies[i],b=bodies[j],ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        if(ox<=0||oy<=0)continue;
        if(oy<=ox){const upper=a.y+a.h/2<b.y+b.h/2?a:b,lower=upper===a?b:a,push=oy/2+.01;upper.y-=push;lower.y+=push;const relative=upper.vy-lower.vy;if(relative>0){const impulse=relative*.54,side=upper.x+upper.w/2<lower.x+lower.w/2?-1:1,lateral=Math.min(70,relative*.22);upper.vy-=impulse;lower.vy+=impulse;upper.vx+=side*lateral;lower.vx-=side*lateral*.4;upper.spin+=side*Math.min(18,relative*.04);if(!upper.fragment&&upper.impactItem.impact==null)upper.impactItem.impact=now;}}
        else{const left=a.x+a.w/2<b.x+b.w/2?a:b,right=left===a?b:a,push=ox/2+.01;left.x-=push;right.x+=push;const relative=left.vx-right.vx;if(relative>0){left.vx-=relative*.52;right.vx+=relative*.52;}}
        for(const body of [a,b]){body.x=Math.max(0,Math.min(width-body.w,body.x));if(body.y+body.h>height){body.y=height-body.h;body.vy=Math.min(0,body.vy);}}
      }
      // Replace a few impacted words with individual colliding letter bodies.
      // Bound their count so a dense song cannot stall the renderer.
      let fragments=bodies.filter(b=>b.fragment).length;
      for(let i=bodies.length-1;i>=0;i--){const b=bodies[i],item=b.impactItem;
        if(b.fragment||!item.breakApart||item.impact==null||item.fragments||fragments+item.glyphs.length>48)continue;
        record(b,now);bodies.splice(i,1);item.fragments=[];const unit=item.width/item.glyphs.length;
        item.glyphs.forEach((glyph,index)=>{const fragment={text:glyph,width:unit,height:item.height,frames:[]};item.fragments.push(fragment);
          const piece={item,fragment,w:unit,h:item.height,x:b.x+item.padX+index*unit,y:b.y+item.padY,vx:b.vx+(index-(item.glyphs.length-1)/2)*18,vy:Math.min(-25,b.vy-60-(index%3)*14),angle:b.angle,spin:((item.seed>>>(index%16))%81)-40};bodies.push(piece);record(piece,now);});
        fragments+=item.glyphs.length;
      }
      for(const b of bodies)record(b,now);
    }
    for(const item of page.items){const base=item.reuseId?byId.get(item.reuseId)?.item:item;if(base&&base!==item)item.frames=base.frames;const f=item.frames;item.x=f.length?f[f.length-3]:0;item.y=f.length?f[f.length-2]:height-item.height;for(const fragment of item.fragments||[]){const frames=fragment.frames;fragment.x=frames[frames.length-3];fragment.y=frames[frames.length-2];}}
  }
  // Words appear in the center and become bounded, interacting debris at their
  // sung end. Precomputed source-clock frames make pause and seek deterministic.
  function burstTrack(words,width,height,measure,{font=48,maxParticles=40}={}){
    width=Math.max(1,width);height=Math.max(1,height);font=Math.max(4,Math.min(font,height*.35));maxParticles=Math.max(32,Math.min(96,maxParticles));
    const ordered=[...words].sort((a,b)=>a.startMs-b.startMs||String(a.id).localeCompare(String(b.id))),items=ordered.map(word=>{
      const size=Math.max(4,Math.min(font,font*(width*.75/Math.max(1,measure(word.text,font,word))))),w=Math.min(width,Math.max(1,measure(word.text,size,word)+size*.04)),h=Math.min(height,size*1.15),x=(width-w)/2,y=(height-h)/2;
      let seed=2166136261;for(const ch of String(word.id)){seed^=ch.codePointAt(0);seed=Math.imul(seed,16777619);}seed>>>=0;
      const glyphs=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word.text)].map(s=>s.segment):Array.from(word.text);
      if(glyphs.length>32)glyphs.splice(31,glyphs.length-31,glyphs.slice(31).join(''));
      return {id:word.id,phraseId:word.phraseId,laneId:word.laneId,startMs:word.startMs,impact:Math.max(word.startMs,word.endMs),endMs:Math.max(word.startMs,word.endMs),width:w,height:h,font:size,x,y,seed,stationary:true,frames:[word.startMs,x,y,0,Math.max(word.startMs,word.endMs),x,y,0],glyphs,fragments:[],expiresAt:Infinity};
    });
    const events=[...items].sort((a,b)=>a.impact-b.impact||a.startMs-b.startMs||String(a.id).localeCompare(String(b.id))),bodies=[],step=50;
    if(!events.length)return {width,height,pages:[]};let now=events[0].impact,next=0,lastSpawn=now;
    const record=(body,t)=>body.fragment.frames.push(t,body.x,body.y,body.angle);
    while(next<events.length||now<events.at(-1).impact+1800){
      if(next<events.length&&now-lastSpawn>2200&&events[next].impact>now+step){now=events[next].impact;for(const body of bodies){body.vx=body.vy=body.spin=0;record(body,now);}}
      while(next<events.length&&events[next].impact<=now+.001){
        const item=events[next++];lastSpawn=now;const glyphs=item.glyphs.length?item.glyphs:[''];
        while(bodies.length+glyphs.length>maxParticles&&bodies.length){const old=bodies.shift();old.fragment.expiresAt=now;record(old,now);}
        const unit=item.width/glyphs.length,partFont=item.font*.58,partWidth=Math.max(2,unit*.58),partHeight=Math.max(2,item.height*.58);
        glyphs.forEach((text,index)=>{const angle=2*Math.PI*((index+.5)/glyphs.length+(item.seed%997)/997),speed=Math.min(width,height)*(1.05+((item.seed>>>(index%16))%35)/100),fragment={text,width:partWidth,height:partHeight,font:partFont,frames:[],expiresAt:Infinity};item.fragments.push(fragment);
          const body={item,fragment,x:item.x+index*unit+(unit-partWidth)/2,y:item.y+(item.height-partHeight)/2,w:partWidth,h:partHeight,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,angle:0,spin:((item.seed>>>(index%16))%121)-60};bodies.push(body);record(body,now);});
      }
      if(!bodies.length){if(next>=events.length)break;now=events[next].impact;continue;}
      const nextEvent=next<events.length?events[next].impact:Infinity,dtMs=Math.min(step,Math.max(.001,nextEvent-now));now+=dtMs;const dt=dtMs/1000,damp=Math.pow(.925,dtMs/step);
      const centered=items.filter(item=>item.startMs<=now&&now<item.endMs).reduce((best,item)=>!best||item.width>best.width?item:best,null);
      for(const b of bodies){b.x+=b.vx*dt;b.y+=b.vy*dt;b.angle+=b.spin*dt;b.vx*=damp;b.vy*=damp;b.spin*=damp;
        if(b.x<0){b.x=0;b.vx=Math.abs(b.vx)*.16;}if(b.x+b.w>width){b.x=Math.max(0,width-b.w);b.vx=-Math.abs(b.vx)*.16;}if(b.y<0){b.y=0;b.vy=Math.abs(b.vy)*.16;}if(b.y+b.h>height){b.y=Math.max(0,height-b.h);b.vy=-Math.abs(b.vy)*.16;}
        if(centered&&b.item!==centered&&now-b.item.impact>120){const ox=Math.min(b.x+b.w,centered.x+centered.width)-Math.max(b.x,centered.x),oy=Math.min(b.y+b.h,centered.y+centered.height)-Math.max(b.y,centered.y);if(ox>0&&oy>0){const dx=b.x+b.w/2-width/2,dy=b.y+b.h/2-height/2;if(ox<oy){const sign=dx<0?-1:1;b.x+=sign*(ox+.1);b.vx+=sign*55;}else{const sign=dy<0?-1:1;b.y+=sign*(oy+.1);b.vy+=sign*55;}}}}
      for(let pass=0;pass<2;pass++)for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){const a=bodies[i],b=bodies[j],ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);if(ox<=0||oy<=0)continue;
        if(ox<oy){const sign=a.x+a.w/2<b.x+b.w/2?-1:1,push=ox/2+.01;a.x+=sign*push;b.x-=sign*push;const v=(a.vx+b.vx)/2;a.vx=(a.vx+v)/2;b.vx=(b.vx+v)/2;}else{const sign=a.y+a.h/2<b.y+b.h/2?-1:1,push=oy/2+.01;a.y+=sign*push;b.y-=sign*push;const v=(a.vy+b.vy)/2;a.vy=(a.vy+v)/2;b.vy=(b.vy+v)/2;}}
      for(const b of bodies){b.x=Math.max(0,Math.min(width-b.w,b.x));b.y=Math.max(0,Math.min(height-b.h,b.y));record(b,now);}
    }
    for(const item of items){for(const f of item.fragments){const frames=f.frames;f.x=frames[frames.length-3];f.y=frames[frames.length-2];}if(item.fragments.length&&item.fragments.every(f=>Number.isFinite(f.expiresAt)))item.expiresAt=Math.max(...item.fragments.map(f=>f.expiresAt));}
    return {width,height,pages:[{startMs:items[0].startMs,items}]};
  }
  function pileAt(item,clock,width,height,{reduced=false}={}){
    if(clock<item.startMs)return null;
    if(reduced)return {x:item.x,y:item.y,rotation:0,squash:0};
    const frames=item.frames;if(!frames?.length)return {x:item.x,y:item.y};let lo=0,hi=frames.length/4-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(frames[mid*4]<=clock)lo=mid;else hi=mid-1;}
    const i=lo*4,j=Math.min(i+4,frames.length-4),span=frames[j]-frames[i],u=span>0?clamp((clock-frames[i])/span):0;
    const since=item.impact==null?-1:clock-item.impact,squash=since>=0&&since<220?Math.sin(Math.PI*since/220)*.08:0;
    const idle=item.stationary?0:clamp((clock-frames[frames.length-4])/600),phase=(clock+(item.seed%5000))/1100;
    return {x:Math.max(0,Math.min(Math.max(0,width-item.width),frames[i+1]+(frames[j+1]-frames[i+1])*u+idle*.45*Math.sin(phase))),y:frames[i+2]+(frames[j+2]-frames[i+2])*u-idle*.25*(1+Math.cos(phase*.8)),rotation:frames[i+3]+(frames[j+3]-frames[i+3])*u+idle*.15*Math.sin(phase*.7),squash};
  }
  function backingSettings(value={}){
    return {space:value?.space==='separate'?'separate':'shared',area:Number.isFinite(value?.area)?Math.max(.15,Math.min(.4,value.area)):.25,leadLabels:value?.leadLabels===true};
  }
  // All backing lanes share one budget, independent of their phrase count.
  function vocalAreas(width,height,hasBacking,value){
    const settings=backingSettings(value),band=hasBacking?height*settings.area:0;
    return {main:{x:0,y:0,width,height:height-(settings.space==='separate'?band:0)},backing:{x:width*.1,y:height-band,width:width*.8,height:band}};
  }
  const firePalettes=Object.freeze({
    ember:['#5a160c','#a72b0c','#e95812','#ff9c27','#ffd263','#fff0b9','#fffef4'],
    blue:['#102e69','#1554a4','#178acb','#37bfe9','#80e5ff','#d5f7ff','#ffffff'],
    violet:['#321458','#662798','#a13dcc','#cf72ee','#efabff','#fbe0ff','#ffffff'],
    green:['#153c27','#247342','#48a94b','#8ad85b','#c6ef8c','#edffd5','#ffffff'],
    crimson:['#4c1126','#8e1939','#ca2c48','#f65a65','#ff9e98','#ffded0','#fffdfa'],
    ghost:['#293c4c','#4b6475','#758e9b','#a8bfc7','#d6e4e6','#f0f7f7','#ffffff']
  });
  // Stateless, advected pixel noise: seeking reconstructs the same fire and
  // there is no short scrolling-image reset. Color never changes its geometry.
  function fireFrame(sourceMs,{color='ember',reduced=false}={}){
    const width=64,height=32,time=reduced?1600:Math.floor(Math.max(0,Number(sourceMs)||0)/83)*83;
    const hash=(x,y)=>{let n=Math.imul(x,374761393)+Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;};
    const noise=(x,y)=>{const a=Math.floor(x),b=Math.floor(y),u=x-a,v=y-b,s=u*u*(3-2*u),t=v*v*(3-2*v);return (hash(a,b)*(1-s)+hash(a+1,b)*s)*(1-t)+(hash(a,b+1)*(1-s)+hash(a+1,b+1)*s)*t;};
    const pixels=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const drift=time*.0023,plume=noise(x/6+noise(y/8,time*.00023)*1.6,y/6+drift);
      const heat=.10+.44*y/(height-1)+plume*.55;
      let index=Math.max(1,Math.min(6,Math.floor(heat*6)));
      if(noise(x*.7,y*.8+time*.008)>.79&&heat>.4)index=6;
      pixels[y*width+x]=index;
    }
    const particles=(count,smoke)=>Array.from({length:count},(_,i)=>{const seed=i+(smoke?47:11),period=(smoke?3100:1700)+hash(seed,3)*1900,age=((time+hash(seed,9)*period)%period)/period;return {x:(hash(seed,4)-.5)*2.5+Math.sin(age*4+seed)*.13,y:(smoke?.15:.55)-age*(smoke?.65:.95),alpha:(smoke?.12:.8)*Math.sin(Math.PI*age),size:smoke?.06+.07*age:.025};});
    return {width,height,time,palette:firePalettes[color]||firePalettes.ember,pixels,embers:reduced?[]:particles(4,false),smoke:reduced?[]:particles(3,true)};
  }
  // Paths follow the target's authored interval. Seeks and playback rate need no timers.
  function pathPosition(layer,progress,reduced=false){
    const path=layer.path,t=clamp(progress);if(!path||reduced)return {...layer.position};
    if(path.kind==='quadratic'){
      const u=t*t*(3-2*t),v=1-u;
      return {x:v*v*path.start.x+2*v*u*path.control.x+u*u*layer.position.x,y:v*v*path.start.y+2*v*u*path.control.y+u*u*layer.position.y};
    }
    const points=path.points;let i=1;while(i<points.length-1&&points[i].t<t)i++;
    const a=points[i-1],b=points[i],u=clamp((t-a.t)/(b.t-a.t));
    return {x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u};
  }
  const api={pathPosition,emojiMapDelta,applyEmojiMapDelta,resolveWordSet,validateEmojiMap,parseEmojiMap,formatEmojiMap,wordSetFor,coinSpin,stagePerformanceAt,layoutOrigins,landingStyles,landingAt,accentShadow,layout,readablePages,arrival,compose,expressionAt,danceAt,wordRuleMotions,wordRuleEffects,defaultWordRules,ruleWord,validateWordRules,validateWordRuleSets,wordRuleAt,vinylTrack,vinylAt,paintVinyl,dejaGroups,dejaIds,dejaPhrase,leadTrackPlan,pileVoicesAt,pileTrack,burstTrack,pileAt,backingSettings,vocalAreas,firePalettes,fireFrame};root.LvChoreography=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
