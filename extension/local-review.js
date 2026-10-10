(function (root, factory) {
  const score = root.LvScore || (typeof module === "object" && module.exports ? require("./score-core.js") : null);
  const api = factory(score);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LvLocalReview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (LvScore) {
  "use strict";

  const VERSION = "lyricvibe.review.v1";
  const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
  const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
  const MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
  const MAX_WAVEFORM_BUCKETS = 18000;
  const AUDIO_DURATION_TOLERANCE_MS = 500;
  const HASH_RE = /^[a-f0-9]{64}$/i;

  class LocalReviewError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "LocalReviewError";
      this.code = code;
    }
  }

  function fail(code, message) { throw new LocalReviewError(code, message); }
  function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function utf8Bytes(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  }

  function parsePackage(input) {
    let json;
    if (typeof input === "string") {
      if (utf8Bytes(input) > MAX_PACKAGE_BYTES) fail("PACKAGE_TOO_LARGE", "Review package exceeds the 5 MiB limit");
      try { json = JSON.parse(input); }
      catch { fail("INVALID_PACKAGE_JSON", "Review package is not valid JSON"); }
    } else {
      try { json = JSON.stringify(input); }
      catch { fail("INVALID_REVIEW_PACKAGE", "Review package must be JSON-compatible data"); }
      if (typeof json !== "string") fail("INVALID_REVIEW_PACKAGE", "Review package must be JSON-compatible data");
      if (utf8Bytes(json) > MAX_PACKAGE_BYTES) fail("PACKAGE_TOO_LARGE", "Review package exceeds the 5 MiB limit");
      try { json = JSON.parse(json); }
      catch { fail("INVALID_REVIEW_PACKAGE", "Review package must be JSON-compatible data"); }
    }
    if (!isRecord(json)) fail("INVALID_REVIEW_PACKAGE", "Review package must be a JSON object");
    return json;
  }

  function validAudioName(name) {
    return typeof name === "string" && name.length > 0 && name.length <= 255 &&
      name !== "." && name !== ".." && !/[\\/:\u0000-\u001f\u007f]/.test(name) && name.trim() === name;
  }

  function validateAudioMetadata(audio) {
    if (!isRecord(audio) || !validAudioName(audio.name) ||
        !Number.isFinite(audio.durationMs) || audio.durationMs <= 0 ||
        !Number.isSafeInteger(audio.sizeBytes) || audio.sizeBytes <= 0 ||
        typeof audio.sha256 !== "string" || !HASH_RE.test(audio.sha256)) {
      fail("INVALID_AUDIO_METADATA", "Audio metadata must include a safe filename, positive duration and size, and SHA-256 digest");
    }
    if (audio.sizeBytes > MAX_AUDIO_BYTES) fail("AUDIO_TOO_LARGE", "Audio file exceeds the 512 MiB limit");
    if (audio.durationMs > MAX_AUDIO_DURATION_MS) fail("AUDIO_TOO_LONG", "Audio file exceeds the 30 minute limit");
  }

  function validateWaveform(waveform, durationMs) {
    if (!isRecord(waveform) || waveform.sampleRate !== 8000 || waveform.bucketMs !== 100 || !Array.isArray(waveform.peaks)) {
      fail("INVALID_WAVEFORM", "Waveform must use 8 kHz samples and 100 ms buckets");
    }
    const expectedCount = Math.ceil(durationMs / waveform.bucketMs);
    if (waveform.peaks.length !== expectedCount || waveform.peaks.length > MAX_WAVEFORM_BUCKETS ||
        waveform.peaks.some(peak => typeof peak !== "number" || !Number.isFinite(peak) || peak < 0 || peak > 1)) {
      fail("INVALID_WAVEFORM", "Waveform peaks must cover the full audio duration and stay within 0..1");
    }
  }

  function validatePackage(input) {
    const value = parsePackage(input);
    if (value.version !== VERSION || !isRecord(value.score) || !isRecord(value.receipt)) {
      fail("INVALID_REVIEW_PACKAGE", "Review package has an unsupported version or is missing its score or receipt");
    }
    if (!LvScore || typeof LvScore.validateScore !== "function" || typeof LvScore.validateAlignmentReceipt !== "function") {
      fail("SCORE_VALIDATOR_UNAVAILABLE", "LyricVibe score validation is unavailable");
    }
    LvScore.validateScore(value.score);
    LvScore.validateAlignmentReceipt(value.score, value.receipt);
    validateAudioMetadata(value.audio);
    validateWaveform(value.waveform, value.audio.durationMs);

    return {
      version: VERSION,
      score: clone(value.score),
      receipt: clone(value.receipt),
      audio: { ...clone(value.audio), sha256: value.audio.sha256.toLowerCase() },
      waveform: { sampleRate: 8000, bucketMs: 100, peaks: value.waveform.peaks.slice() },
    };
  }

  function validateMediaFile(expectedAudio, actualMeta) {
    validateAudioMetadata(expectedAudio);
    if (!isRecord(actualMeta) || !validAudioName(actualMeta.name) ||
        !Number.isSafeInteger(actualMeta.sizeBytes) || actualMeta.sizeBytes <= 0 ||
        typeof actualMeta.sha256 !== "string" || !HASH_RE.test(actualMeta.sha256) ||
        !Number.isFinite(actualMeta.durationMs) || actualMeta.durationMs <= 0) {
      fail("INVALID_AUDIO_METADATA", "Selected file metadata is incomplete or invalid");
    }
    if (expectedAudio.sha256.toLowerCase() !== actualMeta.sha256.toLowerCase() ||
        expectedAudio.sizeBytes !== actualMeta.sizeBytes ||
        Math.abs(expectedAudio.durationMs - actualMeta.durationMs) > AUDIO_DURATION_TOLERANCE_MS) {
      fail("AUDIO_MISMATCH", "Selected audio does not match the review package");
    }
    return true;
  }

  return {
    VERSION,
    LocalReviewError,
    MAX_PACKAGE_BYTES,
    validatePackage,
    validateMediaFile,
  };
});
