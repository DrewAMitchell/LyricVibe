# Privacy and local data

Updated October 28, 2026 for this development fork.

## Browser extension

- Reads page media metadata and playback state for the activated overlay. Lyrics requests send song title/artist to LRCLIB and optionally lyrics.ovh. Those services receive ordinary request metadata, including your IP address.
- Stores preferences, cached lyrics, exact-video scores, preview edits, captured timing events, map versions and bounded history in the local browser profile. The song library reads that local state.
- Explicit exports create files chosen through the browser. Exported scores can contain lyrics; review their contents and permissions before sharing them.
- Optional audio analysis captures the selected tab into bounded temporary memory. The extension does not record the microphone or upload captured audio. Native alignment is delivered through a locally registered native messaging host; browser fallback runs local JavaScript/WASM.
- Browser model downloads contact Hugging Face and its model-storage hosts and cache weights locally. Settings can clear the model cache.
- An optional user-configured package endpoint receives a YouTube video ID to retrieve a score. It does not automatically receive local edits or captured audio.

## Optional native tools

The separate native guide viewer has an explicitly started, bounded microphone mode and a tap-only mode. It starts idle. These experimental native tools are distinct from extension tab capture. Local review and alignment tools read selected files and may write score copies, review packages or numeric results only through their explicit output actions. Model setup/downloads require network access; local audio processing does not upload recordings.

There is no built-in analytics service, account system, or automatic publication of a song library. Browser permissions, optional tool setup and any configured endpoint remain under your control. Source code is public; browser state, local exports and recordings are not shipped in this repository.
