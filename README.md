# LyricVibe â€” editable video lyrics

A development fork of [riteshzz29/LyricVibe](https://github.com/riteshzz29/LyricVibe), licensed under MIT. It adds exact-video timing, separate vocal tracks, word and syllable recording, lyric editing, visual effects, and a local song library.

## Install from source

1. Install Node.js 20 or later and Google Chrome (Chromium integration tests use Chrome).
2. Run `npm ci` followed by `npm run build`.
3. Open `chrome://extensions`, enable **Developer mode**, then **Load unpacked** and select `dist/lyricvibe`.
4. Open a YouTube video and click the extension icon (or press Ctrl+Shift+L). The editing and exact-video score workflow targets YouTube.

The VS Code **Build extension and open output** launch target runs the same build and opens its output folder on Windows. After updating source, build again and reload the extension. Save your current work before reloading.

## Record and edit

Open **Edit timing**, set a baseline BPM, and choose phrase, word, or syllable capture. Lyrics can be pasted or fetched through the configured providers. Lead and backing tracks have independent timings. Stop recording to apply lyric corrections. Completed marks are incorporated before those corrections.

Changes remain in a local preview until **Save timings**. Save is disabled when the preview matches the saved score and enables again after a change. Completing the last recorded word or phrase does not silently save: unsaved work still triggers a navigation warning. Choose Cancel to stay and save. The library lists saved songs and valid previews with timing completeness, search, sorting, and filters.

Display controls include typography, animation, word effects, emoji maps, stage layout, backing placement, and instrumental-gap behavior. Audio/model timing suggestions are experimental and require review; completeness measures authored timing coverage, not acoustic accuracy.

## Data and privacy

This repository distributes source code and short test fixtures. It contains no song lyric collection, recorded audio/video, exported song scores, local browser state, or development screenshots. The included CMU pronunciation dictionary and Unicode keyword data are general language resources with their licenses, not song lyrics.

Lyrics obtained or entered while using the extension are stored in your browser profile. The software license does not grant rights to third-party lyrics or recordings. See [PRIVACY.md](PRIVACY.md) for network requests, storage, exports, and optional capture behavior.

The optional [native companion](native/README.md) handles local alignment and review. It is not needed for manual timing. Browser fallback analysis downloads model files on first use. No alignment accuracy guarantee is made.

## Development checks

```sh
npm test
npm run typecheck
npm run build
node scripts/save-state-proof.cjs
node scripts/unsaved-navigation-proof.cjs
node scripts/overlay-startup-proof.cjs
```

Unit tests exercise score operations, source/revision binding, previews, capture, and editor logic. The three browser proofs use isolated synthetic pages and mocked media/worker boundaries; they do not touch a personal browser profile or prove timing accuracy on real singing. Optional Python tests can be run with `python -m unittest discover -s tests -p "test_*.py"` after installing their dependencies.

This is an unpacked development extension, not a Chrome Web Store release.

## Published development history

The original 301 development commits from October 10–28, 2026 are retained in order, with their original author/committer dates and parent relationships. Their hashes changed because publication removes private development evidence and uses a GitHub noreply author address. Commits containing only excluded evidence remain as empty historical entries.

The filtered history keeps implementation and unit-test changes. It excludes private project notes, song captures/exports, screenshots, demo recordings, local runtime details and live-session probe scripts. Identifiable song references in retained tests were replaced by synthetic fixtures. Upstream history and license attribution remain unchanged. The final packaging commit provides these public installation/privacy documents and safe launch targets.

This branch replaces the initial one-commit public snapshot. Existing clones should fetch and switch to the new origin/main history; do not merge the old snapshot or private development branches back into it. A branch rewrite does not guarantee that a hosting provider immediately removes previously published, now-unreferenced objects.
