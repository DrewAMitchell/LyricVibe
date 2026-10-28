'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function calendar(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Date must be YYYY-MM-DD.');
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw Error('Invalid calendar date.');
  const [year, month] = date.split('-').map(Number);
  const quarter = Math.ceil(month / 3);
  const start = Date.UTC(year, (quarter - 1) * 3, 1);
  return [year, quarter, Math.floor((time - start) / 86400000 / 14) + 1];
}

function parse(version) {
  if (!/^[1-9]\d{3}\.[1-4]\.[1-7]\.(0|[1-9]\d*)$/.test(version)) throw Error('Expected year.quarter.sprint.build without leading zeros.');
  const values = version.split('.').map(Number);
  if (values.some(n => n > 65535)) throw Error('Chrome version components cannot exceed 65535.');
  return values;
}
const display = version => { parse(version); return version; };
const npmVersion = version => { const [y, q, s, b] = parse(version); return `${y}.${q}.${s}-build.${b}`; };
const compare = (a, b) => { for (let i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };

function nextVersion(date, current, tags = []) {
  const previous = [];
  // The one-time migration from the old release line is explicit.
  if (current !== '0.5.0') previous.push(parse(current));
  const seen = new Set();
  for (const tag of tags) {
    if (!/^v\d{4}\./.test(tag)) continue;
    const canonical = tag.slice(1).split('.').map(Number).join('.');
    if (`v${display(canonical)}` !== tag) throw Error(`Invalid release tag: ${tag}`);
    const values = parse(canonical);
    if (seen.has(values[3])) throw Error('Release tags reuse a global build number.');
    seen.add(values[3]); previous.push(values);
  }
  const value = [...calendar(date), previous.length ? Math.max(...previous.map(v => v[3])) + 1 : 0];
  parse(value.join('.'));
  if (previous.some(v => compare(value, v) <= 0)) throw Error('Release date would move the extension version backwards.');
  return value.join('.');
}

function git(args, root = ROOT) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function assertPublic(root = ROOT) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'release-policy.json')));
  try { git(['merge-base', '--is-ancestor', policy.publicBase, 'HEAD'], root); }
  catch { throw Error('Release requires the filtered public history; this checkout does not descend from the audited public baseline.'); }
  if (git(['status', '--porcelain', '--untracked-files=all'], root)) throw Error('Release requires a clean filtered public checkout. Commit reviewed changes first.');
  return policy;
}
function metadata(root = ROOT) {
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
  const manifest = read('extension/manifest.json'), pkg = read('package.json'), lock = read('package-lock.json');
  parse(manifest.version);
  if (manifest.version_name !== display(manifest.version) || pkg.version !== npmVersion(manifest.version) || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
    throw Error('Manifest, display version and npm lock metadata disagree. Use release:version.');
  }
  return manifest;
}
function mark(state, label, pid) {
  if (process.env.LV_PROBE_LEDGER) fs.appendFileSync(process.env.LV_PROBE_LEDGER, `\n- ${new Date().toISOString()} ${state} LyricVibe release ${label} PID${pid}; finite verification.\n`);
}
function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    mark('START', path.basename(args[0]), child.pid);
    let lineBuffer = '';
    child.stdout.on('data', data => {
      process.stdout.write(data); lineBuffer += data;
      const lines = lineBuffer.split('\n'); lineBuffer = lines.pop();
      for (const line of lines) for (const match of line.matchAll(/"testNodePid":(\d+)/g)) mark('START', 'test child', match[1]);
    });
    child.on('error', reject);
    child.on('close', code => { mark('END', path.basename(args[0]), child.pid); code === 0 ? resolve() : reject(Error(`${args[0]} failed (${code})`)); });
  });
}

async function main(command, args) {
  if (!['version', 'check', 'package'].includes(command) || args.length) throw Error('Usage: node scripts/release.cjs version|check|package');
  const policy = assertPublic();
  if (command === 'version') {
    // Read remote tags without importing or pushing any private local refs.
    const remote = git(['ls-remote', '--tags', policy.repository]);
    const tags = [...new Set(remote.split('\n').map(row => row.split('\t')[1]).filter(ref => ref && !ref.endsWith('^{}')).map(ref => ref.replace('refs/tags/', '')))];
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const manifestPath = path.join(ROOT, 'extension/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const version = nextVersion(date, manifest.version, tags);
    manifest.version = version; manifest.version_name = display(version);
    const pkgPath = path.join(ROOT, 'package.json'), lockPath = path.join(ROOT, 'package-lock.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath)), lock = JSON.parse(fs.readFileSync(lockPath));
    pkg.version = npmVersion(version); lock.version = pkg.version; lock.packages[''].version = pkg.version;
    for (const [file, data] of [[manifestPath, manifest], [pkgPath, pkg], [lockPath, lock]]) fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Prepared ${display(version)} for ${date} (${policy.timeZone}). Review and commit these three files, then run release:package. No tag was created.`);
    return;
  }
  const manifest = metadata();
  if (command === 'check') { console.log(`Release metadata and filtered ancestry verified: ${display(manifest.version)}`); return; }
  const sha = git(['rev-parse', 'HEAD']);
  const tag = `v${display(manifest.version)}`;
  const remoteTags = git(['ls-remote', '--tags', policy.repository]);
  for (const row of remoteTags.split('\n')) {
    const ref = row.split('\t')[1];
    if (!ref || ref.endsWith('^{}') || !/^refs\/tags\/v\d{4}\./.test(ref)) continue;
    const previous = parse(ref.replace('refs/tags/v', ''));
    if (parse(manifest.version)[3] <= previous[3] || compare(parse(manifest.version), previous) <= 0) throw Error('Release must exceed every published build number and version. Prepare a new release version.');
  }
  const output = path.join(ROOT, '.verification', 'releases', tag);
  if (fs.existsSync(output)) throw Error(`Release output already exists: ${output}. Preserve it; use a new version for changed bytes.`);
  fs.mkdirSync(path.join(ROOT, '.verification'), { recursive: true });
  const source = fs.mkdtempSync(path.join(ROOT, '.verification', 'release-source-'));
  // Export exact committed blobs. Ignored/untracked browser state and old dist files cannot enter the build.
  const entries = git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const [header, name] = entry.split('\t');
    if (!/^100(644|755) blob /.test(header) || name.split('/').includes('..') || path.isAbsolute(name)) throw Error(`Unsupported source entry: ${name}`);
    const target = path.join(source, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync('git', ['cat-file', 'blob', header.split(' ')[2]], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
  }
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  await run(process.execPath, ['scripts/test.cjs'], source);
  await run('python', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_release_package.py'], source);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], source);
  await run(process.execPath, ['scripts/build.cjs'], source);
  await run(process.execPath, ['scripts/save-state-proof.cjs'], source);
  await run(process.execPath, ['scripts/overlay-startup-proof.cjs'], source);
  await run('python', ['scripts/package-release.py', source, output, sha], source);
  console.log(`Candidate ${tag} verified and packaged in ${output}. Publish only this commit and its exact artifacts; release publication is a separate step.`);
}

if (require.main === module) {
  mark('START', 'runner', process.pid);
  main(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mark('END', 'runner', process.pid));
}
module.exports = { calendar, parse, display, npmVersion, nextVersion, metadata, assertPublic };
