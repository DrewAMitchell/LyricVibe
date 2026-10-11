import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, ChevronLeft, ChevronRight, Download, FolderOpen, Pause, Play, Repeat2, RotateCcw, Settings2, SlidersHorizontal, X, ZoomIn, ZoomOut, Crosshair, ShieldCheck, Check, FileJson, Waves } from 'lucide-react';
import { createEditorController } from './controller';
import { clock, intersectingLanes, movedInterval, phraseRange, positionPercent, rulerTicks } from './timeline';
import type { ViewRange, TimelineItem } from './timeline';
import type { EditorController, EditorSnapshot, EditorRuntime, Immutable, LyricVibeScore, ScoreCore, LocalReviewModule, ReviewQueueModule, ScoreWord, ScoreSyllable, ScoreOperation } from './types';

declare global {
  interface Window {
    LvScore: ScoreCore & { revealProgress(item: unknown, ms: number, offset?: number): number };
    LvLocalReview: LocalReviewModule;
    LvReviewQueue: ReviewQueueModule;
    LvEditor: Pick<EditorController, 'getState' | 'dispatch' | 'subscribe' | 'selectPhrase' | 'selectWord'>;
    chrome?: { runtime: EditorRuntime & { openOptionsPage?(): void } };
  }
}

const audio = document.getElementById('source-audio') as HTMLAudioElement;
const params = new URLSearchParams(location.search);
const rawTab = params.get('sourceTab') ?? params.get('tabId');
const tabId = rawTab !== null && /^\d+$/.test(rawTab) && Number.isSafeInteger(Number(rawTab)) ? Number(rawTab) : null;
const controller = createEditorController({ core: window.LvScore, localReview: window.LvLocalReview, reviewQueue: window.LvReviewQueue, runtime: window.chrome?.runtime, tabId, requestedMediaKey: params.get('mediaKey'), audio });
window.LvEditor = Object.freeze({ getState: controller.getState, dispatch: controller.dispatch, subscribe: controller.subscribe, selectPhrase: controller.selectPhrase, selectWord: controller.selectWord });
window.addEventListener('pagehide', event => { if (!event.persisted) controller.dispose(); });

type Snapshot = Immutable<EditorSnapshot>;
type Draft = { id: string; syllable: boolean; start: string; end: string; revision: number };
type Drag = { key: string; startMs: number; endMs: number };

function PreviewWord({ item, time, offset }: { item: Immutable<ScoreWord | ScoreSyllable>; time: number; offset: number }) {
  const at = time - offset, active = at >= item.startMs && at <= item.endMs;
  const progress = window.LvScore.revealProgress(item, time, offset);
  const effect = (item.effects as readonly { type: string; strength: number }[] | undefined)?.[0];
  const phase = (at - item.startMs) / 1000;
  const strength = active ? effect?.strength || 0 : 0;
  const transform = effect?.type === 'shake' ? `translate(${Math.sin(phase * 57) * strength * 3}px,${Math.sin(phase * 43) * strength * 2}px)`
    : effect?.type === 'tilt' ? `rotate(${Math.sin(phase * 11) * strength * 6}deg)`
    : effect?.type === 'pulse' ? `scale(${1 + Math.sin(phase * 9) * strength * .06})` : undefined;
  const children = 'syllables' in item ? item.syllables as readonly Immutable<ScoreSyllable>[] | undefined : undefined;
  return <span className={`preview-token ${active ? 'sung-word' : ''}`} style={{ visibility: at >= item.startMs ? 'visible' : 'hidden', clipPath: item.reveal ? `inset(0 ${(1 - progress) * 100}% 0 0)` : undefined, transform }}>
    {children?.length ? children.map(child => <PreviewWord key={child.id} item={child} time={time} offset={offset} />) : item.text}
  </span>;
}

function useController() {
  const [state, setState] = useState<Snapshot>(() => controller.getState());
  useEffect(() => controller.subscribe(setState), []);
  return state;
}

function Action({ children, label, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} title={label} aria-label={label}>{children}</button>;
}

