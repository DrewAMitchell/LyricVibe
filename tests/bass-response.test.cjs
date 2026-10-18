const test=require('node:test'),assert=require('node:assert/strict'),{energyFromSpectrum,create}=require('../extension/bass-response.js');
test('bass meter excludes silence and high frequencies, stays finite and responds to low frequencies',()=>{
 const db=new Float32Array(1024).fill(-Infinity);assert.equal(energyFromSpectrum(db,48000,2048),0);
 db[Math.round(1500*2048/48000)]=-10;assert.equal(energyFromSpectrum(db,48000,2048),0);
 db[Math.round(60*2048/48000)]=-25;const quiet=energyFromSpectrum(db,48000,2048);assert.ok(quiet>.1&&quiet<1);
 db[Math.round(60*2048/48000)]=-5;assert.equal(energyFromSpectrum(db,48000,2048),1);
 db.fill(NaN);assert.equal(energyFromSpectrum(db,48000,2048),0);
});
test('missing capture support stays explicitly unavailable and stop clears permission',async()=>{
 const monitor=create();assert.equal(await monitor.start({},'video'),false);assert.deepEqual(monitor.state(),{enabled:false,status:'unavailable',energy:0});
 assert.equal(monitor.sample({},'video'),0);monitor.stop();assert.equal(monitor.state().status,'off');
});
