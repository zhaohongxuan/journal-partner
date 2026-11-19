/**
 * Pure data layer for the yearly stats view.
 *
 * Kept Obsidian-free so it can be unit-tested in isolation. The view layer
 * is responsible for IO (reading daily notes, resolving dates) and feeds
 * the raw section text into these helpers.
 *
 * Important: the stats layer does NOT depend on `- HH:MM` formatting.
 * Older journals written as plain paragraphs (or list items without
 * timestamps) are counted just the same — only the "most common hour"
 * KPI requires a timestamp, and it gracefully degrades to "—" when no
 * timestamps exist.
 */

import { timestampToSeconds } from './time-format';

// ── Types ──────────────────────────────────────────────────────────────────

/** Stats for a single day. */
export interface DayStats {
  /** ISO key in `YYYY-MM-DD` form. */
  key: string;
  /** Number of "memos" detected — list items + plain paragraphs. */
  entryCount: number;
  /** Word count across the whole section (CJK chars + ASCII tokens). */
  wordCount: number;
  /** Number of audio-embedded attachments in the section. */
  audioCount: number;
}

/** Aggregated stats for an entire year. */
export interface YearStats {
  year: number;
  totalWords: number;
  totalEntries: number;
  totalAudios: number;
  /** Days with non-empty journal content. */
  writingDays: number;
  /** Longest run of consecutive writing days. */
  longestStreak: number;
  /** Most common hour across all entry timestamps, formatted as "HH:00". */
  mostCommonHour: string;
  /** Daily lookup keyed by `YYYY-MM-DD`. */
  dailyMap: Map<string, DayStats>;
}

/** Aggregated stats across all years. */
export interface AllTimeStats {
  totalWords: number;
  totalEntries: number;
  totalAudios: number;
  writingDays: number;
  longestStreak: number;
  yearsWithData: number[];
}

/** Caller-supplied per-day input. */
export interface DayInput {
  /** ISO `YYYY-MM-DD` key. */
  key: string;
  /**
   * Raw text of the journal section's body, between (but not including)
   * the heading line and the next heading. Empty string means "the file
   * exists but the section is empty / missing"; the day still appears
   * in `dailyMap` but contributes nothing.
   */
  sectionText: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** CJK Unified Ideographs (BMP + Ext-A). One character = one word. */
const CJK_RE = /[一-鿿㐀-䶿]/g;
/** Wiki-link / embed token; stripped before word counting. */
const WIKI_RE = /!?\[\[[^\]]+\]\]/g;
/** ASCII word token. */
const ASCII_WORD_RE = /[A-Za-z0-9][A-Za-z0-9'_-]*/g;
/** Audio extensions recognised in `![[...]]` embeds. Mirrors section.ts. */
const AUDIO_EXT_RE = /\.(m4a|mp3|wav|ogg|flac|opus|aac|webm)$/i;
/** List marker at line start, with required trailing space. */
const LIST_MARKER_RE = /^[-*+]\s/;

/**
 * Count words in a piece of text.
 *
 * Rules:
 * - Strip wiki-links / embeds (they're attachments, not "writing").
 * - Each CJK character = one word.
 * - Latin / digit tokens are split on word boundaries and counted.
 *
 * Imperfect by design — it answers "roughly how much did I write today",
 * not a publishable word count.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(WIKI_RE, ' ');
  const cjk = (cleaned.match(CJK_RE) ?? []).length;
  const ascii = (cleaned.replace(CJK_RE, ' ').match(ASCII_WORD_RE) ?? []).length;
  return cjk + ascii;
}

/** Count audio embed tokens in a piece of text. */
export function countAudioEmbeds(text: string): number {
  if (!text) return 0;
  const re = /!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (AUDIO_EXT_RE.test(m[1].trim())) n++;
  }
  return n;
}

/**
 * Count "entries" (memos) in a journal section body.
 *
 * Two formats are supported simultaneously so legacy notes count too:
 *
 *  1. **List items** — `- ...`, `* ...`, `+ ...` at line start. Each list
 *     item is one entry. Indented continuation lines are folded into the
 *     parent and don't add to the count.
 *
 *  2. **Plain paragraphs** — runs of non-list, non-empty lines separated
 *     by blank lines. Each paragraph is one entry. This covers the older
 *     "just wrote a few sentences" style of journaling.
 *
 * Mixing the two within a single day works: each list item is counted,
 * and any paragraph blocks between/around them are counted separately.
 */
export function countEntries(sectionText: string): number {
  if (!sectionText) return 0;

  const lines = sectionText.split('\n');
  let count = 0;
  let inParagraph = false;

  for (const raw of lines) {
    const isList = LIST_MARKER_RE.test(raw);
    const isEmpty = raw.trim().length === 0;
    const isIndented = /^\s/.test(raw) && !isEmpty;

    if (isList) {
      count++;
      inParagraph = false;
    } else if (isEmpty) {
      inParagraph = false;
    } else if (isIndented) {
      // Continuation of a previous list item — already counted.
      inParagraph = false;
    } else {
      // Plain paragraph line. Only the first line of the run counts.
      if (!inParagraph) {
        count++;
        inParagraph = true;
      }
    }
  }

  return count;
}

/**
 * Extract every hour value from timestamps in `sectionText` and add to
 * the provided counter array (indices 0–23).
 *
 * Uses the same flexible pattern as the rest of the plugin: a single
 * occurrence per line is enough, and the line need not be a list item.
 */
