import type {
  AlignmentProposal,
  AlignmentReceipt,
  AudioMetadata,
  EditorController,
  EditorControllerOptions,
  EditorDispatchRequest,
  EditorError,
  EditorResult,
  EditorSnapshot,
  Immutable,
  LyricVibeScore,
  PersistenceState,
  ReviewPackage,
  ReviewQueue,
  RuntimeResponse,
  ScoreOperation,
  RuntimeMessageListener,
} from "./types";

const SNAPSHOT_VERSION = "lyricvibe.editor-state.v1" as const;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
const MAX_HISTORY = 50;
const AUDIO_DURATION_TOLERANCE_MS = 500;

type Listener = (snapshot: Immutable<EditorSnapshot>) => void;
type UnknownRecord = Record<string, unknown>;

interface InternalState {
  mode: EditorSnapshot["mode"];
  score: LyricVibeScore | null;
  review: AlignmentProposal[];
  queuedWordIds: string[];
  playback: EditorSnapshot["playback"];
  analysis: unknown;
  alignmentDiagnostics: unknown | null;
  draft: boolean;
  busy: boolean;
  audioReady: boolean;
  selection: EditorSnapshot["selection"];
  waveform: EditorSnapshot["waveform"];
  packageAudio: AudioMetadata | null;
  persistence: PersistenceState;
  notice: EditorSnapshot["notice"];
  clockSeen: boolean;
  history: LyricVibeScore[];
  reviewRevision: number | null;
  draftRevision: number | null;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDeep<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as UnknownRecord)) freezeDeep(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

function errorOf(cause: unknown, fallbackCode: string, fallbackMessage = "The editor request failed."): EditorError {
  const record = cause && typeof cause === "object" ? cause as UnknownRecord : {};
  const message = typeof record.message === "string" && record.message ? record.message : fallbackMessage;
  const code = typeof record.code === "string" && record.code ? record.code : fallbackCode;
  return { code, message };
}

function failure(cause: unknown, code: string, message?: string): EditorResult<never> {
  return { ok: false, error: errorOf(cause, code, message) };
}

function makeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findWord(score: LyricVibeScore | null, wordId: string): { phraseId: string; word: LyricVibeScore["phrases"][number]["words"][number] } | null {
  if (!score) return null;
  for (const phrase of score.phrases) {
    const word = phrase.words.find(item => item.id === wordId);
    if (word) return { phraseId: phrase.id, word };
  }
  return null;
}

function defaultQueue(): string[] { return []; }

function parseJsonInput(input: unknown): Promise<unknown> | unknown {
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) throw makeError("INPUT_TOO_LARGE", "JSON file exceeds the 5 MiB limit.");
    try { return JSON.parse(input); }
    catch { throw makeError("INVALID_FILE", "The selected file is not valid JSON."); }
  }
  if (isRecord(input) && typeof input.text === "function") {
    if (typeof input.size === "number" && input.size > MAX_IMPORT_BYTES) throw makeError("INPUT_TOO_LARGE", "JSON file exceeds the 5 MiB limit.");
    return (input.text as () => Promise<string>).call(input).then(text => parseJsonInput(text));
  }
  if (isRecord(input)) {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) {
      throw makeError("INPUT_TOO_LARGE", "JSON file exceeds the 5 MiB limit.");
    }
    return JSON.parse(serialized) as unknown;
  }
  throw makeError("INVALID_FILE", "Choose a JSON score or alignment receipt.");
}

