// Audio runs directly to destination through the source node. This branch only
// copies bounded mono PCM and emits a silent output; it cannot double playback.
class LvPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2048); this.used = 0; this.startFrame = 0; this.pending = 0; this.droppedFrames = 0;
    this.port.onmessage = ({ data }) => { if (data.type === 'ack') this.pending = Math.max(0, this.pending - 1); };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      // Four outstanding PCM messages bound the cross-thread queue even if the
      // offscreen event loop stalls. Gaps carry absolute sample frame identity.
      if (this.pending >= 4) { this.droppedFrames++; continue; }
      if (!this.used) this.startFrame = currentFrame + i;
      let sum = 0;
      for (const channel of channels) sum += channel[i] || 0;
      this.buffer[this.used++] = sum / channels.length;
      if (this.used === this.buffer.length) {
        this.port.postMessage({ pcm: this.buffer, startFrame: this.startFrame, sampleRate, droppedFrames: this.droppedFrames }, [this.buffer.buffer]);
        this.pending++; this.droppedFrames = 0;
        this.buffer = new Float32Array(2048); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('lv-pcm-capture', LvPcmCapture);
