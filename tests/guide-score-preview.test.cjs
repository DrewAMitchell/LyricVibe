"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const core = require("../extension/score-core.js");
const { MAX_INPUT_BYTES, previewGuideUnits } = require("../scripts/guide-score-preview.cjs");

function makeScore() {
  return core.createScore(
    { videoId: "FIXTURE0004", durationMs: 10_000, title: "Fixture", artist: "Fixture" },
    "[00:01.00]hello world\n[00:04.00]",
    { contentHash: "a".repeat(64), provider: "fixture" },
  );
}

function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function withSyllables(score) {
  const word = score.phrases[0].words[0];
  const split = word.startMs + Math.floor((word.endMs - word.startMs) / 2);
  return core.applyOperation(score, {
    type: "setWordSyllables", wordId: word.id,
    syllables: [
      { id: "guide-syllable-a", text: word.text.slice(0, 2), startMs: word.startMs, endMs: split, provenance: "estimated", locked: false },
      { id: "guide-syllable-b", text: word.text.slice(2), startMs: split, endMs: word.endMs, provenance: "estimated", locked: false },
    ],
  }, score.revision);
}

test("preview applies validated word timings to a clone; confirmation alone exports revisioned operations", () => {
  const score = makeScore();
  const before = structuredClone(score);
  const word = score.phrases[0].words[0];
  const input = { score, expectedRevision: 0, units: [{ wordId: word.id, syllableId: null, startMs: 1050, endMs: 1500 }], humanConfirmed: false };
  const preview = previewGuideUnits(input);

  assert.deepEqual(score, before);
  assert.equal(preview.ok, true);
  assert.equal(preview.previewScore.revision, 1);
  assert.deepEqual([preview.previewScore.phrases[0].words[0].startMs, preview.previewScore.phrases[0].words[0].endMs], [1050, 1500]);
  assert.equal(preview.previewScore.phrases[0].words[0].provenance, "manual");
  assert.equal(preview.previewScore.phrases[0].words[0].locked, true);
  assert.deepEqual(preview.operations, []);
  assert.equal(preview.humanConfirmed, false);
  assert.equal(preview.proposalExported, false);
  assert.equal(preview.scoreMutation, false);
  assert.equal(preview.calibrated, false);
  assert.equal(preview.automaticAdmissionEnabled, false);

  const confirmed = previewGuideUnits({ ...input, humanConfirmed: true });
  assert.equal(confirmed.proposalExported, true);
  assert.equal(confirmed.operations.length, 1);
  assert.equal(confirmed.operations[0].expectedRevision, 0);
  const applied = core.applyOperation(score, confirmed.operations[0].operation, confirmed.operations[0].expectedRevision);
  assert.deepEqual(applied, confirmed.previewScore);
  assert.deepEqual(score, before);
});

test("preview changes only existing unlocked syllables and does not invent a segmentation", () => {
  const score = withSyllables(makeScore());
  const word = score.phrases[0].words[0];
  const child = word.syllables[0];
  const preview = previewGuideUnits({
    score, expectedRevision: score.revision,
    units: [{ wordId: word.id, syllableId: child.id, startMs: child.startMs + 5, endMs: child.endMs - 5 }],
    humanConfirmed: true,
  });
  const resultWord = preview.previewScore.phrases[0].words[0];
  assert.equal(resultWord.syllables.length, 2);
  assert.deepEqual([resultWord.syllables[0].startMs, resultWord.syllables[0].endMs], [child.startMs + 5, child.endMs - 5]);
  assert.equal(resultWord.syllables[0].locked, true);
  assert.equal(preview.operations[0].operation.type, "setSyllableTiming");
  assert.deepEqual(score.phrases[0].words[0].syllables[0], child);

  const second = word.syllables[1];
  expectCode(() => previewGuideUnits({
    score, expectedRevision: score.revision,
    units: [{ wordId: word.id, syllableId: child.id, startMs: child.startMs, endMs: second.startMs + 1 }],
    humanConfirmed: false,
  }), "OVERLAPPING_SCORE_UNITS");
});

