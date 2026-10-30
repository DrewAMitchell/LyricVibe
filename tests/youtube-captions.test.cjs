const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const captions=require('../extension/youtube-captions.js'),core=require('../extension/score-core.js');
const id='TESTVIDEO01',packet=events=>({state:'available',videoId:id,language:'en',kind:'automatic',format:'json3',body:JSON.stringify({events})});

test('caption segments keep gaps, repeated phrases and literal text while word timings remain estimates',()=>{
 const c=captions.decode(packet([
  {tStartMs:1000,dDurationMs:2000,wWinId:1,segs:[{utf8:'(hello) <world>'}]},
  {tStartMs:1000,dDurationMs:2000,wWinId:1,segs:[{utf8:'(hello) <world>'}]},
  {tStartMs:6000,dDurationMs:12000,segs:[{utf8:'(hello) <world>'}]}
 ]),id,10000);
 assert.equal(c.cues.length,2);assert.deepEqual(c.cues.map(c=>[c.startMs,c.endMs]),[[1000,3000],[6000,10000]]);
 const score=captions.createScore(core,{videoId:id,durationMs:10000},c,'a'.repeat(64));
 assert.equal(score.lanes.length,1);assert.equal(score.phrases[0].words[0].text,'(hello)');assert.equal(score.phrases[0].words[1].text,'<world>');
 assert.ok(score.phrases.every(p=>!p.endEstimated&&p.words.every(w=>w.provenance==='estimated'&&!w.locked)));
 assert.equal(core.activeAt(score,4000).phrases.length,0);
});

test('caption parser rejects foreign, empty and oversized results, and joins append events without losing time',()=>{
 assert.equal(captions.decode(packet([]),'OTHERVIDEO1',10000),null);
 assert.equal(captions.decode({...packet([]),body:'bad'},id,10000),null);
 assert.equal(captions.decode({...packet([]),body:'x'.repeat(1000001)},id,10000),null);
 const c=captions.decode(packet([{tStartMs:100,dDurationMs:200,wWinId:0,segs:[{utf8:'First'}]},{tStartMs:200,dDurationMs:200,aAppend:1,wWinId:0,segs:[{utf8:'second'}]}]),id,10000);
 assert.deepEqual(c.cues,[{startMs:100,endMs:400,text:'First second'}]);
 assert.equal(captions.decode(packet([{tStartMs:-1,dDurationMs:100,segs:[{utf8:'bad'}]}]),id,10000),null);
});

test('page reader binds caption URLs to this video and rejects a navigation during fetch',async()=>{
 const track={languageCode:'en',name:{simpleText:'English'},baseUrl:'https://www.youtube.com/api/timedtext?v='+id+'&lang=en'};
 let url='https://www.youtube.com/watch?v='+id,requests=0;
 const player={getPlayerResponse:()=>({videoDetails:{videoId:id},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}}),getOption:()=>({})};
 const context=vm.createContext({URL,AbortSignal,TextDecoder,location:{get href(){return url;}},document:{documentElement:{lang:'en'},querySelector:s=>s==='#movie_player'?player:null},navigator:{language:'en'},performance:{getEntriesByType:()=>[]},fetch:async()=>{requests++;url='https://www.youtube.com/watch?v=OTHERVIDEO1';return new Response(JSON.stringify({events:[]}));}});
 context.read=captions.readFromPage.toString();
 assert.equal((await vm.runInContext(`(${captions.readFromPage.toString()})('${id}')`,context)).state,'source-changed');assert.equal(requests,1);
 url='https://www.youtube.com/watch?v='+id;track.baseUrl='https://example.com/collect?v='+id+'&lang=en';
 await vm.runInContext(`(${captions.readFromPage.toString()})('${id}')`,context);assert.equal(requests,1);
});
