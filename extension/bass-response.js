/* Local, ephemeral bass meter. Never routes captured sound to an output. */
(() => {
  'use strict';
  const clamp = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  function energyFromSpectrum(db, sampleRate, fftSize) {
    const first = Math.max(1, Math.ceil(35 * fftSize / sampleRate));
    const last = Math.min(db.length - 1, Math.floor(180 * fftSize / sampleRate));
    let power = 0;
    for (let i = first; i <= last; i++) if (Number.isFinite(db[i])) power += 10 ** (db[i] / 10);
    // Fixed floor avoids amplifying silence; square root preserves quieter bass.
    return clamp((Math.sqrt(power) - .00056) / .12);
  }
  function create() {
    let current = null, generation = 0, status = 'off';
    function stop(reason = 'off') {
      generation++; const s = current; current = null; status = reason;
      if (s) {
        s.source?.disconnect(); s.analyser?.disconnect();
        s.stream?.getTracks().forEach(t => t.stop());
        s.data?.fill(0); void s.context?.close().catch(() => {});
        for (const [name, fn] of s.listeners) s.media.removeEventListener(name, fn);
      }
    }
    async function start(media, key) {
      stop();
      if (!media?.captureStream || !key) { status = 'unavailable'; return false; }
      const token = generation, s = current = { media, key, listeners: [], value: 0, last: 0 };
      status = 'starting';
      try {
        s.stream = media.captureStream();
        s.stream.getVideoTracks().forEach(t => t.stop());
        const audio = s.stream.getAudioTracks();
        if (!audio.length) throw Error('No accessible audio track');
        s.context = new AudioContext({ latencyHint: 'interactive' });
        s.source = s.context.createMediaStreamSource(new MediaStream(audio));
        s.analyser = s.context.createAnalyser(); s.analyser.fftSize = 2048; s.analyser.smoothingTimeConstant = 0;
        s.data = new Float32Array(s.analyser.frequencyBinCount);
        s.source.connect(s.analyser);
        const reset = () => { s.value = 0; s.last = 0; };
        for (const name of ['pause', 'seeking', 'ratechange']) { media.addEventListener(name, reset); s.listeners.push([name, reset]); }
        const ended = () => { if (current === s) stop('ended'); };
        for (const name of ['emptied', 'loadstart', 'ended']) { media.addEventListener(name, ended); s.listeners.push([name, ended]); }
        audio.forEach(track => track.addEventListener('ended', ended, { once: true }));
        await s.context.resume();
        if (token !== generation || current !== s) return false;
        status = s.context.state === 'running' ? 'ready' : 'suspended'; return status === 'ready';
      } catch (_) { if (current === s) stop('unavailable'); return false; }
    }
    function sample(media, key, eligible = true) {
      const s = current;
      if (!s) return 0;
      if (media !== s.media || key !== s.key) { stop('source-changed'); return 0; }
      if (!eligible || media.paused || media.seeking || media.ended) { s.value = 0; s.last = 0; return 0; }
      if (s.context?.state !== 'running') { status = 'suspended'; return 0; }
      if (!s.stream.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)) { s.value = 0; status = 'no-signal'; return 0; }
      s.analyser.getFloatFrequencyData(s.data);
      const target = energyFromSpectrum(s.data, s.context.sampleRate, s.analyser.fftSize);
      const now = s.context.currentTime, dt = s.last ? Math.max(0, Math.min(.1, now - s.last)) : .016;
      s.last = now; s.value += (target - s.value) * (1 - Math.exp(-dt / (target > s.value ? .025 : .18)));
      status = 'ready'; return clamp(s.value);
    }
    return { start, stop, sample, state: () => ({ status, enabled: !!current, energy: current?.value || 0 }) };
  }
  const api = { create, energyFromSpectrum }; globalThis.LvBassResponse = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