test("preview rejects stale revisions, unknown/mismatched IDs, duplicates, mixed granularity, and reordered units", () => {
  const score = makeScore();
  const [first, second] = score.phrases[0].words;
  const unit = { wordId: first.id, syllableId: null, startMs: 1050, endMs: 1400 };
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [unit], humanConfirmed: false, lyrics: "ignored" }), "INVALID_INPUT");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 1, units: [unit], humanConfirmed: false }), "REVISION_CONFLICT");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [{ ...unit, wordId: "missing" }], humanConfirmed: false }), "INVALID_GUIDE_UNIT");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [unit, unit], humanConfirmed: false }), "DUPLICATE_UNIT");
  const withChildren = withSyllables(score);
  const childId = withChildren.phrases[0].words[0].syllables[0].id;
  expectCode(() => previewGuideUnits({ score: withChildren, expectedRevision: 1, units: [
    { ...unit, startMs: 1050, endMs: 1250 }, { wordId: first.id, syllableId: childId, startMs: 1050, endMs: 1250 },
  ], humanConfirmed: false }), "MIXED_GRANULARITY");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [
    { wordId: second.id, syllableId: null, startMs: 1800, endMs: 2200 },
    { wordId: first.id, syllableId: null, startMs: 1050, endMs: 1400 },
  ], humanConfirmed: false }), "REORDERED_UNITS");
});

test("preview rejects invalid, overlapping, outside-phrase, and locked intervals without changing source", () => {
  const score = makeScore();
  const [first, second] = score.phrases[0].words;
  const before = structuredClone(score);
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [
    { wordId: first.id, syllableId: null, startMs: 1200, endMs: 1900 },
  ], humanConfirmed: false }), "OVERLAPPING_SCORE_UNITS");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [
    { wordId: first.id, syllableId: null, startMs: 1400, endMs: 1200 },
  ], humanConfirmed: false }), "INVALID_TIME");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [
    { wordId: first.id, syllableId: null, startMs: 1050, endMs: 2600 },
  ], humanConfirmed: false }), "GUIDE_OUTSIDE_PHRASE");
  expectCode(() => previewGuideUnits({ score, expectedRevision: 0, units: [
    { wordId: first.id, syllableId: null, startMs: 1050, endMs: 1300 },
    { wordId: second.id, syllableId: null, startMs: 1250, endMs: 1800 },
  ], humanConfirmed: false }), "OVERLAPPING_UNITS");
  const locked = core.applyOperation(score, { type: "setWordLock", wordId: first.id, locked: true }, 0);
  expectCode(() => previewGuideUnits({ score: locked, expectedRevision: 1, units: [
    { wordId: first.id, syllableId: null, startMs: 1050, endMs: 1300 },
  ], humanConfirmed: true }), "LOCKED");
  const protectedChildren = core.applyOperation(score, { type: "setWordSyllables", wordId: first.id, syllables: [
    { id: "locked-child", text: first.text, startMs: first.startMs, endMs: first.endMs },
  ] }, 0);
  expectCode(() => previewGuideUnits({ score: protectedChildren, expectedRevision: 1, units: [
    { wordId: first.id, syllableId: null, startMs: 1050, endMs: 1300 },
  ], humanConfirmed: false }), "LOCKED");
  expectCode(() => previewGuideUnits({ score: protectedChildren, expectedRevision: 1, units: [
    { wordId: first.id, syllableId: "locked-child", startMs: 1050, endMs: 1300 },
  ], humanConfirmed: false }), "LOCKED");
  assert.deepEqual(score, before);
});

test("CLI accepts bounded JSON and emits content-free errors", () => {
  const script = path.join(__dirname, "..", "scripts", "guide-score-preview.cjs");
  const score = makeScore();
  const word = score.phrases[0].words[0];
  const input = JSON.stringify({ score, expectedRevision: 0, units: [{ wordId: word.id, syllableId: null, startMs: 1050, endMs: 1400 }], humanConfirmed: false });
  const result = spawnSync(process.execPath, [script], { input, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).scoreMutation, false);

  const bad = spawnSync(process.execPath, [script], { input: JSON.stringify({ score, expectedRevision: 0, units: [{ wordId: "secret-id", syllableId: null, startMs: 1050, endMs: 1400 }], humanConfirmed: false }), encoding: "utf8", timeout: 10_000 });
  assert.equal(bad.status, 1);
  const error = JSON.parse(bad.stdout);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "INVALID_GUIDE_UNIT");
  assert.equal(error.error.message.includes("secret-id"), false);

  const oversized = spawnSync(process.execPath, [script], { input: Buffer.alloc(MAX_INPUT_BYTES + 1), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stdout).error.code, "INPUT_TOO_LARGE");
});
