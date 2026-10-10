const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const scoreCore = require('../extension/score-core.js');

const root = path.resolve(__dirname, '..');
const scoreSource = fs.readFileSync(path.join(root, 'extension/score-core.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'extension/score-host.js'), 'utf8');
const HASH = 'a'.repeat(64);
const ID_A = 'FIXTURE0001';
const ID_B = 'FIXTURE0003';

function makeHarness() {
  const values = Object.create(null);
  const tabs = new Map([[1, { url: `https://www.youtube.com/watch?v=${ID_A}`, duration: 10, mediaReady: true, isAd: false }], [2, { url: `https://music.youtube.com/watch?v=${ID_B}`, duration: 20, mediaReady: true, isAd: false }]]);
  const tabMessages = [];
  let listener;
  let analysisStatus = { state: 'capturing', tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1' };
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { return message; },
      getURL(file) { return `chrome-extension://test/${file}`; },
    },
    storage: { local: {
      async get(key) { return { [key]: structuredClone(values[key]) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) values[key] = structuredClone(value); },
    } },
    tabs: {
      async sendMessage(tabId, message) {
        if (message.type === 'LV_GET_HINTS') return { ...tabs.get(tabId) };
        tabMessages.push({ tabId, message: structuredClone(message) });
        return { ok: true };
      },
      async create() { return {}; },
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, URL, AbortSignal, setTimeout, clearTimeout, console,
    LvAnalysis: { async analysisStatus() { return analysisStatus; } },
  });
  vm.runInContext(scoreSource, context, { filename: 'score-core.js' });
  vm.runInContext(hostSource, context, { filename: 'score-host.js' });

  function dispatch(message, sender = { id: chrome.runtime.id, tab: { id: 1 } }) {
    if (message.type === 'LV_ALIGNMENT_PROPOSALS') {
      message = { tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1', ...message };
      if (sender.url === undefined && sender.tab) sender = { ...sender, url: chrome.runtime.getURL('analysis/offscreen.html') };
    }
    if (message.type === 'LV_SCORE_REVIEW_APPLY' && sender.url === undefined) {
      const tabId = message.tabId ?? sender.tab?.id ?? 1;
      const mediaKey = message.mediaKey || `youtube:${ID_A}`;
      message = { tabId, ...message };
      sender = { id: chrome.runtime.id, url: chrome.runtime.getURL(`editor.html?sourceTab=${tabId}&mediaKey=${encodeURIComponent(mediaKey)}`) };
    }
    return new Promise((resolve, reject) => {
      if (!listener) return reject(new Error('score host listener was not registered'));
      const keptOpen = listener(message, sender, resolve);
      if (keptOpen !== true) reject(new Error('score host did not keep its response channel open'));
    });
  }
  async function ensure(tabId = 1, videoId = tabId === 1 ? ID_A : ID_B, overrides = {}) {
    return context.LvScoreHost.ensure(tabId, {
      hints: { videoId },
      lyrics: { synced: '[00:01.00]hello world\n[00:03.00]' , provider: 'test' },
      track: { title: 'Same song', artist: 'Same artist' },
      match: { id: 'entry-1' },
      ...overrides,
    });
  }
  return { context, values, tabs, tabMessages, dispatch, ensure, setAnalysisStatus(value) { analysisStatus = value; } };
}

function recordFor(h, id = ID_A) { return h.values[`lvScore:youtube:${id}`]; }
function firstWord(score) { return score.phrases.flatMap(p => p.words)[0]; }

test('host persists separate exact-video scores even when lookup metadata matches', async () => {
  const h = makeHarness();
  await h.ensure(1, ID_A);
  await h.ensure(2, ID_B);
  assert.ok(recordFor(h, ID_A));
  assert.ok(recordFor(h, ID_B));
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lvScore:')).length, 2);
  assert.equal(recordFor(h, ID_A).score.source.videoId, ID_A);
  assert.equal(recordFor(h, ID_B).score.source.videoId, ID_B);
  assert.equal(recordFor(h, ID_A).score.lyrics.contentHash, recordFor(h, ID_B).score.lyrics.contentHash);
});

test('host rejects an imported score whose exact video differs from the active tab', async () => {
  const h = makeHarness();
  const scoreA = await h.ensure(1, ID_A);
  const scoreB = await h.ensure(2, ID_B);
  const response = await h.dispatch({ type: 'LV_SCORE_IMPORT', tabId: 1, mediaKey: `youtube:${ID_A}`, score: scoreB, expectedRevision: 0 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SOURCE_MISMATCH');
  assert.equal(recordFor(h, ID_A).score?.source?.videoId, scoreA.source.videoId);
  assert.equal(recordFor(h, ID_A).score.revision, 0);
});

test('same-revision concurrent writes serialize so only one commits', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const [one, two] = await Promise.all([
    h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordText', wordId: word.id, text: 'first' }, expectedRevision: 0 }),
    h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordText', wordId: word.id, text: 'second' }, expectedRevision: 0 }),
  ]);
  assert.equal([one, two].filter(x => x.ok).length, 1);
  assert.equal([one, two].filter(x => !x.ok && x.error.code === 'REVISION_CONFLICT').length, 1);
  assert.equal(recordFor(h).score.revision, 1);
  assert.ok(['first', 'second'].includes(firstWord(recordFor(h).score).text));
});

test('manual word locks survive alignment proposals and explicit review', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const timing = { startMs: word.startMs + 100, endMs: word.startMs + 300 };
  const manual = await h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordTiming', wordId: word.id, ...timing }, expectedRevision: 0 });
  assert.equal(manual.ok, true);
  const aligned = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 1,
    diagnostics: { validatedForSinging: true },
    proposals: [{ wordId: word.id, startMs: word.startMs, endMs: word.endMs, accepted: true, evidenceId: 'audio-1', confidence: 0.999 }],
  });
  assert.equal(aligned.ok, true);
  const lockedWord = firstWord(aligned.score);
  assert.equal(lockedWord.locked, true);
  assert.deepEqual([lockedWord.startMs, lockedWord.endMs], [timing.startMs, timing.endMs]);
  const reviewed = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', wordIds: [word.id], expectedRevision: aligned.score.revision });
  assert.equal(reviewed.ok, true);
  assert.deepEqual([firstWord(reviewed.score).startMs, firstWord(reviewed.score).endMs], [timing.startMs, timing.endMs]);
});