export function createEditorController(options: EditorControllerOptions): EditorController {
  const core: EditorControllerOptions["core"] = options.core;
  const { localReview, reviewQueue: queueApi, runtime, audio } = options;
  const requestedTabId = options.tabId ?? null;
  const requestedMediaKey = options.requestedMediaKey ?? null;
  const live = requestedTabId !== null && Boolean(runtime?.sendMessage) && options.mode !== "local-recording";
  const mode = options.mode ?? (live ? "youtube" : "local-recording");
  const listeners = new Set<Listener>();
  const history: LyricVibeScore[] = [];
  const state: InternalState = {
    mode,
    score: null,
    review: [],
    queuedWordIds: defaultQueue(),
    playback: { mediaMs: 0, paused: true, loop: null },
    analysis: { state: "unavailable", message: live ? "Waiting for source status" : "Open a review package and choose its recording" },
    alignmentDiagnostics: null,
    draft: false,
    busy: false,
    audioReady: false,
    selection: { phraseId: null, wordId: null, syllableId: null },
    waveform: null,
    packageAudio: null,
    persistence: live ? "saved" : "saved",
    notice: { message: "", kind: "" },
    clockSeen: false,
    history,
    reviewRevision: null,
    draftRevision: null,
  };

  let localPackage: ReviewPackage | null = null;
  let reviewQueue: ReviewQueue | null = null;
  let localMediaUrl: string | null = null;
  let mediaEpoch = 0;
  let sourceEpoch = 0;
  let scoreEpoch = 0;
  let initialized = false;
  let disposed = false;
  let clockSourceChanged = false;
  let runtimeListener: RuntimeMessageListener | null = null;
  let cancelMetadataWait: (() => void) | null = null;
  const audioListeners: Array<[string, EventListener]> = [];

  function playbackSnapshot(): EditorSnapshot["playback"] {
    if (state.mode === "local-recording" && state.audioReady && audio) {
      const mediaMs = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime * 1000) : state.playback.mediaMs;
      return { mediaMs, paused: audio.paused, loop: state.playback.loop ? clone(state.playback.loop) : null };
    }
    return clone(state.playback);
  }

  function snapshot(): EditorSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      mode: state.mode,
      score: state.score ? clone(state.score) : null,
      review: clone(state.review),
      queuedWordIds: [...state.queuedWordIds],
      playback: playbackSnapshot(),
      analysis: clone(state.analysis),
      alignmentDiagnostics: state.alignmentDiagnostics == null ? null : clone(state.alignmentDiagnostics),
      draft: state.draft,
      busy: state.busy,
      audioReady: state.audioReady,
      selection: clone(state.selection),
      waveform: state.waveform ? clone(state.waveform) : null,
      packageAudio: state.packageAudio ? clone(state.packageAudio) : null,
      persistence: state.persistence,
      notice: clone(state.notice),
      clockSeen: state.clockSeen,
      history: { length: state.history.length, canUndo: live ? Boolean(state.score) : state.history.length > 0 },
    };
  }

  function notify(): void {
    if (disposed) return;
    const view = freezeDeep(snapshot());
    for (const listener of [...listeners]) {
      try { listener(view); } catch { /* A view listener cannot interrupt the controller. */ }
    }
  }

  function getState(): Immutable<EditorSnapshot> {
    return freezeDeep(snapshot());
  }

  function setNotice(message: string, kind: EditorSnapshot["notice"]["kind"] = ""): void {
    state.notice = { message, kind };
    notify();
  }

  function identity(): { tabId: number; mediaKey?: string } {
    if (requestedTabId === null) throw makeError("SOURCE_UNAVAILABLE", "No source tab is connected.");
    if (!state.score) return { tabId: requestedTabId, ...(requestedMediaKey ? { mediaKey: requestedMediaKey } : {}) };
    return { tabId: requestedTabId, mediaKey: core.mediaKey(state.score.source) };
  }

  async function send(type: string, payload: UnknownRecord = {}): Promise<UnknownRecord> {
    if (!live || !runtime?.sendMessage) throw makeError("RUNTIME_UNAVAILABLE", "The source tab runtime is unavailable.");
    let response: RuntimeResponse;
    try { response = await runtime.sendMessage({ type, ...identity(), ...payload }); }
    catch (cause) {
      const detail = cause instanceof Error && cause.message ? cause.message : "runtime unavailable";
      throw makeError("RUNTIME_UNAVAILABLE", `Editor → source tab: ${detail}. Retry after reconnecting the source.`);
    }
    if (!response || response.ok !== true) throw makeError(response?.error?.code || "NO_RESPONSE", response?.error?.message || "The source did not acknowledge the request.");
    return response as UnknownRecord;
  }

  function setAnalysis(value: unknown): void {
    state.analysis = value ? clone(value) : { state: "unavailable" };
    notify();
  }

  function setReview(value: AlignmentProposal[], diagnostics: unknown = null): void {
    if (!Array.isArray(value)) throw makeError("INVALID_REVIEW_PROPOSAL", "Review proposals must be an array.");
    state.review = clone(value);
    state.alignmentDiagnostics = diagnostics == null ? null : clone(diagnostics);
    reviewQueue = state.score && state.review.length
      ? queueApi.create(state.score, state.review)
      : null;
    state.queuedWordIds = reviewQueue ? [...reviewQueue.selectedWordIds] : [];
    state.reviewRevision = state.score ? state.score.revision : null;
    notify();
  }

  function setScore(value: LyricVibeScore, preserveDraft = false): void {
    core.validateScore(value);
    const previousKey = state.score ? core.mediaKey(state.score.source) : null;
    const nextKey = core.mediaKey(value.source);
    if (!previousKey && requestedMediaKey && nextKey !== requestedMediaKey) throw makeError("SOURCE_MISMATCH", "The returned score does not match the requested media key.");
    if (previousKey && previousKey !== nextKey) throw makeError("SOURCE_CHANGED", "The source video changed. Reopen the editor from the current video.");
    if (previousKey === nextKey && state.score && value.revision < state.score.revision) throw makeError("STALE_SCORE_REVISION", "A stale score revision was ignored.");
    if (previousKey !== nextKey) sourceEpoch++;
    state.score = clone(value);
    scoreEpoch++;
    if (state.reviewRevision !== null && state.reviewRevision !== state.score.revision) clearReview();
    const priorWord = state.selection.wordId && findWord(state.score, state.selection.wordId);
    if (!priorWord) {
      const firstPhrase = state.score.phrases[0];
      const firstWord = firstPhrase?.words[0];
      state.selection = { phraseId: firstPhrase?.id ?? null, wordId: firstWord?.id ?? null, syllableId: null };
    } else {
      const syllableId = state.selection.syllableId && priorWord.word.syllables?.some(item => item.id === state.selection.syllableId)
        ? state.selection.syllableId
        : null;
      state.selection = { phraseId: priorWord.phraseId, wordId: priorWord.word.id, syllableId };
    }
    if (!preserveDraft) {
      state.draft = false;
      state.draftRevision = null;
    }
    notify();
  }

  function checkedReviewProtection(proposal: AlignmentProposal): string {
    if (!state.score) return "Unavailable score";
    const located = findWord(state.score, proposal.wordId);
    if (!located) return "Unavailable word";
    if (located.word.locked) return "Locked";
    if (located.word.syllables?.some(item => item.locked)) return "Protected syllable";
    const phrase = state.score.phrases.find(item => item.id === located.phraseId);
    if (phrase && !phrase.endEstimated && (proposal.startMs < phrase.startMs || proposal.endMs > phrase.endMs)) return "Adjust phrase bounds before accepting";
    return "";
  }

  function assertCurrentEnvelope(request: EditorDispatchRequest): void {
    if (!state.score) throw makeError("EDITOR_BUSY", "Open a score first.");
    if (!isRecord(request)) throw makeError("INVALID_OPERATION", "Editor request must be an object.");
    const audition = request.type === "LV_SCORE_TRANSPORT" || request.type === "LV_SCORE_SEEK";
    if (state.busy || (state.draft && !audition)) throw makeError("EDITOR_BUSY", "Apply or discard the current draft and wait for pending work first.");
    if (request.mediaKey !== core.mediaKey(state.score.source)) throw makeError("SOURCE_MISMATCH", "Editor source does not match request.");
    if (request.lyricsHash !== state.score.lyrics.contentHash) throw makeError("LYRIC_REVISION_MISMATCH", "Editor lyric hash does not match request.");
    if (request.expectedRevision !== state.score.revision) throw makeError("REVISION_CONFLICT", "Editor revision changed; read state before retrying.");
  }

  function clearReview(): void {
    state.review = [];
    state.queuedWordIds = [];
    state.alignmentDiagnostics = null;
    state.reviewRevision = null;
    reviewQueue = null;
  }

  async function applyMutation(type: string, payload: UnknownRecord, expectedRevision: number): Promise<EditorResult<{ score?: LyricVibeScore }>> {
    if (!state.score || state.busy) return failure(makeError("EDITOR_BUSY", "Score unavailable or editor busy."), "EDITOR_BUSY");
    const before = state.score;
    const bindingEpoch = sourceEpoch;
    const requestScoreEpoch = scoreEpoch;
    state.busy = true;
    notify();
    try {
      let predicted: LyricVibeScore | null = null;
      if (type === "LV_SCORE_OPERATION") predicted = core.applyOperation(before, payload.operation as ScoreOperation, expectedRevision);
      if (type === "LV_SCORE_REVIEW_APPLY") {
        if (!reviewQueue) throw makeError("EMPTY_SELECTION", "No timings selected.");
        if (state.reviewRevision !== expectedRevision) throw makeError("REVISION_CONFLICT", "Review proposals belong to a different score revision.");
        const proposals = (payload.wordIds as string[]).map(wordId => {
          const proposal = state.review.find(item => item.wordId === wordId);
          if (!proposal) throw makeError("UNKNOWN_REVIEW_WORD", "Selected word is not in the current review queue.");
          const protection = checkedReviewProtection(proposal);
          if (protection) throw makeError("LOCKED", protection);
          return { ...proposal, accepted: true as const };
        });
        predicted = core.applyAlignment(before, proposals, expectedRevision);
      }
      if (type === "LV_SCORE_IMPORT") {
        const incoming = payload.score as LyricVibeScore;
        core.validateScore(incoming);
        if (core.mediaKey(before.source) !== core.mediaKey(incoming.source)) throw makeError("SOURCE_MISMATCH", "This file belongs to a different video. Open that source video before importing.");
        if (before.lyrics.contentHash !== incoming.lyrics.contentHash) throw makeError("LYRICS_MISMATCH", "This file belongs to a different lyric content revision.");
        predicted = { ...clone(incoming), revision: before.revision + 1 };
      }

      if (live) {
        const result = await send(type, { ...payload, expectedRevision });
        if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while the request was pending.");
        let applyReplyReview = false;
        if (result.score) {
          const replyScore = result.score as LyricVibeScore;
          const newerPushArrived = scoreEpoch !== requestScoreEpoch && state.score &&
            core.mediaKey(state.score.source) === core.mediaKey(replyScore.source) &&
            state.score.revision >= replyScore.revision;
          if (!newerPushArrived) {
            setScore(replyScore);
            applyReplyReview = true;
          }
        }
        else {
          const newerPushAlreadyArrived = scoreEpoch !== requestScoreEpoch && state.score;
          if (newerPushAlreadyArrived) {
            applyReplyReview = false;
          } else {
            const beforeGetEpoch = scoreEpoch;
            const latest = await send("LV_SCORE_GET");
            if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while refreshing the score.");
            const newerPushArrived = scoreEpoch !== beforeGetEpoch && state.score;
            if (!newerPushArrived) {
              setScore(latest.score as LyricVibeScore);
              setReview((latest.review || []) as AlignmentProposal[], latest.diagnostics ?? null);
              setAnalysis(latest.analysis);
              applyReplyReview = true;
            }
          }
        }
        if (applyReplyReview && result.score) setReview((result.review || []) as AlignmentProposal[], result.diagnostics ?? null);
        else if (applyReplyReview && result.review) setReview(result.review as AlignmentProposal[], result.diagnostics ?? null);
        state.persistence = "saved";
      } else if (type === "LV_SCORE_UNDO") {
        const previous = state.history.pop();
        if (!previous) throw makeError("NO_UNDO", "There is no local score change to undo.");
        setScore({ ...clone(previous), revision: before.revision + 1 });
        clearReview();
        state.persistence = "unsaved";
      } else {
        if (!predicted) throw makeError("INVALID_OPERATION", "Operation could not be applied.");
        state.history.push(clone(before));
        if (state.history.length > MAX_HISTORY) state.history.shift();
        setScore(predicted);
        clearReview();
        state.persistence = "unsaved";
      }
      state.draft = false;
      state.draftRevision = null;
      state.notice = { message: type === "LV_SCORE_UNDO" ? `Previous score restored · Revision ${state.score?.revision}` : `Score updated · Revision ${state.score?.revision}`, kind: "success" };
      return { ok: true, ...(state.score ? { score: clone(state.score) } : {}) };
    } catch (cause) {
      const result = failure(cause, "EDITOR_OPERATION_FAILED");
      state.notice = { message: `${result.error.code} · ${result.error.message}${state.draft ? " Your draft is preserved." : ""}`, kind: "error" };
      return result;
    } finally {
      state.busy = false;
      notify();
    }
  }

  function seekTarget(mediaMs: number): number {
    if (!state.score) return Math.max(0, Math.round(mediaMs));
    const duration = state.score.source.durationMs;
    return Math.round(Math.max(0, Math.min(duration > 0 ? duration : Number.POSITIVE_INFINITY, mediaMs)));
  }

  async function seekTo(mediaMs: number): Promise<EditorResult<{ mediaMs: number }>> {
    if (!state.score) return failure(makeError("EDITOR_BUSY", "Open a score before seeking."), "EDITOR_BUSY");
    if (!Number.isFinite(mediaMs)) return failure(makeError("INVALID_TIME", "Enter a finite source position in milliseconds."), "INVALID_TIME");
    const target = seekTarget(mediaMs);
    const bindingEpoch = sourceEpoch;
    const sourceMediaEpoch = mediaEpoch;
    try {
      if (live) await send("LV_SCORE_SEEK", { mediaMs: target });
      if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while seeking.");
      if (state.mode === "local-recording") {
        if (!state.audioReady || !audio) throw makeError("AUDIO_UNAVAILABLE", "Choose the matching recording before seeking.");
        if (sourceMediaEpoch !== mediaEpoch) throw makeError("SELECTION_CHANGED", "Recording selection changed while seeking.");
        audio.currentTime = target / 1000;
        state.playback.mediaMs = audio.currentTime * 1000;
        state.playback.paused = audio.paused;
      } else state.playback.mediaMs = target;
      state.clockSeen = true;
      notify();
      return { ok: true, mediaMs: target };
    } catch (cause) { return failure(cause, "SEEK_FAILED"); }
  }

  async function transport(action: string, loop?: { startMs: number; endMs: number }): Promise<EditorResult> {
    if (!state.score) return failure(makeError("EDITOR_BUSY", "Open a score before using transport."), "EDITOR_BUSY");
    if (!["play", "pause", "setLoop", "clearLoop"].includes(action)) return failure(makeError("INVALID_OPERATION", "Unknown transport action."), "INVALID_OPERATION");
    if (action === "setLoop" && (!loop || !Number.isFinite(loop.startMs) || !Number.isFinite(loop.endMs) || loop.startMs < 0 || loop.endMs <= loop.startMs || loop.endMs > state.score.source.durationMs)) {
      return failure(makeError("INVALID_TIME", "Loop must fit inside the source duration."), "INVALID_TIME");
    }
    const bindingEpoch = sourceEpoch;
    const sourceMediaEpoch = mediaEpoch;
    try {
      if (live) await send("LV_SCORE_TRANSPORT", { action, ...(loop ? { loop } : {}) });
      if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while transport was pending.");
      if (state.mode === "local-recording" && (action === "play" || action === "pause")) {
        if (!state.audioReady || !audio) throw makeError("AUDIO_UNAVAILABLE", "Choose the matching recording before playing.");
        if (action === "play") await audio.play();
        else audio.pause();
        if (disposed || sourceMediaEpoch !== mediaEpoch) throw makeError("SELECTION_CHANGED", "Recording selection changed while transport was pending.");
      }
      if (action === "play" || action === "pause") state.playback.paused = action === "pause";
      if (action === "setLoop") state.playback.loop = loop ? clone(loop) : null;
      if (action === "clearLoop") state.playback.loop = null;
      if (state.mode === "local-recording" && state.audioReady && audio) state.playback.mediaMs = audio.currentTime * 1000;
      notify();
      return { ok: true };
    } catch (cause) { return failure(cause, "TRANSPORT_FAILED"); }
  }

  function sourcePlaybackMatches(message: UnknownRecord, sender: { id?: string; tab?: { id?: number } }, mediaKey: string): boolean {
    return message.type === "LV_SCORE_PLAYBACK" &&
      sender.id === runtime?.id && sender.tab?.id === requestedTabId &&
      message.mediaKey === mediaKey && Number.isFinite(message.mediaMs) &&
      (message.mediaMs as number) >= 0 && typeof message.paused === "boolean";
  }

  function handleRuntimeMessage(rawMessage: unknown, sender: { id?: string; tab?: { id?: number } }): void {
    if (disposed || !isRecord(rawMessage) || sender?.id !== runtime?.id) return;
    const message = rawMessage;
    const expectedKey = state.score ? core.mediaKey(state.score.source) : requestedMediaKey;
    if (message.type === "LV_ANALYSIS_OFFSCREEN_STATE" && isRecord(message.analysis)) {
      if (message.analysis.tabId === requestedTabId && (!expectedKey || message.analysis.mediaKey === expectedKey)) setAnalysis(message.analysis);
      return;
    }
    if (message.type === "LV_SCORE_PLAYBACK") {
      if (expectedKey && typeof message.mediaKey === "string" && message.mediaKey !== expectedKey &&
          core.mediaKey({ videoId: message.mediaKey.slice(8) }) === message.mediaKey &&
          sourcePlaybackMatches(message, sender, message.mediaKey)) {
        clockSourceChanged = true;
        state.clockSeen = false;
        state.playback.paused = true;
        state.playback.loop = null;
        state.notice = { message: "The source tab changed videos. Your score and draft are preserved; reopen the editor from the current video.", kind: "error" };
        notify();
        return;
      }
      if (!expectedKey || !sourcePlaybackMatches(message, sender, expectedKey)) return;
      if (clockSourceChanged) {
        clockSourceChanged = false;
        state.notice = { message: "The original video clock is connected again. Review any draft before applying it.", kind: "" };
      }
      state.playback.mediaMs = message.mediaMs as number;
      state.playback.paused = message.paused as boolean;
      state.clockSeen = true;
      notify();
      return;
    }
    if (message.tabId !== requestedTabId || (expectedKey && message.mediaKey !== expectedKey)) return;
    if (message.type === "LV_SCORE_UPDATED") {
      if (!message.score) return;
      try {
        setScore(message.score as LyricVibeScore, state.draft);
        if (Array.isArray(message.review)) setReview(message.review as AlignmentProposal[], message.diagnostics ?? null);
        if (state.draft) state.notice = { message: "Source score updated. Your draft retains its original revision; discard or retry against the new state.", kind: "error" };
        notify();
      } catch (cause) {
        if ((cause as UnknownRecord)?.code === "STALE_SCORE_REVISION") return;
        state.notice = { ...errorOf(cause, "INVALID_SCORE"), kind: "error" };
        notify();
      }
      return;
    }
    if (message.type === "LV_ANALYSIS_OFFSCREEN_STATE" && message.analysis) setAnalysis(message.analysis);
  }

  function onAudioClock(): void {
    if (disposed || !audio || !state.audioReady) return;
    const currentMs = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime * 1000) : state.playback.mediaMs;
    const loop = state.playback.loop;
    if (loop && !audio.paused && currentMs >= loop.endMs) {
      try { audio.currentTime = loop.startMs / 1000; } catch { /* The media element will emit an error if it cannot seek. */ }
    }
    state.playback.mediaMs = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime * 1000) : currentMs;
    state.playback.paused = audio.paused;
    state.clockSeen = true;
    notify();
  }

  function onAudioError(): void {
    if (disposed || !audio) return;
    state.audioReady = false;
    state.playback.paused = true;
    state.notice = { message: "Recording playback failed. Choose the original recording again.", kind: "error" };
    notify();
  }

  function detachMedia(): void {
    mediaEpoch++;
    const cancel = cancelMetadataWait;
    cancelMetadataWait = null;
    cancel?.();
    state.audioReady = false;
    if (audio) {
      try { audio.pause(); } catch { /* Best effort while releasing local media. */ }
      try { audio.removeAttribute("src"); audio.load(); } catch { /* Best effort while releasing local media. */ }
    }
    if (localMediaUrl) {
      try { URL.revokeObjectURL(localMediaUrl); } catch { /* URL implementation may be unavailable in tests. */ }
      localMediaUrl = null;
    }
    state.playback.paused = true;
    state.playback.loop = null;
    state.playback.mediaMs = 0;
  }

  function waitForMetadata(url: string, epoch: number): Promise<number> {
    if (!audio) return Promise.reject(makeError("AUDIO_UNAVAILABLE", "No local audio element was provided."));
    return new Promise((resolve, reject) => {
      let finish!: (cause?: unknown) => void;
      let cancel: () => void = () => undefined;
      const timeout = setTimeout(() => finish(makeError("MEDIA_METADATA_TIMEOUT", "Recording metadata did not load within 15 seconds.")), 15000);
      const loaded: EventListener = () => finish();
      const failed: EventListener = () => finish(makeError("MEDIA_DECODE_FAILED", "The browser could not decode this recording. Choose a supported local audio or video file."));
      finish = (cause?: unknown): void => {
        clearTimeout(timeout);
        audio.removeEventListener("loadedmetadata", loaded);
        audio.removeEventListener("error", failed);
        if (cancelMetadataWait === cancel) cancelMetadataWait = null;
        if (epoch !== mediaEpoch || disposed) reject(makeError("SELECTION_CHANGED", "Recording selection changed."));
        else if (cause) reject(cause);
        else if (!Number.isFinite(audio.duration) || audio.duration <= 0) reject(makeError("MEDIA_DURATION_INVALID", "Selected recording has an invalid duration."));
        else resolve(audio.duration * 1000);
      };
      cancel = () => finish(makeError("SELECTION_CHANGED", "Recording selection changed."));
      cancelMetadataWait = cancel;
      audio.addEventListener("loadedmetadata", loaded);
      audio.addEventListener("error", failed);
      audio.src = url;
      audio.load();
    });
  }

  function addAudioListeners(): void {
    if (!audio || audioListeners.length) return;
    for (const name of ["timeupdate", "play", "pause", "ended", "seeked", "loadedmetadata"]) {
      const listener: EventListener = () => onAudioClock();
      audio.addEventListener(name, listener);
      audioListeners.push([name, listener]);
    }
    const errorListener: EventListener = () => onAudioError();
    audio.addEventListener("error", errorListener);
    audioListeners.push(["error", errorListener]);
  }

  async function initialize(): Promise<EditorResult<{ score?: LyricVibeScore }>> {
    if (disposed) return failure(makeError("DISPOSED", "Editor controller has been disposed."), "DISPOSED");
    if (initialized) return { ok: true, ...(state.score ? { score: clone(state.score) } : {}) };
    initialized = true;
    addAudioListeners();
    if (!live) {
      setNotice(state.notice.message || "Open a review package, then choose its original recording.");
      return { ok: true };
    }
    if (runtime?.onMessage) {
      runtimeListener = (message, sender) => handleRuntimeMessage(message, sender);
      runtime.onMessage.addListener(runtimeListener);
    }
    const bindingEpoch = sourceEpoch;
    const initialScoreEpoch = scoreEpoch;
    try {
      const result = await send("LV_SCORE_GET");
      if (disposed) throw makeError("SELECTION_CHANGED", "Source selection changed while connecting.");
      if (scoreEpoch !== initialScoreEpoch && state.score) return { ok: true, score: clone(state.score) };
      if (bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while connecting.");
      if (!isRecord(result.score)) throw makeError("INVALID_SCORE", "The source returned no validated score.");
      setScore(result.score as unknown as LyricVibeScore);
      setReview((Array.isArray(result.review) ? result.review : []) as AlignmentProposal[], result.diagnostics ?? null);
      setAnalysis(result.analysis);
      setNotice("Select a word to adjust timing. Changes save to this exact video and lyric revision.", "success");
      return { ok: true, score: clone(state.score!) };
    } catch (cause) {
      setNotice(`${errorOf(cause, "SOURCE_UNAVAILABLE").code} · ${errorOf(cause, "SOURCE_UNAVAILABLE").message}`, "error");
      return failure(cause, "SOURCE_UNAVAILABLE");
    }
  }

  async function loadPackage(input: unknown): Promise<EditorResult<{ score: LyricVibeScore }>> {
    if (disposed) return failure(makeError("DISPOSED", "Editor controller has been disposed."), "DISPOSED");
    if (state.mode !== "local-recording") return failure(makeError("WRONG_MODE", "Local review packages require local-recording mode."), "WRONG_MODE");
    if (state.persistence !== "saved" || state.draft || state.busy) return failure(makeError("EDITOR_BUSY", "Export current edits and apply or discard drafts before opening another package."), "EDITOR_BUSY");
    try {
      const validated = localReview.validatePackage(input);
      core.validateScore(validated.score);
      const receipt = core.validateAlignmentReceipt(validated.score, validated.receipt);
      detachMedia();
      localPackage = clone(validated);
      state.score = null;
      state.selection = { phraseId: null, wordId: null, syllableId: null };
      state.history.splice(0);
      state.playback.mediaMs = 0;
      state.waveform = clone(validated.waveform);
      state.packageAudio = clone(validated.audio);
      state.persistence = "saved";
      clearReview();
      setScore(validated.score);
      setReview(receipt.proposals);
      state.analysis = { state: "review-ready", message: `${state.review.length} native proposals · review required` };
      const firstProposal = state.review[0];
      if (firstProposal) selectWord(firstProposal.wordId);
      state.notice = { message: `Choose ${validated.audio.name} · ${state.review.length} model proposals · no timing changed`, kind: "" };
      notify();
      return { ok: true, score: clone(state.score!) };
    } catch (cause) {
      state.notice = { message: `${errorOf(cause, "INVALID_REVIEW_PACKAGE").code} · ${errorOf(cause, "INVALID_REVIEW_PACKAGE").message}`, kind: "error" };
      notify();
      return failure(cause, "INVALID_REVIEW_PACKAGE");
    }
  }

  async function attachRecording(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<EditorResult<{ audioReady: true }>> {
    if (disposed) return failure(makeError("DISPOSED", "Editor controller has been disposed."), "DISPOSED");
    if (state.mode !== "local-recording" || !localPackage) return failure(makeError("PACKAGE_REQUIRED", "Open a review package first."), "PACKAGE_REQUIRED");
    if (!audio) return failure(makeError("AUDIO_UNAVAILABLE", "No local audio element was provided."), "AUDIO_UNAVAILABLE");
    detachMedia();
    const epoch = mediaEpoch;
    try {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_RECORDING_BYTES || file.size !== localPackage.audio.sizeBytes) {
        throw makeError("AUDIO_MISMATCH", "The recording size does not match this review package.");
      }
      const cryptoApi = globalThis.crypto;
      if (!cryptoApi?.subtle) throw makeError("CRYPTO_UNAVAILABLE", "Secure SHA-256 verification is unavailable in this browser context.");
      const digest = await cryptoApi.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (epoch !== mediaEpoch || disposed) throw makeError("SELECTION_CHANGED", "Recording selection changed.");
      if (sha256 !== localPackage.audio.sha256) throw makeError("AUDIO_MISMATCH", "This recording does not match the package SHA-256.");
      localMediaUrl = URL.createObjectURL(file as unknown as Blob);
      const durationMs = await waitForMetadata(localMediaUrl, epoch);
      if (epoch !== mediaEpoch || disposed || localPackage === null) throw makeError("SELECTION_CHANGED", "Recording selection changed.");
      localReview.validateMediaFile(localPackage.audio, { name: file.name, sizeBytes: file.size, durationMs, sha256 });
      state.audioReady = true;
      state.playback.mediaMs = audio.currentTime * 1000;
      state.playback.paused = audio.paused;
      state.clockSeen = true;
      state.notice = { message: "Recording verified. Proposals remain unverified until reviewed.", kind: "success" };
      notify();
      return { ok: true, audioReady: true };
    } catch (cause) {
      if (epoch === mediaEpoch && !(cause && typeof cause === "object" && (cause as UnknownRecord).code === "SELECTION_CHANGED")) detachMedia();
      if ((cause as UnknownRecord)?.code !== "SELECTION_CHANGED") {
        state.notice = { message: `${errorOf(cause, "AUDIO_MISMATCH").code} · ${errorOf(cause, "AUDIO_MISMATCH").message}`, kind: "error" };
        notify();
      }
      return failure(cause, "AUDIO_MISMATCH");
    }
  }

  async function importScore(input: unknown): Promise<EditorResult<{ score?: LyricVibeScore; review?: AlignmentProposal[] }>> {
    if (!state.score) return failure(makeError("EDITOR_BUSY", "Open a score before importing."), "EDITOR_BUSY");
    if (state.draft || state.busy) return failure(makeError("EDITOR_BUSY", "Apply or discard your current draft before importing."), "EDITOR_BUSY");
    const startingRevision = state.score.revision;
    try {
      const epoch = sourceEpoch;
      const incoming = await parseJsonInput(input);
      if (disposed || epoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while the file was being read.");
      if (state.score?.revision !== startingRevision) throw makeError("REVISION_CONFLICT", "Score changed while the file was being read. Review the current state before importing again.");
      if (state.mode === "local-recording" && state.persistence !== "saved") throw makeError("EDITOR_BUSY", "Export current edits before importing another score.");
      if (isRecord(incoming) && incoming.version === "lyricvibe.alignment.v1") {
        const receipt: AlignmentReceipt = core.validateAlignmentReceipt(state.score, incoming);
        if (live) {
          state.busy = true;
          notify();
          try {
            const bindingEpoch = sourceEpoch;
            const requestScoreEpoch = scoreEpoch;
            const requestMediaKey = core.mediaKey(state.score.source);
            const requestRevision = state.score.revision;
            const result = await send("LV_NATIVE_ALIGNMENT_IMPORT", { receipt, expectedRevision: state.score.revision });
            if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while importing timing suggestions.");
            if (requestScoreEpoch !== scoreEpoch) {
              const sameScore = state.score && core.mediaKey(state.score.source) === requestMediaKey && state.score.revision === requestRevision;
              if (!sameScore) throw makeError("REVISION_CONFLICT", "Score changed while importing timing suggestions. Read the current state before retrying.");
            } else setReview((result.review || []) as AlignmentProposal[], result.diagnostics ?? null);
          } finally { state.busy = false; notify(); }
        } else setReview(receipt.proposals);
        setNotice("Timing suggestions loaded. Audition before accepting; no timing changed.", "success");
        return { ok: true, review: clone(state.review) };
      }
      if (!isRecord(incoming)) throw makeError("INVALID_SCORE", "Selected JSON is not a score.");
      core.validateScore(incoming);
      const expectedRevision = state.score.revision;
      const result = await applyMutation("LV_SCORE_IMPORT", { score: incoming }, expectedRevision);
      return result.ok ? { ok: true, ...(result.score ? { score: result.score } : {}) } : result;
    } catch (cause) {
      state.notice = { message: `${errorOf(cause, "INVALID_FILE").code} · ${errorOf(cause, "INVALID_FILE").message}`, kind: "error" };
      notify();
      return failure(cause, "INVALID_FILE");
    }
  }

  function exportScore(): LyricVibeScore {
    if (!state.score) throw makeError("NO_SCORE", "Open a score before exporting.");
    core.validateScore(state.score);
    const value = clone(state.score);
    state.persistence = "export-requested";
    notify();
    return value;
  }

  function acknowledgeExport(revision: number): boolean {
    if (!state.score || !Number.isSafeInteger(revision) || state.score.revision !== revision || state.persistence !== "export-requested") return false;
    state.persistence = "saved";
    state.notice = { message: `Validated score export acknowledged · Revision ${revision}`, kind: "success" };
    notify();
    return true;
  }

  function selectPhrase(phraseId: string): boolean {
    if (!state.score || state.draft) return false;
    const phrase = state.score.phrases.find(item => item.id === phraseId);
    if (!phrase) return false;
    const current = state.selection.wordId ? findWord(state.score, state.selection.wordId) : null;
    const word = current?.phraseId === phraseId ? current.word : phrase.words[0];
    state.selection = { phraseId, wordId: word?.id ?? null, syllableId: null };
    notify();
    return true;
  }

  function selectWord(wordId: string, syllableId?: string): boolean {
    if (!state.score) return false;
    const nextSyllableId = syllableId ?? null;
    if (state.draft && (wordId !== state.selection.wordId || nextSyllableId !== state.selection.syllableId)) {
      setNotice("Apply your current timing draft before selecting another word or syllable, or discard it.", "error");
      return false;
    }
    const located = findWord(state.score, wordId);
    if (!located) return false;
    if (syllableId && !located.word.syllables?.some(item => item.id === syllableId)) return false;
    state.selection = { phraseId: located.phraseId, wordId, syllableId: nextSyllableId };
    notify();
    return true;
  }

  function setDraft(value: boolean): void {
    if (value && !state.draft) state.draftRevision = state.score?.revision ?? null;
    if (!value) state.draftRevision = null;
    state.draft = value;
    notify();
  }

  function selectProposal(wordId: string): boolean {
    if (!state.review.some(proposal => proposal.wordId === wordId)) return false;
    return selectWord(wordId);
  }

  async function dispatch(request: EditorDispatchRequest): Promise<EditorResult<{ score?: LyricVibeScore; mediaMs?: number; queuedWordIds?: string[]; analysis?: unknown }>> {
    try {
      if (disposed) throw makeError("DISPOSED", "Editor controller has been disposed.");
      assertCurrentEnvelope(request);
      if (request.type === "LV_SCORE_OPERATION") return await applyMutation(request.type, { operation: request.operation }, request.expectedRevision);
      if (request.type === "LV_SCORE_UNDO") return await applyMutation(request.type, {}, request.expectedRevision);
      if ((request.type === "LV_NATIVE_ANALYSIS_START" || request.type === "LV_NATIVE_ANALYSIS_STOP" || request.type === "LV_NATIVE_ANALYSIS_STATUS" || request.type === "LV_ANALYSIS_START" || request.type === "LV_ANALYSIS_STOP" || request.type === "LV_ANALYSIS_STATUS") && live) {
        const bindingEpoch = sourceEpoch;
        const requestScoreEpoch = scoreEpoch;
        const result = await send(request.type, { expectedRevision: state.score!.revision, lyricsHash: state.score!.lyrics.contentHash });
        if (disposed || bindingEpoch !== sourceEpoch) throw makeError("SELECTION_CHANGED", "Source selection changed while analysis was pending.");
        if (requestScoreEpoch !== scoreEpoch) throw makeError("REVISION_CONFLICT", "Score changed while analysis was pending. Read the current state before retrying.");
        const analysis = result.analysis || result.status || result;
        setAnalysis(analysis);
        if (isRecord(analysis) && analysis.state === "error") {
          const nested = isRecord(analysis.error) ? analysis.error : {};
          return failure(makeError(typeof nested.code === "string" ? nested.code : "ANALYSIS_FAILED", typeof nested.message === "string" ? nested.message : "Analysis could not start."), "ANALYSIS_FAILED");
        }
        setNotice(request.type.endsWith("_START") ? "Analysis requested. Timings remain unverified suggestions until reviewed." : request.type.endsWith("_STOP") ? "Analysis stopped." : "Analysis status refreshed.", "success");
        return { ok: true, analysis };
      }
      if (request.type === "LV_SCORE_REVIEW_SELECT") {
        if (!reviewQueue) throw makeError("NO_REVIEW_QUEUE", "No review queue is loaded.");
        const wordId = request.wordId;
        if (typeof wordId !== "string") throw makeError("UNKNOWN_REVIEW_WORD", "Choose a word from the current review queue.");
        const checked = request.checked === undefined ? true : request.checked;
        if (typeof checked !== "boolean") throw makeError("INVALID_SELECTION", "Selection state must be boolean.");
        reviewQueue = queueApi.toggle(reviewQueue, wordId, checked, state.score!);
        state.queuedWordIds = [...reviewQueue.selectedWordIds];
        notify();
        return { ok: true, queuedWordIds: [...state.queuedWordIds] };
      }
      if (request.type === "LV_SCORE_REVIEW_APPLY") {
        if (!reviewQueue) return failure(makeError("EMPTY_SELECTION", "No timings selected."), "EMPTY_SELECTION");
        let wordIds = request.wordIds;
        if (wordIds !== undefined) {
          if (!Array.isArray(wordIds) || wordIds.some(id => typeof id !== "string")) throw makeError("INVALID_SELECTION", "wordIds must be an array of word IDs.");
          let next = reviewQueue;
          for (const wordId of wordIds as string[]) next = queueApi.toggle(next, wordId, true, state.score!);
          reviewQueue = next;
          state.queuedWordIds = [...reviewQueue.selectedWordIds];
        }
        const selected = queueApi.selected(reviewQueue, state.score!);
        if (!selected.length) return failure(makeError("EMPTY_SELECTION", "No timings selected."), "EMPTY_SELECTION");
        return await applyMutation("LV_SCORE_REVIEW_APPLY", { wordIds: selected.map(item => item.wordId) }, state.reviewRevision ?? request.expectedRevision);
      }
      if (request.type === "LV_SCORE_SEEK") {
        if (typeof request.mediaMs !== "number") throw makeError("INVALID_TIME", "mediaMs must be finite.");
        return await seekTo(request.mediaMs);
      }
      if (request.type === "LV_SCORE_TRANSPORT") {
        if (typeof request.action !== "string") throw makeError("INVALID_OPERATION", "Transport action is required.");
        const loop = isRecord(request.loop) ? { startMs: Number(request.loop.startMs), endMs: Number(request.loop.endMs) } : undefined;
        return await transport(request.action, loop);
      }
      throw makeError("INVALID_OPERATION", "Unsupported editor request type.");
    } catch (cause) { return failure(cause, "INVALID_OPERATION"); }
  }

  async function acceptProposal(wordId: string, checked = true): Promise<EditorResult<{ queuedWordIds: string[] }>> {
    if (!state.score) return failure(makeError("EDITOR_BUSY", "Open a score first."), "EDITOR_BUSY");
    const result = await dispatch({
      type: "LV_SCORE_REVIEW_SELECT",
      mediaKey: core.mediaKey(state.score.source),
      lyricsHash: state.score.lyrics.contentHash,
      expectedRevision: state.score.revision,
      wordId,
      checked,
    });
    return result.ok ? { ok: true, queuedWordIds: result.queuedWordIds ?? [...state.queuedWordIds] } : result;
  }

  async function acceptSelectedProposals(): Promise<EditorResult<{ score?: LyricVibeScore }>> {
    if (!state.score) return failure(makeError("EDITOR_BUSY", "Open a score first."), "EDITOR_BUSY");
    const result = await dispatch({
      type: "LV_SCORE_REVIEW_APPLY",
      mediaKey: core.mediaKey(state.score.source),
      lyricsHash: state.score.lyrics.contentHash,
      expectedRevision: state.score.revision,
    });
    return result.ok ? { ok: true, ...(result.score ? { score: result.score } : {}) } : result;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    sourceEpoch++;
    detachMedia();
    if (runtimeListener && runtime?.onMessage?.removeListener) runtime.onMessage.removeListener(runtimeListener);
    runtimeListener = null;
    if (audio) for (const [type, listener] of audioListeners) audio.removeEventListener(type, listener);
    audioListeners.splice(0);
    listeners.clear();
  }

  function subscribe(listener: Listener): () => void {
    if (disposed) return () => undefined;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return {
    getState,
    subscribe,
    initialize,
    loadPackage,
    attachRecording,
    importScore,
    exportScore,
    acknowledgeExport,
    selectPhrase,
    selectWord,
    setDraft,
    selectProposal,
    acceptProposal,
    acceptSelectedProposals,
    dispatch,
    dispose,
  };
}
