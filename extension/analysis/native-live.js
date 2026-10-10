(function (root) {
  'use strict';

  const VERSION = 'lyricvibe.native-live.v1';
  const HOST_NAME = 'com.lyricvibe.native_audio';
  const SAMPLE_RATE_HZ = 16000;
  const MAX_WINDOW_MS = 12000;
  const MAX_PCM_BYTES = SAMPLE_RATE_HZ * 2 * MAX_WINDOW_MS / 1000;
  const MAX_EXPECTED_WORDS = 200;
  const ALLOWED_RESULT_REASON_CODES = new Set(['SILENT_AUDIO']);
  const TOKEN_RE = /^[A-Za-z]+(?:'[A-Za-z]+)?$/;
  const boundedLabel = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  function normalizeExpectedWord(text) {
    const normalized = String(text).normalize('NFKC').replace(/’/gu, "'");
    const tokens = normalized.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) || [];
    if (tokens.length !== 1) return null;
    const remainder = normalized.replace(tokens[0], '');
    return /^[\p{P}\s]*$/u.test(remainder) ? tokens[0] : null;
  }

  function fail(code, message, detail = {}) { throw Object.assign(new Error(message), { code, ...detail }); }
  function digestHex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(digest =>
      [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  }

  function encodePcm16(floatPcm) {
    if (!(floatPcm instanceof Float32Array) || !floatPcm.length || floatPcm.length > SAMPLE_RATE_HZ * MAX_WINDOW_MS / 1000) {
      fail('INVALID_AUDIO_WINDOW', 'Captured PCM must contain between 1 ms and 12 seconds of mono samples.');
    }
    const bytes = new Uint8Array(floatPcm.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < floatPcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(floatPcm[i]) ? floatPcm[i] : 0));
      view.setInt16(i * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
    }
    return bytes;
  }

  function toBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  function phraseContainsUnsafeOverlap(score, phrase) {
    const offset = score.offsetMs || 0;
    const start = phrase.startMs + offset;
    const end = phrase.endMs + offset;
    return score.phrases.some(other => other.id !== phrase.id && start < other.endMs + offset && end > other.startMs + offset);
  }

  function expectedWordsForWindow(score, audioStartMs, durationMs, playbackRate = 1) {
    const leadLane = score.lanes.find(lane => lane.role === 'lead');
    if (!leadLane) return [];
    const offset = score.offsetMs || 0;
    if (!Number.isFinite(playbackRate) || playbackRate < 0.25 || playbackRate > 4) fail('UNSUPPORTED_PLAYBACK_RATE', 'Native analysis requires a supported playback rate.');
    const windowEndMs = audioStartMs + durationMs * playbackRate;
    const phrases = score.phrases.filter(phrase => {
      if (phrase.laneId !== leadLane.id || phrase.startMs + offset < audioStartMs || phrase.endMs + offset > windowEndMs) return false;
      if (phraseContainsUnsafeOverlap(score, phrase)) return false;
      if (!phrase.words.length || phrase.words.length > MAX_EXPECTED_WORDS) return false;
      if (phrase.words.some(word => word.locked || (word.syllables || []).some(syllable => syllable.locked))) return false;
      for (const word of phrase.words) {
        const token = normalizeExpectedWord(word.text);
        if (!token || !TOKEN_RE.test(token)) fail('UNSUPPORTED_LYRICS', 'A complete lead phrase contains a word that native alignment cannot represent safely.', { wordId: word.id, tokenClass: 'unsupported-or-compound-token' });
      }
      return true;
    });
    return phrases.flatMap(phrase => phrase.words.map(word => ({ wordId: word.id, phraseId: phrase.id, laneId: phrase.laneId, text: normalizeExpectedWord(word.text) })));
  }

  function validateHello(message) {
    const limits = message?.limits;
    if (message?.version !== VERSION || message.type !== 'hello' || message.hostName !== HOST_NAME ||
        !boundedLabel(message.hostVersion) || message.state !== 'ready' || message.modelReady !== true || message.alignmentReady !== true ||
        !limits || !Number.isSafeInteger(limits.maxAudioMs) || limits.maxAudioMs < 1 || limits.maxAudioMs > MAX_WINDOW_MS ||
        limits.sampleRateHz !== SAMPLE_RATE_HZ || limits.channels !== 1 || limits.encoding !== 'pcm_s16le' ||
        !Number.isSafeInteger(limits.maxPcmBytes) || limits.maxPcmBytes < 1 || limits.maxPcmBytes > MAX_PCM_BYTES) {
      fail('NATIVE_HOST_INCOMPATIBLE', 'The native audio host is unavailable or does not satisfy the bounded PCM protocol.');
    }
    return { hostVersion: message.hostVersion, limits: { ...limits } };
  }

  function validateEnvelope(message, expected) {
    if (!message || message.version !== VERSION || message.requestId !== expected.requestId ||
        message.sessionId !== expected.sessionId || !message.source ||
        ['tabId', 'mediaKey', 'lyricsHash', 'expectedRevision', 'captureEpoch'].some(key => message.source[key] !== expected.source[key])) {
      fail('NATIVE_RESPONSE_MISMATCH', 'Native response did not match the active request and source revision.');
    }
  }

  function validateAccepted(message, expected) {
    validateEnvelope(message, expected);
    if (message.type !== 'status' || message.state !== 'accepted') fail(message?.error?.code || 'NATIVE_REQUEST_REJECTED', message?.error?.message || 'Native host did not accept the audio window.');
    if (!message.audio || message.audio.audioStartMs !== expected.audio.audioStartMs || message.audio.sha256 !== expected.audio.sha256) {
      fail('NATIVE_RESPONSE_MISMATCH', 'Native acknowledgement did not bind the captured audio window.');
    }
  }

  function validateResult(message, expected, score) {
    validateEnvelope(message, expected);
    if (message.type === 'error') fail(message.error?.code || 'NATIVE_ALIGNMENT_FAILED', message.error?.message || 'Native alignment failed.');
    if (message.type !== 'result' || message.accepted !== false || message.alignmentKind !== 'supplied-text-ctc' || message.automaticAdmissionEnabled !== false ||
        message.reasonCode != null && !ALLOWED_RESULT_REASON_CODES.has(message.reasonCode) ||
        !boundedLabel(message.adapter) || !boundedLabel(message.model) || !boundedLabel(message.modelRevision) ||
        !message.audio || message.audio.audioStartMs !== expected.audio.audioStartMs || message.audio.sha256 !== expected.audio.sha256 ||
        !Array.isArray(message.words) || message.words.length > expected.expectedWords.length || !Array.isArray(message.warnings) || message.warnings.length > 100) {
      fail('NATIVE_RESPONSE_INVALID', 'Native result failed the review-only protocol checks.');
    }
    const byId = new Map(expected.expectedWords.map(word => [word.wordId, word]));
    const seen = new Set();
    const offset = score.offsetMs || 0;
    const proposals = [];
    const support = [];
    const consistency = message.diagnostics?.greedyConsistency;
    const validConsistency = consistency?.method === 'same-model-greedy-vs-forced-ctc' && consistency.calibrated === false && Array.isArray(consistency.words) && consistency.words.length <= expected.expectedWords.length &&
        Number.isSafeInteger(consistency.wordCount) && consistency.wordCount >= 0 && consistency.wordCount <= 600 &&
        Number.isSafeInteger(consistency.greedyWordCount) && consistency.greedyWordCount >= 0 && consistency.greedyWordCount <= 600 &&
        Number.isFinite(consistency.matchedWordFraction) && consistency.matchedWordFraction >= 0 && consistency.matchedWordFraction <= 1;
    if (validConsistency) {
      for (const row of consistency.words) {
        const wordId = typeof row?.wordId === 'string' && byId.has(row.wordId)
          ? row.wordId
          : Number.isSafeInteger(row?.wordIndex) && row.wordIndex >= 0 && row.wordIndex < expected.expectedWords.length ? expected.expectedWords[row.wordIndex].wordId : null;
        if (!wordId || support.some(item => item.wordId === wordId) ||
            !Number.isSafeInteger(row.forcedFrameCount) || row.forcedFrameCount < 0 || row.forcedFrameCount > 600 ||
            !Number.isFinite(row.greedyTop1FrameFraction) || row.greedyTop1FrameFraction < 0 || row.greedyTop1FrameFraction > 1 ||
            !Number.isFinite(row.meanForcedLogProb) || row.meanForcedLogProb > 0 || row.meanForcedLogProb < -1000) continue;
        support.push({ wordId, forcedFrameCount: row.forcedFrameCount, greedyTop1FrameFraction: row.greedyTop1FrameFraction, meanForcedLogProb: row.meanForcedLogProb, calibrated: false });
      }
    }
    for (const word of message.words) {
      const expectedWord = word && byId.get(word.wordId);
      if (!expectedWord || seen.has(word.wordId) || !Number.isSafeInteger(word.startMs) || !Number.isSafeInteger(word.endMs) ||
          word.startMs < 0 || word.endMs <= word.startMs || word.endMs > expected.audio.durationMs) {
        fail('NATIVE_RESPONSE_INVALID', 'Native result contained an unknown or out-of-window word timing.');
      }
      seen.add(word.wordId);
      const startMs = Math.round(expected.audio.audioStartMs + word.startMs * expected.audio.playbackRate - offset);
      const endMs = Math.round(expected.audio.audioStartMs + word.endMs * expected.audio.playbackRate - offset);
      const phrase = score.phrases.find(item => item.id === expectedWord.phraseId);
      if (!phrase || startMs < 0 || endMs <= startMs ||
          (score.source.durationMs > 0 && endMs + offset > score.source.durationMs + 1000) ||
          (!phrase.endEstimated && (startMs < phrase.startMs || endMs > phrase.endMs))) continue;
      const currentWord = phrase.words.find(item => item.id === word.wordId);
      if (!currentWord || currentWord.locked || (currentWord.syllables || []).some(syllable => syllable.locked)) continue;
      proposals.push({ wordId: word.wordId, startMs, endMs, accepted: false, evidenceId: `${expected.requestId}:${word.wordId}` });
    }
    return {
      proposals,
      diagnostics: {
        method: 'native-live-supplied-text-ctc', alignmentKind: message.alignmentKind,
        adapter: message.adapter, model: message.model, modelRevision: message.modelRevision,
        reasonCode: ALLOWED_RESULT_REASON_CODES.has(message.reasonCode) ? message.reasonCode : null,
        confidenceValidated: false, automaticAdmissionEnabled: false, audioRetained: false,
        sampleWindow: { audioStartMs: expected.audio.audioStartMs, durationMs: expected.audio.durationMs, playbackRate: expected.audio.playbackRate, captureEpoch: expected.source.captureEpoch, expectedWords: expected.expectedWords.length },
        warnings: message.warnings.map(warning => typeof warning === 'string' ? warning.slice(0, 1000) : 'Invalid warning omitted'),
        ...(validConsistency ? { greedyConsistency: { method: consistency.method, calibrated: false, wordCount: consistency.wordCount, greedyWordCount: consistency.greedyWordCount, matchedWordFraction: consistency.matchedWordFraction, words: support } } : {}),
      },
    };
  }

  async function createRequest({ requestId, sessionId, source, audioStartMs, playbackRate, floatPcm, expectedWords }) {
    if (typeof requestId !== 'string' || !requestId || typeof sessionId !== 'string' || !sessionId ||
        !source || !Number.isSafeInteger(source.tabId) || typeof source.mediaKey !== 'string' || !source.mediaKey ||
        !/^[a-f0-9]{64}$/.test(source.lyricsHash) || !Number.isSafeInteger(source.expectedRevision) || !Number.isSafeInteger(source.captureEpoch) ||
        !Number.isSafeInteger(audioStartMs) || audioStartMs < 0 || !Number.isFinite(playbackRate) || playbackRate < 0.25 || playbackRate > 4 ||
        !Array.isArray(expectedWords) || expectedWords.length < 1 || expectedWords.length > MAX_EXPECTED_WORDS) {
      fail('INVALID_NATIVE_REQUEST', 'Native request is missing source-bound audio or lyrics context.');
    }
    const pcm = encodePcm16(floatPcm);
    if (pcm.byteLength > MAX_PCM_BYTES) fail('INVALID_AUDIO_WINDOW', 'Captured PCM exceeds the 384,000 byte request limit.');
    const durationMs = Math.round(floatPcm.length * 1000 / SAMPLE_RATE_HZ);
    const sha256 = await digestHex(pcm);
    const request = {
      version: VERSION, type: 'analyze', requestId, sessionId,
      source: { ...source },
      audio: { encoding: 'pcm_s16le', sampleRateHz: SAMPLE_RATE_HZ, channels: 1, durationMs, audioStartMs, playbackRate, pcmBase64: toBase64(pcm), sha256 },
      expectedWords: expectedWords.map(word => ({ ...word })),
    };
    pcm.fill(0);
    return request;
  }

  root.LvNativeLive = { VERSION, HOST_NAME, SAMPLE_RATE_HZ, MAX_WINDOW_MS, MAX_PCM_BYTES, MAX_EXPECTED_WORDS, ALLOWED_RESULT_REASON_CODES, encodePcm16, expectedWordsForWindow, validateHello, validateEnvelope, validateAccepted, validateResult, createRequest };
  if (typeof module !== 'undefined') module.exports = root.LvNativeLive;
})(globalThis);
