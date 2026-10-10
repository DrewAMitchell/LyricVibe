#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const core = require("../extension/score-core.js");

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_UNITS = 5000;
const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: "Guide preview input is invalid.",
  INVALID_SCORE: "The supplied score is invalid.",
  REVISION_CONFLICT: "The supplied score revision changed.",
  INVALID_GUIDE_UNIT: "A guide interval does not identify an existing score unit.",
  INVALID_TIME: "Guide intervals must be positive integer milliseconds.",
  DUPLICATE_UNIT: "Guide intervals contain a duplicate score unit.",
  REORDERED_UNITS: "Guide intervals must follow the existing score order.",
  OVERLAPPING_UNITS: "Guide intervals must not overlap.",
  OVERLAPPING_SCORE_UNITS: "A guide interval conflicts with an adjacent score interval.",
  LOCKED: "A protected word or syllable cannot be changed.",
  MIXED_GRANULARITY: "Use either word intervals or existing syllable intervals for each word.",
  GUIDE_OUTSIDE_PHRASE: "The guide interval falls outside its current phrase boundary.",
  INVALID_JSON: "Input must be valid JSON.",
  INPUT_TOO_LARGE: "Input exceeds the 10 MiB limit.",
  OUTPUT_TOO_LARGE: "Preview exceeds the 10 MiB limit.",
  PREVIEW_FAILED: "Guide preview could not be created.",
});

class GuideScorePreviewError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.PREVIEW_FAILED);
    this.name = "GuideScorePreviewError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "PREVIEW_FAILED";
  }
}

function reject(code) { throw new GuideScorePreviewError(code); }

