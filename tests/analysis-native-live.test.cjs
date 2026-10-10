const test = require('node:test');
const assert = require('node:assert/strict');
const scoreCore = require('../extension/score-core.js');
const native = require('../extension/analysis/native-live.js');

function score() {
  const value = scoreCore.createScore({ videoId: 'FIXTURE0001', durationMs: 30000 }, '[00:10]wake me up', { contentHash: 'a'.repeat(64) });
  value.revision = 4;
  return value;
}

test('native windows select whole unlocked lead phrases only and exclude overlapping lanes', () => {
  const value = score();
  value.offsetMs = 250;
  const eligible = native.expectedWordsForWindow(value, 10250, 12000);
  assert.deepEqual(eligible.map(word => word.text), ['wake', 'me', 'up']);
  value.phrases.push({ id: 'backing-1', laneId: 'backing', startMs: 10200, endMs: 10400, endEstimated: false, fadeOutMs: 0, words: [{ id: 'b1', text: 'yeah', startMs: 10200, endMs: 10400, provenance: 'estimated', locked: false, effects: [] }] });
  assert.deepEqual(native.expectedWordsForWindow(value, 10250, 12000), []);
  value.phrases.pop();
  value.phrases[0].words[1].locked = true;
  assert.deepEqual(native.expectedWordsForWindow(value, 10250, 12000), []);
  assert.deepEqual(native.expectedWordsForWindow(value, 11000, 1000), []); // No partial phrase fragments.
});

test('native phrase tokenization accepts punctuation around one word and reports unsafe word identity only', () => {
  const value = score();
  value.phrases[0].words[0].text = '“Wake,”';
  value.phrases[0].words[1].text = "me!";
  assert.deepEqual(native.expectedWordsForWindow(value, 10000, 12000).map(word => word.text), ['Wake', 'me', 'up']);
  value.phrases[0].words[1].text = 'wake-me';
  assert.throws(() => native.expectedWordsForWindow(value, 10000, 12000), error => {
    assert.equal(error.code, 'UNSUPPORTED_LYRICS');
    assert.equal(error.wordId, value.phrases[0].words[1].id);
    assert.equal(error.tokenClass, 'unsupported-or-compound-token');
    assert.equal(error.message.includes('wake-me'), false);
    return true;
  });
});

test('native request is bounded PCM16 mono and result maps local time into score time once', async () => {
  const value = score();
  value.offsetMs = 250;
  const expectedWords = native.expectedWordsForWindow(value, 10250, 12000);
  const request = await native.createRequest({
    requestId: 'req-1', sessionId: 'session-1',
    source: { tabId: 7, mediaKey: scoreCore.mediaKey(value.source), lyricsHash: value.lyrics.contentHash, expectedRevision: value.revision, captureEpoch: 2 },
    audioStartMs: 10250, playbackRate: 1, floatPcm: new Float32Array(16000).fill(0.5), expectedWords,
  });
  assert.equal(request.audio.encoding, 'pcm_s16le');
  assert.equal(request.audio.sampleRateHz, 16000);
  assert.equal(request.audio.channels, 1);
  assert.equal(request.audio.durationMs, 1000);
  assert.equal(request.audio.pcmBase64.length, Math.ceil((16000 * 2) / 3) * 4);
  const response = {
    version: native.VERSION, type: 'result', requestId: request.requestId, sessionId: request.sessionId, source: { ...request.source },
    audio: { audioStartMs: request.audio.audioStartMs, sha256: request.audio.sha256 }, accepted: false,
    alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture-model', modelRevision: 'r1',
    words: [{ wordId: expectedWords[0].wordId, startMs: 100, endMs: 300 }], warnings: [],
    diagnostics: { greedyConsistency: { method: 'same-model-greedy-vs-forced-ctc', calibrated: false, wordCount: 3, greedyWordCount: 5, matchedWordFraction: 0.66, words: [{ wordIndex: 0, forcedFrameCount: 4, greedyTop1FrameFraction: 0.75, meanForcedLogProb: -1.2 }] } },
  };
  const result = native.validateResult(response, request, value);
  assert.deepEqual(result.proposals.map(proposal => [proposal.startMs, proposal.endMs]), [[10100, 10300]]);
  assert.equal(result.proposals[0].accepted, false);
  assert.deepEqual(result.diagnostics.greedyConsistency.words[0], { wordId: expectedWords[0].wordId, forcedFrameCount: 4, greedyTop1FrameFraction: 0.75, meanForcedLogProb: -1.2, calibrated: false });
  assert.equal(result.diagnostics.automaticAdmissionEnabled, false);
  assert.equal(result.diagnostics.audioRetained, false);
});

test('native hello, acknowledgement and result reject protocol/source spoofing', () => {
  const hello = { version: native.VERSION, type: 'hello', hostName: native.HOST_NAME, hostVersion: '1', state: 'ready', modelReady: true, alignmentReady: true, limits: { maxAudioMs: 12000, sampleRateHz: 16000, channels: 1, encoding: 'pcm_s16le', maxPcmBytes: 384000 } };
  assert.equal(native.validateHello(hello).hostVersion, '1');
  const envelope = { version: native.VERSION, requestId: 'req', sessionId: 'session', source: { tabId: 1, mediaKey: 'youtube:id', lyricsHash: 'a'.repeat(64), expectedRevision: 1, captureEpoch: 1 } };
  assert.doesNotThrow(() => native.validateEnvelope(envelope, envelope));
  assert.throws(() => native.validateEnvelope({ ...envelope, source: { ...envelope.source, captureEpoch: 2 } }, envelope), { code: 'NATIVE_RESPONSE_MISMATCH' });
  assert.throws(() => native.validateHello({ ...hello, limits: { ...hello.limits, maxAudioMs: 12001 } }), { code: 'NATIVE_HOST_INCOMPATIBLE' });
});

test('native result reason codes are allowlisted and preserved as diagnostics', () => {
  const value = score();
  const expectedWords = native.expectedWordsForWindow(value, 10000, 12000);
  const request = { version: native.VERSION, requestId: 'req-silent', sessionId: 'session-1', source: { tabId: 1, mediaKey: scoreCore.mediaKey(value.source), lyricsHash: value.lyrics.contentHash, expectedRevision: value.revision, captureEpoch: 1 }, audio: { audioStartMs: 10000, durationMs: 12000, playbackRate: 1, sha256: 'a'.repeat(64) }, expectedWords };
  const response = { version: native.VERSION, type: 'result', requestId: request.requestId, sessionId: request.sessionId, source: { ...request.source }, audio: { audioStartMs: request.audio.audioStartMs, sha256: request.audio.sha256 }, accepted: false, alignmentKind: 'supplied-text-ctc', automaticAdmissionEnabled: false, adapter: 'fixture', model: 'fixture', modelRevision: 'r1', words: [], warnings: [], reasonCode: 'SILENT_AUDIO' };
  const result = native.validateResult(response, request, value);
  assert.equal(result.diagnostics.reasonCode, 'SILENT_AUDIO');
  assert.throws(() => native.validateResult({ ...response, reasonCode: 'FREEFORM_TEXT' }, request, value), { code: 'NATIVE_RESPONSE_INVALID' });
});
