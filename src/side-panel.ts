/**
 * Wide-layout side panel (desktop only).
 *
 * When the capture view is wide enough, three常驻 cards sit to the right of
 * the timeline: a compact stats summary with the current-year heatmap, the
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

/**
 * Minimum view width (px) that turns the side panel on.
 *
 * Not 900: with a 340px panel plus gaps and padding, a 900px view leaves the
 * timeline about 500px — narrower than the single-column layout it replaces,
 * so widening would actually shrink the text column. 1024 keeps it at ~620px.
 */
export const WIDE_LAYOUT_MIN_WIDTH = 1024;

export interface SidePanelData {
  allTime: AllTimeStats | null;
  /** Year shown in the mini heatmap — the newest year that has data. */
  yearStats: YearStats | null;
  /** Newest favorited first; the panel shows the head of the list. */
  favorites: FavoriteEntry[];
  random: { date: Moment; entry: JournalEntry } | null;
  /** True while the first stats load / random pick is still in flight. */
  loading: boolean;
}

export interface SidePanelHandlers {
  openStats(): void;
  openFavorites(): void;
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
  const card = makeCard(parent, 'bar-chart-2', t('side.stats'), {
    label: t('side.viewAll'),
    onClick: () => handlers.openStats(),
  });

  const allTime = data.allTime;
  if (!allTime) {
    makeEmpty(card, data.loading ? t('stats.loading') : t('side.heatmapEmpty'));
    return;
  }

  const nums = card.createDiv({ cls: 'jp-side-nums' });
  const addNum = (value: string, label: string) => {
    const cell = nums.createDiv({ cls: 'jp-side-num' });
    cell.createDiv({ cls: 'jp-side-num-value', text: value });
    cell.createDiv({ cls: 'jp-side-num-label', text: label });
  };
  addNum(String(allTime.totalEntries), t('stats.totalEntries'));
  addNum(String(allTime.writingDays), t('stats.writingDays'));
  addNum(String(allTime.longestStreak), t('stats.longestStreak'));

  renderMiniHeatmap(card, data.yearStats);
}

/**
 * A year-at-a-glance density strip: one column per week, 7 rows per week.
 * Deliberately tiny (4px cells) so a full year fits the 320px panel without
 * horizontal scrolling — the full month-labelled heatmap lives in the stats
 * pane, this only answers "how has this year been going".
 */
function renderMiniHeatmap(parent: HTMLElement, stats: YearStats | null): void {
  if (!stats) return;

  const today = moment().startOf('day');
  const start = moment({ year: stats.year, month: 0, day: 1 }).startOf('day');
  const end = moment({ year: stats.year, month: 11, day: 31 }).startOf('day');

  // -1 = padding before Jan 1, -2 = future / outside the year (rendered blank).
  const cells: number[] = [];
  const firstDow = start.day();
  for (let i = 0; i < (firstDow === 0 ? 6 : firstDow - 1); i++) cells.push(-1);

  for (let d = start.clone(); d.isSameOrBefore(end); d.add(1, 'day')) {
    if (d.isAfter(today, 'day')) {
      cells.push(-2);
      continue;
    }
    const ds = stats.dailyMap.get(d.format('YYYY-MM-DD'));
    cells.push(getHeatmapLevel(ds?.entryCount ?? 0));
  }
  while (cells.length % 7 !== 0) cells.push(-2);

  const grid = parent.createDiv({ cls: 'jp-side-heatmap' });
  for (let i = 0; i < cells.length; i += 7) {
    const week = grid.createDiv({ cls: 'jp-side-heatmap-week' });
    for (let dow = 0; dow < 7; dow++) {
      const level = cells[i + dow];
      const cell = week.createDiv({ cls: 'jp-side-heatmap-cell' });
      if (level >= 0) cell.addClass(`level-${level}`);
      else cell.addClass('is-blank');
    }
  }
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
  const card = makeCard(parent, 'dice', t('side.random'));

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
