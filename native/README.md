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
