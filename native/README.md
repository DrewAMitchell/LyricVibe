# Optional native tools

Manual browser editing works without these tools. Native alignment and local guide/review interfaces are experimental. Suggested boundaries require human review and are not proven accurate on all singing or overlapping voices.

## Windows native messaging setup

Use Python 3.11 and an environment dedicated to this project:

```powershell
$analysisVenv = Join-Path $env:LOCALAPPDATA 'LyricVibe\analysis-venv'
py -3.11 -m venv $analysisVenv
& (Join-Path $analysisVenv 'Scripts\python.exe') -m pip install -r native/requirements.txt
.\native\register_native_host.ps1 -ExtensionId <id-from-chrome-extensions> -Browser Chrome
```

The registration writes only current-user native messaging settings. The unpacked extension ID is installation-specific; supply the actual ID. Registration currently targets Windows Chrome/Chromium. Model dependencies and first-use downloads are optional and separate from the extension build.

## Local file alignment

```sh
python native/companion.py analyze --score score.json --audio selected.wav --output receipt.json
```

Input must be a selected PCM WAV within the tool's size/duration bounds and a matching validated score. English alignment returns unaccepted proposals with exact media, lyric hash, revision, model and timing provenance. Locked and unsupported units remain protected. `--audio-start-ms` declares where a selected clip starts on the original media clock. No HTTP service is required.

For offline review, inspect `python native/review_package.py --help` and `python -m native.lyric_timeline --help`. The guide viewer and guide review tools expose their own `--help` commands; the guide viewer's microphone mode is optional, explicit and bounded. They do not provide a turnkey installer or an accuracy guarantee.

[Pronunciation lookup](PRONUNCIATION.md) uses the licensed CMU dictionary to suggest syllable counts. Lexical syllables are not measurements of sung timing.


## One-phrase word and syllable proposals

Use VS Code **LyricVibe: propose alignment for one phrase**, or run from the repo:

```powershell
python -m native.phrase_alignment --score path/to/score.json --media path/to/song.mp4 --phrase-id phrase-2 --output .verification/phrase-proposal.json
```

Use the existing isolated analysis Python runtime. The selected phrase must have
positive whole-millisecond bounds of at most12 seconds. FFmpeg decodes just that
window into memory at original speed; the existing pinned local CTC model aligns
the supplied English text. No audio file, upload, score mutation or automatic
acceptance occurs. Decode/model subprocesses have20/60-second limits and are reaped.
Input hashes bind the proposal; changed inputs and existing output paths reject.

The result is a normal `lyricvibe.alignment.v1` word receipt, usable by the existing
native alignment review importer. Additional `syllableOperations` are a **backend
review prototype**, not yet applied by the browser's receipt importer. They group
model-assigned character frames using existing user cuts first, or an unambiguous
CMUdict count plus estimated spelling cuts. Unknown/ambiguous cuts remain unresolved.
Repeated words map by supplied ordinal. Locked word/child timing stays protected.
The complete proposed batch is tested against the shared score core on a clone;
word provenance remains aligned, never manually verified. Model diagnostic agreement
and runtime timings are retained separately from capture-speed evidence.

These syllable estimates are not phoneme boundaries. The speech-trained model has
not been calibrated on sung audio, and no displayed score or raw tap is replaced.
The next quality gate is listened onset/end references across sustained vowels,
dense phrases, rests and overlapping vocals. Structural validation alone is not
alignment accuracy.


Candidate-model investigation (2026-10-28):
[SOFA](https://github.com/qiuqiao/SOFA) supplies a singing-oriented phoneme aligner;
an [English GTSinger checkpoint](https://huggingface.co/Silasimo/SOFA-GTSinger)
is available under CC-BY-NC-SA-4.0. It is a candidate for separate local evaluation,
not a bundled dependency or a measured improvement here. The
[SingAlign model card](https://huggingface.co/pymaster/SingAlign) reports English
singing checkpoints, but its linked code repository returned404 during this review;
installation/reproducibility was therefore not established. No new model was installed.
A comparison should use exact phrase clips and listened timing references, reporting
boundary error and missing coverage separately; preserve manual data and do not turn
the current uncalibrated speed prior into a confidence probability.
