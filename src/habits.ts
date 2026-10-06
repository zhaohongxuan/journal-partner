/**
 * Habit check-in support for the capture sidebar.
 *
 * Design note: there is **no separate habit store**. A habit is "done today"
 * exactly when today's journal section contains a completed checkbox task whose
 * text matches the habit's label:
 *
 *     - [x] 07:12 #log/habit 早起
 *
 * That makes the timeline the single source of truth — ticking the box in the
 * editor, in the timeline, or from the pinned module below all agree, and
 * nothing drifts out of sync. `habits.ts` therefore holds only pure helpers
 * (matching, payload building, frontmatter values); the I/O lives in
 * `capture-view.ts`.
 */

import type { HabitConfig, JournalEntry } from './section';
import { extractTags, normalizeTag } from './section';

/**
 * Icons offered in the settings dropdown. A curated list (rather than a free
 * text field) so a typo can't silently render an empty button.
 */
export const HABIT_ICON_CHOICES = [
  'sunrise',
  'moon',
  'dumbbell',
  'activity',
  'footprints',
  'bike',
  'heart-pulse',
  'snowflake',
  'droplet',
  'apple',
  'coffee',
  'book-open',
  'brain',
  'pen-line',
  'target',
  'sparkles',
  'bed',
  'music',
] as const;

let habitSeq = 0;

/** Create a habit with a stable-enough unique id. */
export function makeHabit(label = '', icon = 'sunrise'): HabitConfig {
  habitSeq += 1;
  return {
    id: `h${Date.now().toString(36)}${habitSeq}`,
    label,
    icon,
    field: '',
    tag: '',
  };
}

/** Strip every `#tag` token so only the habit's own words remain. */
export function stripTagTokens(text: string): string {
  return text
    .replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Does a journal entry belong to this habit?
 *
 * Exact match wins; a *leading* match is accepted as a fallback so a manually
 * written `早起 6:30` still counts, while `写早起计划` (label in the middle) does
 * not — that would be a false positive.
 */
export function habitTextMatches(entryText: string, label: string): boolean {
  const target = stripTagTokens(label).trim();
  if (target.length === 0) return false;
  const body = stripTagTokens(entryText);
  return body === target || body.startsWith(target);
}

/**
 * The task entry backing this habit today, or null when it has never been
 * checked in. Only `type === 'task'` entries count — a plain memo mentioning
 * the habit is not a check-in.
 *
 * When several entries match (e.g. the user checked in twice), the **last** one
 * wins: it is the most recent intent, and it is the one the module toggles.
 */
export function findHabitEntry(
  entries: JournalEntry[],
  habit: HabitConfig,
): JournalEntry | null {
  const exact: JournalEntry[] = [];
  const loose: JournalEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'task') continue;
    const body = stripTagTokens(entry.text);
    const target = stripTagTokens(habit.label).trim();
    if (body === target) exact.push(entry);
    else if (habitTextMatches(entry.text, habit.label)) loose.push(entry);
  }
  const pool = exact.length > 0 ? exact : loose;
  return pool.length > 0 ? pool[pool.length - 1] : null;
}

/** Whether the habit counts as done, given today's entries. */
export function isHabitDone(entries: JournalEntry[], habit: HabitConfig): boolean {
  return findHabitEntry(entries, habit)?.completed === true;
}

/**
 * The payload handed to `writeToTodayJournal` for a fresh check-in. The leading
 * `[x]` is what makes `writeToTodayJournal` build a **task** line, and the tag
 * (each habit carries its own, and it may be empty) goes after the checkbox so
 * that detection still sees the marker first.
 */
export function habitTaskPayload(habit: HabitConfig, completed: boolean): string {
  const box = completed ? '[x]' : '[ ]';
  const tag = normalizeTag(habit.tag ?? '');
  const parts = [box, tag, habit.label.trim()].filter(p => p.length > 0);
  return parts.join(' ');
}

/** Progress for the module header, e.g. `2/5`. */
export function habitProgress(entries: JournalEntry[], habits: HabitConfig[]): string {
  const total = habits.length;
  if (total === 0) return '';
  const done = habits.filter(h => isHabitDone(entries, h)).length;
  return `${done}/${total}`;
}

/** Sanity check used by the settings tab: a valid label is required. */
export function isHabitUsable(habit: HabitConfig): boolean {
  return habit.label.trim().length > 0;
}

/** Tags present in a habit check-in — kept for callers that need to inspect. */
export function habitTags(text: string): string[] {
  return extractTags(text);
}
