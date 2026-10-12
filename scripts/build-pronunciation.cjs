#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'data', 'cmudict.dict.gz');
const LICENSE = path.join(ROOT, 'native', 'data', 'cmudict.LICENSE');
const SOURCE_COMMIT = '74790861f652b15e4ac49015a90074ad62a27690';
const SOURCE_SHA256 = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22';
const GZIP_SHA256 = 'ed91821de146d4cc1bfdfb04c830c60b69c562eb2b62c1d5b2077ac655eb5159';
const VOWEL = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)[012]$/;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildPronunciation(outDir) {
  const gzipBytes = fs.readFileSync(SOURCE);
  if (sha256(gzipBytes) !== GZIP_SHA256) throw new Error('Pinned CMUdict gzip SHA-256 mismatch.');
  const dictionaryBytes = zlib.gunzipSync(gzipBytes);
  if (sha256(dictionaryBytes) !== SOURCE_SHA256) throw new Error('Pinned CMUdict source SHA-256 mismatch.');

  const countSets = new Map();
  for (const line of dictionaryBytes.toString('ascii').split(/\r?\n/)) {
    if (!line || line[0] === ';') continue;
    const [rawWord, ...phones] = line.trim().split(/\s+/);
    if (!rawWord || phones.length === 0) continue;
    const word = rawWord.replace(/\(\d+\)$/, '').toLowerCase();
    const count = phones.reduce((sum, phone) => sum + Number(VOWEL.test(phone)), 0);
    if (count > 0) {
      if (!countSets.has(word)) countSets.set(word, new Set());
      countSets.get(word).add(count);
    }
  }
  const entries = Object.fromEntries([...countSets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([word, counts]) => [word, [...counts].sort((a, b) => a - b)]));
  const result = {
    metadata: {
      source: 'CMU Pronouncing Dictionary',
      commit: SOURCE_COMMIT,
      sha256: SOURCE_SHA256,
      gzipSha256: GZIP_SHA256,
      language: 'en',
      license: 'Carnegie Mellon University two-clause BSD license; see pronunciation-LICENSE.txt',
      countBasis: 'number of stress-marked vowel phones per pronunciation; sorted unique counts across variants',
    },
    entries,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pronunciation-counts.json'), `${JSON.stringify(result)}\n`);
  fs.copyFileSync(LICENSE, path.join(outDir, 'pronunciation-LICENSE.txt'));
  return result;
}

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'lyricvibe', 'data'));
  buildPronunciation(outDir);
  process.stdout.write(`Wrote pronunciation counts to ${outDir}\n`);
}

module.exports = { buildPronunciation, SOURCE_COMMIT, SOURCE_SHA256, GZIP_SHA256 };
