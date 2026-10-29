// Browser-only Web Audio boundary for capture proofs. No speaker output.
// Tests can set __audioTime explicitly; otherwise accelerate the count-in clock.
module.exports=function installCaptureAudioFixture(){
  window.__audioStarts=[];window.__audioStops=[];
  window.AudioContext=class{
    constructor(){this.state='running';this.destination={};}
    get currentTime(){return window.__audioTime??performance.now()/10;}
    async resume(){this.state='running';}
    async close(){this.state='closed';}
    createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
    createOscillator(){return {frequency:{value:0},connect(){},disconnect(){},start(at){__audioStarts.push({at,frequency:this.frequency.value});},stop(at){__audioStops.push(at??null);}};}
  };
};
