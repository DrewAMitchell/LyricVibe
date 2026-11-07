import type { Immutable, LyricVibeScore, ScorePhrase, ScoreWord, ScoreSyllable } from './types';

export interface ViewRange { startMs: number; endMs: number }
export type TimedItem = Immutable<ScoreWord | ScoreSyllable>;
export interface TimelineItem { phrase: Immutable<ScorePhrase>; word: Immutable<ScoreWord>; item: TimedItem; row: number; syllable: boolean }
export interface TimelineLane { id: string; label: string; role: string; rows: number; items: TimelineItem[] }

/** The timeline always uses the full source clock, including initial and trailing silence. */
export function songRange(score: Immutable<LyricVibeScore>): ViewRange {
  const end = Math.max(1000, score.source.durationMs || 0, ...score.phrases.map(p => p.endMs + score.offsetMs));
  return { startMs: 0, endMs: end };
}

/** A playback-focused window without changing the underlying song range. */
export function phraseWindow(score: Immutable<LyricVibeScore>, sourceMs: number, count: 3 | 5) {
  const lead = (score.lanes as readonly { id: string; role: string }[]).find(lane => lane.role === 'lead')?.id;
  const primary = score.phrases.filter(phrase => phrase.laneId === lead);
  const phrases = [...(primary.length ? primary : score.phrases)].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (!phrases.length) return null;
  const time = sourceMs - score.offsetMs;
  let index = 0;
  for (let i = 0; i < phrases.length && phrases[i].startMs <= time; i++) index = i;
  const begin = Math.max(0, Math.min(phrases.length - count, index - Math.floor(count / 2)));
  const window = phrases.slice(begin, begin + count);
  const start = Math.max(0, window[0].startMs + score.offsetMs);
  const end = Math.max(start + 250, ...window.map(phrase => phrase.endMs + score.offsetMs));
  const padding = Math.max(150, (end - start) * .035);
  return { phraseId: phrases[index].id, key: window.map(phrase => phrase.id).join(':'), startMs: Math.max(0, start - padding), endMs: end + padding };
}

export function intersectingLanes(score: Immutable<LyricVibeScore>, range: ViewRange): TimelineLane[] {
  const laneDefs = score.lanes as readonly { id: string; label: string; role: string }[];
  return laneDefs.map(lane => {
    const words = score.phrases.filter(p => p.laneId === lane.id)
      .flatMap(phrase => phrase.words.map(word => ({ phrase, word })))
      .filter(({ word }) => !word.excluded && word.endMs + score.offsetMs >= range.startMs && word.startMs + score.offsetMs <= range.endMs)
      .sort((a, b) => a.word.startMs - b.word.startMs || a.word.id.localeCompare(b.word.id));
    const occupied: number[] = [];
    const items: TimelineItem[] = [];
    for (const { phrase, word } of words) {
      const hasChildren = Boolean(word.syllables?.length);
      let row = occupied.findIndex((end, index) => end <= word.startMs && (!hasChildren || (occupied[index + 1] ?? -Infinity) <= word.startMs));
      if (row < 0) row = occupied.length;
      occupied[row] = word.endMs;
      // Reserve the adjacent row for the word's actual child intervals.
      if (hasChildren) occupied[row + 1] = word.endMs;
      items.push({ phrase, word, item: word, row, syllable: false });
      for (const child of word.syllables || []) items.push({ phrase, word, item: child, row: row + 1, syllable: true });
    }
    return { ...lane, rows: Math.max(1, occupied.length), items };
  }).filter(lane => lane.items.length || lane.role === 'lead');
}

export function positionPercent(ms: number, range: ViewRange): number {
  return (ms - range.startMs) / (range.endMs - range.startMs) * 100;
}

export function movedInterval(item: TimedItem, deltaMs: number, edge: 'move' | 'start' | 'end', low: number, high: number) {
  const length = item.endMs - item.startMs;
  if (edge === 'move') {
    const startMs = Math.round(Math.max(low, Math.min(high - length, item.startMs + deltaMs)));
    return { startMs, endMs: startMs + length };
  }
  return edge === 'start'
    ? { startMs: Math.round(Math.max(low, Math.min(item.endMs, item.startMs + deltaMs))), endMs: item.endMs }
    : { startMs: item.startMs, endMs: Math.round(Math.min(high, Math.max(item.startMs, item.endMs + deltaMs))) };
}

export function rulerTicks(range: ViewRange, width: number) {
  const count = Math.max(2, Math.floor(width / 96));
  const raw = (range.endMs - range.startMs) / count;
  const step = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000].find(n => n >= raw) || Math.ceil(raw / 60000) * 60000;
  const ticks = [];
  for (let ms = Math.ceil(range.startMs / step) * step; ms <= range.endMs; ms += step) ticks.push(ms);
  return ticks;
}

export function clock(ms: number, precise = false) {
  const safe = Math.max(0, ms);
  return `${Math.floor(safe / 60000)}:${String(Math.floor(safe / 1000) % 60).padStart(2, '0')}${precise ? '.' + String(Math.floor(safe) % 1000).padStart(3, '0') : ''}`;
}
