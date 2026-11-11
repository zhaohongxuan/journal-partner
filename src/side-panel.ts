/**
 * Wide-layout side panel (desktop only).
 *
 * When the capture view is wide enough, three常驻 cards sit to the right of
 * the timeline: a compact stats summary with the recent 30-day heatmap, the
 * most recently favorited entries, and one random note.
 *
 * Pure DOM builders — no view state, no IO. The view owns the data (see
 * {@link SidePanelData}) and reacts to user intent through
 * {@link SidePanelHandlers}. Favorites and the random note are rendered from
 * snapshots (`FavoriteEntry` already stores `text`/`timestamp`), so painting
 * the panel costs zero file reads.
 */

import { moment, setIcon } from 'obsidian';
import type { Moment } from 'moment';

import type { FavoriteEntry, JournalEntry } from './section';
import { getHeatmapLevel, type AllTimeStats, type YearStats } from './stats';
import { formatDate, t } from './i18n';

/** Minimum leaf width for the desktop workspace; cards shrink to 240px. */
export const WIDE_LAYOUT_MIN_WIDTH = 800;

export interface SidePanelData {
  allTime: AllTimeStats | null;
  /** Stats by year, including the previous year when the recent range crosses January. */
  yearStats: ReadonlyMap<number, YearStats>;
  /** Newest favorited first; the panel shows the head of the list. */
  favorites: FavoriteEntry[];
  random: { date: Moment; entry: JournalEntry } | null;
  /** True while the first stats load / random pick is still in flight. */
  loading: boolean;
}

export interface SidePanelHandlers {
  openStats(): void;
  openFavorites(): void;
  openReview(): void;
  openDate(date: Moment): void;
  reroll(): void;
}

/** How many favorites the preview shows before "all favorites". */
const FAVORITE_PREVIEW_COUNT = 3;

export function createSidePanel(root: HTMLElement): HTMLElement {
  return root.createDiv({ cls: 'jp-side-panel' });
}

/** Repaint the whole panel. Cheap — three cards of static DOM. */
export function renderSidePanel(
  el: HTMLElement,
  data: SidePanelData,
  handlers: SidePanelHandlers,
): void {
  el.empty();
  renderStatsCard(el, data, handlers);
  renderFavoritesCard(el, data, handlers);
  renderRandomCard(el, data, handlers);
}

// ── Card scaffolding ───────────────────────────────────────────────────────

interface CardAction {
  label: string;
  onClick: () => void;
}

function makeCard(
  parent: HTMLElement,
  icon: string,
  title: string,
  action?: CardAction,
): HTMLElement {
  const card = parent.createDiv({ cls: 'jp-side-card' });
  const head = card.createDiv({ cls: 'jp-side-card-head' });

  const iconEl = head.createSpan({ cls: 'jp-side-card-icon' });
  setIcon(iconEl, icon);
  head.createSpan({ cls: 'jp-side-card-title', text: title });

  if (action) {
    const more = head.createEl('button', {
      cls: 'jp-side-card-more',
      text: action.label,
      attr: { type: 'button', title: action.label },
    });
    more.addEventListener('click', evt => {
      evt.stopPropagation();
      action.onClick();
    });
  }

  return card;
}

function makeEmpty(parent: HTMLElement, text: string): void {
  parent.createDiv({ cls: 'jp-side-empty', text });
}

// ── Stats ──────────────────────────────────────────────────────────────────

function renderStatsCard(
  parent: HTMLElement,
  data: SidePanelData,
  handlers: SidePanelHandlers,
): void {
  const card = makeCard(parent, 'calendar-days', t('side.recentStats'), {
    label: t('side.viewAll'),
    onClick: () => handlers.openStats(),
  });

  const today = moment().startOf('day');
  const start = today.clone().isoWeekday(1).subtract(19, 'weeks');

  let totalEntries = 0;
  let writingDays = 0;
  for (let day = start.clone(); day.isSameOrBefore(today, 'day'); day.add(1, 'day')) {
    const count = data.yearStats.get(day.year())?.dailyMap.get(day.format('YYYY-MM-DD'))?.entryCount ?? 0;
    totalEntries += count;
    if (count > 0) writingDays++;
  }

  const nums = card.createDiv({ cls: 'jp-side-nums' });
  const addNum = (value: string, label: string) => {
    const cell = nums.createDiv({ cls: 'jp-side-num' });
    cell.createDiv({ cls: 'jp-side-num-value', text: value });
    cell.createDiv({ cls: 'jp-side-num-label', text: label });
  };
  addNum(String(totalEntries), t('stats.totalEntries'));
  addNum(String(writingDays), t('stats.writingDays'));

  renderRecentHeatmap(card, data.yearStats, start, today, handlers);
}

