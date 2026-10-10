// Bundle this module locally. Never import executable code from a CDN.
import { pipeline, env } from '@huggingface/transformers';
const MODEL = 'onnx-community/whisper-tiny_timestamped';
const REVISION = '517244293732ee2d58139af5814231b7e6830a0d';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.cacheKey = 'lyricvibe-models-v1';
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  wasm: new URL('./vendor/ort-wasm-simd-threaded.asyncify.wasm', self.location.href).href,
  mjs: new URL('./vendor/ort-wasm-simd-threaded.asyncify.mjs', self.location.href).href,
};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let transcriber;
let provider;
let busy = false;

function resample(pcm, rate) {
  if (rate === 16000) return pcm;
  const ratio = rate / 16000;
  const output = new Float32Array(Math.floor(pcm.length / ratio));
  // Box-average before downsampling; no unbounded browser/offline decoding.
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < Math.min(end, pcm.length); j++) sum += pcm[j];
    output[i] = sum / (Math.min(end, pcm.length) - start);
  }
  return output;
}

async function load() {
  let gpuAvailable = false;
  try { gpuAvailable = Boolean(await navigator.gpu?.requestAdapter()); } catch (_) { /* CPU path remains explicit. */ }
  const progress_callback = p => self.postMessage({ type: 'progress', progress: { status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total } });
  if (gpuAvailable) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', MODEL, { revision: REVISION, device: 'webgpu', dtype: 'fp32', progress_callback });
      provider = 'webgpu';
    } catch (_) {
      self.postMessage({ type: 'fallback', reason: 'WEBGPU_MODEL_LOAD_FAILED', provider: 'wasm' });
    }
  }
  if (!transcriber) {
    transcriber = await pipeline('automatic-speech-recognition', MODEL, { revision: REVISION, device: 'wasm', dtype: 'q8', progress_callback });
    provider = 'wasm';
  }
  self.postMessage({ type: 'ready', provider, model: MODEL, modelRevision: REVISION, method: 'top-one-transcription-anchors' });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    try { await load(); } catch (_) { self.postMessage({ type: 'error', code: 'MODEL_LOAD_FAILED', message: 'The browser could not load the packaged runtime or model data.' }); }
    return;
  }
  if (data.type !== 'transcribe' || busy || !transcriber) return;
  busy = true;
  let audio;
  try {
    audio = resample(data.pcm, data.sampleRate);
    const started = performance.now();
    const result = await transcriber(audio, { return_timestamps: 'word', task: 'transcribe', language: data.language || 'en', chunk_length_s: 12, stride_length_s: 0, max_new_tokens: 128 });
    self.postMessage({ type: 'result', epoch: data.epoch, window: data.window, chunks: result.chunks || [], provider, model: MODEL, modelRevision: REVISION, inferenceMs: Math.round(performance.now() - started) });
  } catch (_) {
    self.postMessage({ type: 'error', epoch: data.epoch, code: 'INFERENCE_FAILED', message: 'Browser transcription failed; this window produced no timing evidence.' });
  } finally {
    audio?.fill(0);
    data.pcm?.fill(0);
    busy = false;
  }
};
