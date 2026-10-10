const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const root = path.resolve(__dirname, '..');
const scoreSource = fs.readFileSync(path.join(root, 'extension/score-core.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'extension/score-host.js'), 'utf8');
const HASH = 'a'.repeat(64);
const ID_A = 'FIXTURE0001';
const ID_B = 'FIXTURE0003';

function makeHarness() {
  const values = Object.create(null);
  const tabs = new Map([[1, { url: `https://www.youtube.com/watch?v=${ID_A}`, duration: 10 }], [2, { url: `https://music.youtube.com/watch?v=${ID_B}`, duration: 20 }]]);
  const tabMessages = [];
  let listener;
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
        if (message.type === 'LV_GET_HINTS') return { url: tabs.get(tabId)?.url, duration: tabs.get(tabId)?.duration };
        tabMessages.push({ tabId, message: structuredClone(message) });
        return { ok: true };
      },
      async create() { return {}; },
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, URL, AbortSignal, setTimeout, clearTimeout, console });
  vm.runInContext(scoreSource, context, { filename: 'score-core.js' });
  vm.runInContext(hostSource, context, { filename: 'score-host.js' });

  function dispatch(message, sender = { id: chrome.runtime.id, tab: { id: 1 } }) {
    return new Promise((resolve, reject) => {
      if (!listener) return reject(new Error('score host listener was not registered'));
      const keptOpen = listener(message, sender, resolve);
      if (keptOpen !== true) reject(new Error('score host did not keep its response channel open'));
    });
  }
  async function ensure(tabId = 1, videoId = tabId === 1 ? ID_A : ID_B) {
    return context.LvScoreHost.ensure(tabId, {
      hints: { videoId },
      lyrics: { synced: '[00:01.00]hello world\n[00:03.00]' , provider: 'test' },
      track: { title: 'Same song', artist: 'Same artist' },
      match: { id: 'entry-1' },
    });
  }
  return { context, values, tabs, tabMessages, dispatch, ensure };
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

test('manual word locks survive admitted alignment proposals', async () => {
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
