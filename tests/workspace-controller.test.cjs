const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/score-core.js');
const localReview = require('../extension/local-review.js');
const reviewQueue = require('../extension/review-queue.js');
const { createEditorController } = require(process.env.LV_WORKSPACE_CONTROLLER || '../.verification/workspace-controller.cjs');

const LYRICS_HASH = 'a'.repeat(64);
const AUDIO_HASH = 'b'.repeat(64);

function makeScore(videoId = 'FIXTURE0001') {
  return core.createScore(
    { platform: 'youtube', videoId, title: 'Fixture', artist: 'Fixture Artist', durationMs: 10000 },
    '[00:01.00]hello world\n[00:03.00]',
    { provider: 'test', entryId: 'workspace-fixture', contentHash: LYRICS_HASH },
  );
}

function makePackage(score = makeScore()) {
  const word = score.phrases.find(phrase => score.lanes.find(lane => lane.id === phrase.laneId)?.role === 'lead').words[0];
  const receipt = {
    version: 'lyricvibe.alignment.v1',
    mediaKey: core.mediaKey(score.source),
    lyricsHash: score.lyrics.contentHash,
    expectedRevision: score.revision,
    timeDomain: 'score-time-before-offset',
    audioStartMs: 0,
    adapter: 'workspace-fixture',
    model: 'workspace-fixture',
    wordMapping: 'supplied-path-ordinal',
    proposals: [{ wordId: word.id, startMs: word.startMs + 50, endMs: word.endMs, accepted: false, evidenceId: 'workspace-evidence' }],
    automaticAdmissionEnabled: false,
  };
  return {
    version: 'lyricvibe.review.v1', score, receipt,
    audio: { name: 'fixture.wav', durationMs: 10000, sizeBytes: 160044, sha256: AUDIO_HASH },
    waveform: { sampleRate: 8000, bucketMs: 100, peaks: Array(100).fill(0.25) },
  };
}

function controllerOptions(overrides = {}) {
  return { core, localReview, reviewQueue, ...overrides };
}

function envelope(score, fields = {}) {
  return {
    mediaKey: core.mediaKey(score.source),
    lyricsHash: score.lyrics.contentHash,
    expectedRevision: score.revision,
    ...fields,
  };
}

function words(score) {
  return score.phrases.flatMap(phrase => phrase.words.map(word => ({ phrase, word })));
}

function findWord(score, wordId) {
  return words(score).find(item => item.word.id === wordId).word;
}

async function loadedController({ score = makeScore(), ...options } = {}) {
  const controller = createEditorController(controllerOptions(options));
  const result = await controller.loadPackage(makePackage(score));
  assert.equal(result.ok, true, result.error?.message);
  return controller;
}

function captureRuntime({ id = 'lyricvibe-extension', respond = async () => ({ ok: false, error: { code: 'UNHANDLED' } }) } = {}) {
  const listeners = new Set();
  const sent = [];
  return {
    id,
    sent,
    onMessage: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
    },
    async sendMessage(message) { sent.push(structuredClone(message)); return respond(message); },
    emit(message, sender = { id }) { for (const listener of [...listeners]) listener(message, sender); },
    listenerCount() { return listeners.size; },
  };
}

function overrideProperty(target, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
}

