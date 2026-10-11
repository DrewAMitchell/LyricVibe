const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
(async () => {
  const esbuild = require('esbuild');
  try {
    for (const name of ['controller', 'timeline']) {
      await esbuild.build({ entryPoints: [path.join(root, `extension/workspace/${name}.ts`)], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(root, `.verification/workspace-${name}.cjs`) });
    }
  } finally { esbuild.stop(); }
  const files = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.cjs')).map(file => path.join(root, 'tests', file));
  const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
  console.log(JSON.stringify({ testNodePid: child.pid }));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = typeof code === 'number' ? code : 1; });
})().catch(error => { console.error(error); process.exitCode = 1; });
