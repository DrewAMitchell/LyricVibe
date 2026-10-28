const test = require('node:test');
const assert = require('node:assert/strict');
const { calendar, nextVersion, display, npmVersion, parse, metadata, assertPublic } = require('../scripts/release.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

test('calendar sprints restart each quarter and use calendar days through leap years and DST', () => {
  assert.deepEqual(calendar('2026-10-14'), [2026, 4, 1]);
  assert.deepEqual(calendar('2026-10-15'), [2026, 4, 2]);
  assert.deepEqual(calendar('2026-10-28'), [2026, 4, 2]);
  assert.deepEqual(calendar('2026-10-29'), [2026, 4, 3]);
  assert.deepEqual(calendar('2026-12-31'), [2026, 4, 7]);
  assert.deepEqual(calendar('2027-01-01'), [2027, 1, 1]);
  assert.deepEqual(calendar('2024-02-29'), [2024, 1, 5]);
  assert.throws(() => calendar('2026-02-29'), /Invalid/);
});

test('release counters start at zero, never reset and reject rollback, collisions or exhaustion', () => {
  assert.equal(nextVersion('2026-10-28', '0.5.0'), '2026.4.2.0');
  assert.equal(nextVersion('2026-10-28', '2026.4.2.0'), '2026.4.2.1');
  assert.equal(nextVersion('2027-01-01', '2026.4.7.8', ['v2026.4.7.10']), '2027.1.1.11');
  assert.throws(() => nextVersion('2026-10-14', '2026.4.2.0'), /backwards/);
  assert.throws(() => nextVersion('2027-01-01', '2026.4.7.65535'), /65535/);
  assert.throws(() => nextVersion('2027-01-01', '0.5.0', ['v2026.3.1.2', 'v2026.4.1.2']), /reuse/);
});

test('Chrome version, display and npm SemVer preserve one release identity', () => {
  assert.equal(display('2026.4.2.0'), '2026.4.2.0');
  assert.equal(npmVersion('2026.4.2.0'), '2026.4.2-build.0');
  for (const bad of ['2026.04.2.0', '2026.5.2.0', '2026.4.8.0', '2026.4.2.-1', '2026.4.2.65536']) assert.throws(() => parse(bad));
});

test('release rejects dirty checkouts, unapproved ancestry and inconsistent version metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricvibe-release-test-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  try {
    git(['init', '-q']); git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Public baseline']);
    const base = git(['rev-parse', 'HEAD']);
    write('release-policy.json', { publicBase: base });
    assert.throws(() => assertPublic(root), /clean filtered/);
    git(['add', 'release-policy.json']); git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Policy']);
    assert.equal(assertPublic(root).publicBase, base);
    write('release-policy.json', { publicBase: '0'.repeat(40) });
    assert.throws(() => assertPublic(root), /filtered public history/);
    fs.mkdirSync(path.join(root, 'extension'));
    write('extension/manifest.json', { version: '2026.4.2.0', version_name: '2026.4.2.0' });
    write('package.json', { version: '2026.4.2-build.0' });
    write('package-lock.json', { version: '2026.4.2-build.0', packages: { '': { version: '2026.4.2-build.0' } } });
    assert.equal(metadata(root).version, '2026.4.2.0');
    write('package.json', { version: '2026.4.2-build.1' });
    assert.throws(() => metadata(root), /disagree/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
