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

## Song sync

For a song that runs late, type an exact negative millisecond value in the sidebar's
**SYNC** field, then press Enter or leave the field. For example, `-170` shows the
lyrics 170 ms earlier. Positive values show them later. The status confirms when
the song-wide offset is saved for that exact video; it is included in exported
scores and does not rewrite word timings. Rapid changes remain responsive during
playback. A failed save keeps the requested value and offers **Retry save**.
No fixed recording-delay correction is enabled automatically. When a timing preview
is open, use its lightweight editor's **Song timing** offset and **Save timings**.

## Releases

The version format is `year.quarter.sprint.build` (for example `2026.4.2.0`).
See [the release process](RELEASING.md) for preparation, validation, publication
and preserving local scores during upgrades.


### Recording syllables and pitch changes

In **Hold syllables**, hold Space for each syllable and release during rests.
Press **N** for a pitch change while holding. In **Tap freely**, Space records a
syllable entrance; **N** or **Shift+Space** adds a pitch event without advancing
text. Stop, open **Refine**, review word counts and use the assignments, then Save.
Your counts override dictionary suggestions. Raw input remains in the local
recording when you undo or re-record. Capture speed and pitch events travel with
saved syllable evidence; the speed weight is an estimate, not measured accuracy.
Negative song sync displays the result earlier without rewriting captured times.


### Correcting phrases while recording

During a **phrase take**, press **Backspace** to remove the current phrase from
the recording sequence. The next phrase takes its place, later cues move up,
and a held Space entrance carries over to the next phrase. Playback continues.
**Ctrl+Z** (Command+Z on macOS) restores the removed cue; the existing Undo input
button uses the same take history. Backspace keeps its normal behavior in text fields.

The original controls and compact playback strip are retained. **Remove phrase · ⌫**
is also available beside the existing recording recovery controls. Stop applies
removals and completed timing to the preview; **Save timings** persists them.
There is no separate correction form or required repair queue. Phrase mode can
still arm before estimated cues. Existing unsaved-work navigation protection remains.


### Record unrecorded parts

Enable **Record unrecorded parts** before Start to record unfinished phrases in
the selected range and timing mode. From Main it includes nearby backing parts,
even when Main is already recorded. Completed words in a partial word pass are
also skipped. Estimates do not count as recorded timing. Turn it off to rerecord
the selected track normally. An empty range does not start playback.

Prepared syllable practice skips fully completed phrases; partial phrases keep
its existing whole-phrase review. Free-running syllable capture is unchanged.
The run stops when remaining targets are complete, even with Repeat enabled.
Use Save timings to keep the preview. The new choice starts off and is remembered.

Display studio: **Look** chooses font/color, **Motion** chooses layout/dance,
**Words** edits word rules and emoji maps, and **Stage** controls placement/exits.
The sidebar opens each directly; arrow keys move between studio tabs.


### Perform choreography on the stage

Open **Stage live**. Press **Enter** to arm, then **1–9** to layer effects on the
word or syllable playing now. **Space** pauses/resumes. Choose **Place**, then
click a landing point; existing lyric timing stays fixed. Landing offers preset
entry and motion profiles. Look & motion also holds the vocal track and per-word
look/emoji controls. Click a lyric while stopped to select it.

Open **Layers** to select or remove an individual effect or placement.
**Backspace** removes the selected layer; **Ctrl/Command+Z** restores the last
preview edit. Base effects are labeled separately. Stop with **Enter**, then
**Save**. Failed saves retain the take for retry. Advanced maps, presets, beat
editing and region keyframes remain in their existing tools outside Stage live.


### Shape a word or syllable's path

In **Stage live**, choose a word from the left lyric rail. Enable **Syllables**
to work with authored syllables. Drag the grip before its text onto the stage to
set its destination. Drag **Start**, **Bend**, or **Land** to shape the motion;
arrow keys nudge a focused handle, with Shift for a finer step. Timing stays fixed.

For a performed gesture, select **Record motion**, then drag the selected word
or its Land handle. The song plays from that unit's cue; release to finish, or let
it stop at the unit's end. Escape cancels. One Undo restores the prior path.
**Save** keeps the result. **Follow song** follows the playhead again; the arrow
beside Lyrics collapses the rail when you need the full stage.

### Capture keys and held notes

In syllable event capture, **Space** marks a new syllable and **N** marks a
new note within that syllable. Hold Space through its duration; the key stays
lit, and N flashes separately without advancing the syllable count.
For one “oh” across three notes: hold Space, tap N twice, then release.

Open **Stage live → Held notes** for global qualification (relative length,
minimum duration per syllable, or explicit words only) and the effect (Breathe,
Wave, Glow, Pulse, or None). Select a word in the rail for **Follow global /
Always / Never**. Global defaults save immediately; word overrides use Save/Undo.
Automatic expression must be enabled. Authored effects and word rules take
priority. The rule uses saved timing and estimated counts for unsplit words,
not detected pitch. Existing scores remain valid; scores with explicit held
word overrides require this version or newer.
