export type EditorMode = "youtube" | "local-recording";
export type PersistenceState = "saved" | "unsaved" | "export-requested";
export type NoticeKind = "" | "success" | "error";

export interface ScoreSource {
  platform: "youtube";
  videoId: string;
  title: string;
  artist: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface ScoreLyrics {
  provider: string;
  entryId: string | null;
  contentHash: string;
  [key: string]: unknown;
}

export interface ScoreSyllable {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  provenance?: string;
  locked?: boolean;
  [key: string]: unknown;
}

export interface ScoreWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  provenance: "estimated" | "manual" | "aligned" | string;
  locked: boolean;
  syllables?: ScoreSyllable[];
  [key: string]: unknown;
}

export interface ScorePhrase {
  id: string;
  laneId: string;
  startMs: number;
  endMs: number;
  endEstimated: boolean;
  words: ScoreWord[];
  [key: string]: unknown;
}

export interface LyricVibeScore {
  version: "lyricvibe.score.v1";
  revision: number;
  offsetMs: number;
  source: ScoreSource;
  lyrics: ScoreLyrics;
  phrases: ScorePhrase[];
  [key: string]: unknown;
}

export interface ScoreOperation {
  type: string;
  [key: string]: unknown;
}

export interface AlignmentProposal {
  wordId: string;
  startMs: number;
  endMs: number;
  accepted?: boolean;
  evidenceId: string;
  confidence?: number;
  [key: string]: unknown;
}

export interface AlignmentReceipt {
  version: "lyricvibe.alignment.v1";
  proposals: AlignmentProposal[];
  [key: string]: unknown;
}

export interface ReviewPackage {
  version: "lyricvibe.review.v1";
  score: LyricVibeScore;
  receipt: AlignmentReceipt;
  audio: AudioMetadata;
  waveform: WaveformData;
}

export interface AudioMetadata {
  name: string;
  durationMs: number;
  sizeBytes: number;
  sha256: string;
}

export interface WaveformData {
  sampleRate: number;
  bucketMs: number;
  peaks: number[];
}

export interface PlaybackState {
  mediaMs: number;
  paused: boolean;
  loop: { startMs: number; endMs: number } | null;
}

export interface SelectionState {
  phraseId: string | null;
  wordId: string | null;
  syllableId: string | null;
}

export interface HistoryState {
  length: number;
  canUndo: boolean;
}

export interface EditorSnapshot {
  version: "lyricvibe.editor-state.v1";
  mode: EditorMode;
  score: LyricVibeScore | null;
  review: AlignmentProposal[];
  queuedWordIds: string[];
  playback: PlaybackState;
  analysis: unknown;
  alignmentDiagnostics: unknown | null;
  draft: boolean;
  busy: boolean;
  audioReady: boolean;
  selection: SelectionState;
  waveform: WaveformData | null;
  packageAudio: AudioMetadata | null;
  persistence: PersistenceState;
  notice: { message: string; kind: NoticeKind };
  clockSeen: boolean;
  history: HistoryState;
}

export type Immutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly Immutable<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Immutable<T[K]> }
      : T;

export interface ScoreCore {
  mediaKey(source: ScoreSource | Record<string, unknown>): string;
  validateScore(score: unknown): asserts score is LyricVibeScore;
  applyOperation(score: LyricVibeScore, operation: ScoreOperation, expectedRevision: number): LyricVibeScore;
  applyAlignment(score: LyricVibeScore, proposals: Array<AlignmentProposal | (AlignmentProposal & { accepted: true })>, expectedRevision: number): LyricVibeScore;
  validateAlignmentReceipt(score: LyricVibeScore, receipt: unknown): AlignmentReceipt;
}

export interface LocalReviewModule {
  validatePackage(input: unknown): ReviewPackage;
  validateMediaFile(expected: AudioMetadata, actual: AudioMetadata): true | void;
}

export interface ReviewQueue {
  version: "lyricvibe.review-queue.v1";
  expectedRevision: number;
  mediaKey: string;
  lyricsHash: string;
  proposals: AlignmentProposal[];
  wordIds: string[];
  selectedWordIds: string[];
}

export interface ReviewQueueModule {
  create(score: LyricVibeScore, proposals: AlignmentProposal[]): ReviewQueue;
  toggle(queue: ReviewQueue, wordId: string, checked: boolean, score: LyricVibeScore): ReviewQueue;
  selected(queue: ReviewQueue, score: LyricVibeScore): Array<AlignmentProposal & { accepted: true }>;
  diagnosticsForProposal(score: LyricVibeScore, proposal: AlignmentProposal): { kind: string; flags: string[] };
}

export interface RuntimeResponse {
  ok?: boolean;
  score?: LyricVibeScore;
  review?: AlignmentProposal[];
  diagnostics?: unknown;
  analysis?: unknown;
  status?: unknown;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

export interface RuntimeSender {
  id?: string;
  tab?: { id?: number };
}

export type RuntimeMessageListener = (message: unknown, sender: RuntimeSender) => void;

export interface EditorRuntime {
  id?: string;
  sendMessage(message: Record<string, unknown>): Promise<RuntimeResponse>;
  onMessage?: {
    addListener(listener: RuntimeMessageListener): void;
    removeListener?(listener: RuntimeMessageListener): void;
  };
}

export interface AudioElementLike {
  currentTime: number;
  duration: number;
  paused: boolean;
  src: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface RecordingFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface EditorControllerOptions {
  core: ScoreCore;
  localReview: LocalReviewModule;
  reviewQueue: ReviewQueueModule;
  runtime?: EditorRuntime;
  tabId?: number | null;
  requestedMediaKey?: string | null;
  mode?: EditorMode;
  audio?: AudioElementLike | null;
}

export interface EditorError {
  code: string;
  message: string;
}

export type EditorResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: EditorError };

export interface EditorDispatchRequest extends Record<string, unknown> {
  type: string;
  mediaKey: string;
  lyricsHash: string;
  expectedRevision: number;
}

export interface EditorController {
  getState(): Immutable<EditorSnapshot>;
  subscribe(listener: (snapshot: Immutable<EditorSnapshot>) => void): () => void;
  initialize(): Promise<EditorResult<{ score?: LyricVibeScore }>>;
  loadPackage(input: unknown): Promise<EditorResult<{ score: LyricVibeScore }>>;
  attachRecording(file: RecordingFileLike): Promise<EditorResult<{ audioReady: true }>>;
  importScore(input: unknown): Promise<EditorResult<{ score?: LyricVibeScore; review?: AlignmentProposal[] }>>;
  exportScore(): LyricVibeScore;
  acknowledgeExport(revision: number): boolean;
  selectPhrase(phraseId: string): boolean;
  selectWord(wordId: string, syllableId?: string): boolean;
  setDraft(value: boolean): void;
  selectProposal(wordId: string): boolean;
  acceptProposal(wordId: string, checked?: boolean): Promise<EditorResult<{ queuedWordIds: string[] }>>;
  acceptSelectedProposals(): Promise<EditorResult<{ score?: LyricVibeScore }>>;
  dispatch(request: EditorDispatchRequest): Promise<EditorResult<{ score?: LyricVibeScore; mediaMs?: number; queuedWordIds?: string[]; analysis?: unknown }>>;
  dispose(): void;
}
