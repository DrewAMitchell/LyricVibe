#!/usr/bin/env node
"use strict";

const core = require("../extension/score-core.js");

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MESSAGES = Object.freeze({
  INVALID_INPUT: "Timeline bridge input is invalid.",
  INVALID_JSON: "Timeline bridge input must be valid JSON.",
  INPUT_TOO_LARGE: "Timeline bridge input exceeds 10 MiB.",
  OUTPUT_TOO_LARGE: "Timeline score exceeds 10 MiB.",
  INVALID_SCORE: "Score validation failed.",
  REVISION_CONFLICT: "Score revision changed; reload before editing.",
  INVALID_OPERATION: "The requested score operation is invalid.",
  INVALID_TIME: "Timing values do not fit the score interval.",
  INVALID_SYLLABLES: "Syllable text or timing does not match the word.",
  UNKNOWN_ID: "The target score item no longer exists.",
  LOCKED: "The target score item is locked.",
  BRIDGE_FAILED: "The shared score operation failed.",
});

function fail(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.BRIDGE_FAILED);
  error.code = Object.hasOwn(MESSAGES, code) ? code : "BRIDGE_FAILED";
  throw error;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { fail("INVALID_JSON"); }
}

function handle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_INPUT");
  if (input.action === "validate" && Object.keys(input).every(key => ["action", "score"].includes(key))) {
    try { core.validateScore(input.score); }
    catch (error) { fail(error && error.code); }
    return { ok: true, score: input.score };
  }
  if (input.action === "apply" && Object.keys(input).every(key => ["action", "score", "operation", "expectedRevision"].includes(key))) {
    try { return { ok: true, score: core.applyOperation(input.score, input.operation, input.expectedRevision) }; }
    catch (error) { fail(error && error.code); }
  }
  fail("INVALID_INPUT");
}

async function main() {
  try {
    const result = handle(await readInput());
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE");
    process.stdout.write(`${encoded}\n`);
    return 0;
  } catch (error) {
    const code = error && Object.hasOwn(MESSAGES, error.code) ? error.code : "BRIDGE_FAILED";
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: MESSAGES[code] } })}\n`);
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, handle };
