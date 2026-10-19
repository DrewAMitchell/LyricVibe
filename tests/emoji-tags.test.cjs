const test=require('node:test'),assert=require('node:assert/strict');
const emojis=require('../extension/emoji-tags.js'),core=require('../extension/score-core.js'),choreo=require('../extension/choreography.js');
const score=text=>core.createPlainScore({videoId:'TESTVIDEO01',durationMs:10000},text,{contentHash:'c'.repeat(64)});
test('emoji hold extends only presentation to the phrase end and survives preset and export snapshots',()=>{
 const s=score('love air'),phrase=s.phrases[0],[love,air]=phrase.words;phrase.startMs=1000;phrase.endMs=5000;Object.assign(love,{startMs:1000,endMs:1800});Object.assign(air,{startMs:2500,endMs:3500});const before=structuredClone(s);
 const library={version:1,activeId:'hold',sets:[{id:'hold',name:'Hold',rules:[],emojiTags:true,emojiHold:'phrase'}]};assert.deepEqual(choreo.validateWordRuleSets(JSON.parse(JSON.stringify(library))),library);
 assert.throws(()=>choreo.validateWordRuleSets({...library,sets:[{...library.sets[0],emojiHold:'forever'}]}),/Hold emojis/);
 const word=choreo.compose(s,[]),held=choreo.compose(s,[],library.sets[0]);assert.equal(word[love.id].emojiEndMs,1800);assert.equal(held[love.id].emojiEndMs,5000);assert.equal(held[love.id].endMs,1800);assert.equal(held[air.id].startMs,2500);assert.deepEqual(s,before);
 const exp=require('../extension/overlay-export.js'),packet=exp.create(s,{theme:'neon',fontScale:1,liteMode:false,choreography:{mode:'classic'},placement:{left:0,top:0,width:100,height:100,minFontPx:28,maxFontPx:128},wordSet:library.sets[0],backingDisplay:choreo.backingSettings(),backingLabel:'hidden',linger:{mode:'off',beats:1},bloom:true,tempoMap:null},{startMs:1000,endMs:5000,width:640,height:360,fps:30});assert.equal(exp.validate(JSON.parse(JSON.stringify(packet))).display.wordSet.emojiHold,'phrase');
});
test('turntable holds each emoji beside its word until its selected end, including staggered backing words and seeks',()=>{
 for(const text of ['love air','(love air)']){const s=score(text),phrase=s.phrases[0],[love,air]=phrase.words;phrase.startMs=1000;phrase.endMs=5000;Object.assign(love,{startMs:1000,endMs:1800});Object.assign(air,{startMs:2500,endMs:3500});
 const track=hold=>choreo.vinylTrack(s,()=>.5,{emojiTags:true,cues:choreo.compose(s,[],{emojiHold:hold})}),word=track('word'),held=track('phrase'),emojis=(t,at)=>choreo.vinylAt(t,at).glyphs.filter(g=>g.emoji).map(g=>g.text);
 assert.deepEqual(emojis(held,999),[]);assert.deepEqual(emojis(held,1500),['❤️']);assert.deepEqual(emojis(word,1800),[]);assert.deepEqual(emojis(held,2200),['❤️']);assert.deepEqual(emojis(held,3000),['❤️','🌬️']);assert.deepEqual(emojis(held,5000),[]);assert.deepEqual(emojis(held,1500),['❤️']);assert.deepEqual(choreo.vinylAt(word,3000).glyphs.filter(g=>!g.emoji),choreo.vinylAt(held,3000).glyphs.filter(g=>!g.emoji));}
});
test('offline CLDR keywords resolve names, synonyms and preferred lyric words without substring guesses',()=>{
 assert.equal(emojis.count,1577);assert.equal(emojis.match('LOVE!').emoji,'❤️');assert.equal(emojis.match('breeze').label,'wind face');assert.equal(emojis.match('thunder').label,'high voltage');assert.equal(emojis.match('levitate').label,'cloud');
 assert.ok(emojis.suggest('joy').some(e=>e.keywords.includes('joy')));assert.ok(emojis.describe('🌬️').keywords.includes('wind'));assert.equal(emojis.match('the'),null);assert.equal(emojis.match('airflowzzz'),null);assert.deepEqual(emojis.match('flower'),emojis.match('flower'));
 const choices=emojis.suggest('love');choices[0].keywords.length=0;assert.ok(emojis.suggest('love')[0].keywords.length);
});
test('emoji rules, set toggles, phrase scopes and explicit per-word overrides keep source intact',()=>{
 const s=score('love lay down lay down air');const before=structuredClone(s),words=s.phrases[0].words;
 const rules=[{word:'lay down',motion:'off',effects:[],emoji:'☁️'},{word:'air',motion:'float',effects:[],emoji:''}];
 const library=choreo.validateWordRuleSets({version:1,activeId:'default',sets:[{id:'default',name:'Default',emojiTags:true,rules}]});assert.equal(library.sets[0].emojiTags,true);assert.equal(library.sets[0].rules[1].emoji,'');
 const cues=choreo.compose(s,rules);assert.equal(cues[words[0].id].emoji,'❤️');assert.equal(cues[words[1].id].emoji,'');assert.equal(cues[words[2].id].emoji,'☁️');assert.equal(cues[words[3].id].emoji,'');assert.equal(cues[words[4].id].emoji,'☁️');assert.equal(cues[words[5].id].emoji,'');assert.deepEqual(s,before);
 const edited=core.applyOperation(s,{type:'setWordAppearance',wordId:words[5].id,appearance:{emoji:'🌊',motion:'float'}},s.revision);assert.equal(choreo.compose(edited,rules)[words[5].id].emoji,'🌊');assert.deepEqual(edited.phrases[0].words.map(w=>[w.id,w.startMs,w.endMs]),s.phrases[0].words.map(w=>[w.id,w.startMs,w.endMs]));
 assert.throws(()=>choreo.validateWordRules([{word:'love',motion:'off',effects:[],emoji:'<img>'}]),/emoji/);assert.throws(()=>core.applyOperation(s,{type:'setWordAppearance',wordId:words[0].id,appearance:{emoji:'❤️❤️'}},s.revision),/appearance/);assert.throws(()=>choreo.validateWordRuleSets({...library,sets:[{...library.sets[0],emojiTags:'yes'}]}),/on or off/);
});
test('vinyl tags are optional grapheme glyphs and keep doubled backing word ranges intact',()=>{
 const s=score('(love(d) air)'),before=structuredClone(s),cues=choreo.compose(s),plain=choreo.vinylTrack(s,()=>.5),tagged=choreo.vinylTrack(s,()=>.5,{emojiTags:true,cues});
 assert.equal(plain.tokens[0].text,'(LOVE AIR)');assert.equal(tagged.tokens[0].text,'(LOVE ❤️ AIR 🌬️)');assert.equal(tagged.tokens[0].chars.filter(c=>c.emoji).length,2);assert.equal(tagged.tokens[0].chars.filter(c=>c.doubled).map(c=>c.text).join(''),'LOVE');assert.deepEqual(s,before);
});