function WheelInput({ onWheelStep, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { onWheelStep(event: WheelEvent, input: HTMLInputElement): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const callback = useRef(onWheelStep); callback.current = onWheelStep;
  useEffect(() => { const node = ref.current; if (!node) return; const wheel = (event: WheelEvent) => { if (document.activeElement !== node) return; event.preventDefault(); callback.current(event, node); }; node.addEventListener('wheel', wheel, { passive: false }); return () => node.removeEventListener('wheel', wheel); }, []);
  return <input {...props} ref={ref} />;
}

function SyllableDefinition({ word, revision, busy, globalDraft, commit, report }: { word: Immutable<ScoreWord>; revision: number; busy: boolean; globalDraft: boolean; commit(op: ScoreOperation, revision?: number): Promise<boolean>; report(message: string): void }) {
  const spelling = word.syllables?.map(child => child.text).join('|') || word.text;
  const [pending, setPending] = useState<{ text: string; revision: number } | null>(null);
  const applying = useRef(false);
  useEffect(() => { if (!globalDraft && !applying.current) setPending(null); }, [globalDraft]);
  async function apply(event: React.FormEvent) {
    event.preventDefault(); if (!pending) return;
    const parts = pending.text === '' ? [] : pending.text.split('|');
    if ((parts.length && parts.join('') !== word.text) || parts.some(part => !part) || parts.length > 32) { report('Use up to 32 nonempty syllables that join to the exact word spelling. Empty clears the split.'); return; }
    const draft = pending; applying.current = true; controller.setDraft(false);
    const success = await commit({ type: 'setWordSyllables', wordId: word.id, syllables: parts.map((text, index) => ({ id: `${word.id}-s-${crypto.randomUUID()}`, text, startMs: Math.round(word.startMs + index / parts.length * (word.endMs - word.startMs)), endMs: Math.round(word.startMs + (index + 1) / parts.length * (word.endMs - word.startMs)), provenance: 'estimated', locked: false, effects: [] })) }, draft.revision);
    if (success) setPending(null); else { setPending(draft); controller.setDraft(true); }
    applying.current = false;
  }
  return <details><summary>Define syllables…</summary><p>Insert | in the exact spelling. Initial times are estimates. Empty clears the split.</p><form onSubmit={event => void apply(event)}>
    <label className="sr-only" htmlFor="syllable-spelling">Exact word with syllable separators</label>
    <input id="syllable-spelling" value={pending?.text ?? spelling} disabled={busy || (globalDraft && !pending)} onChange={event => { setPending({ text: event.target.value, revision: pending?.revision ?? revision }); controller.setDraft(true); }} spellCheck={false} />
    <button type="submit" disabled={!pending || busy}>Apply estimated split</button>
    {pending && <button type="button" onClick={() => { setPending(null); controller.setDraft(false); }}>Discard split draft</button>}
  </form></details>;
}

function useWidth(ref: React.RefObject<HTMLElement>) {
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const observer = new ResizeObserver(() => setWidth(node.clientWidth)); observer.observe(node); setWidth(node.clientWidth); return () => observer.disconnect(); }, [ref]);
  return width;
}

function Waveform({ state, range, seek }: { state: Snapshot; range: ViewRange; seek(ms: number): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = useWidth(ref);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const dpr = Math.min(2, devicePixelRatio || 1); canvas.width = Math.max(1, width * dpr); canvas.height = 80 * dpr;
    const context = canvas.getContext('2d'); if (!context) return; context.scale(dpr, dpr); context.clearRect(0, 0, width, 80);
    context.strokeStyle = '#26302f'; context.beginPath(); context.moveTo(0, 40); context.lineTo(width, 40); context.stroke();
    const wave = state.waveform; if (!wave) return;
    context.strokeStyle = '#829b91'; context.lineWidth = 1;
    for (let x = 0; x < width; x += 2) {
      const from = Math.floor((range.startMs + x / width * (range.endMs - range.startMs)) / wave.bucketMs);
      const to = Math.ceil((range.startMs + (x + 2) / width * (range.endMs - range.startMs)) / wave.bucketMs);
      let peak = 0; for (let n = Math.max(0, from); n < Math.min(wave.peaks.length, Math.max(from + 1, to)); n++) peak = Math.max(peak, wave.peaks[n]);
      context.beginPath(); context.moveTo(x, 40 - peak * 34); context.lineTo(x, 40 + peak * 34); context.stroke();
    }
  }, [state.waveform, range.startMs, range.endMs, width]);
  return <div className="wave-wrap"><canvas ref={ref} aria-label="Original recording waveform. Use the ruler or position field to seek." onClick={event => { const box = event.currentTarget.getBoundingClientRect(); seek(range.startMs + (event.clientX - box.left) / box.width * (range.endMs - range.startMs)); }} />{!state.waveform && <span className="wave-unavailable">{state.mode === 'youtube' ? 'Source waveform is unavailable for this tab' : 'Choose the review package to show the waveform'}</span>}</div>;
}

