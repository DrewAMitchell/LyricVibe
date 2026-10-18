const test=require('node:test'),assert=require('node:assert/strict');
const Policy=require('../extension/lookup-policy.js');
const ok=()=>({ok:true,status:200,json:async()=>({words:'fixture'})});
const storage=()=>{const data={};return {get:async()=>structuredClone(data),set:async value=>Object.assign(data,structuredClone(value))};};

test('provider requests from multiple tabs share one serial paced queue and identical results',async()=>{
  const starts=[];let active=0,maximum=0;
  const policy=Policy.create({spacingMs:25,fetch:async url=>{starts.push({url,at:Date.now()});maximum=Math.max(maximum,++active);await new Promise(r=>setTimeout(r,5));active--;return ok();}});
  await Promise.all([policy.request('https://fixture/a','lrclib',100,{}),policy.request('https://fixture/a','lrclib',100,{}),policy.request('https://fixture/b','lyricsOvh',100,{})]);
  assert.equal(starts.length,2);assert.equal(maximum,1);assert.ok(starts[1].at-starts[0].at>=24);
});

test('429 and 503 cooldowns honor Retry-After and survive worker replacement, including another tab',async()=>{
  const store=storage();let now=100000,calls=0;
  let policy=Policy.create({storage:store,now:()=>now,spacingMs:0,fetch:async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '120'}};}});
  const first=await policy.request('https://fixture/a','lrclib',100,{});assert.equal(first.retryAfterMs,120000);
  policy=Policy.create({storage:store,now:()=>now,spacingMs:0,fetch:async()=>{calls++;return ok();}});
  assert.equal((await policy.request('https://fixture/b','lrclib',100,{})).errorType,'RATE_LIMITED');assert.equal(calls,1);
  now+=120001;assert.equal((await policy.request('https://fixture/b','lrclib',100,{})).ok,true);
  const date=new Date(now+90000).toUTCString();
  policy=Policy.create({now:()=>now,spacingMs:0,fetch:async()=>({ok:false,status:503,headers:{get:()=>date}})});
  assert.ok((await policy.request('https://fixture/a','lrclib',100,{})).retryAfterMs>=89000);
});

test('navigation cancellation aborts active transport, skips queued work, and is not a provider failure',async()=>{
  const controller=new AbortController(),queued=new AbortController(),started=[];let entered;
  const began=new Promise(r=>entered=r);
  const policy=Policy.create({spacingMs:0,fetch:async(url,{signal})=>{started.push(url);entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'})),{once:true}));}});
  const first=policy.request('https://fixture/a','lrclib',1000,{signal:controller.signal});
  const second=policy.request('https://fixture/b','lrclib',1000,{signal:queued.signal});
  const rejected1=assert.rejects(first,{code:'LOOKUP_CANCELLED'}),rejected2=assert.rejects(second,{code:'LOOKUP_CANCELLED'});
  await began;queued.abort();controller.abort();await Promise.all([rejected1,rejected2]);
  assert.deepEqual(started,['https://fixture/a']);assert.deepEqual(policy.status().cooldowns,{});
});

test('one lookup has finite provider budgets; duplicate misses never consume another request',async()=>{
  let calls=0;const policy=Policy.create({spacingMs:0,fetch:async()=>{calls++;return {ok:false,status:404};}}),job={trace:[]};
  await policy.request('https://fixture/0','lrclib',100,job);await policy.request('https://fixture/0','lrclib',100,job);
  for(let i=1;i<8;i++)await policy.request('https://fixture/'+i,'lrclib',100,job);
  assert.equal(calls,5);assert.equal(job.counts.lrclib,5);assert.ok(job.trace.some(e=>e.reason==='REQUEST_BUDGET'));
  for(let i=0;i<4;i++)await policy.request('https://fallback/'+i,'lyricsOvh',100,job);
  assert.equal(calls,7);
});

test('request timeout covers response-body decoding as well as headers',async()=>{
  const policy=Policy.create({spacingMs:0,fetch:async(url,{signal})=>({ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'})),{once:true}))})});
  assert.equal((await policy.request('https://fixture/a','lrclib',15,{})).errorType,'TIMEOUT');
});
