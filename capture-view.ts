/**
 * Quick-capture sidebar view.
 *
 * Layout:
 *   1. Toolbar — refresh + sort toggle
 *   2. Input card — multi-line textarea + NOTE submit button (always
 *      writes to today)
 *   3. Timeline — continuous-scroll stream of days. Today is rendered at
 *      the top; scrolling near the bottom auto-loads earlier non-empty
 *      days. Each day is a sub-section: date header node + its entries.
 *
 * Reads daily notes (via obsidian-daily-notes-interface) and renders the
 * `## Journal` section of each day. Submitting writes `- HH:MM text` to
 * today's file, creating the file or heading if needed.
 */

import {
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  moment,
  setIcon,
} from 'obsidian';
import {
  appHasDailyNotesPluginLoaded,
  getAllDailyNotes,
  getDailyNote,
  getDateFromFile,
} from 'obsidian-daily-notes-interface';

import {
  JournalEntry,
  deleteEntryFromSection,
  extractAudioEmbeds,
  findSection,
  parseJournalEntries,
  removeAudioEmbedsFromEntry,
} from './section';
import {
  YearStats,
  computeYearStats,
  formatChineseWordCount,
  getHeatmapLevel,
} from './stats';
import type JournalPartnerPlugin from './main';

export const CAPTURE_VIEW_TYPE = 'journal-partner-capture-view';

/**
 * Which "delete" action the context menu picked. Surfacing this as a type
 * (instead of two booleans) keeps `executeDelete` and the confirm modal
 * exhaustive — adding a fourth mode in the future will fail to type-check
 * any switch that doesn't handle it.
 */
type DeleteMode = 'memo' | 'memo+audio' | 'audio-only';

/** Per-day rendered chunk in the infinite-scroll timeline. */
interface DaySection {
  /** Local-day moment (00:00) for stable identity. */
  date: moment.Moment;
  /** Wrapper element for the day's date-header + entry rows. */
  el: HTMLElement;
  /** Lifecycle owner for this day's MarkdownRenderer.render calls. */
  scope: Component;
  /** Path of the daily note backing this day (may be null on a missing file). */
  filePath: string | null;
}

export class JournalCaptureView extends ItemView {
  private plugin: JournalPartnerPlugin;

  // Top-level tab state
  private currentTab: 'capture' | 'stats' = 'capture';
  private tabBarEl!: HTMLElement;
  private capturePaneEl!: HTMLElement;
  private statsPaneEl!: HTMLElement;
  private captureTabBtn!: HTMLButtonElement;
  private statsTabBtn!: HTMLButtonElement;

  // DOM references (capture pane)
  private inputCardEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private sentinelEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private submitBtn!: HTMLButtonElement;

  // DOM references (stats pane)
  private statsToolbarEl!: HTMLElement;
  private statsBodyEl!: HTMLElement;
  private statsYearLabelEl!: HTMLElement;

  // Stats state
  private statsYear: number = moment().year();
  private statsLoading = false;
  private statsRefreshTimer: number | null = null;
  /** Last computed snapshot — null while loading or before first render. */
  private yearStats: YearStats | null = null;
  /** Files belonging to the currently displayed year (path → date key). */
  private statsFilesInYear: Map<string, string> = new Map();

  // Cached state
  private days: DaySection[] = [];
  /** Day immediately older than the oldest loaded day; next `loadMore` starts here. */
  private nextProbeDate: moment.Moment = moment().startOf('day').subtract(1, 'day');
  /** True once we've scanned far enough back that nothing earlier exists. */
  private exhausted = false;
  private loadingMore = false;
  /** Max calendar days we'll probe in a single loadMore call. */
  private readonly probeWindow = 30;
  /** Hard floor: refuse to scan further back than this many days from today. */
  private readonly maxLookbackDays = 365;
  private rerenderTimer: number | null = null;
  private intersectionObs: IntersectionObserver | null = null;

  // ── Mobile toolbar auto-hide (scroll-direction triggered) ──
  /** Last observed scrollTop, for direction detection. */
  private lastScrollTop = 0;
  /** Bound scroll handler we install on the view's scroll container. */
  private onScrollBound: (() => void) | null = null;
  /** Element we attached the scroll listener to, kept for clean removal. */
  private scrollEl: HTMLElement | null = null;
  /** Min pixel delta between events that counts as a real scroll move. */
  private readonly scrollDeltaThreshold = 6;

  constructor(leaf: WorkspaceLeaf, plugin: JournalPartnerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CAPTURE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '快速记录';
  }