function previewGuideUnits(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) reject("INVALID_INPUT");
  if (Object.keys(input).some(key => !["score", "expectedRevision", "units", "humanConfirmed"].includes(key))) reject("INVALID_INPUT");
  const { score, expectedRevision, units, humanConfirmed } = input;
  try { core.validateScore(score); }
  catch (error) { reject(error && error.code === "INVALID_SCORE" ? "INVALID_SCORE" : "INVALID_SCORE"); }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== score.revision) reject("REVISION_CONFLICT");
  if (typeof humanConfirmed !== "boolean" || !Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) reject("INVALID_INPUT");

  const wordsById = new Map();
  const syllablesById = new Map();
  const positions = new Map();
  let position = 0;
  score.phrases.forEach((phrase, phraseIndex) => phrase.words.forEach((word, wordIndex) => {
    wordsById.set(word.id, { phrase, phraseIndex, word, wordIndex });
    positions.set(`word\0${word.id}`, position++);
    for (const syllable of word.syllables || []) {
      syllablesById.set(syllable.id, { phrase, phraseIndex, word, wordIndex, syllable });
      positions.set(`syllable\0${syllable.id}`, position++);
    }
  }));

  const seen = new Set();
  const wordKinds = new Map();
  const resolved = [];
  let priorPosition = -1;
  let priorEndMs = -1;
  for (const unit of units) {
    if (!unit || typeof unit !== "object" || Array.isArray(unit)
      || Object.keys(unit).some(key => !["wordId", "syllableId", "startMs", "endMs"].includes(key))
      || typeof unit.wordId !== "string" || !unit.wordId
      || !(unit.syllableId === null || (typeof unit.syllableId === "string" && unit.syllableId))) reject("INVALID_GUIDE_UNIT");
    if (!Number.isSafeInteger(unit.startMs) || !Number.isSafeInteger(unit.endMs) || unit.startMs < 0 || unit.endMs <= unit.startMs) reject("INVALID_TIME");
    const isSyllable = unit.syllableId !== null;
    const target = isSyllable ? syllablesById.get(unit.syllableId) : wordsById.get(unit.wordId);
    if (!target || target.word.id !== unit.wordId) reject("INVALID_GUIDE_UNIT");
    const key = `${isSyllable ? "syllable" : "word"}\0${isSyllable ? unit.syllableId : unit.wordId}`;
    if (seen.has(key)) reject("DUPLICATE_UNIT");
    seen.add(key);
    const priorKind = wordKinds.get(unit.wordId);
    const thisKind = isSyllable ? "syllable" : "word";
    if (priorKind && priorKind !== thisKind) reject("MIXED_GRANULARITY");
    wordKinds.set(unit.wordId, thisKind);
    const order = positions.get(`${thisKind}\0${isSyllable ? unit.syllableId : unit.wordId}`);
    if (order <= priorPosition) reject("REORDERED_UNITS");
    if (unit.startMs < priorEndMs) reject("OVERLAPPING_UNITS");
    priorPosition = order;
    priorEndMs = unit.endMs;
    if (unit.startMs < target.phrase.startMs || unit.endMs > target.phrase.endMs) reject("GUIDE_OUTSIDE_PHRASE");
    if (score.source.durationMs > 0 && unit.endMs + score.offsetMs > score.source.durationMs + 1000) reject("INVALID_TIME");
    if (!isSyllable) {
      if (target.word.locked || (target.word.syllables || []).some(item => item.locked || item.provenance !== "estimated")) reject("LOCKED");
    } else if (target.word.locked || target.syllable.locked) {
      reject("LOCKED");
    }
    resolved.push({ unit, target, isSyllable, key });
  }

  const operations = resolved.map(({ unit, isSyllable }) => isSyllable
    ? { type: "setSyllableTiming", syllableId: unit.syllableId, startMs: unit.startMs, endMs: unit.endMs }
    : { type: "setWordTiming", wordId: unit.wordId, startMs: unit.startMs, endMs: unit.endMs });
  let previewScore = JSON.parse(JSON.stringify(score));
  const revisionedOperations = [];
  try {
    for (const operation of operations) {
      const operationRevision = previewScore.revision;
      previewScore = core.applyOperation(previewScore, operation, operationRevision);
      revisionedOperations.push({ expectedRevision: operationRevision, operation });
    }
  } catch (error) {
    if (error && error.code === "LOCKED") reject("LOCKED");
    if (error && error.code === "UNKNOWN_ID") reject("INVALID_GUIDE_UNIT");
    if (error && error.code === "INVALID_TIME") reject("INVALID_TIME");
    reject("PREVIEW_FAILED");
  }

  const changedWords = new Set(resolved.filter(item => !item.isSyllable).map(item => item.target.word.id));
  const changedPhrases = new Set(resolved.map(item => item.target.phrase.id));
  for (const phrase of previewScore.phrases) {
    if (!changedPhrases.has(phrase.id)) continue;
    for (let index = 1; index < phrase.words.length; index++) {
      const left = phrase.words[index - 1], right = phrase.words[index];
      if ((changedWords.has(left.id) || changedWords.has(right.id)) && left.endMs > right.startMs) reject("OVERLAPPING_SCORE_UNITS");
    }
  }
  const changedSyllablesByWord = new Map();
  for (const item of resolved) if (item.isSyllable) {
    const ids = changedSyllablesByWord.get(item.target.word.id) || new Set();
    ids.add(item.unit.syllableId);
    changedSyllablesByWord.set(item.target.word.id, ids);
  }
  for (const phrase of previewScore.phrases) for (const word of phrase.words) {
    const changedIds = changedSyllablesByWord.get(word.id);
    if (!changedIds) continue;
    const syllables = word.syllables || [];
    for (let index = 1; index < syllables.length; index++) {
      const left = syllables[index - 1], right = syllables[index];
      if ((changedIds.has(left.id) || changedIds.has(right.id)) && left.endMs > right.startMs) reject("OVERLAPPING_SCORE_UNITS");
    }
  }

  return {
    ok: true,
    previewScore,
    operations: humanConfirmed ? revisionedOperations : [],
    initialRevision: score.revision,
    finalRevision: previewScore.revision,
    humanConfirmed,
    proposalExported: humanConfirmed,
    calibration: false,
    calibrated: false,
    automaticAdmissionEnabled: false,
    scoreMutation: false,
  };
}

async function readInput(stream, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) reject("INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function runCli() {
  let output;
  try {
    const raw = await readInput(process.stdin, MAX_INPUT_BYTES);
    let input;
    try { input = JSON.parse(raw); }
    catch { reject("INVALID_JSON"); }
    output = previewGuideUnits(input);
    const serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) reject("OUTPUT_TOO_LARGE");
    process.stdout.write(`${serialized}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof GuideScorePreviewError ? error.code : "PREVIEW_FAILED";
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.PREVIEW_FAILED } })}\n`);
    return 1;
  }
}

if (require.main === module) runCli().then(code => { process.exitCode = code; });

module.exports = { GuideScorePreviewError, MAX_INPUT_BYTES, MAX_UNITS, previewGuideUnits };