test('sender confidence and validation flags cannot enable automatic admission', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const result = await h.dispatch({ type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: score.revision,
    diagnostics: { validatedForSinging: true },
    proposals: [{ wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs + 100, accepted: true, evidenceId: 'untrusted-flag', confidence: 1 }] });
  assert.equal(result.ok, true);
  assert.equal(firstWord(result.score).startMs, word.startMs);
  assert.equal(result.review[0].accepted, false);
  const reviewed = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', wordIds: [word.id], expectedRevision: result.score.revision });
  assert.equal(reviewed.ok, true);
  assert.equal(firstWord(reviewed.score).startMs, word.startMs + 100);
});

test('undo restores prior timing and advances revision monotonically', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const original = [word.startMs, word.endMs];
  const edited = await h.dispatch({ type: 'LV_SCORE_OPERATION', operation: { type: 'setWordTiming', wordId: word.id, startMs: word.startMs + 100, endMs: word.endMs + 100 }, expectedRevision: 0 });
  assert.equal(edited.score.revision, 1);
  const undone = await h.dispatch({ type: 'LV_SCORE_UNDO', expectedRevision: 1 });
  assert.equal(undone.ok, true);
  assert.equal(undone.score.revision, 2);
  assert.deepEqual([firstWord(undone.score).startMs, firstWord(undone.score).endMs], original);
});

test('uncertain proposals are returned for review and do not alter word timing', async () => {
  const h = makeHarness();
  const score = await h.ensure();
  const word = firstWord(score);
  const original = [word.startMs, word.endMs];
  const result = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0,
    diagnostics: { validatedForSinging: false },
    proposals: [{ wordId: word.id, startMs: word.startMs + 200, endMs: word.endMs + 200, accepted: true, evidenceId: 'uncertain-audio', confidence: 0.7 }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual([firstWord(result.score).startMs, firstWord(result.score).endMs], original);
  assert.equal(result.review.length, 1);
  assert.equal(result.review[0].accepted, false);
  assert.equal(recordFor(h).review.length, 1);
});

test('host rejects score requests while an advertisement is active or the media is unready', async () => {
  const h = makeHarness();
  await h.ensure();
  h.tabs.get(1).isAd = true;
  let response = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ADVERTISEMENT_ACTIVE');
  h.tabs.get(1).isAd = false;
  h.tabs.get(1).mediaReady = false;
  response = await h.dispatch({ type: 'LV_SCORE_GET', mediaKey: `youtube:${ID_A}` });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SOURCE_UNREADY');
});

test('cached score refreshes duration while retaining valid source title and artist', async () => {
  const h = makeHarness();
  const initial = await h.ensure();
  h.tabs.get(1).duration = 25;
  const refreshed = await h.ensure(1, ID_A, { track: { title: 'Transient title', artist: 'Transient artist' } });
  assert.equal(refreshed.revision, initial.revision + 1);
  assert.equal(refreshed.source.durationMs, 25000);
  assert.equal(refreshed.source.title, initial.source.title);
  assert.equal(refreshed.source.artist, initial.source.artist);
  assert.equal(recordFor(h).history.length, 1);
});

test('host rejects a same-video import bound to a different lyric hash', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const otherLyrics = '[00:01.00]different text\n[00:03.00]';
  const otherHash = await h.context.LvScoreHost.digest(otherLyrics);
  const wrongRevision = scoreCore.createScore(
    { platform: 'youtube', videoId: ID_A, title: current.source.title, artist: current.source.artist, durationMs: current.source.durationMs },
    otherLyrics,
    { provider: 'test', entryId: 'other', contentHash: otherHash },
  );
  const response = await h.dispatch({ type: 'LV_SCORE_IMPORT', mediaKey: `youtube:${ID_A}`, score: wrongRevision, expectedRevision: 0 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'LYRIC_REVISION_MISMATCH');
  assert.equal(recordFor(h).score.revision, 0);
  assert.equal(recordFor(h).score.lyrics.contentHash, current.lyrics.contentHash);
});

test('review keeps pending proposals from earlier windows and replaces each word with its latest evidence', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const [first, second] = current.phrases[0].words;
  const firstWindow = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0,
    diagnostics: { validatedForSinging: false, window: 1 },
    proposals: [
      { wordId: first.id, startMs: first.startMs + 10, endMs: first.endMs, accepted: false, evidenceId: 'window-1-a', confidence: 0.55 },
      { wordId: second.id, startMs: second.startMs + 10, endMs: second.endMs, accepted: false, evidenceId: 'window-1-b', confidence: 0.4 },
    ],
  });
  assert.equal(firstWindow.ok, true);
  const secondWindow = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 1,
    diagnostics: { validatedForSinging: false, window: 2 },
    proposals: [{ wordId: first.id, startMs: first.startMs + 20, endMs: first.endMs, accepted: false, evidenceId: 'window-2-a', confidence: 0.8 }],
  });
  assert.equal(secondWindow.ok, true);
  assert.equal(secondWindow.review.length, 2);
  assert.deepEqual([...secondWindow.review].map(p => p.wordId).sort(), [first.id, second.id].sort());
  const latestFirst = secondWindow.review.find(p => p.wordId === first.id);
  assert.equal(latestFirst.evidenceId, 'window-2-a');
  assert.equal(latestFirst.confidence, 0.8);
  assert.equal(secondWindow.score.revision, 2);
});