export function accumulateHourHistogram(
  sectionText: string,
  pattern: string,
  histogram: number[],
  formats: readonly string[] = [],
): void {
  if (!sectionText) return;
  // Match once per physical line so a time mentioned in the body cannot
  // double-count the entry. The outer capture precedes any advanced groups.
  const lineRe = new RegExp(`(?:^|\\s)(${pattern})(?=\\s|$)`);
  for (const line of sectionText.split(/\r\n?|\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const seconds = timestampToSeconds(m[1], [...formats, 'H:mm', 'H:mm:ss']);
    if (seconds !== null) histogram[Math.floor(seconds / 3600)]++;
  }
}

/** Build a DayStats from the section's raw text. */
export function buildDayStats(key: string, sectionText: string): DayStats {
  return {
    key,
    entryCount: countEntries(sectionText),
    wordCount: countWords(sectionText),
    audioCount: countAudioEmbeds(sectionText),
  };
}

/**
 * Map a day's entry count to a 5-level heat scale.
 *
 * Thresholds: 0 / 1 / 2-3 / 4-6 / 7+. Tuned for the typical "a few memos
 * a day" cadence — anything past level-4 should feel like a clear "wrote
 * a lot" outlier, not a typical day.
 */
export function getHeatmapLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

/**
 * Walk the dailyMap and find the longest run of consecutive days with
 * `entryCount > 0`. Plain ISO-date arithmetic — no moment dep here.
 */
function computeLongestStreak(dailyMap: Map<string, DayStats>): number {
  const keys = [...dailyMap.keys()]
    .filter(k => (dailyMap.get(k)?.entryCount ?? 0) > 0)
    .sort();

  let longest = 0;
  let current = 0;
  let prev: number | null = null;

  for (const k of keys) {
    const t = Date.parse(k + 'T00:00:00');
    if (prev !== null && t - prev === 86_400_000) {
      current++;
    } else {
      current = 1;
    }
    if (current > longest) longest = current;
    prev = t;
  }

  return longest;
}

/**
 * Pick the modal hour from the histogram. Returns "—" when the histogram
 * is all zero. Ties resolve to the earlier hour (e.g. 7am beats 21pm if
 * both have the same count) so the displayed value stays stable across
 * reloads.
 */
function computeMostCommonHour(histogram: number[]): string {
  let bestHour = -1;
  let bestCount = 0;
  for (let h = 0; h < 24; h++) {
    if (histogram[h] > bestCount) {
      bestCount = histogram[h];
      bestHour = h;
    }
  }
  if (bestHour < 0) return '—';
  return String(bestHour).padStart(2, '0') + ':00';
}

// ── Top-level aggregation ──────────────────────────────────────────────────

/**
 * Aggregate one year's stats from per-day raw section text.
 *
 * Pass every day for which a daily note exists in the year, even if its
 * journal section is empty — keeps `dailyMap` complete so the heatmap can
 * tell "no file" (absent) apart from "file but empty" (level 0).
 */
export function computeYearStats(
  year: number,
  dayInputs: DayInput[],
  timestampPattern: string,
  formats: readonly string[] = [],
): YearStats {
  const dailyMap = new Map<string, DayStats>();
  const histogram = new Array<number>(24).fill(0);

  let totalEntries = 0;
  let totalWords = 0;
  let totalAudios = 0;
  let writingDays = 0;

  for (const { key, sectionText } of dayInputs) {
    const ds = buildDayStats(key, sectionText);
    dailyMap.set(key, ds);
    totalEntries += ds.entryCount;
    totalWords += ds.wordCount;
    totalAudios += ds.audioCount;
    if (ds.entryCount > 0 || ds.wordCount > 0) writingDays++;

    accumulateHourHistogram(sectionText, timestampPattern, histogram, formats);
  }

  return {
    year,
    totalWords,
    totalEntries,
    totalAudios,
    writingDays,
    longestStreak: computeLongestStreak(dailyMap),
    mostCommonHour: computeMostCommonHour(histogram),
    dailyMap,
  };
}

/**
 * Aggregate stats across all years from per-year stats.
 */
export function computeAllTimeStats(yearStatsList: YearStats[]): AllTimeStats {
  let totalWords = 0;
  let totalEntries = 0;
  let totalAudios = 0;
  let writingDays = 0;
  const yearsWithData: number[] = [];

  // Merge all daily maps to compute global longest streak
  const globalDailyMap = new Map<string, DayStats>();

  for (const ys of yearStatsList) {
    if (ys.totalWords === 0 && ys.totalEntries === 0) continue;
    yearsWithData.push(ys.year);
    totalWords += ys.totalWords;
    totalEntries += ys.totalEntries;
    totalAudios += ys.totalAudios;
    writingDays += ys.writingDays;
    for (const [key, ds] of ys.dailyMap) {
      globalDailyMap.set(key, ds);
    }
  }

  yearsWithData.sort((a, b) => a - b);

  return {
    totalWords,
    totalEntries,
    totalAudios,
    writingDays,
    longestStreak: computeLongestStreak(globalDailyMap),
    yearsWithData,
  };
}

// ── Number formatting ──────────────────────────────────────────────────────

/**
 * Format a large word count as a Chinese-friendly short string:
 *   - <10000   → "1234"
 *   - <100000  → "3.2 万"   (one decimal)
 *   - >=100000 → "12 万"    (no decimal — past five digits the decimal noise distracts)
 */
export function formatChineseWordCount(n: number): string {
  if (n < 10_000) return String(n);
  const wan = n / 10_000;
  if (wan < 10) return `${wan.toFixed(1)} 万`;
  return `${Math.floor(wan)} 万`;
}
