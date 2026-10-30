const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/content.js'),'utf8');
const start=source.indexOf('  function setupTrackChangeObserver() {');
const watcher=source.slice(start,source.indexOf('\n  /* ═',start+10));
function harness(){
 let now=0,sequence=0,focused=true,reads=0;const timers=new Map(),messages=[],observed=new Set();
 const events=()=>{const handlers=new Map();return {addEventListener(n,f){if(!handlers.has(n))handlers.set(n,[]);handlers.get(n).push(f)},fire(n){for(const f of handlers.get(n)||[])f({target:null})}}};
 const document={...events(),readyState:'complete',querySelectorAll:()=>[{id:'title'}]};
 const window=events(), hints={url:'https://www.youtube.com/watch?v=AAAAAAAAAAA',track:'A',mediaReady:true};
 const add=(fn,delay,interval)=>{const id=++sequence;timers.set(id,{fn,at:now+delay,interval});return id};
 const context=vm.createContext({document,window,root:{contains:()=>false},performance:{now:()=>now},state:{active:false},observationFocused:()=>focused,
  listenGlobal:(target,name,listener,options)=>target.addEventListener(name,listener,options),
  getPageHints:()=>{reads++;return hints},LvScore:require('../extension/score-core.js'),chrome:{runtime:{sendMessage:async m=>messages.push(m)}},
  MutationObserver:class {constructor(fn){this.fn=fn}observe(){observed.add(this)}disconnect(){observed.delete(this)}},
  setTimeout:(f,d)=>add(f,d,0),clearTimeout:id=>timers.delete(id),setInterval:(f,d)=>add(f,d,d),clearInterval:id=>timers.delete(id),
  cancelLoop(){},stopSpotifyPolling(){},cancelBeatClicks(){},startLoop(){},startSpotifyPolling(){}});
 vm.runInContext(watcher+'\nvar watcher=setupTrackChangeObserver();watcher.sync();',context);
 const advance=ms=>{const until=now+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [id,t]=next;now=t.at;if(t.interval)t.at+=t.interval;else timers.delete(id);t.fn()}now=until};
 return {context,hints,messages,document,window,advance,reads:()=>reads,observers:()=>observed.size,timers:()=>timers.size,
  mutation:()=>{for(const o of [...observed])o.fn()},focus:value=>{focused=value;window.fire(value?'focus':'blur')},status:()=>vm.runInContext('watcher.status()',context)};
}
test('track watching detaches observers and timers while unfocused and reconciles exactly one stable change on return',()=>{
 const h=harness();h.advance(1800);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,1);
 h.messages.length=0;h.focus(false);const reads=h.reads();assert.equal(h.observers(),0);assert.equal(h.timers(),0);
 h.hints.url='https://www.youtube.com/watch?v=BBBBBBBBBBB';h.advance(20000);h.mutation();assert.equal(h.reads(),reads);
 h.focus(true);h.advance(1800);const changes=h.messages.filter(m=>m.type==='LV_TRACK_CHANGED');assert.equal(changes.length,1);assert.equal(changes[0].changed,true);assert.equal(changes[0].key,'youtube:BBBBBBBBBBB');
 h.advance(10000);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,1);
});
test('loading, metadata bursts and transient identities do not flood detection or announce an unready track',()=>{
 const h=harness();h.document.readyState='loading';h.advance(10000);assert.equal(h.reads(),0);
 h.document.readyState='complete';h.document.fire('readystatechange');h.advance(1800);h.messages.length=0;const before=h.reads();
 for(let i=0;i<100;i++){h.mutation();h.advance(10)}assert.ok(h.reads()-before<=2);
 h.document.fire('yt-navigate-start');h.hints.url='https://www.youtube.com/watch?v=BBBBBBBBBBB';h.advance(1500);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,0);
 h.document.fire('yt-navigate-finish');h.hints.mediaReady=false;h.advance(1800);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,0);
 h.hints.mediaReady=true;h.document.fire('loadedmetadata');h.advance(500);h.hints.url='https://www.youtube.com/watch?v=CCCCCCCCCCC';h.advance(2600);
 const changes=h.messages.filter(m=>m.type==='LV_TRACK_CHANGED');assert.equal(changes.length,1);assert.equal(changes[0].key,'youtube:CCCCCCCCCCC');
});
test('returning to the same track requests only resume, and a loaded score establishes the watcher baseline',()=>{
 const h=harness();vm.runInContext("watcher.accept('youtube:AAAAAAAAAAA')",h.context);h.advance(1800);h.messages.length=0;
 h.focus(false);h.focus(true);h.advance(1800);const change=h.messages.find(m=>m.type==='LV_TRACK_CHANGED');assert.equal(change.changed,false);assert.equal(change.resume,true);
});


test('fallback polling never ends an unfinished SPA navigation and changed metadata must settle again',()=>{
 const h=harness();h.advance(1800);h.messages.length=0;
 h.document.fire('yt-navigate-start');h.hints.url='https://www.youtube.com/watch?v=BBBBBBBBBBB';h.advance(16000);
 assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,0);assert.equal(h.status().navigating,true);
 h.document.fire('yt-navigate-finish');h.advance(500);h.hints.track='Real new title';h.mutation();h.advance(1200);
 assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,0);
 h.advance(1200);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,1);
});

test('manual reset invalidates the old generation and produces one settled same-source detection',()=>{
 const h=harness();h.advance(1800);const before=h.status().navigationToken;h.messages.length=0;
 vm.runInContext('watcher.reset()',h.context);assert.notEqual(h.status().navigationToken,before);assert.equal(h.status().settled,false);
 h.advance(1800);assert.equal(h.messages.filter(m=>m.type==='LV_NAVIGATION_RESET').length,1);assert.equal(h.messages.filter(m=>m.type==='LV_TRACK_CHANGED').length,1);
});