test('host review application preserves a syllable-locked word despite a late proposal', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const word = firstWord(current);
  const segmented = scoreCore.applyOperation(current, { type: 'setWordSyllables', wordId: word.id, syllables: [
    { id: 'host-locked-syllable', text: word.text, startMs: word.startMs, endMs: word.endMs },
  ] }, current.revision);
  const imported = await h.dispatch({ type: 'LV_SCORE_IMPORT', mediaKey: `youtube:${ID_A}`, score: segmented, expectedRevision: 0 });
  assert.equal(imported.ok, true);
  const before = imported.score.phrases[0].words[0];
  const evidence = { wordId: word.id, startMs: 5000, endMs: 5300, accepted: true, evidenceId: 'late-evidence', confidence: 0.7 };
  const reviewed = await h.dispatch({
    type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 1,
    diagnostics: { validatedForSinging: false }, proposals: [evidence],
  });
  assert.equal(reviewed.ok, true);
  const forgedApply = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', tabId: 1, expectedRevision: 2, wordIds: [word.id] }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL('analysis/offscreen.html'),
  });
  assert.equal(forgedApply.ok, false);
  assert.equal(forgedApply.error.code, 'EDITOR_REQUIRED');
  assert.equal(recordFor(h).score.revision, 2);
  const wrongEditor = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', tabId: 1, expectedRevision: 2, wordIds: [word.id] }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL(`editor.html?sourceTab=2&mediaKey=${encodeURIComponent(`youtube:${ID_A}`)}`),
  });
  assert.equal(wrongEditor.ok, false);
  assert.equal(wrongEditor.error.code, 'EDITOR_REQUIRED');
  const applied = await h.dispatch({ type: 'LV_SCORE_REVIEW_APPLY', expectedRevision: 2, wordIds: [word.id] });
  assert.equal(applied.ok, true);
  const after = applied.score.phrases[0].words[0];
  assert.deepEqual([after.startMs, after.endMs], [before.startMs, before.endMs]);
  assert.deepEqual(JSON.parse(JSON.stringify(after.syllables)), JSON.parse(JSON.stringify(before.syllables)));
  assert.equal(applied.review.length, 0);
});

test('proposal ingress requires the exact offscreen page and the active matching session', async () => {
  const h = makeHarness();
  const current = await h.ensure();
  const word = firstWord(current);
  const proposal = { wordId: word.id, startMs: word.startMs, endMs: word.endMs, accepted: false, evidenceId: 'evidence', confidence: 0.5 };
  const base = { type: 'LV_ALIGNMENT_PROPOSALS', expectedRevision: 0, proposals: [proposal] };
  const offscreenUrl = h.context.chrome.runtime.getURL('analysis/offscreen.html');

  let response = await h.dispatch({ ...base, sessionId: 'session-1' }, {
    id: 'test-extension', url: h.context.chrome.runtime.getURL(`editor.html?sourceTab=1&mediaKey=youtube%3A${ID_A}`),
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).review.length, 0);

  response = await h.dispatch({ ...base, sessionId: 'stale-session' }, { id: 'test-extension', url: offscreenUrl });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).score.revision, 0);

  h.setAnalysisStatus({ state: 'stopped', tabId: 1, mediaKey: `youtube:${ID_A}`, sessionId: 'session-1' });
  response = await h.dispatch({ ...base, sessionId: 'session-1' }, { id: 'test-extension', url: offscreenUrl });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ANALYSIS_SOURCE_MISMATCH');
  assert.equal(recordFor(h).review.length, 0);
});
