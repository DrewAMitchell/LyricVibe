const test = require('node:test');
const assert = require('node:assert/strict');
const scoreCore = require('../extension/score-core.js');
const review = require('../extension/local-review.js');

const HASH = 'a'.repeat(64);
const AUDIO_HASH = 'b'.repeat(64);

function fixture() {
  const score = scoreCore.createScore(
    { platform: 'youtube', videoId: 'FIXTURE0001', title: 'Song', artist: 'Artist', durationMs: 10000 },
    '[00:01.00]hello world\n[00:04.00]',
    { provider: 'test', entryId: 'one', contentHash: HASH },
  );
  const word = score.phrases[0].words[0];
  const receipt = {
    version: 'lyricvibe.alignment.v1', mediaKey: scoreCore.mediaKey(score.source), lyricsHash: HASH,
    expectedRevision: score.revision, timeDomain: 'score-time-before-offset', audioStartMs: 0,
    adapter: 'fixture-adapter', model: 'fixture-model', wordMapping: 'supplied-path-ordinal',
    proposals: [{ wordId: word.id, startMs: word.startMs + 40, endMs: word.endMs + 40, accepted: false, evidenceId: 'fixture-evidence' }],
    automaticAdmissionEnabled: false,
  };
  const audio = { name: 'review-audio.wav', durationMs: 10000, sizeBytes: 160044, sha256: AUDIO_HASH };
  const waveform = { sampleRate: 8000, bucketMs: 100, peaks: Array(100).fill(0.25) };
  return { score, receipt, audio, waveform, package: { version: 'lyricvibe.review.v1', score, receipt, audio, waveform } };
}

function errorCode(run, code) {
  assert.throws(run, error => error.code === code);
}

test('exports a browser global and CommonJS package validation interface', () => {
  assert.equal(globalThis.LvLocalReview, review);
  assert.equal(typeof review.validatePackage, 'function');
  assert.equal(typeof review.validateMediaFile, 'function');
});

test('validates, clones, and preserves receipt metadata for a bounded review package', () => {
  const f = fixture();
  const normalized = review.validatePackage(f.package);
  assert.equal(normalized.version, 'lyricvibe.review.v1');
  assert.deepEqual(normalized.score, f.score);
  assert.notEqual(normalized.score, f.score);
  assert.notEqual(normalized.receipt, f.receipt);
  assert.equal(normalized.receipt.wordMapping, 'supplied-path-ordinal');
  assert.deepEqual(normalized.waveform.peaks, f.waveform.peaks);
  assert.equal(f.receipt.proposals[0].accepted, false);
});

test('accepts JSON text but rejects malformed or over-5-MiB package input before parsing', () => {
  const f = fixture();
  assert.deepEqual(review.validatePackage(JSON.stringify(f.package)), review.validatePackage(f.package));
  errorCode(() => review.validatePackage('{'), 'INVALID_PACKAGE_JSON');
  errorCode(() => review.validatePackage(' '.repeat(5 * 1024 * 1024 + 1)), 'PACKAGE_TOO_LARGE');
});

test('binds package receipt to exact source, lyric hash, revision, and review-only proposals', () => {
  const f = fixture();
  let incoming = structuredClone(f.package);
  incoming.receipt.mediaKey = 'youtube:FIXTURE0003';
  errorCode(() => review.validatePackage(incoming), 'SOURCE_MISMATCH');
  incoming = structuredClone(f.package);
  incoming.receipt.lyricsHash = 'c'.repeat(64);
  errorCode(() => review.validatePackage(incoming), 'LYRIC_REVISION_MISMATCH');
  incoming = structuredClone(f.package);
  incoming.receipt.expectedRevision += 1;
  errorCode(() => review.validatePackage(incoming), 'REVISION_CONFLICT');
  incoming = structuredClone(f.package);
  incoming.receipt.proposals[0].accepted = true;
  errorCode(() => review.validatePackage(incoming), 'INVALID_ALIGNMENT_RECEIPT');
});

test('rejects invalid audio metadata, excessive duration or size, and unsafe stored names', () => {
  const f = fixture();
  for (const [field, value, code] of [
    ['sha256', 'bad', 'INVALID_AUDIO_METADATA'],
    ['sizeBytes', 0, 'INVALID_AUDIO_METADATA'],
    ['sizeBytes', 512 * 1024 * 1024 + 1, 'AUDIO_TOO_LARGE'],
    ['durationMs', 0, 'INVALID_AUDIO_METADATA'],
    ['durationMs', 30 * 60 * 1000 + 1, 'AUDIO_TOO_LONG'],
    ['name', 'C:\\private\\recording.wav', 'INVALID_AUDIO_METADATA'],
  ]) {
    const incoming = structuredClone(f.package);
    incoming.audio[field] = value;
    errorCode(() => review.validatePackage(incoming), code);
  }
});

test('requires 8 kHz 100 ms waveform buckets covering audio with bounded normalized peaks', () => {
  const f = fixture();
  for (const mutate of [
    p => { p.waveform.sampleRate = 16000; },
    p => { p.waveform.bucketMs = 50; },
    p => { p.waveform.peaks.pop(); },
    p => { p.waveform.peaks[0] = 1.01; },
    p => { p.waveform.peaks[0] = NaN; },
    p => { p.waveform.peaks = Array(18001).fill(0); },
  ]) {
    const incoming = structuredClone(f.package);
    mutate(incoming);
    errorCode(() => review.validatePackage(incoming), 'INVALID_WAVEFORM');
  }
});

test('matches selected audio by exact SHA-256 and size while allowing a renamed file and 500 ms duration drift', () => {
  const f = fixture();
  assert.equal(review.validateMediaFile(f.audio, {
    name: 'renamed-copy.wav', sizeBytes: f.audio.sizeBytes, sha256: AUDIO_HASH.toUpperCase(), durationMs: 10099.9,
  }), true);
  errorCode(() => review.validateMediaFile(f.audio, { ...f.audio, sha256: 'c'.repeat(64) }), 'AUDIO_MISMATCH');
  errorCode(() => review.validateMediaFile(f.audio, { ...f.audio, sizeBytes: f.audio.sizeBytes + 1 }), 'AUDIO_MISMATCH');
  errorCode(() => review.validateMediaFile(f.audio, { ...f.audio, durationMs: 10501 }), 'AUDIO_MISMATCH');
  errorCode(() => review.validateMediaFile(f.audio, { ...f.audio, sha256: 'bad' }), 'INVALID_AUDIO_METADATA');
});