/** GitHub-style contribution grid: twenty week columns, seven day rows. */
function renderRecentHeatmap(
  parent: HTMLElement,
  stats: ReadonlyMap<number, YearStats>,
  start: Moment,
  today: Moment,
  handlers: SidePanelHandlers,
): void {
  const grid = parent.createDiv({ cls: 'jp-side-recent-grid' });
  for (let offset = 0; offset < 140; offset++) {
    const date = start.clone().add(offset, 'days');
    if (date.isAfter(today, 'day')) {
      grid.createDiv({ cls: 'jp-side-recent-padding', attr: { 'aria-hidden': 'true' } });
      continue;
    }
    const key = date.format('YYYY-MM-DD');
    const count = stats.get(date.year())?.dailyMap.get(key)?.entryCount ?? 0;
    const label = `${key}: ${t('timeline.entries', { count })}`;
    const button = grid.createEl('button', {
      cls: `jp-side-recent-day level-${getHeatmapLevel(count)}`,
      attr: { type: 'button', 'aria-label': label, title: label },
    });
    if (date.isSame(today, 'day')) {
      button.addClass('is-today');
      button.setAttr('aria-current', 'date');
    }
    button.addEventListener('click', () => handlers.openDate(date.clone()));
  }

  const range = parent.createDiv({ cls: 'jp-side-recent-range' });
  range.createSpan({ text: start.format('YYYY-MM-DD') });
  range.createSpan({ text: today.format('YYYY-MM-DD') });
}

// ── Favorites ──────────────────────────────────────────────────────────────

function renderFavoritesCard(
  parent: HTMLElement,
  data: SidePanelData,
  handlers: SidePanelHandlers,
): void {
  const card = makeCard(parent, 'heart', t('tab.favorites'), {
    label: t('side.allFavorites'),
    onClick: () => handlers.openFavorites(),
  });

  if (data.favorites.length === 0) {
    makeEmpty(card, t('side.favEmpty'));
    return;
  }

  for (const fav of data.favorites.slice(0, FAVORITE_PREVIEW_COUNT)) {
    const row = card.createDiv({ cls: 'jp-side-fav' });
    row.setAttr('aria-label', t('side.openDay'));
    row.setAttr('title', t('side.openDay'));

    const heartEl = row.createSpan({ cls: 'jp-side-fav-heart' });
    setIcon(heartEl, 'heart');

    const body = row.createDiv({ cls: 'jp-side-fav-body' });
    body.createDiv({ cls: 'jp-side-fav-text', text: fav.text });
    body.createDiv({
      cls: 'jp-side-fav-date',
      text: `${formatDate(moment(fav.date, 'YYYY-MM-DD'))} ${fav.timestamp}`,
    });

    row.addEventListener('click', () => handlers.openDate(moment(fav.date, 'YYYY-MM-DD')));
  }
}

// ── Random note ────────────────────────────────────────────────────────────

function renderRandomCard(
  parent: HTMLElement,
  data: SidePanelData,
  handlers: SidePanelHandlers,
): void {
  const card = makeCard(parent, 'dice', t('side.random'), {
    label: t('tab.review'),
    onClick: () => handlers.openReview(),
  });

  if (!data.random) {
    makeEmpty(card, data.loading ? t('stats.loading') : t('side.randomEmpty'));
    return;
  }

  const { date, entry } = data.random;
  const body = card.createDiv({ cls: 'jp-side-random' });
  body.createDiv({
    cls: 'jp-side-random-date',
    text: `${formatDate(date)} ${entry.timestamp}`,
  });
  body.createDiv({ cls: 'jp-side-random-text', text: entry.text });
  body.addEventListener('click', () => handlers.openDate(date));

  const btn = card.createEl('button', {
    cls: 'jp-side-reroll',
    attr: { type: 'button' },
  });
  const btnIcon = btn.createSpan({ cls: 'jp-side-reroll-icon' });
  setIcon(btnIcon, 'dice');
  btn.createSpan({ text: t('side.reroll') });
  btn.addEventListener('click', evt => {
    evt.stopPropagation();
    handlers.reroll();
  });
}