async function waitForSignal(signal, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      signal,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms waiting for test signal.`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('rejects source, lyric hash, and revision mismatches before score mutation', async () => {
  const controller = await loadedController();
  const before = controller.getState().score;
  for (const [field, value, code] of [
    ['mediaKey', 'youtube:FIXTURE0003', 'SOURCE_MISMATCH'],
    ['lyricsHash', 'c'.repeat(64), 'LYRIC_REVISION_MISMATCH'],
    ['expectedRevision', before.revision + 1, 'REVISION_CONFLICT'],
  ]) {
    const result = await controller.dispatch({
      type: 'LV_SCORE_OPERATION',
      ...envelope(before, { [field]: value }),
      operation: { type: 'setOffset', offsetMs: 125 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(controller.getState().score, before);
  }
  controller.dispose();
});

test('repeated word and locked-child edits remain manual, protected, undoable, and immutable', async () => {
  const controller = await loadedController();
  const original = controller.getState().score;
  const originalCopy = structuredClone(original);
  const word = words(original)[0].word;
  let state = controller.getState();
  let result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 20, endMs: word.endMs - 20 },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  let currentWord = findWord(state.score, word.id);
  assert.equal(currentWord.locked, true);
  assert.equal(currentWord.provenance, 'manual');
  const firstTiming = [currentWord.startMs, currentWord.endMs];

  result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 40, endMs: word.endMs - 40 },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  currentWord = findWord(state.score, word.id);
  assert.equal(currentWord.locked, true);
  assert.equal(currentWord.provenance, 'manual');
  assert.notDeepEqual([currentWord.startMs, currentWord.endMs], firstTiming);
  result = await controller.dispatch({ type: 'LV_SCORE_UNDO', ...envelope(state.score) });
  assert.equal(result.ok, true);
  state = controller.getState();
  currentWord = findWord(state.score, word.id);
  assert.equal(currentWord.locked, true);
  assert.deepEqual([currentWord.startMs, currentWord.endMs], firstTiming);
  result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 40, endMs: word.endMs - 40 },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  currentWord = findWord(state.score, word.id);

  const childId = `${word.id}-child`;
  result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setWordSyllables', wordId: word.id, syllables: [
      { id: childId, text: word.text, startMs: currentWord.startMs, endMs: currentWord.endMs },
    ] },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  const child = findWord(state.score, word.id).syllables[0];
  const middle = child.startMs + Math.floor((child.endMs - child.startMs) / 2);
  result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setSyllableTiming', syllableId: childId, startMs: child.startMs, endMs: middle },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  const firstChildTiming = [findWord(state.score, word.id).syllables[0].startMs, findWord(state.score, word.id).syllables[0].endMs];
  assert.equal(findWord(state.score, word.id).syllables[0].locked, true);
  assert.equal(findWord(state.score, word.id).syllables[0].provenance, 'manual');
  result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(state.score),
    operation: { type: 'setSyllableTiming', syllableId: childId, startMs: child.startMs + 5, endMs: middle - 5 },
  });
  assert.equal(result.ok, true);
  state = controller.getState();
  const editedChild = findWord(state.score, word.id).syllables[0];
  assert.equal(editedChild.locked, true);
  assert.deepEqual([editedChild.startMs, editedChild.endMs], [child.startMs + 5, middle - 5]);

  result = await controller.dispatch({ type: 'LV_SCORE_UNDO', ...envelope(state.score) });
  assert.equal(result.ok, true);
  state = controller.getState();
  const undoneChild = findWord(state.score, word.id).syllables[0];
  assert.equal(undoneChild.locked, true);
  assert.deepEqual([undoneChild.startMs, undoneChild.endMs], firstChildTiming);

  const events = [];
  const unsubscribe = controller.subscribe(snapshot => events.push(snapshot));
  const current = controller.getState();
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(current.score));
  const beforeSelectionOnly = structuredClone(current.score);
  controller.selectWord(word.id);
  assert.ok(Object.isFrozen(events.at(-1)));
  assert.deepEqual(events.at(-1).score, beforeSelectionOnly);
  const exposed = controller.getState();
  assert.ok(Object.isFrozen(exposed.score.phrases[0].words[0]));
  assert.deepEqual(original, originalCopy);
  unsubscribe();
  controller.dispose();
});

test('selection and navigation update only the projection, not score or history', async () => {
  const controller = await loadedController();
  const before = controller.getState();
  const phrase = before.score.phrases[0];
  const word = phrase.words[1];
  controller.selectPhrase(phrase.id);
  controller.selectWord(word.id);
  const after = controller.getState();
  assert.deepEqual(after.score, before.score);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.selection.phraseId, phrase.id);
  assert.equal(after.selection.wordId, word.id);
  controller.dispose();
});

test('a draft cannot switch to another syllable within the selected word', async () => {
  let score = makeScore();
  const word = score.phrases[0].words[0];
  score = core.applyOperation(score, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'child-a', text: word.text.slice(0, 2), startMs: word.startMs, endMs: word.startMs + Math.floor((word.endMs - word.startMs) / 2) },
    { id: 'child-b', text: word.text.slice(2), startMs: word.startMs + Math.floor((word.endMs - word.startMs) / 2), endMs: word.endMs },
  ] }, score.revision);
  const controller = await loadedController({ score });
  assert.equal(controller.selectWord(word.id, 'child-a'), true);
  controller.setDraft(true);
  assert.equal(controller.selectWord(word.id, 'child-b'), false);
  assert.equal(controller.getState().selection.syllableId, 'child-a');
  assert.equal(controller.getState().draft, true);
  controller.dispose();
});

test('local edits stay unsaved until a matching explicit export acknowledgement', async () => {
  const controller = await loadedController({ mode: 'local-recording' });
  let state = controller.getState();
  const before = state.score;
  const word = words(before)[0].word;
  const changed = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(before),
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 25, endMs: word.endMs - 25 },
  });
  assert.equal(changed.ok, true);
  state = controller.getState();
  assert.equal(state.persistence, 'unsaved');
  const revision = state.score.revision;
  const exported = controller.exportScore();
  assert.equal(exported.revision, revision);
  assert.equal(controller.getState().persistence, 'export-requested');
  assert.equal(controller.acknowledgeExport(revision - 1), false);
  assert.equal(controller.getState().persistence, 'export-requested');
  assert.equal(controller.acknowledgeExport(revision), true);
  assert.equal(controller.getState().persistence, 'saved');
  controller.dispose();
});

test('live operations use the host and remain host-saved rather than local-export dirty', async () => {
  let hostScore = makeScore();
  const runtime = captureRuntime({ respond: async message => {
    if (message.type === 'LV_SCORE_GET') return { ok: true, score: hostScore, review: [], analysis: { state: 'idle' } };
    if (message.type === 'LV_NATIVE_ANALYSIS_START') return { ok: true, analysis: { state: 'running', provider: 'fixture-native', reviewOnly: true } };
    if (message.type === 'LV_SCORE_OPERATION') hostScore = core.applyOperation(hostScore, message.operation, message.expectedRevision);
    if (message.type === 'LV_SCORE_OPERATION' || message.type === 'LV_SCORE_UNDO') return { ok: true, score: hostScore };
    return { ok: false, error: { code: 'UNHANDLED' } };
  } });
  const score = hostScore;
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: core.mediaKey(score.source) }));
  assert.equal((await controller.initialize()).ok, true);
  const before = controller.getState().score;
  const analysis = await controller.dispatch({ type: 'LV_NATIVE_ANALYSIS_START', ...envelope(before) });
  assert.equal(analysis.ok, true);
  assert.deepEqual(controller.getState().score, before);
  assert.equal(controller.getState().history.length, 0);
  const word = words(before)[0].word;
  const result = await controller.dispatch({
    type: 'LV_SCORE_OPERATION', ...envelope(before),
    operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 30, endMs: word.endMs - 30 },
  });
  assert.equal(result.ok, true);
  assert.equal(runtime.sent.at(-1).tabId, 17);
  assert.equal(runtime.sent.at(-1).mediaKey, core.mediaKey(score.source));
  assert.equal(controller.getState().persistence, 'saved');
  controller.dispose();
});

test('review package proposals remain review-only until an explicit apply request', async () => {
  const controller = createEditorController(controllerOptions());
  const packageData = makePackage();
  const before = structuredClone(packageData.score);
  assert.equal((await controller.loadPackage(packageData)).ok, true);
  let state = controller.getState();
  assert.deepEqual(state.score, before);
  assert.equal(state.history.length, 0);
  assert.deepEqual(state.review.map(proposal => proposal.accepted), [false]);
  const wordId = packageData.receipt.proposals[0].wordId;
  const queued = await controller.acceptProposal(wordId, true);
  assert.equal(queued.ok, true);
  assert.deepEqual(queued.queuedWordIds, [wordId]);
  state = controller.getState();
  assert.deepEqual(state.score, before);
  assert.equal(state.score.revision, before.revision);
  const applied = await controller.acceptSelectedProposals();
  assert.equal(applied.ok, true);
  assert.notDeepEqual(controller.getState().score, before);
  controller.dispose();
});

test('live reviewed selections use one host mutation and protected words never reach that mutation', async () => {
  const score = makeScore(), proposal = makePackage(score).receipt.proposals[0];
  let hosted = score;
  const runtime = captureRuntime({ respond: async message => {
    if (message.type === 'LV_SCORE_GET') return { ok: true, score: hosted, review: [proposal] };
    if (message.type === 'LV_SCORE_REVIEW_APPLY') {
      assert.deepEqual(message.wordIds, [proposal.wordId]);
      hosted = core.applyAlignment(hosted, [{ ...proposal, accepted: true }], message.expectedRevision);
      return { ok: true, score: hosted, review: [] };
    }
    throw Error('Unexpected runtime request');
  } });
  const controller = createEditorController(controllerOptions({ mode: 'youtube', runtime, tabId: 17 }));
  assert.equal((await controller.initialize()).ok, true);
  assert.equal((await controller.acceptProposal(proposal.wordId)).ok, true);
  assert.equal(runtime.sent.filter(message => message.type === 'LV_SCORE_REVIEW_APPLY').length, 0);
  assert.equal((await controller.acceptSelectedProposals()).ok, true);
  assert.equal(runtime.sent.filter(message => message.type === 'LV_SCORE_REVIEW_APPLY').length, 1);
  assert.equal(controller.getState().score.revision, score.revision + 1);
  controller.dispose();

  hosted = structuredClone(score);
  hosted.phrases[0].words[0].locked = true;
  const protectedController = createEditorController(controllerOptions({ mode: 'youtube', runtime, tabId: 17 }));
  assert.equal((await protectedController.initialize()).ok, true);
  assert.equal((await protectedController.acceptProposal(proposal.wordId)).ok, false);
  assert.equal(runtime.sent.filter(message => message.type === 'LV_SCORE_REVIEW_APPLY').length, 1);
  assert.equal(protectedController.getState().score.revision, score.revision);
  protectedController.dispose();
});

test('late media hash completion is discarded after source replacement', async () => {
  let finishDigest;
  let digestStarted;
  const started = new Promise(resolve => { digestStarted = resolve; });
  const fakeCrypto = { subtle: { digest: () => { digestStarted(); return new Promise(resolve => { finishDigest = resolve; }); } } };
  const restoreCrypto = overrideProperty(globalThis, 'crypto', fakeCrypto);
  let controller;
  try {
    const audio = {
      currentTime: 0, duration: 10, paused: true, src: '',
      play() {}, pause() {}, load() {}, removeAttribute() {},
      addEventListener() {}, removeEventListener() {},
    };
    controller = createEditorController(controllerOptions({ mode: 'local-recording', audio }));
    assert.equal((await controller.loadPackage(makePackage())).ok, true);
    const file = { name: 'late.wav', size: 160044, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
    const attaching = controller.attachRecording(file);
    await waitForSignal(started);
    await controller.loadPackage(makePackage(makeScore('FIXTURE0003')));
    finishDigest(new Uint8Array(32).buffer);
    const result = await waitForSignal(attaching);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SELECTION_CHANGED');
    assert.equal(controller.getState().packageAudio.sha256, AUDIO_HASH);
    assert.equal(controller.getState().score.source.videoId, 'FIXTURE0003');
  } finally {
    controller?.dispose();
    restoreCrypto();
  }
});

test('late media metadata completion is discarded after package replacement', async () => {
  const digestBytes = Uint8Array.from(AUDIO_HASH.match(/../g).map(pair => Number.parseInt(pair, 16))).buffer;
  const restoreCrypto = overrideProperty(globalThis, 'crypto', { subtle: { digest: async () => digestBytes } });
  const revoked = [];
  const restoreCreateObjectUrl = overrideProperty(URL, 'createObjectURL', () => 'blob:workspace-fixture');
  const restoreRevokeObjectUrl = overrideProperty(URL, 'revokeObjectURL', value => revoked.push(value));
  let controller;
  try {
    const listeners = new Map();
    let srcValue = '';
    let signalSourceAssigned;
    const sourceAssigned = new Promise(resolve => { signalSourceAssigned = resolve; });
    const audio = {
      currentTime: 0, duration: 10, paused: true,
      play: async () => {}, pause() {}, load() {}, removeAttribute(name) { if (name === 'src') srcValue = ''; },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      emit(type) { for (const listener of [...(listeners.get(type) || [])]) listener(new Event(type)); },
    };
    Object.defineProperty(audio, 'src', {
      get: () => srcValue,
      set: value => { srcValue = value; signalSourceAssigned(); },
    });
    controller = createEditorController(controllerOptions({ mode: 'local-recording', audio }));
    assert.equal((await controller.loadPackage(makePackage())).ok, true);
    const file = { name: 'fixture.wav', size: 160044, arrayBuffer: async () => new ArrayBuffer(4) };
    const attaching = controller.attachRecording(file);
    await waitForSignal(sourceAssigned);
    assert.equal(srcValue, 'blob:workspace-fixture');
    assert.equal((await controller.loadPackage(makePackage(makeScore('FIXTURE0003')))).ok, true);
    audio.emit('loadedmetadata');
    const result = await waitForSignal(attaching);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SELECTION_CHANGED');
    assert.equal(controller.getState().score.source.videoId, 'FIXTURE0003');
    assert.deepEqual(revoked, ['blob:workspace-fixture']);
  } finally {
    controller?.dispose();
    restoreCrypto();
    restoreCreateObjectUrl();
    restoreRevokeObjectUrl();
  }
});

test('dispose releases local audio listeners and transport resources', async () => {
  const listeners = new Map();
  const calls = { pause: 0, removeSource: 0, load: 0 };
  const audio = {
    currentTime: 0, duration: 10, paused: true, src: '',
    play: async () => {}, pause() { calls.pause++; }, load() { calls.load++; },
    removeAttribute(name) { if (name === 'src') calls.removeSource++; },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const controller = createEditorController(controllerOptions({ mode: 'local-recording', audio }));
  await controller.initialize();
  assert.ok([...listeners.values()].reduce((sum, set) => sum + set.size, 0) > 0);
  controller.dispose();
  assert.equal([...listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
  assert.ok(calls.pause > 0);
  assert.ok(calls.removeSource > 0);
  assert.ok(calls.load > 0);
});

test('late live initialization response cannot overwrite a newer source score event', async () => {
  const original = makeScore();
  const latest = core.applyOperation(original, { type: 'setOffset', offsetMs: 325 }, original.revision);
  let resolveInitialRead;
  const runtime = captureRuntime({ respond: message => message.type === 'LV_SCORE_GET'
    ? new Promise(resolve => { resolveInitialRead = resolve; })
    : { ok: false, error: { code: 'UNHANDLED' } } });
  const mediaKey = core.mediaKey(original.source);
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: mediaKey }));
  const initializing = controller.initialize();
  assert.equal(runtime.listenerCount(), 1);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score: latest, review: [] }, { id: runtime.id, tab: { id: 17 } });
  resolveInitialRead({ ok: true, score: original, review: [], analysis: { state: 'idle' } });
  const result = await initializing;
  assert.equal(result.ok, true);
  assert.equal(controller.getState().score.revision, latest.revision);
  assert.equal(controller.getState().score.offsetMs, 325);
  controller.dispose();
});

test('same-source score updates with an older revision are ignored', async () => {
  const revision0 = makeScore();
  const revision1 = core.applyOperation(revision0, { type: 'setOffset', offsetMs: 125 }, 0);
  const revision2 = core.applyOperation(revision1, { type: 'setOffset', offsetMs: 250 }, 1);
  const mediaKey = core.mediaKey(revision0.source);
  const runtime = captureRuntime({ respond: async message => message.type === 'LV_SCORE_GET'
    ? { ok: true, score: revision2, review: [], analysis: { state: 'idle' } }
    : { ok: false, error: { code: 'UNHANDLED' } } });
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: mediaKey }));
  assert.equal((await controller.initialize()).ok, true);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score: revision1, review: [] }, { id: runtime.id, tab: { id: 17 } });
  assert.equal(controller.getState().score.revision, revision2.revision);
  assert.equal(controller.getState().score.offsetMs, 250);
  controller.dispose();
});

test('mutation fallback read cannot overwrite a newer live score push', async () => {
  const initial = makeScore();
  const pushed = core.applyOperation(initial, { type: 'setOffset', offsetMs: 425 }, initial.revision);
  const staleRead = core.applyOperation(initial, { type: 'setOffset', offsetMs: 100 }, initial.revision);
  const mediaKey = core.mediaKey(initial.source);
  let getCount = 0;
  let resolveFallbackRead;
  let signalFallbackRead;
  const fallbackStarted = new Promise(resolve => { signalFallbackRead = resolve; });
  const runtime = captureRuntime({ respond: message => {
    if (message.type === 'LV_SCORE_GET') {
      getCount++;
      if (getCount === 1) return { ok: true, score: initial, review: [], analysis: { state: 'idle' } };
      signalFallbackRead();
      return new Promise(resolve => { resolveFallbackRead = resolve; });
    }
    if (message.type === 'LV_SCORE_OPERATION') return { ok: true };
    return { ok: false, error: { code: 'UNHANDLED' } };
  } });
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: mediaKey }));
  assert.equal((await controller.initialize()).ok, true);
  const before = controller.getState().score;
  const operation = { type: 'setOffset', offsetMs: 100 };
  const pendingMutation = controller.dispatch({ type: 'LV_SCORE_OPERATION', ...envelope(before), operation });
  await waitForSignal(fallbackStarted);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score: pushed, review: [] }, { id: runtime.id, tab: { id: 17 } });
  resolveFallbackRead({ ok: true, score: staleRead, review: [], analysis: { state: 'idle' } });
  const result = await waitForSignal(pendingMutation);
  assert.equal(result.ok, true);
  assert.equal(controller.getState().score.revision, pushed.revision);
  assert.equal(controller.getState().score.offsetMs, 425);
  controller.dispose();
});

test('late live receipt and analysis responses cannot overwrite newer review or analysis state', async () => {
  const score = makeScore();
  const packageData = makePackage(score);
  const staleProposal = packageData.receipt.proposals[0];
  const pushedProposal = { ...staleProposal, startMs: staleProposal.startMs + 25, evidenceId: 'newer-source-review' };
  let resolveReceipt;
  let signalReceipt;
  const receiptStarted = new Promise(resolve => { signalReceipt = resolve; });
  let resolveAnalysis;
  let signalAnalysis;
  const analysisStarted = new Promise(resolve => { signalAnalysis = resolve; });
  const runtime = captureRuntime({ respond: message => {
    if (message.type === 'LV_SCORE_GET') return { ok: true, score, review: [], analysis: { state: 'idle' } };
    if (message.type === 'LV_NATIVE_ALIGNMENT_IMPORT') {
      signalReceipt();
      return new Promise(resolve => { resolveReceipt = resolve; });
    }
    if (message.type === 'LV_NATIVE_ANALYSIS_STATUS') {
      signalAnalysis();
      return new Promise(resolve => { resolveAnalysis = resolve; });
    }
    return { ok: false, error: { code: 'UNHANDLED' } };
  } });
  const mediaKey = core.mediaKey(score.source);
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: mediaKey }));
  assert.equal((await controller.initialize()).ok, true);
  const importing = controller.importScore(packageData.receipt);
  await waitForSignal(receiptStarted);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score, review: [pushedProposal] }, { id: runtime.id, tab: { id: 17 } });
  resolveReceipt({ ok: true, review: [staleProposal] });
  const imported = await waitForSignal(importing);
  assert.equal(imported.ok, true);
  assert.deepEqual(controller.getState().review, [pushedProposal]);
  assert.equal(controller.getState().score.revision, score.revision);

  const beforeAnalysis = controller.getState();
  const checking = controller.dispatch({ type: 'LV_NATIVE_ANALYSIS_STATUS', ...envelope(beforeAnalysis.score) });
  await waitForSignal(analysisStarted);
  const newerScore = core.applyOperation(beforeAnalysis.score, { type: 'setOffset', offsetMs: 450 }, beforeAnalysis.score.revision);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score: newerScore, review: [] }, { id: runtime.id, tab: { id: 17 } });
  resolveAnalysis({ ok: true, analysis: { state: 'ready', sourceRevision: score.revision } });
  const status = await waitForSignal(checking);
  assert.equal(status.ok, false);
  assert.equal(status.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(controller.getState().analysis, beforeAnalysis.analysis);
  assert.equal(controller.getState().score.revision, newerScore.revision);
  controller.dispose();
});

test('late local play completion after recording replacement cannot restore old playing clock state', async () => {
  const digestBytes = Uint8Array.from(AUDIO_HASH.match(/../g).map(pair => Number.parseInt(pair, 16))).buffer;
  const restoreCrypto = overrideProperty(globalThis, 'crypto', { subtle: { digest: async () => digestBytes } });
  const restoreCreateObjectUrl = overrideProperty(URL, 'createObjectURL', () => 'blob:pending-play-fixture');
  const restoreRevokeObjectUrl = overrideProperty(URL, 'revokeObjectURL', () => {});
  let controller;
  try {
    const listeners = new Map();
    let resolvePlay;
    let signalPlayStarted;
    const playStarted = new Promise(resolve => { signalPlayStarted = resolve; });
    const audio = {
      currentTime: 0, duration: 10, paused: true, src: '',
      play() { signalPlayStarted(); return new Promise(resolve => { resolvePlay = () => { this.currentTime = 8; this.paused = false; resolve(); }; }); },
      pause() { this.paused = true; },
      load() { for (const listener of [...(listeners.get('loadedmetadata') || [])]) listener(new Event('loadedmetadata')); },
      removeAttribute(name) { if (name === 'src') this.src = ''; },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    };
    controller = createEditorController(controllerOptions({ mode: 'local-recording', audio }));
    assert.equal((await controller.loadPackage(makePackage())).ok, true);
    const file = { name: 'fixture.wav', size: 160044, arrayBuffer: async () => new ArrayBuffer(4) };
    assert.equal((await controller.attachRecording(file)).ok, true);
    const before = controller.getState().score;
    const pendingPlay = controller.dispatch({ type: 'LV_SCORE_TRANSPORT', ...envelope(before), action: 'play' });
    await waitForSignal(playStarted);
    assert.equal(controller.getState().playback.paused, true);
    assert.equal((await controller.loadPackage(makePackage(makeScore('FIXTURE0003')))).ok, true);
    resolvePlay();
    const result = await waitForSignal(pendingPlay);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SELECTION_CHANGED');
    assert.equal(controller.getState().audioReady, false);
    assert.equal(controller.getState().playback.paused, true);
    assert.equal(controller.getState().playback.mediaMs, 0);
  } finally {
    controller?.dispose();
    restoreCrypto();
    restoreCreateObjectUrl();
    restoreRevokeObjectUrl();
  }
});

test('live playback requires extension sender, exact tab, and bound media key; dispose removes the listener', async () => {
  const score = makeScore();
  const mediaKey = core.mediaKey(score.source);
  const runtime = captureRuntime({ respond: async message => message.type === 'LV_SCORE_GET'
    ? { ok: true, score, review: [], analysis: { state: 'idle' } }
    : { ok: false, error: { code: 'UNHANDLED' } } });
  const controller = createEditorController(controllerOptions({ runtime, mode: 'youtube', tabId: 17, requestedMediaKey: mediaKey }));
  assert.equal((await controller.initialize()).ok, true);
  const listenerCount = runtime.listenerCount();
  assert.equal(listenerCount, 1);
  runtime.emit({ type: 'LV_SCORE_UPDATED', tabId: 17, mediaKey, score: { ...score, revision: 99 } }, { id: 'wrong-extension' });
  runtime.emit({ type: 'LV_ANALYSIS_OFFSCREEN_STATE', analysis: { tabId: 17, mediaKey, state: 'wrong' } }, { id: 'wrong-extension' });
  assert.equal(controller.getState().score.revision, score.revision);
  assert.equal(controller.getState().analysis.state, 'idle');
  const message = { type: 'LV_SCORE_PLAYBACK', mediaKey, mediaMs: 2500, paused: true };
  runtime.emit(message, { id: 'wrong-extension', tab: { id: 17 } });
  runtime.emit(message, { id: runtime.id, tab: { id: 18 } });
  runtime.emit({ ...message, mediaKey: 'youtube:FIXTURE0003' }, { id: runtime.id, tab: { id: 17 } });
  assert.equal(controller.getState().clockSeen, false);
  runtime.emit(message, { id: runtime.id, tab: { id: 17 } });
  assert.equal(controller.getState().clockSeen, true);
  assert.equal(controller.getState().playback.mediaMs, 2500);
  controller.dispose();
  assert.equal(runtime.listenerCount(), 0);
});
