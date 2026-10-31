const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const pronunciation=require('../extension/pronunciation.js');
test('batched pronunciation requests return local suggestions and reject oversized input',async()=>{
 const listeners=[],context=vm.createContext({importScripts(){},LvPronunciation:pronunciation,chrome:{runtime:{onMessage:{addListener(fn){listeners.push(fn)}},getURL:p=>p}},fetch:async()=>({ok:true,json:async()=>({entries:{insane:[2],about:[2],variant:[2,3]}})})});
 const source=fs.readFileSync(require.resolve('../extension/service-worker.js'),'utf8').split('/* MV3 service workers')[0];vm.runInContext(source,context);
 const send=message=>new Promise(resolve=>listeners[0](message,{},resolve));
 const result=await send({type:'LV_PRONUNCIATION_BATCH',words:['Insane,','about','variant','unknown']});
 assert.equal(result.ok,true);assert.deepEqual(Array.from(result.suggestions[0].parts),['In','sane,']);assert.deepEqual(Array.from(result.suggestions[1].parts),['a','bout']);assert.equal(result.suggestions[2].status,'ambiguous');assert.equal(result.suggestions[3].status,'unknown');
 assert.equal((await send({type:'LV_PRONUNCIATION_BATCH',words:Array(129).fill('word')})).ok,false);
});
