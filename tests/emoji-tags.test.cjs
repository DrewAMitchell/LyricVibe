const test=require('node:test'),assert=require('node:assert/strict');
const emojis=require('../extension/emoji-tags.js'),core=require('../extension/score-core.js'),choreo=require('../extension/choreography.js');
const score=text=>core.createPlainScore({videoId:'TESTVIDEO01',durationMs:10000},text,{contentHash:'c'.repeat(64)});
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