test('grouped emoji map text round-trips words and quoted phrases and rejects ambiguous duplicate matches',()=>{
 const text='🌊 = (flow, water, "take a dip")\n💦 equals (drip, sweat, wet, gush)\nnone = (baby)';
 const groups=choreo.parseEmojiMap(text);assert.deepEqual(groups[0],{emoji:'🌊',terms:['flow','water','take a dip']});assert.equal(groups[2].emoji,'');assert.deepEqual(choreo.parseEmojiMap(choreo.formatEmojiMap(groups)),groups);
 assert.throws(()=>choreo.parseEmojiMap('🌊 = (Water)\n💦 = (water!)'),/more than once/);
 for(const bad of ['water = (flow)','🌊 = (flow,)','🌊 = ("take a dip)','🌊 = ("one two three four five")'])assert.throws(()=>choreo.parseEmojiMap(bad),/Line 1/);
 assert.deepEqual(choreo.parseEmojiMap('# a comment\n\n'),[]);
});

test('song presets resolve by exact video while library round-trip retains maps and legacy default behavior',()=>{
 const base={version:1,activeId:'default',sets:[{id:'default',name:'Default',rules:[]},{id:'water',name:'Water',rules:[],emojiTags:true,emojiDictionary:false,emojiMap:choreo.parseEmojiMap('🌊 = (water)')},{id:'innuendo',name:'Innuendo',rules:[],emojiTags:true,emojiDictionary:false,emojiMap:choreo.parseEmojiMap('💦 = (water)')}],songSets:{'youtube:TESTVIDEO01':'water','youtube:TESTVIDEO02':'innuendo'}};
 const library=choreo.validateWordRuleSets(JSON.parse(JSON.stringify(base)));assert.deepEqual(library,base);
 assert.equal(choreo.wordSetFor(library,{videoId:'TESTVIDEO01'}).id,'water');assert.equal(choreo.wordSetFor(library,{videoId:'TESTVIDEO02'}).id,'innuendo');assert.equal(choreo.wordSetFor(library,{videoId:'TESTVIDEO03'}).id,'default');
 assert.throws(()=>choreo.validateWordRuleSets({...base,songSets:{'youtube:TESTVIDEO01':'missing'}}),/existing set/);
 assert.throws(()=>choreo.validateWordRuleSets({...base,songSets:{'song title':'water'}}),/exact video/);
 const legacy={version:1,activeId:'default',sets:[{id:'default',name:'Default',rules:[]}]};assert.deepEqual(choreo.validateWordRuleSets(legacy),legacy);
});

test('emoji groups match longest exact phrases independently of motion, with dictionary opt-out and explicit overrides',()=>{
 const s=score('flow water take a dip drip sweat wet gush waterfall love'),before=structuredClone(s),words=s.phrases[0].words;
 const options={emojiDictionary:false,emojiMap:choreo.parseEmojiMap('🌊 = (flow, water, "take a dip")\n💦 = (dip, drip, sweat, wet, gush)')},rules=[{word:'flow',motion:'float',effects:[]}];
 const cues=choreo.compose(s,rules,options);assert.deepEqual(words.map(w=>cues[w.id].emoji),['🌊','🌊','','','🌊','💦','💦','💦','💦','','']);assert.equal(cues[words[0].id].rule.motion,'float');assert.equal(cues[words[1].id].rule,undefined);assert.deepEqual(s,before);
 assert.equal(choreo.compose(s,rules,{...options,emojiDictionary:true})[words.at(-1).id].emoji,'❤️');
 rules[0].emoji='⭐';assert.equal(choreo.compose(s,rules,options)[words[0].id].emoji,'⭐');words[0].appearance={emoji:'🔥'};assert.equal(choreo.compose(s,rules,options)[words[0].id].emoji,'🔥');
});
