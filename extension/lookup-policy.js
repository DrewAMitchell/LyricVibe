/* One paced provider queue across tabs. Cache and saved-score reads never enter it. */
(function(root){
  const cancelled=()=>Object.assign(new Error('Lookup superseded by navigation or reset.'),{code:'LOOKUP_CANCELLED'});
  function check(job){if(job?.signal?.aborted)throw cancelled();}
  function failureMessage(events=[]){
    const e=[...events].reverse().find(e=>e.provider==='lrclib'&&['SERVER_ERROR','RATE_LIMITED','TIMEOUT','NETWORK_ERROR','COOLDOWN','REQUEST_BUDGET'].includes(e.reason));
    const cause=e?.errorType||e?.reason,code=e?.httpStatus?` (HTTP ${e.httpStatus})`:'';
    if(cause==='RATE_LIMITED')return `LRCLIB rate limit reached${code}. Saved lyrics remain available; retry will respect its cooldown.`;
    if(cause==='SERVER_ERROR')return `LRCLIB is temporarily unavailable${code}. Saved lyrics remain available; retries will wait for the cooldown.`;
    if(cause==='TIMEOUT')return 'LRCLIB did not respond in time. Saved lyrics remain available; retries are paced.';
    if(cause==='NETWORK_ERROR')return 'Could not reach LRCLIB. Saved lyrics remain available; retries are paced.';
    if(cause==='REQUEST_BUDGET')return 'This lyrics search reached its request budget. Saved work is retained.';
    return 'Lyrics lookup is temporarily unavailable. Saved work is retained; retries are paced.';
  }
  function create({fetch:fetcher,storage,now=()=>Date.now(),spacingMs=2500,clientId='LyricVibe (https://github.com/DrewAMitchell/LyricVibe)'}={}){
    let tail=Promise.resolve(),nextStartAt=0;
    const cooldowns={},cooldownCauses={},recent=new Map();
    const ready=(async()=>{try{const data=(await storage?.get('lvLookupPacing'))?.lvLookupPacing;if(data){nextStartAt=Number(data.nextStartAt)||0;Object.assign(cooldowns,data.cooldowns||{});Object.assign(cooldownCauses,data.cooldownCauses||{});}}catch{}})();
    const persist=async()=>{try{await storage?.set({lvLookupPacing:{nextStartAt,cooldowns:{...cooldowns},cooldownCauses:{...cooldownCauses}}});}catch{}};
    const wait=(ms,signal)=>new Promise((resolve,reject)=>{
      const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
      const timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(cancelled());};
      if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    });
    function trace(job,provider,url,reason,detail={}){
      if(!job?.trace)return;job.trace.push({at:now(),provider,operation:new URL(url).pathname,reason,...detail});
      if(job.trace.length>40)job.trace.shift();
    }
    function request(url,provider,timeoutMs,job={}){
      const run=async()=>{
        await ready;check(job);
        const memo=job.memo||(job.memo=new Map());
        if(memo.has(url))return {...memo.get(url),reused:true};
        const prior=recent.get(url);if(prior&&now()-prior.at<60000){trace(job,provider,url,'RECENT_RESULT');memo.set(url,prior.result);return {...prior.result,reused:true};}
        const remaining=(cooldowns[provider]||0)-now();
        if(remaining>0){const cause=cooldownCauses[provider]||{errorType:'COOLDOWN'};trace(job,provider,url,'COOLDOWN',{...cause,retryAfterMs:remaining});return {ok:false,data:null,...cause,retryAfterMs:remaining,suppressed:true};}
        const counts=job.counts||(job.counts={});
        if((counts[provider]||0)>=(provider==='lrclib'?5:2)){trace(job,provider,url,'REQUEST_BUDGET');return {ok:false,data:null,errorType:'REQUEST_BUDGET'};}
        const delay=Math.max(0,nextStartAt-now());if(delay){trace(job,provider,url,'PACED',{waitMs:delay});await wait(delay,job.signal);}
        check(job);counts[provider]=(counts[provider]||0)+1;nextStartAt=now()+spacingMs;await persist();check(job);
        const controller=new AbortController(),abort=()=>controller.abort();
        job.signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(abort,timeoutMs);let result;
        trace(job,provider,url,'START');
        try{
          const response=await fetcher(url,{signal:controller.signal,...(provider==='lrclib'?{headers:{'Lrclib-Client':clientId}}:{})});check(job);
          if(response.ok)result={ok:true,data:await response.json(),errorType:null};
          else {
            const type=response.status===429?'RATE_LIMITED':response.status>=500?'SERVER_ERROR':response.status===401?'UNAUTHORIZED':'NOT_FOUND';
            const header=response.headers?.get?.('Retry-After');
            if(response.status===429||response.status===503){
              const numeric=header!=null&&String(header).trim()!==''?Number(header):NaN;
              const serverDelay=Number.isFinite(numeric)?numeric*1000:Date.parse(header)-now();
              const cooldown=Math.max(response.status===429?60000:30000,Number.isFinite(serverDelay)?serverDelay:0);
              cooldowns[provider]=now()+cooldown;cooldownCauses[provider]={errorType:type,httpStatus:response.status,retryAfterSource:Number.isFinite(serverDelay)?'server-header':'local-backoff'};await persist();
              result={ok:false,data:null,...cooldownCauses[provider],retryAfterMs:cooldown};
            }else result={ok:false,data:null,errorType:type,httpStatus:response.status};
          }
          check(job);
        }catch(error){check(job);result={ok:false,data:null,errorType:error.name==='AbortError'?'TIMEOUT':'NETWORK_ERROR'};}
        finally{clearTimeout(timer);job.signal?.removeEventListener('abort',abort);}
        trace(job,provider,url,result.ok?'SUCCESS':result.errorType,{...(result.httpStatus?{httpStatus:result.httpStatus}:{}),...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs,retryAfterSource:result.retryAfterSource}:{})});
        memo.set(url,result);
        if(result.ok||result.errorType==='NOT_FOUND'){recent.set(url,{at:now(),result});if(recent.size>100)recent.delete(recent.keys().next().value);}
        return result;
      };
      const promise=tail.then(run);tail=promise.catch(()=>{});return promise;
    }
    return {request,ready,status:()=>({spacingMs,nextStartAt,cooldowns:{...cooldowns},cooldownCauses:{...cooldownCauses}})};
  }
  const api={create,check,failureMessage};root.LvLookupPolicy=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
