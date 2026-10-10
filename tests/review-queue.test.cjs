const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/score-core.js');
const queueApi = require('../extension/review-queue.js');

const HASH = 'd'.repeat(64);

function fixture() {
  const score = core.createScore(
    { platform: 'youtube', videoId: 'FIXTURE0001', title: 'Song', artist: 'Artist', durationMs: 10000 },
    '[00:01.00]hello world\n[00:02.40]',
    { provider: 'test', contentHash: HASH },
  );
  const words = score.phrases[0].words;
  const proposals = words.map((word, index) => ({
    wordId: word.id, startMs: word.startMs + 20, endMs: word.endMs,
    accepted: false, evidenceId: `evidence-${index}`,
  }));
  return { score, proposals };
}

function code(run, expected) {
  assert.throws(run, error => error.code === expected);
}

test('creates a revision-bound unselected queue and exports its browser global', () => {
  assert.equal(globalThis.LvReviewQueue, queueApi);
  const { score, proposals } = fixture();
  const queue = queueApi.create(score, proposals);
  assert.equal(queue.expectedRevision, score.revision);
  assert.equal(queue.mediaKey, core.mediaKey(score.source));
  assert.equal(queue.lyricsHash, score.lyrics.contentHash);
  assert.deepEqual(queue.wordIds, proposals.map(proposal => proposal.wordId));
  assert.deepEqual(queue.selectedWordIds, []);
  assert.notEqual(queue.proposals, proposals);
});

test('stages decisions immutably and returns one accepted batch without mutating score timing', () => {
  const { score, proposals } = fixture();
  const originalScore = structuredClone(score);
  const originalQueue = queueApi.create(score, proposals);
  let staged = queueApi.toggle(originalQueue, proposals[0].wordId, true, score);
  staged = queueApi.toggle(staged, proposals[1].wordId, true, score);
  staged = queueApi.toggle(staged, proposals[0].wordId, false, score);
  assert.deepEqual(originalQueue.selectedWordIds, []);
  assert.deepEqual(staged.selectedWordIds, [proposals[1].wordId]);
  const accepted = queueApi.selected(staged, score);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].wordId, proposals[1].wordId);
  assert.equal(accepted[0].accepted, true);
  assert.deepEqual(score, originalScore);
  assert.deepEqual(proposals, originalQueue.proposals);
});

test('rejects stale revision, source, lyrics, and unknown proposal selections', () => {
  const { score, proposals } = fixture();
  const queue = queueApi.create(score, proposals);
  code(() => queueApi.toggle(queue, proposals[0].wordId, true, { ...score, revision: score.revision + 1 }), 'REVISION_CONFLICT');
  const otherSource = structuredClone(score);
  otherSource.source.videoId = 'FIXTURE0003';
  code(() => queueApi.toggle(queue, proposals[0].wordId, true, otherSource), 'SOURCE_MISMATCH');
  const otherLyrics = structuredClone(score);
  otherLyrics.lyrics.contentHash = 'c'.repeat(64);
  code(() => queueApi.toggle(queue, proposals[0].wordId, true, otherLyrics), 'LYRIC_REVISION_MISMATCH');
  code(() => queueApi.toggle(queue, 'unknown-word', true, score), 'UNKNOWN_REVIEW_WORD');
});

test('prevents selecting locked words, locked children, or proposals outside explicit phrase bounds', () => {
  const { score, proposals } = fixture();
  const lockedWord = structuredClone(score);
  lockedWord.phrases[0].words[0].locked = true;
  core.validateScore(lockedWord);
  code(() => queueApi.toggle(queueApi.create(lockedWord, proposals), proposals[0].wordId, true, lockedWord), 'LOCKED');

  const lockedChild = structuredClone(score);
  const word = lockedChild.phrases[0].words[0];
  word.syllables = [{ id: `${word.id}-child`, text: word.text, startMs: word.startMs, endMs: word.endMs, provenance: 'manual', locked: true, effects: [] }];
  core.validateScore(lockedChild);
  code(() => queueApi.toggle(queueApi.create(lockedChild, proposals), proposals[0].wordId, true, lockedChild), 'LOCKED');

  const explicit = structuredClone(score);
  explicit.phrases[0].endEstimated = false;
  const outside = [{ ...proposals[0], startMs: explicit.phrases[0].startMs - 1 }];
  code(() => queueApi.toggle(queueApi.create(explicit, outside), outside[0].wordId, true, explicit), 'INVALID_TIME');
});

test('reports anomaly cues without scores or confidence claims', () => {
  const { score, proposals } = fixture();
  const word = score.phrases[0].words[0];
  const short = queueApi.diagnosticsForProposal(score, { ...proposals[0], startMs: word.startMs, endMs: word.startMs + 59 });
  assert.equal(short.kind, 'anomaly-cues-only');
  assert.ok(short.flags.includes('SHORT_WORD'));
  const long = queueApi.diagnosticsForProposal(score, { ...proposals[0], startMs: word.startMs, endMs: word.startMs + 3001 });
  assert.ok(long.flags.includes('LONG_WORD'));
  assert.ok(long.flags.includes('LARGE_SHIFT'));
  const overlap = queueApi.diagnosticsForProposal(score, { ...proposals[0], startMs: score.phrases[0].startMs, endMs: score.phrases[0].endMs });
  assert.ok(overlap.flags.includes('SAME_LANE_OVERLAP'));
  assert.equal('confidence' in overlap, false);
});