  getIcon(): string {
    return 'feather';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('jp-capture-root');

    // Top-level tab bar — switches between "快速记录" and "年度统计".
    this.buildTabBar(root as HTMLElement);

    // Capture pane (default visible)
    this.capturePaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-capture' });

    // Build input card and timeline based on user preference
    if (this.plugin.settings.inputPosition === 'bottom') {
      this.buildTimeline(this.capturePaneEl);
      this.buildInputCard(this.capturePaneEl);
    } else {
      this.buildInputCard(this.capturePaneEl);
      this.buildTimeline(this.capturePaneEl);
    }

    // Stats pane (hidden initially; built lazily on first switch)
    this.statsPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-stats' });
    this.statsPaneEl.style.display = 'none';

    // ── Vault listeners ──
    // modify: refresh the affected day's section in place (no full rebuild)
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (!(file instanceof TFile)) return;
        const day = this.days.find(d => d.filePath === file.path);
        if (day) {
          this.scheduleDayRefresh(day);
        }
        if (this.statsFilesInYear.has(file.path)) {
          this.scheduleStatsRefresh();
        }
      }),
    );
    // create: a new daily note (today, or an older one) — full rebuild
    this.registerEvent(
      this.app.vault.on('create', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleFullRebuild();
          this.scheduleStatsRefresh();
        }
      }),
    );
    // delete: drop the day if it was loaded, then rebuild
    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (file instanceof TFile && this.days.some(d => d.filePath === file.path)) {
          this.scheduleFullRebuild();
        }
        if (file instanceof TFile && this.statsFilesInYear.has(file.path)) {
          this.scheduleStatsRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.statsFilesInYear.has(oldPath) ||
            (file instanceof TFile && file.extension === 'md')) {
          this.scheduleStatsRefresh();
        }
      }),
    );

    await this.fullRebuild();
    this.setupIntersectionObserver();
    this.setupMobileToolbarAutoHide();
  }

  async onClose(): Promise<void> {
    if (this.rerenderTimer !== null) {
      window.clearTimeout(this.rerenderTimer);
      this.rerenderTimer = null;
    }
    if (this.statsRefreshTimer !== null) {
      window.clearTimeout(this.statsRefreshTimer);
      this.statsRefreshTimer = null;
    }
    if (this.intersectionObs) {
      this.intersectionObs.disconnect();
      this.intersectionObs = null;
    }
    this.teardownMobileToolbarAutoHide();
    this.disposeDays();
    this.containerEl.children[1].empty();
  }

  // ── DOM construction ────────────────────────────────────────────────────

  private buildTabBar(root: HTMLElement) {
    this.tabBarEl = root.createDiv({ cls: 'jp-tab-bar' });

    this.captureTabBtn = this.makeTabBtn('feather', '记录', true);
    this.captureTabBtn.addEventListener('click', () => this.switchTab('capture'));

    this.statsTabBtn = this.makeTabBtn('bar-chart-2', '统计', false);
    this.statsTabBtn.addEventListener('click', () => this.switchTab('stats'));
  }

  /** Build one pill tab button: icon + short label. */
  private makeTabBtn(icon: string, label: string, active: boolean): HTMLButtonElement {
    const btn = this.tabBarEl.createEl('button', {
      cls: 'jp-tab-btn' + (active ? ' is-active' : ''),
    });
    const iconEl = btn.createSpan({ cls: 'jp-tab-btn-icon' });
    setIcon(iconEl, icon);
    btn.createSpan({ cls: 'jp-tab-btn-text', text: label });
    return btn;
  }

  private switchTab(tab: 'capture' | 'stats') {
    if (this.currentTab === tab) return;
    this.currentTab = tab;

    this.captureTabBtn.toggleClass('is-active', tab === 'capture');
    this.statsTabBtn.toggleClass('is-active', tab === 'stats');
    this.capturePaneEl.style.display = tab === 'capture' ? '' : 'none';
    this.statsPaneEl.style.display = tab === 'stats' ? '' : 'none';

    if (tab === 'stats') {
      // Lazy: only build the stats pane scaffold (and trigger first load)
      // the first time the user actually opens it. Keeps view startup
      // cheap when the user just wants to write a memo.
      if (this.statsPaneEl.childElementCount === 0) {
        this.buildStatsPane();
        void this.loadStatsYear(this.statsYear);
      }
    }
  }


  private buildInputCard(root: HTMLElement) {
    this.inputCardEl = root.createDiv({ cls: 'jp-capture-card' });

    this.textareaEl = this.inputCardEl.createEl('textarea', {
      cls: 'jp-capture-input',
      attr: {
        placeholder: "What's happening?",
        rows: '3',
      },
    });
    this.textareaEl.addEventListener('input', () => {
      this.refreshSubmitState();
      this.autoResizeTextarea();
    });
    // Shift+Enter submits (Enter alone keeps default newline behaviour for
    // multi-line composition, matching the user's chosen shortcut).
    this.textareaEl.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        void this.handleSubmit();
      }
    });

    const actions = this.inputCardEl.createDiv({ cls: 'jp-capture-actions' });

    this.submitBtn = actions.createEl('button', {
      cls: 'jp-capture-submit',
      text: 'NOTE',
    });
    this.submitBtn.addEventListener('click', () => {
      void this.handleSubmit();
    });

    this.refreshSubmitState();
  }

  private buildTimeline(root: HTMLElement) {
    this.timelineEl = root.createDiv({ cls: 'jp-timeline' });
    this.sentinelEl = root.createDiv({ cls: 'jp-timeline-sentinel' });
  }

  // ── Behaviour ───────────────────────────────────────────────────────────

  private refreshSubmitState() {
    const hasContent = this.textareaEl.value.trim().length > 0;
    this.submitBtn.toggleClass('jp-capture-submit--disabled', !hasContent);
    this.submitBtn.disabled = !hasContent;
  }

  private autoResizeTextarea() {
    this.textareaEl.style.height = 'auto';
    const next = Math.min(this.textareaEl.scrollHeight, 240);
    this.textareaEl.style.height = `${next}px`;
  }

  private scheduleFullRebuild() {
    if (this.rerenderTimer !== null) return;
    this.rerenderTimer = window.setTimeout(() => {
      this.rerenderTimer = null;
      void this.fullRebuild();
    }, 80);
  }

  private scheduleDayRefresh(day: DaySection) {
    // Light debounce per modify burst — Obsidian fires modify multiple times
    // for a single edit. 80ms is enough to coalesce.
    window.setTimeout(() => {
      void this.refreshDay(day);
    }, 80);
  }

  // ── Full rebuild ────────────────────────────────────────────────────────

  private async fullRebuild(): Promise<void> {
    this.disposeDays();
    this.timelineEl.empty();

    // No-plugin guard
    if (!appHasDailyNotesPluginLoaded()) {
      this.renderTopLevelMessage('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      this.exhausted = true;
      return;
    }

    // Reset scroll-window state
    this.nextProbeDate = moment().startOf('day').subtract(1, 'day');
    this.exhausted = false;
    this.loadingMore = false;

    // Always render today first (non-empty or not — gives users a stable
    // anchor and shows the "no entries yet" hint).
    const today = moment().startOf('day');
    const todayDay = await this.buildDaySection(today, /* allowEmpty */ true);
    if (todayDay) {
      this.timelineEl.appendChild(todayDay.el);
      this.days.push(todayDay);
    }

    // Then load the first batch of historical non-empty days.
    await this.loadMore();
  }

  /**
   * Probe `probeWindow` calendar days backwards looking for non-empty
   * journal sections, append any matches to the timeline. Updates
   * `nextProbeDate` and may flip `exhausted`.
   */
  private async loadMore(): Promise<void> {
    if (this.loadingMore || this.exhausted) return;
    this.loadingMore = true;

    try {
      let probed = 0;
      const today = moment().startOf('day');

      while (probed < this.probeWindow) {
        // Floor on lookback window
        if (today.diff(this.nextProbeDate, 'days') > this.maxLookbackDays) {
          this.exhausted = true;
          break;
        }

        const date = this.nextProbeDate.clone();
        this.nextProbeDate = this.nextProbeDate.clone().subtract(1, 'day');
        probed++;

        const day = await this.buildDaySection(date, /* allowEmpty */ false);
        if (day) {
          this.timelineEl.appendChild(day.el);
          this.days.push(day);
        }
      }

      if (this.exhausted) {
        this.markEndOfTimeline();
      }
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Build a day section element + scope for the given date.
   * Returns null when the day has no content and `allowEmpty` is false.
   */
  private async buildDaySection(
    date: moment.Moment,
    allowEmpty: boolean,
  ): Promise<DaySection | null> {
    let file: TFile | null = null;
    try {
      file = getDailyNote(date, getAllDailyNotes()) as TFile | null;
    } catch (err) {
      console.error('[Journal Partner] daily note resolve failed', err);
    }

    let entries: JournalEntry[] = [];
    if (file) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section) {
          const text = content.slice(section.from, section.to);
          entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        }
      } catch (err) {
        console.error('[Journal Partner] read failed', err);
      }
    }

    if (entries.length === 0 && !allowEmpty) {
      return null;
    }

    const day: DaySection = {
      date: date.clone(),
      el: createDiv({ cls: 'jp-timeline-day' }),
      scope: new Component(),
      filePath: file?.path ?? null,
    };
    day.scope.load();

    this.renderDayContent(day, entries);
    return day;
  }

  /** Refresh just one day's section in place (used on vault.modify). */
  private async refreshDay(day: DaySection): Promise<void> {
    let entries: JournalEntry[] = [];
    let file: TFile | null = null;
    try {
      file = getDailyNote(day.date, getAllDailyNotes()) as TFile | null;
      if (file) {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section) {
          const text = content.slice(section.from, section.to);
          entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        }
      }
    } catch (err) {
      console.error('[Journal Partner] day refresh failed', err);
    }

    // Reset the day's lifecycle scope and DOM
    day.scope.unload();
    day.scope = new Component();
    day.scope.load();
    day.filePath = file?.path ?? day.filePath;
    day.el.empty();

    this.renderDayContent(day, entries);
  }

  /** Render the date header + entry rows for one day into `day.el`. */
  private renderDayContent(day: DaySection, entries: JournalEntry[]) {
    // Date header — first row of the day
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({
      cls: 'jp-timeline-entry jp-timeline-entry--header',
    });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });

    if (entries.length === 0) {
      // Today with no entries — soft hint only
      day.el.createDiv({ cls: 'jp-capture-empty', text: '还没有 memo，写点什么吧 →' });
      return;
    }

    // Sort entries within the day — direction follows input position:
    // input on top → newest first; input on bottom → newest last
    const sortDesc = this.plugin.settings.inputPosition !== 'bottom';
    const latestTs = entries.reduce<string>(
      (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
      '',
    );
    const sorted = [...entries].sort((a, b) => {
      if (a.timestamp === b.timestamp) {
        return sortDesc
          ? b.lineIndex - a.lineIndex
          : a.lineIndex - b.lineIndex;
      }
      return sortDesc
        ? a.timestamp < b.timestamp ? 1 : -1
        : a.timestamp < b.timestamp ? -1 : 1;
    });

    const sourcePath = day.filePath ?? '';
    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });

      const dot = row.createDiv({ cls: 'jp-timeline-dot' });
      // "Latest" highlight only applies on today's section (otherwise every
      // historical day would have its own filled dot, which is noisy).
      if (
        day.date.isSame(moment().startOf('day'), 'day') &&
        entry.timestamp === latestTs
      ) {
        dot.addClass('jp-timeline-dot--latest');
      }

      // Header: timestamp pill anchored to the dot via a short connector line.
      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createEl('span', { cls: 'jp-timestamp', text: entry.timestamp });

      // Body bubble: chat-style rounded card holding the rendered markdown.
      const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, day.scope);

      // Context menu: copy / delete (with optional audio cleanup).
      // Attached to both the timestamp pill and bubble so right-click /
      // long-press anywhere on the row triggers it.
      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  /** Build a human-readable date label. */
  private formatDateHeader(d: moment.Moment, count: number): { title: string; subtitle: string } {
    const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.day()];
    const dateLabel = d.format('YYYY年M月D日') + ` · ${weekdayZh}`;
    const today = moment().startOf('day');
    const diff = d.diff(today, 'days');
    let relative = '';
    if (diff === 0) relative = ' · 今天';
    else if (diff === -1) relative = ' · 昨天';
    else if (diff === 1) relative = ' · 明天';
    else if (diff < 0) relative = ` · ${-diff} 天前`;
    else relative = ` · ${diff} 天后`;
    const title = dateLabel + relative;
    const subtitle = count === 0 ? '还没有 memo' : `${count} 个 memo`;
    return { title, subtitle };
  }

  private renderTopLevelMessage(msg: string) {
    this.timelineEl.createDiv({ cls: 'jp-capture-empty', text: msg });
  }

  private markEndOfTimeline() {
    // Replace sentinel functionality with a static end marker
    const end = createDiv({ cls: 'jp-timeline-end', text: '— 已加载到最早的日记 —' });
    this.sentinelEl.replaceWith(end);
    this.sentinelEl = end;
  }

  private setupIntersectionObserver() {
    if (this.intersectionObs) this.intersectionObs.disconnect();
    const root = this.containerEl.children[1] as HTMLElement;
    this.intersectionObs = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting && !this.exhausted && !this.loadingMore) {
            void this.loadMore();
          }
        }
      },
      { root, rootMargin: '200px 0px 200px 0px', threshold: 0 },
    );
    this.intersectionObs.observe(this.sentinelEl);
  }

  /** Tear down all loaded day sections (Component scopes + DOM). */
  private disposeDays() {
    for (const d of this.days) d.scope.unload();
    this.days = [];
  }

  // ── Stats pane ──────────────────────────────────────────────────────────

  /** Build the static scaffold of the stats pane (toolbar + body). */
  private buildStatsPane() {
    // Toolbar with year nav
    this.statsToolbarEl = this.statsPaneEl.createDiv({ cls: 'jp-stats-toolbar' });

    this.statsToolbarEl.createDiv({ cls: 'jp-stats-toolbar-spacer' });

    const nav = this.statsToolbarEl.createDiv({ cls: 'jp-stats-year-nav' });
    const prevBtn = nav.createEl('button', { cls: 'jp-stats-year-btn' });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.setAttr('aria-label', '上一年');
    prevBtn.addEventListener('click', () => void this.loadStatsYear(this.statsYear - 1));

    this.statsYearLabelEl = nav.createDiv({
      cls: 'jp-stats-year-label',
      text: `${this.statsYear} 年`,
    });

    const nextBtn = nav.createEl('button', { cls: 'jp-stats-year-btn' });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.setAttr('aria-label', '下一年');
    nextBtn.addEventListener('click', () => void this.loadStatsYear(this.statsYear + 1));

    // Body container
    this.statsBodyEl = this.statsPaneEl.createDiv({ cls: 'jp-stats-body' });
  }

  /** Debounced reload, used in response to vault mutations. */
  private scheduleStatsRefresh() {
    // Only refresh if the user has at least opened the tab once. Otherwise
    // every memo save would do hidden work the user never sees.
    if (this.statsPaneEl.childElementCount === 0) return;
    if (this.statsRefreshTimer !== null) {
      window.clearTimeout(this.statsRefreshTimer);
    }
    this.statsRefreshTimer = window.setTimeout(() => {
      this.statsRefreshTimer = null;
      void this.loadStatsYear(this.statsYear);
    }, 300);
  }

  /** Load + render stats for one year. */
  private async loadStatsYear(year: number): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;
    this.statsYear = year;
    this.statsYearLabelEl.setText(`${year} 年`);

    this.renderStatsLoading();

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderStatsError('请先启用 Obsidian 自带的「Daily Notes」核心插件');
        return;
      }
      const dayInputs = await this.collectStatsYear(year);
      this.yearStats = computeYearStats(
        year,
        dayInputs,
        this.plugin.settings.timestampPattern,
      );
      this.renderStatsContent();
    } catch (err) {
      console.error('[Journal Partner] stats load failed', err);
      this.renderStatsError(
        `加载失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.statsLoading = false;
    }
  }

  /**
   * Scan every daily note in `year` and return per-day raw journal-section text.
   *
   * The stats layer works off raw section text (not parsed entries) so we
   * can count plain-paragraph memos from older journals that never used the
   * `- HH:MM ...` convention. Days whose section is empty (or whose file
   * has no `## Journal` heading at all) still appear in the result with an
   * empty string, so the heatmap can render them as level-0.
   */
  private async collectStatsYear(
    year: number,
  ): Promise<Array<{ key: string; sectionText: string }>> {
    const all = getAllDailyNotes() as Record<string, TFile>;
    const result: Array<{ key: string; sectionText: string }> = [];
    const newFilesInYear = new Map<string, string>();

    for (const file of Object.values(all)) {
      if (!(file instanceof TFile)) continue;
      const d = getDateFromFile(file as TFile, 'day');
      if (!d || d.year() !== year) continue;
      const key = d.format('YYYY-MM-DD');
      newFilesInYear.set(file.path, key);

      let sectionText = '';
      try {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section) {
          sectionText = content.slice(section.from, section.to);
        }
      } catch (err) {
        console.error('[Journal Partner] stats read failed', file.path, err);
      }
      result.push({ key, sectionText });
    }

    this.statsFilesInYear = newFilesInYear;
    return result;
  }

  private renderStatsLoading() {
    this.statsBodyEl.empty();
    const loading = this.statsBodyEl.createDiv({ cls: 'jp-stats-loading' });
    loading.createDiv({ cls: 'jp-stats-spinner' });
    loading.createDiv({
      text: `正在统计 ${this.statsYear} 年的日记…`,
      cls: 'jp-stats-loading-text',
    });
  }

  private renderStatsError(msg: string) {
    this.statsBodyEl.empty();
    this.statsBodyEl.createDiv({ cls: 'jp-stats-empty', text: msg });
  }

  private renderStatsContent() {
    this.statsBodyEl.empty();
    const stats = this.yearStats;
    if (!stats) return;

    this.renderStatsHero(stats);
    this.renderStatsHeatmapSection(stats);
  }

  private renderStatsHero(stats: YearStats) {
    const hero = this.statsBodyEl.createDiv({ cls: 'jp-stats-hero' });

    // ── Top block: big total-words hero + descriptive subtitle ──
    const top = hero.createDiv({ cls: 'jp-stats-hero-top' });

    const numLine = top.createDiv({ cls: 'jp-stats-hero-number' });
    const formatted = formatChineseWordCount(stats.totalWords);

    if (formatted.includes('万')) {
      const [num, unit] = formatted.split(' ');
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: num });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: unit });
    } else {
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: formatted });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: '字' });
    }

    const sub = top.createDiv({ cls: 'jp-stats-hero-sub' });
    const daysCounted = stats.writingDays;
    const dailyAvg = daysCounted > 0 ? Math.round(stats.totalWords / daysCounted) : 0;
    sub.createSpan({
      text:
        daysCounted === 0
          ? '今年还没有开始写日记 · 期待第一条 memo'
          : `写了 ${daysCounted} 天 · 日均 ${dailyAvg} 字`,
    });

    // ── Bottom block: 4 inline KPIs (writing-days lives in the subtitle) ──
    const grid = hero.createDiv({ cls: 'jp-stats-hero-kpis' });
    this.makeStatsKPI(grid, 'pencil', `${stats.totalEntries}`, '条', '总条数');
    this.makeStatsKPI(grid, 'mic', `${stats.totalAudios}`, '段', '录音数');
    this.makeStatsKPI(grid, 'flame', `${stats.longestStreak}`, '天', '最长连续');
    this.makeStatsKPI(grid, 'clock', stats.mostCommonHour, '', '最常记录时段');
  }

  private makeStatsKPI(
    parent: HTMLElement,
    icon: string,
    value: string,
    unit: string,
    label: string,
  ) {
    const card = parent.createDiv({ cls: 'jp-stats-kpi-card' });
    const iconEl = card.createDiv({ cls: 'jp-stats-kpi-icon' });
    setIcon(iconEl, icon);
    const row = card.createDiv({ cls: 'jp-stats-kpi-row' });
    row.createSpan({ cls: 'jp-stats-kpi-value', text: value });
    if (unit) row.createSpan({ cls: 'jp-stats-kpi-unit', text: unit });
    card.createDiv({ cls: 'jp-stats-kpi-label', text: label });
  }

  private renderStatsHeatmapSection(stats: YearStats) {
    const section = this.statsBodyEl.createDiv({ cls: 'jp-stats-heatmap-section' });

    const header = section.createDiv({ cls: 'jp-stats-heatmap-header' });
    header.createDiv({ cls: 'jp-stats-heatmap-title', text: '每日活跃度' });

    this.renderStatsHeatmap(
      section.createDiv({ cls: 'jp-stats-heatmap-wrap' }),
      stats,
    );

    // Legend
    const legend = section.createDiv({ cls: 'jp-stats-legend' });
    legend.createSpan({ cls: 'jp-stats-legend-label', text: '少' });
    for (let l = 0; l <= 4; l++) {
      legend.createDiv({ cls: `jp-stats-cell level-${l}` });
    }
    legend.createSpan({ cls: 'jp-stats-legend-label', text: '多' });

    // Footer summary
    const footer = section.createDiv({ cls: 'jp-stats-footer' });
    footer.setText(
      `${stats.year} 年共写 ${stats.writingDays} 天 · ` +
        `${stats.totalWords.toLocaleString('en-US')} 字 · ${stats.totalEntries} 条` +
        (stats.totalAudios > 0 ? ` · ${stats.totalAudios} 段录音` : ''),
    );
  }

  private renderStatsHeatmap(parent: HTMLElement, stats: YearStats) {
    const year = stats.year;
    const today = moment().startOf('day');

    // All days of the year (date + per-day counts).
    const allDays: { date: moment.Moment; entryCount: number; wordCount: number }[] = [];
    const start = moment({ year, month: 0, day: 1 }).startOf('day');
    const end = moment({ year, month: 11, day: 31 }).startOf('day');
    for (let d = start.clone(); d.isSameOrBefore(end); d.add(1, 'day')) {
      const ds = stats.dailyMap.get(d.format('YYYY-MM-DD'));
      allDays.push({
        date: d.clone(),
        entryCount: ds?.entryCount ?? 0,
        wordCount: ds?.wordCount ?? 0,
      });
    }

    // Pad to a Monday-start grid. Sunday (0) becomes index 6, Monday (1)
    // becomes 0, etc. Matches the "一/三/五" weekday labels.
    const firstDow = allDays[0].date.day();
    const startPad = firstDow === 0 ? 6 : firstDow - 1;
    const paddedDays: (typeof allDays[number] | null)[] = [
      ...Array(startPad).fill(null),
      ...allDays,
    ];
    const totalWeeks = Math.ceil(paddedDays.length / 7);

    // First week each month appears in (for the month-label row).
    const monthWeek: Record<number, number> = {};
    for (let w = 0; w < totalWeeks; w++) {
      for (let dow = 0; dow < 7; dow++) {
        const item = paddedDays[w * 7 + dow];
        if (!item) continue;
        const mo = item.date.month();
        if (!(mo in monthWeek)) monthWeek[mo] = w;
      }
    }

    const inner = parent.createDiv({ cls: 'jp-stats-heatmap-inner' });

    // Weekday labels column
    const labelsCol = inner.createDiv({ cls: 'jp-stats-daylabels' });
    const dayLabels: Record<number, string> = { 0: '一', 2: '三', 4: '五' };
    for (let i = 0; i < 7; i++) {
      labelsCol.createDiv({ cls: 'jp-stats-daylabel', text: dayLabels[i] ?? '' });
    }

    const rightCol = inner.createDiv({ cls: 'jp-stats-heatmap-right' });

    // Month-label row
    const monthRow = rightCol.createDiv({ cls: 'jp-stats-monthrow' });
    for (let w = 0; w < totalWeeks; w++) {
      const entry = Object.entries(monthWeek).find(([, wk]) => wk === w);
      monthRow.createDiv({
        cls: 'jp-stats-monthlabel',
        text: entry ? `${Number(entry[0]) + 1}月` : '',
      });
    }

    // Cell grid
    const grid = rightCol.createDiv({ cls: 'jp-stats-grid' });

    for (let w = 0; w < totalWeeks; w++) {
      const col = grid.createDiv({ cls: 'jp-stats-col' });
      for (let dow = 0; dow < 7; dow++) {
        const item = paddedDays[w * 7 + dow];
        if (!item) {
          col.createDiv({ cls: 'jp-stats-cell is-empty' });
          continue;
        }
        const { date, entryCount, wordCount } = item;
        const level = getHeatmapLevel(entryCount);
        const isToday = date.isSame(today, 'day');
        const isFuture = date.isAfter(today, 'day');
        const classes =
          `jp-stats-cell level-${level}` +
          (isToday ? ' is-today' : '') +
          (isFuture ? ' is-future' : '');
        const cell = col.createDiv({ cls: classes });

        const label = date.format('YYYY年M月D日');
        if (entryCount > 0) {
          cell.setAttr('title', `${label} · ${entryCount} 条 · ${wordCount} 字`);
        } else {
          cell.setAttr('title', isFuture ? label : `${label} · 未写`);
        }

        if (!isFuture) {
          cell.addEventListener('click', () => void this.openDailyNoteByDate(date));
        }
      }
    }
  }

  /** Open the daily note for `date` in a new center tab. */
  private async openDailyNoteByDate(date: moment.Moment): Promise<void> {
    try {
      const file = getDailyNote(date, getAllDailyNotes()) as TFile | null;
      if (!file) {
        new Notice(`${date.format('YYYY年M月D日')} 没有日记文件`);
        return;
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } catch (err) {
      console.error('[Journal Partner] open daily note failed', err);
      new Notice('打开失败');
    }
  }

  // ── Mobile toolbar auto-hide ────────────────────────────────────────────

  /**
   * On mobile, hide Obsidian's bottom toolbar (`.mobile-toolbar`) when the
   * user scrolls down (looking at older entries) and reveal it when they
   * scroll up. Restores the toolbar on view close so we never leave it in
   * a hidden state when the user navigates away.
   */
  private setupMobileToolbarAutoHide() {
    if (!Platform.isMobile) return;
    const scroller = this.containerEl.children[1] as HTMLElement;
    if (!scroller) return;

    this.scrollEl = scroller;
    this.lastScrollTop = scroller.scrollTop;

    this.onScrollBound = () => {
      const top = scroller.scrollTop;
      const delta = top - this.lastScrollTop;

      if (Math.abs(delta) < this.scrollDeltaThreshold) return;

      // Always show near the top — feels less abrupt when the user lands
      // back on today's entries.
      if (top <= 8) {
        this.setToolbarHidden(false);
      } else if (delta > 0) {
        // Scrolling down → hide
        this.setToolbarHidden(true);
      } else {
        // Scrolling up → show
        this.setToolbarHidden(false);
      }

      this.lastScrollTop = top;
    };

    scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
  }

  private teardownMobileToolbarAutoHide() {
    if (this.scrollEl && this.onScrollBound) {
      this.scrollEl.removeEventListener('scroll', this.onScrollBound);
    }
    this.scrollEl = null;
    this.onScrollBound = null;
    // Always restore on close — never leave the user without their toolbar.
    this.setToolbarHidden(false);
  }

  private setToolbarHidden(hidden: boolean) {
    document.body.toggleClass('jp-hide-mobile-toolbar', hidden);
  }

  // ── Entry context menu (copy / delete) ──────────────────────────────────

  /**
   * Build and show the right-click / long-press context menu for one entry.
   * Items shown:
   *   - 复制                — copies the raw markdown body to clipboard
   *   - 删除 memo           — deletes only the entry line(s) from the daily note
   *   - 删除 memo 和录音文件 — same, plus trashes embedded audio attachments
   *   - 仅删除录音文件       — keeps the memo text, trashes audio + strips ![[..]]
   *
   * The two audio-related items are only added when the entry actually
   * embeds at least one audio attachment (`![[*.m4a]]` etc.).
   */
  private openEntryMenu(evt: MouseEvent, day: DaySection, entry: JournalEntry) {
    const menu = new Menu();
    const audioPaths = extractAudioEmbeds(entry.text);

    menu.addItem(item =>
      item
        .setTitle('复制')
        .setIcon('copy')
        .onClick(() => {
          void this.copyEntry(entry);
        }),
    );

    menu.addSeparator();

    menu.addItem(item =>
      item
        .setTitle('删除 memo')
        .setIcon('trash-2')
        .onClick(() => {
          this.confirmAndDelete(day, entry, 'memo', audioPaths);
        }),
    );

    if (audioPaths.length > 0) {
      menu.addItem(item =>
        item
          .setTitle(
            audioPaths.length === 1
              ? '删除 memo 和录音文件'
              : `删除 memo 和 ${audioPaths.length} 个录音文件`,
          )
          .setIcon('trash-2')
          .onClick(() => {
            this.confirmAndDelete(day, entry, 'memo+audio', audioPaths);
          }),
      );

      menu.addItem(item =>
        item
          .setTitle(
            audioPaths.length === 1
              ? '仅删除录音文件'
              : `仅删除 ${audioPaths.length} 个录音文件`,
          )
          .setIcon('mic-off')
          .onClick(() => {
            this.confirmAndDelete(day, entry, 'audio-only', audioPaths);
          }),
      );
    }

    menu.showAtMouseEvent(evt);
  }

  /** Copy the raw markdown body of the entry (without `- HH:MM` prefix). */
  private async copyEntry(entry: JournalEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.text);
      new Notice('📋 已复制');
    } catch (err) {
      console.error('[Journal Partner] copy failed', err);
      new Notice(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Show a confirmation modal (when `settings.confirmDelete` is on) listing
   * what will be deleted, then execute the deletion on confirm. When the
   * setting is off, the action executes immediately.
   *
   * Audio files are moved to Obsidian's configured trash via
   * `fileManager.trashFile` so they remain recoverable regardless of which
   * mode is picked.
   */
  private confirmAndDelete(
    day: DaySection,
    entry: JournalEntry,
    mode: DeleteMode,
    audioPaths: string[],
  ) {
    const run = () => {
      void this.executeDelete(day, entry, mode, audioPaths);
    };

    if (!this.plugin.settings.confirmDelete) {
      run();
      return;
    }

    new DeleteConfirmModal(this.app, {
      title:
        mode === 'memo'
          ? '删除 memo'
          : mode === 'memo+audio'
            ? '删除 memo 和录音文件'
            : '删除录音文件',
      preview: this.buildEntryPreview(entry),
      timestamp: entry.timestamp,
      audioPaths: mode === 'memo' ? [] : audioPaths,
      mode,
      onConfirm: run,
    }).open();
  }

  /** Compact preview text for the confirm modal (≤ 80 chars, single line). */
  private buildEntryPreview(entry: JournalEntry): string {
    const raw = entry.text.replace(/\s+/g, ' ').trim();
    return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  }

  /**
   * Perform the actual deletion. Rewrites the daily note via
   * `vault.modify`, then (when relevant) trashes audio files. Audio
   * failures are logged but don't roll back the text deletion — they're
   * independent pieces of state and the user explicitly opted into both.
   *
   * Modes:
   *   - 'memo'       : drop entry head + continuation lines
   *   - 'memo+audio' : same as above, plus trash audio files
   *   - 'audio-only' : keep memo text but strip ![[...]] audio embeds,
   *                    plus trash audio files
   */
  private async executeDelete(
    day: DaySection,
    entry: JournalEntry,
    mode: DeleteMode,
    audioPaths: string[],
  ): Promise<void> {
    if (!day.filePath) {
      new Notice('找不到对应的日记文件');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) {
      new Notice('找不到对应的日记文件');
      return;
    }

    try {
      const content = await this.app.vault.read(file);
      const next =
        mode === 'audio-only'
          ? removeAudioEmbedsFromEntry(content, this.plugin.settings, entry.lineIndex)
          : deleteEntryFromSection(content, this.plugin.settings, entry.lineIndex);
      if (next === content) {
        // No-op means our lineIndex no longer matches a head line — the file
        // changed under us. Refresh and bail rather than mangling content.
        new Notice('日记内容已变化，请刷新后重试');
        await this.refreshDay(day);
        return;
      }
      await this.app.vault.modify(file, next);
    } catch (err) {
      console.error('[Journal Partner] delete entry failed', err);
      new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Trash embedded audio files when the mode calls for it.
    const trashAudio = mode === 'memo+audio' || mode === 'audio-only';
    let trashed = 0;
    let missing = 0;
    if (trashAudio) {
      for (const path of audioPaths) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) {
          missing++;
          continue;
        }
        try {
          await this.app.fileManager.trashFile(af);
          trashed++;
        } catch (err) {
          console.error(`[Journal Partner] trash audio failed: ${path}`, err);
        }
      }
    }

    // User-visible toast — tuned per mode so the message is unambiguous.
    if (mode === 'memo') {
      new Notice('🗑️ 已删除');
    } else if (mode === 'memo+audio') {
      if (missing === audioPaths.length) {
        new Notice('🗑️ memo 已删除（录音文件已不存在）');
      } else if (trashed === audioPaths.length) {
        new Notice(`🗑️ 已删除 memo 和 ${trashed} 个录音文件`);
      } else {
        new Notice(`🗑️ memo 已删除；${trashed}/${audioPaths.length} 个录音文件移入回收站`);
      }
    } else {
      // audio-only
      if (missing === audioPaths.length) {
        new Notice('🎙️ 录音链接已移除（文件已不存在）');
      } else if (trashed === audioPaths.length) {
        new Notice(`🎙️ 已删除 ${trashed} 个录音文件（memo 保留）`);
      } else {
        new Notice(`🎙️ 链接已移除；${trashed}/${audioPaths.length} 个录音文件移入回收站`);
      }
    }
  }

  // ── Submit / write path ─────────────────────────────────────────────────

  private async handleSubmit(): Promise<void> {
    const raw = this.textareaEl.value;
    if (raw.trim().length === 0) return;

    if (!appHasDailyNotesPluginLoaded()) {
      new Notice('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return;
    }

    this.submitBtn.disabled = true;
    this.submitBtn.addClass('jp-capture-submit--disabled');
    const originalText = this.submitBtn.textContent;
    this.submitBtn.setText('写入中…');

    try {
      const ok = await this.plugin.writeToTodayJournal(raw);
      if (!ok) return;

      this.textareaEl.value = '';
      this.autoResizeTextarea();

      // vault.modify will catch-up the today section automatically; if
      // today's section wasn't mounted (e.g. plugin just opened with no
      // file), trigger a full rebuild so it appears at the top.
      const todayDay = this.days.find(d =>
        d.date.isSame(moment().startOf('day'), 'day'),
      );
      if (!todayDay) {
        await this.fullRebuild();
      }

      // Scroll: input on top → scroll to top; input on bottom → scroll to bottom
      const scroller = this.containerEl.children[1] as HTMLElement;
      if (this.plugin.settings.inputPosition === 'bottom') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      } else {
        scroller.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      console.error('[Journal Partner] submit failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.submitBtn.setText(originalText ?? 'NOTE');
      this.refreshSubmitState();
    }
  }
}

// ── Delete confirmation modal ──────────────────────────────────────────────

interface DeleteConfirmOptions {
  title: string;
  /** Single-line preview of the entry body. */
  preview: string;
  /** HH:MM timestamp of the entry being deleted. */
  timestamp: string;
  /** Audio file paths that will be trashed (empty = text-only delete). */
  audioPaths: string[];
  /** Which delete mode the user picked — affects copy in the dialog body. */
  mode: DeleteMode;
  onConfirm: () => void;
}

/**
 * Small confirm dialog shown before any timeline entry is deleted. Two
 * affordances:
 *   - Body preview + audio file list (so the user sees what they're about
 *     to lose before clicking 删除)
 *   - Esc / 取消 / clicking outside all dismiss
 *
 * Audio files are trashed via `fileManager.trashFile` (Obsidian-respecting
 * recycle bin), not permanently removed — the modal copy reflects that.
 */
class DeleteConfirmModal extends Modal {
  private opts: DeleteConfirmOptions;

  constructor(app: import('obsidian').App, opts: DeleteConfirmOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);

    contentEl.addClass('jp-delete-confirm');

    contentEl.createEl('p', {
      cls: 'jp-delete-confirm-question',
      text:
        this.opts.mode === 'audio-only'
          ? '确定要删除这条 memo 的录音文件吗？memo 文字会保留。'
          : '确定要删除这条 memo 吗？',
    });

    // Preview card — timestamp + body preview
    const preview = contentEl.createDiv({ cls: 'jp-delete-confirm-preview' });
    preview.createEl('span', {
      cls: 'jp-timestamp',
      text: this.opts.timestamp,
    });
    preview.createEl('span', {
      cls: 'jp-delete-confirm-preview-text',
      text: this.opts.preview.length > 0 ? this.opts.preview : '(空 memo)',
    });

    // Audio file list (only when audio is being trashed)
    if (this.opts.audioPaths.length > 0) {
      const audioBlock = contentEl.createDiv({ cls: 'jp-delete-confirm-audio' });
      audioBlock.createEl('div', {
        cls: 'jp-delete-confirm-audio-label',
        text:
          this.opts.mode === 'audio-only'
            ? '将移入回收站的录音文件（可恢复）：'
            : '附带删除的录音文件（移入回收站，可恢复）：',
      });
      const list = audioBlock.createEl('ul', { cls: 'jp-delete-confirm-audio-list' });
      for (const path of this.opts.audioPaths) {
        list.createEl('li', { text: path });
      }
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'jp-delete-confirm-actions' });
    const cancelBtn = actions.createEl('button', {
      cls: 'jp-delete-confirm-cancel',
      text: '取消',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = actions.createEl('button', {
      cls: 'mod-warning jp-delete-confirm-confirm',
      text: '删除',
    });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.opts.onConfirm();
    });
    // Initial focus on cancel — safer default for a destructive dialog.
    window.setTimeout(() => cancelBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