function Timeline({ state, range, playhead, seek, commit }: { state: Snapshot; range: ViewRange; playhead: number; seek(ms: number): void; commit(op: ScoreOperation, revision?: number): Promise<boolean> }) {
  const ref = useRef<HTMLDivElement>(null); const width = useWidth(ref);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && cancelDrag.current) { event.preventDefault(); cancelDrag.current(); } }; window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel); }, []);
  const [drag, setDrag] = useState<Drag | null>(null);
  const score = state.score!;
  const lanes = useMemo(() => intersectingLanes(score, range), [score, range.startMs, range.endMs]);
  const ticks = rulerTicks(range, width);
  const percentage = positionPercent(playhead, range);

  function startDrag(event: React.PointerEvent<HTMLButtonElement>, record: TimelineItem) {
    if (event.button !== 0 || state.busy || state.draft) return;
    if (!controller.selectWord(record.word.id, record.syllable ? record.item.id : undefined)) return;
    event.preventDefault(); const node = event.currentTarget;
    const edge = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
    const bounds = node.getBoundingClientRect(); const right = event.clientX - bounds.left;
    const mode = edge || (right < Math.min(10, bounds.width / 3) ? 'start' : right > bounds.width - Math.min(10, bounds.width / 3) ? 'end' : 'move');
    const startX = event.clientX, revision = score.revision;
    const rowWidth = node.parentElement!.getBoundingClientRect().width;
    const low = record.syllable ? record.word.startMs : record.phrase.startMs;
    const high = record.syllable ? record.word.endMs : record.phrase.endMs;
    let latest = { startMs: record.item.startMs, endMs: record.item.endMs };
    let changed = false;
    node.setPointerCapture(event.pointerId); controller.setDraft(true);
    document.body.classList.add('timing-drag');
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) / rowWidth * (range.endMs - range.startMs);
      if (Math.abs(moveEvent.clientX - startX) > 2) changed = true;
      latest = movedInterval(record.item, delta, mode, low, high);
      setDrag({ key: record.item.id, ...latest });
    };
    const clean = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', finish); node.removeEventListener('pointercancel', cancel); node.removeEventListener('lostpointercapture', cancel); cancelDrag.current = null; if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId); document.body.classList.remove('timing-drag'); controller.setDraft(false); setDrag(null); };
    const cancel = () => clean();
    const finish = async () => { clean(); if (changed) await commit({ type: record.syllable ? 'setSyllableTiming' : 'setWordTiming', [record.syllable ? 'syllableId' : 'wordId']: record.item.id, ...latest }, revision); };
    cancelDrag.current = clean;
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', finish, { once: true }); node.addEventListener('pointercancel', cancel, { once: true }); node.addEventListener('lostpointercapture', cancel, { once: true });
  }

  return <div className="timeline-viewport" ref={ref} data-testid="phrase-timeline">
    <div className="ruler" role="group" aria-label="Source-time ruler">
      {ticks.map(ms => <button key={ms} className="ruler-tick" style={{ left: `${positionPercent(ms, range)}%` }} onClick={() => seek(ms)} title={`Seek to ${clock(ms, true)}`}>{clock(ms, range.endMs - range.startMs < 4000)}</button>)}
    </div>
    <Waveform state={state} range={range} seek={seek} />
    <div className="spectrum-note"><Waves size={13} /><span>Source spectrogram · not in this package</span></div>
    <div className="vocal-lanes">
      {lanes.map(lane => <section className="vocal-lane" key={lane.id} aria-label={`${lane.label} timing lane`}>
        <div className="lane-caption"><span>{lane.label}</span><span>{lane.role === 'backing' ? 'Independent backing part' : 'Words · actual syllables below'}</span></div>
        <div className="lane-grid" style={{ height: `${Math.max(76, lane.rows * 50 + 16)}px` }}>
          {ticks.map(ms => <i key={ms} className="grid-line" style={{ left: `${positionPercent(ms, range)}%` }} />)}
          {lane.items.map(record => {
            const item = record.item, preview = drag?.key === item.id ? drag : item;
            const left = positionPercent(preview.startMs + score.offsetMs, range), end = positionPercent(preview.endMs + score.offsetMs, range);
            const selected = record.syllable ? state.selection.syllableId === item.id : state.selection.wordId === item.id && !state.selection.syllableId;
            const active = playhead >= item.startMs + score.offsetMs && playhead <= item.endMs + score.offsetMs;
            return <button key={item.id} data-word-id={record.word.id} data-item-id={item.id} data-start-ms={item.startMs} data-end-ms={item.endMs} className={`lyric-block ${item.provenance || 'estimated'} ${record.syllable ? 'syllable-block' : ''} ${selected ? 'selected' : ''} ${active ? 'active' : ''}`} style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(.35, Math.min(100, end) - Math.max(0, left))}%`, top: `${record.row * 50 + 8}px` }} onPointerDown={event => startDrag(event, record)} onClick={() => controller.selectWord(record.word.id, record.syllable ? item.id : undefined)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || state.draft || state.busy) return;
              event.preventDefault(); const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.altKey ? 1 : event.shiftKey ? 100 : 10);
              const interval = movedInterval(item, delta, event.ctrlKey ? 'end' : 'move', record.syllable ? record.word.startMs : record.phrase.startMs, record.syllable ? record.word.endMs : record.phrase.endMs);
              void commit({ type: record.syllable ? 'setSyllableTiming' : 'setWordTiming', [record.syllable ? 'syllableId' : 'wordId']: item.id, ...interval });
            }} aria-label={`${record.syllable ? 'Syllable' : 'Word'} ${item.text}, ${clock(item.startMs + score.offsetMs, true)} to ${clock(item.endMs + score.offsetMs, true)}, ${item.provenance || 'estimated'}${item.locked ? ', protected from automatic alignment' : ''}`} aria-pressed={selected} title={`${item.text} · ${Math.round(preview.startMs + score.offsetMs)}–${Math.round(preview.endMs + score.offsetMs)} ms\nDrag to move; drag an edge to resize. Arrow keys nudge; Ctrl+arrow changes end.`}>
              <span className="resize-edge start" data-edge="start" /><span className="block-text">{item.text}</span><span className="resize-edge end" data-edge="end" />
            </button>;
          })}
          {lane.items.filter(record => !record.syllable).map(record => {
            const proposal = state.review.find(candidate => candidate.wordId === record.word.id); if (!proposal) return null;
            const start = positionPercent(proposal.startMs + score.offsetMs, range), end = positionPercent(proposal.endMs + score.offsetMs, range);
            if (end < 0 || start > 100) return null;
            return <div key={`proposal-${record.word.id}`} className="proposal-boundary" role="img" aria-label={`Unverified proposal for ${record.word.text}, ${Math.round(proposal.startMs + score.offsetMs)} to ${Math.round(proposal.endMs + score.offsetMs)} milliseconds`} style={{ left: `${Math.max(0, start)}%`, width: `${Math.max(.35, Math.min(100, end) - Math.max(0, start))}%`, top: `${record.row * 50 + 46}px` }} />;
          })}
        </div>
      </section>)}
    </div>
    {percentage >= 0 && percentage <= 100 && <div className="workspace-playhead" style={{ left: `${percentage}%` }} aria-hidden="true"><span /></div>}
  </div>;
}

function App() {
  const state = useController();
  const [filesOpen, setFilesOpen] = useState(false), [advanced, setAdvanced] = useState(false);
  const [inspector, setInspector] = useState(() => innerWidth > 800);
  const [inspectorWidth, setInspectorWidth] = useState(264);
  const [zoom, setZoom] = useState(1), [center, setCenter] = useState<number | undefined>();
  const [position, setPosition] = useState(''), [draft, setDraft] = useState<Draft | null>(null);
  const [fileError, setFileError] = useState(''), [actionError, setActionError] = useState('');
  const [exportRevision, setExportRevision] = useState<number | null>(null);
  const [viewTime, setViewTime] = useState(state.playback.mediaMs);
  const applyingDraft = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null), rootRef = useRef<HTMLDivElement>(null);
  const score = state.score, phrase = score?.phrases.find(p => p.id === state.selection.phraseId) || score?.phrases[0];
  const phraseIndex = phrase && score ? score.phrases.findIndex(p => p.id === phrase.id) : -1;
  const found = score?.phrases.flatMap(p => p.words.map(word => ({ word, phrase: p }))).find(row => row.word.id === state.selection.wordId);
  const word = found?.word;
  const item: Immutable<ScoreWord | ScoreSyllable> | undefined = word?.syllables?.find(s => s.id === state.selection.syllableId) || word;
  const isSyllable = Boolean(state.selection.syllableId);
  const range = score && phrase ? phraseRange(score, phrase, zoom, center) : { startMs: 0, endMs: 10000 };
  const paused = state.mode === 'local-recording' && state.audioReady ? audio.paused : state.playback.paused;
  const ready = Boolean(score && (state.mode === 'youtube' ? state.clockSeen : state.audioReady));

  useEffect(() => { void (async () => { await controller.initialize(); const seed = document.getElementById('local-review-seed'); if (seed && state.mode === 'local-recording') { try { const value = JSON.parse(seed.textContent || '{}'); const result = await controller.loadPackage(value.package); if (!result.ok) throw Error(result.error.message); setFilesOpen(true); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); } } })(); const close = (event: BeforeUnloadEvent) => { const current = controller.getState(); if (current.draft || current.busy || current.persistence !== 'saved') { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', close); return () => window.removeEventListener('beforeunload', close); }, []);
  useEffect(() => { if (filesOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [filesOpen]);
  useEffect(() => { setZoom(1); setCenter(undefined); }, [phrase?.id]);
  useEffect(() => { if (!state.draft && !applyingDraft.current) { setDraft(null); } }, [state.selection.wordId, state.selection.syllableId, score?.revision, state.draft]);
  useEffect(() => {
    const current = () => state.mode === 'local-recording' && state.audioReady ? audio.currentTime * 1000 : state.playback.mediaMs;
    setViewTime(current());
    if (paused || state.mode !== 'local-recording' || !state.audioReady) return;
    let frame = 0, last = 0; const tick = (stamp: number) => { if (stamp - last >= 1000 / 30) { setViewTime(current()); last = stamp; } frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [state.mode, state.audioReady, state.playback.mediaMs, paused]);

  function envelope(type: string, payload: Record<string, unknown> = {}, revision = score?.revision) {
    if (!score || revision === undefined) throw Error('Open a score first.');
    return { type, mediaKey: window.LvScore.mediaKey(score.source), lyricsHash: score.lyrics.contentHash, expectedRevision: revision, ...payload };
  }
  async function request(type: string, payload: Record<string, unknown> = {}, revision?: number) {
    try { const result = await controller.dispatch(envelope(type, payload, revision)); if (!result.ok) throw Error(result.error.message); setActionError(''); return true; }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); return false; }
  }
  const commit = (operation: ScoreOperation, revision?: number) => request('LV_SCORE_OPERATION', { operation }, revision);
  const transport = (action: string, loop?: unknown) => request('LV_SCORE_TRANSPORT', { action, ...(loop ? { loop } : {}) });
  const seek = (ms: number) => { void request('LV_SCORE_SEEK', { mediaMs: Math.max(0, Math.min(score?.source.durationMs || Infinity, Math.round(ms))) }); };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,[contenteditable],dialog')) return;
      if (event.code === 'Space' && ready && !(event.target instanceof HTMLElement && event.target.closest('button,summary,a'))) { event.preventDefault(); void transport(paused ? 'play' : 'pause'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void request('LV_SCORE_UNDO'); }
      if (event.key === 'Escape') { if (draft || state.draft) { controller.setDraft(false); setDraft(null); } else void transport('pause'); }
      if (event.key.toLowerCase() === 'i') setInspector(value => !value);
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  function changeDraft(edge: 'start' | 'end', value: string) {
    if (!item || !score) return;
    const next = draft || { id: item.id, syllable: isSyllable, start: String(Math.round(item.startMs + score.offsetMs)), end: String(Math.round(item.endMs + score.offsetMs)), revision: score.revision };
    setDraft({ ...next, [edge]: value }); controller.setDraft(true);
  }
  async function applyDraft(event?: React.FormEvent) {
    event?.preventDefault(); if (!draft || !score) return;
    const startMs = Number(draft.start) - score.offsetMs, endMs = Number(draft.end) - score.offsetMs;
    if (!draft.start.trim() || !draft.end.trim() || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) { setActionError('Enter whole milliseconds for both boundaries.'); return; }
    const pending = draft; applyingDraft.current = true;
    controller.setDraft(false);
    if (await commit({ type: draft.syllable ? 'setSyllableTiming' : 'setWordTiming', [draft.syllable ? 'syllableId' : 'wordId']: draft.id, startMs, endMs }, draft.revision)) setDraft(null);
    else { setDraft(pending); controller.setDraft(true); }
    applyingDraft.current = false;
  }

  async function readFile(event: React.ChangeEvent<HTMLInputElement>, action: 'package' | 'score' | 'recording') {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setFileError('');
    try {
      if (action !== 'recording' && file.size > 5 * 1024 * 1024) throw Error('This JSON exceeds the 5 MiB limit.');
      const result = action === 'recording' ? await controller.attachRecording(file) : action === 'package' ? await controller.loadPackage(await file.text()) : await controller.importScore(JSON.parse(await file.text()));
      if (!result.ok) throw Error(result.error.message);
    } catch (cause) { setFileError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function download() {
    try {
      const exported = controller.exportScore(), url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `lyricvibe-${exported.source.videoId}-r${exported.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportRevision(exported.revision); setFileError('');
    } catch (cause) { setFileError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const visiblePreview = score?.phrases.filter(p => viewTime >= p.startMs + score.offsetMs && viewTime <= p.endMs + score.offsetMs).slice(0, 4) || [];
  const proposal = state.review.find(p => p.wordId === word?.id);
  const analysis = state.analysis as { state?: string; message?: string } | null;

  return <div className="lyric-workspace" ref={rootRef} style={{ '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}>
    <a href="#phrase-workspace" className="skip-link">Skip to lyric timeline</a>
    <header className="workspace-header"><div className="product-mark"><AudioLines size={24} /><span>LyricVibe<small>LYRIC WORKSPACE</small></span></div><div className="song-identity"><h1>{score?.source.title || 'Open your song'}</h1><p>{score ? `${score.source.artist || 'YouTube'} · ${score.source.videoId}` : 'Listen. Move a word. Replay.'}</p></div><span className="source-mode">{state.mode === 'youtube' ? 'YouTube' : 'Local recording'}</span><button className="header-files" onClick={() => setFilesOpen(true)}><FolderOpen size={16} /><span>Files</span></button></header>
    <section className="workspace-transport" aria-label="Playback and editing controls"><button className="primary play-control" disabled={!ready || state.busy} onClick={() => void transport(paused ? 'play' : 'pause')}>{paused ? <Play size={17} fill="currentColor" /> : <Pause size={17} fill="currentColor" />}<span>{paused ? 'Play' : 'Pause'}</span></button><output className="time-display" aria-label="Current source time">{clock(viewTime, true)}</output><div className="transport-divider" /><Action label="Seek to selected phrase start" disabled={!ready || !phrase} onClick={() => phrase && seek(phrase.startMs + (score?.offsetMs || 0))}><Crosshair size={17} /></Action><Action label="Loop selected phrase" aria-pressed={Boolean(state.playback.loop)} disabled={!ready || !phrase} onClick={() => phrase && void transport(state.playback.loop ? 'clearLoop' : 'setLoop', { startMs: Math.max(0, phrase.startMs + (score?.offsetMs || 0)), endMs: phrase.endMs + (score?.offsetMs || 0) })}><Repeat2 size={17} /></Action><Action label="Undo timing edit · Ctrl+Z" disabled={state.busy || state.draft || !state.history.canUndo} onClick={() => void request('LV_SCORE_UNDO')}><RotateCcw size={17} /><span className="wide-label">Undo</span></Action><form className="seek-form" onSubmit={event => { event.preventDefault(); if (position.trim() && Number.isFinite(Number(position))) { seek(Number(position) * 1000); setPosition(''); } }}><label><span className="sr-only">Seek to source seconds</span><input aria-label="Seek to source seconds" value={position} onChange={event => setPosition(event.target.value)} placeholder="Go to sec…" inputMode="decimal" /></label><button type="submit" disabled={!ready}>Go</button></form><span className="transport-fill" /><span className={`save-indicator ${state.persistence !== 'saved' ? 'unsaved' : ''}`}>{state.persistence === 'saved' ? 'Saved' : state.persistence === 'export-requested' ? 'Confirm export' : 'Unsaved edits'}</span><button disabled={!score || state.draft || state.busy} onClick={() => { setFilesOpen(true); download(); }}><Download size={16} /><span className="wide-label">Save copy</span></button></section>
    <div className={`workspace-notice ${actionError || state.notice.kind === 'error' ? 'error' : ''}`} role="status" aria-live="polite">{actionError || state.notice.message || 'Open the review package, then choose its recording.'}</div>
    {score && phrase ? <>
      <nav className="phrase-navigation" aria-label="Phrase navigation"><Action label="Previous phrase" disabled={phraseIndex <= 0 || state.draft} onClick={() => controller.selectPhrase(score.phrases[phraseIndex - 1].id)}><ChevronLeft size={18} /></Action><label className="phrase-picker"><span className="sr-only">Selected phrase</span><select value={phrase.id} onChange={event => controller.selectPhrase(event.target.value)} disabled={state.draft}>{score.phrases.map((p, index) => <option value={p.id} key={p.id}>{String(index + 1).padStart(2, '0')} · {p.words.map(w => w.text).join(' ')}</option>)}</select></label><Action label="Next phrase" disabled={phraseIndex >= score.phrases.length - 1 || state.draft} onClick={() => controller.selectPhrase(score.phrases[phraseIndex + 1].id)}><ChevronRight size={18} /></Action><span className="phrase-count">{phraseIndex + 1} / {score.phrases.length}</span><div className="zoom-controls"><Action label="Zoom out to phrase" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z / 1.5))}><ZoomOut size={16} /></Action><button onClick={() => { setZoom(1); setCenter(undefined); }}>Fit</button><Action label="Zoom into selected word" disabled={zoom >= 16} onClick={() => { setCenter(item ? (item.startMs + item.endMs) / 2 + score.offsetMs : viewTime); setZoom(z => Math.min(16, z * 1.5)); }}><ZoomIn size={16} /></Action></div><Action label={inspector ? 'Collapse timing inspector · I' : 'Open timing inspector · I'} aria-expanded={inspector} onClick={() => setInspector(value => !value)}><SlidersHorizontal size={17} /><span className="wide-label">Edit</span></Action></nav>
      <main id="phrase-workspace" className={`focused-workspace ${inspector ? '' : 'inspector-collapsed'}`}>
        <section className="phrase-canvas" aria-label="Focused phrase editor"><div className="playback-preview" aria-label="Lyrics at source playhead">{visiblePreview.length ? visiblePreview.map(p => <div key={p.id} className={p.laneId === 'backing' ? 'backing-preview' : ''} style={{ opacity: viewTime > p.endMs + score.offsetMs - Number(p.fadeOutMs || 0) && Number(p.fadeOutMs) > 0 ? Math.max(0, (p.endMs + score.offsetMs - viewTime) / Number(p.fadeOutMs)) : 1 }}>{p.words.map(w => <React.Fragment key={w.id}><PreviewWord item={w} time={viewTime} offset={score.offsetMs} />{' '}</React.Fragment>)}</div>) : <span className="silence-label">{paused ? 'Ready to listen' : 'Instrumental'}</span>}</div><Timeline state={state} range={range} playhead={viewTime} seek={seek} commit={commit} /><div className="phrase-word-strip" aria-label="Words in selected phrase">{phrase.words.map(w => <button key={w.id} className={state.selection.wordId === w.id ? 'selected' : ''} aria-pressed={state.selection.wordId === w.id} onClick={() => controller.selectWord(w.id)}>{w.text}</button>)}</div><footer className="canvas-footer"><span>Drag to move · edges to stretch · arrows to nudge</span><span>{clock(range.startMs, true)}–{clock(range.endMs, true)} · source time</span></footer></section>
        <div className="dock-resizer" role="separator" tabIndex={inspector ? 0 : -1} aria-label="Resize timing inspector" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={inspectorWidth} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setInspectorWidth(value => Math.max(180, Math.min(400, value + (event.key === 'ArrowLeft' ? 10 : -10)))); } }} onPointerDown={event => { const node = event.currentTarget; node.setPointerCapture(event.pointerId); const start = event.clientX, original = inspectorWidth; node.onpointermove = move => setInspectorWidth(Math.max(180, Math.min(400, original + start - move.clientX))); node.onpointerup = node.onpointercancel = () => { node.onpointermove = null; }; }} />
        <aside className="timing-inspector" aria-label="Word and syllable timing"><button className="dock-rail" onClick={() => setInspector(true)} aria-label="Expand timing inspector"><SlidersHorizontal size={18} /><span>Edit</span></button><div className="inspector-content"><div className="inspector-top"><span>TIMING</span><Action label="Collapse timing inspector" onClick={() => setInspector(false)}><ChevronRight size={17} /></Action></div>{item && word ? <><h2>{item.text}</h2><div className="timing-status"><span className={`provenance-dot ${item.provenance || 'estimated'}`} />{item.provenance === 'manual' ? 'Manually timed' : item.provenance === 'aligned' ? 'Model aligned · review' : 'Estimated timing'}{item.locked && <ShieldCheck size={14} aria-label="Protected from automatic alignment" />}</div><p className="inspector-help">{isSyllable ? `Syllable inside “${word.text}”` : 'Move the block or enter exact boundaries.'}</p><form onSubmit={applyDraft} className="timing-form">{(['start', 'end'] as const).map(edge => <label key={edge}>{edge === 'start' ? 'Start' : 'End'} <span>ms</span><WheelInput disabled={state.busy || (state.draft && !draft)} inputMode="numeric" aria-label={`${edge === 'start' ? 'Start' : 'End'} source milliseconds`} value={draft?.id === item.id ? draft[edge] : String(Math.round(item[edge === 'start' ? 'startMs' : 'endMs'] + score.offsetMs))} onChange={event => changeDraft(edge, event.target.value)} onWheelStep={event => { const step = event.altKey ? 1 : event.shiftKey ? 1000 : 100; const value = Number(draft?.[edge] ?? item[edge === 'start' ? 'startMs' : 'endMs'] + score.offsetMs); changeDraft(edge, String(value + (event.deltaY < 0 ? step : -step))); }} /><button type="button" className="boundary-here" disabled={!ready || !paused} onClick={() => changeDraft(edge, String(Math.round(viewTime)))}>Use playhead</button></label>)}<button type="submit" className="primary" disabled={!draft || state.busy}>Apply timing</button>{draft && <button type="button" onClick={() => { controller.setDraft(false); setDraft(null); }}>Discard draft</button>}</form><p className="field-hint">Focus + wheel: 100ms · Shift: 1s · Alt: 1ms</p><label className="protection-toggle"><input type="checkbox" checked={Boolean(item.locked)} disabled={state.draft || state.busy} onChange={event => void commit({ type: isSyllable ? 'setSyllableLock' : 'setWordLock', [isSyllable ? 'syllableId' : 'wordId']: item.id, locked: event.target.checked })} /><span>Protect from automatic alignment<small>Manual edits always remain available.</small></span></label>
          <section className="syllable-section"><h3>Syllables</h3>{word.syllables?.length ? <div className="syllable-chips"><button className={!isSyllable ? 'selected' : ''} onClick={() => controller.selectWord(word.id)}>Whole word</button>{word.syllables.map(s => <button key={s.id} className={state.selection.syllableId === s.id ? 'selected' : ''} onClick={() => controller.selectWord(word.id, s.id)}>{s.text}</button>)}</div> : <p>No subdivisions authored yet.</p>}<SyllableDefinition key={word.id} word={word} revision={score.revision} busy={state.busy} globalDraft={state.draft} commit={commit} report={setActionError} /></section>
          {proposal && <section className="proposal-section"><h3>Unverified proposal</h3><p>{Math.round(proposal.startMs + score.offsetMs)}–{Math.round(proposal.endMs + score.offsetMs)}ms</p><button disabled={!ready} onClick={async () => { await transport('pause'); seek(Math.max(0, proposal.startMs + score.offsetMs - 350)); void transport('play'); }}>Audition proposal</button><label><input type="checkbox" checked={state.queuedWordIds.includes(word.id)} onChange={event => { void controller.acceptProposal(word.id, event.target.checked).then(result => { if (!result.ok) setActionError(result.error.message); }); }} />Keep for reviewed batch</label></section>}
          <details className="appearance-settings"><summary>Text &amp; appearance</summary><label>Word effect<select disabled={state.draft} value={((word.effects as { type: string }[] | undefined)?.[0]?.type) || 'none'} onChange={event => void commit({ type: 'setWordEffect', wordId: word.id, effect: event.target.value === 'none' ? null : { type: event.target.value, strength: .3 } })}><option value="none">None</option><option value="shake">Shake</option><option value="tilt">Tilt</option><option value="pulse">Pulse</option></select></label><label>Word reveal<select disabled={state.draft} value={(word.reveal as { easing?: string } | undefined)?.easing || 'instant'} onChange={event => void commit({ type: 'setWordReveal', wordId: word.id, reveal: event.target.value === 'instant' ? null : { type: 'sweep', easing: event.target.value } })}><option value="instant">Instant</option><option value="linear">Sweep · linear</option><option value="ease-out">Sweep · ease out</option><option value="ease-in-out">Sweep · ease in/out</option></select></label></details>
        </> : <p>Select a word to adjust its timing.</p>}</div></aside>
      </main>
      <section className="analysis-footer"><span><span className="status-light" />{state.mode === 'local-recording' ? state.audioReady ? 'Original recording ready' : 'Choose the original recording' : state.clockSeen ? 'Source clock connected' : 'Waiting for source clock'}</span><span className="revision-label">r{score.revision} · {state.review.length} unverified proposals</span>{state.queuedWordIds.length > 0 && <button disabled={state.busy || state.draft} onClick={() => void controller.acceptSelectedProposals()}>Apply {state.queuedWordIds.length} reviewed</button>}<button onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}><Settings2 size={15} /><span>Analysis &amp; offset</span></button></section>
      {advanced && <section className="advanced-panel"><label>Global offset · ms<WheelInput defaultValue={score.offsetMs} key={score.offsetMs} inputMode="numeric" onKeyDown={event => { if (event.key === 'Enter') { const offsetMs = Number(event.currentTarget.value); if (Number.isSafeInteger(offsetMs)) void commit({ type: 'setOffset', offsetMs }); else setActionError('Offset must be whole milliseconds.'); } }} onWheelStep={(event, input) => { const value = Number(input.value) || 0; input.value = String(value + (event.deltaY < 0 ? 1 : -1) * (event.altKey ? 1 : event.shiftKey ? 1000 : 100)); }} /><small>Type or scroll; Enter applies.</small></label><div><strong>Native timing analysis</strong><p>{analysis?.message || analysis?.state || 'Optional companion · audio stays local'}</p><div className="analysis-actions"><button disabled={state.mode !== 'youtube' || state.draft || state.busy} onClick={() => void request('LV_NATIVE_ANALYSIS_START')}>Start analysis</button><button disabled={state.mode !== 'youtube'} onClick={() => void request('LV_NATIVE_ANALYSIS_STOP')}>Stop</button><button disabled={state.mode !== 'youtube'} onClick={() => void request('LV_NATIVE_ANALYSIS_STATUS')}>Refresh</button></div></div>{window.chrome?.runtime.openOptionsPage && <button onClick={() => window.chrome?.runtime.openOptionsPage?.()}>Extension settings</button>}</section>}
    </> : <main className="empty-workspace"><AudioLines size={42} strokeWidth={1.25} /><h2>Your song, one phrase at a time.</h2><p>Open a review package and its original recording.<br />Then import your saved timing score to continue editing.</p><button className="primary" onClick={() => setFilesOpen(true)}><FolderOpen size={17} />Open recording…</button><span>Local playback · no audio upload</span></main>}
    <dialog ref={dialog} className="files-dialog" onCancel={() => setFilesOpen(false)} onClose={() => setFilesOpen(false)}><header><h2>Song files</h2><Action label="Close song files" onClick={() => setFilesOpen(false)}><X size={19} /></Action></header><p>Keep your original recording and timing score together.</p><div className="file-steps"><label className="file-step"><FileJson size={19} /><span><strong>1. Review package</strong><small>{state.packageAudio ? 'Package loaded' : 'Contains the score and source waveform'}</small></span><input type="file" accept=".json,application/json" aria-label="Open review package" onChange={event => void readFile(event, 'package')} /></label><label className={`file-step ${!state.packageAudio ? 'disabled' : ''}`}><AudioLines size={19} /><span><strong>2. Original recording</strong><small>{state.audioReady ? 'Exact recording verified' : state.packageAudio?.name || 'Choose the matching MP4, WAV or audio file'}</small></span><input type="file" disabled={!state.packageAudio || state.busy} accept="audio/*,video/*,.mp4,.wav,.mp3,.m4a" aria-label="Choose original recording" onChange={event => void readFile(event, 'recording')} /></label><label className={`file-step ${!score ? 'disabled' : ''}`}><FolderOpen size={19} /><span><strong>3. Saved timings · optional</strong><small>Resume your aligned score, or import a receipt</small></span><input type="file" disabled={!score || state.busy} accept=".json,application/json" aria-label="Import saved timing score or alignment receipt" onChange={event => void readFile(event, 'score')} /></label></div><div className="export-section"><button disabled={!score || state.draft || state.busy} onClick={download}><Download size={16} />Save score copy…</button>{exportRevision !== null && <div className="export-confirm"><p>Download requested for revision {exportRevision}. Confirm after the file is saved.</p><button disabled={exportRevision !== score?.revision} onClick={() => { if (controller.acknowledgeExport(exportRevision)) { setExportRevision(null); setFileError(''); } }}><Check size={16} />I saved the file</button></div>}</div>{fileError && <p role="alert" className="file-error">{fileError}</p>}<footer><button className="primary" onClick={() => setFilesOpen(false)}>Return to timeline</button></footer></dialog>
  </div>;
}

createRoot(document.getElementById('workspace-root')!).render(<App />);
