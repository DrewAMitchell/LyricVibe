const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'lyricvibe');
(async () => {
  // One compiled entry also serves the existing offline review launcher.
  await require('esbuild').build({ entryPoints: [path.join(root, 'extension/workspace/main.tsx')], bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(root, 'extension/workspace/main.bundle.js') });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(root, 'extension'), out, { recursive: true });
  await require('./build-pronunciation.cjs').buildPronunciation(path.join(out, 'data'));
  await require('esbuild').build({ entryPoints: [path.join(root, 'extension/analysis/model-worker.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(out, 'analysis/model-worker.bundle.js') });
  const vendor = path.join(out, 'analysis/vendor');
  fs.mkdirSync(vendor, { recursive: true });
  const runtimeFiles = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
  // Remove obsolete ORT outputs only inside this generated vendor folder.
  for (const file of fs.readdirSync(vendor)) {
    if (/^ort[.-].*\.(wasm|mjs)$/.test(file) && !runtimeFiles.includes(file)) fs.unlinkSync(path.join(vendor, file));
  }
  for (const file of runtimeFiles) fs.copyFileSync(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(vendor, file));
  console.log(`Unpacked extension: ${out}`);
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') {
      const explorer = spawn('explorer.exe', [out], { detached: true, stdio: 'ignore' });
      explorer.on('error', error => { console.error(`Could not open build folder: ${error.message}`); process.exitCode = 1; });
      explorer.unref();
    }
    else console.log('Load this folder through your browser extension developer page.');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
