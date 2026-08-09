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
  requestUrl,
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
  buildEntryLine,
  buildTaskLine,
  deleteEntryFromSection,
  editEntryInSection,
  extractAudioEmbeds,
  findSection,
  generateTimestamp,
  parseJournalEntries,
  removeAudioEmbedsFromEntry,
  sortJournalEntries,
} from './section';
import {
  YearStats,
  AllTimeStats,
  computeYearStats,
  computeAllTimeStats,
  formatChineseWordCount,
  getHeatmapLevel,
} from './stats';
import type JournalPartnerPlugin from './main';

export const CAPTURE_VIEW_TYPE = 'journal-partner-capture-view';

/**
 * Wrap an async listener so it satisfies `void`-returning handler signatures
 * (e.g. `addEventListener`, `setTimeout`). Without this, passing an `async`
 * function directly trips `@typescript-eslint/no-misused-promises` because the
 * handler returns a Promise that the caller ignores.
 */
const runAsync = <Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): ((...args: Args) => void) => (...args: Args): void => {
  void fn(...args);
};

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
  private currentTab: 'capture' | 'stats' | 'search' | 'review' = 'capture';
  private tabBarEl!: HTMLElement;
  private capturePaneEl!: HTMLElement;
  private statsPaneEl!: HTMLElement;
  private reviewPaneEl!: HTMLElement;
  private captureTabBtn!: HTMLButtonElement;
  private statsTabBtn!: HTMLButtonElement;
  private searchTabBtn!: HTMLButtonElement;
  private reviewTabBtn!: HTMLButtonElement;

  // Search state
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchActive = false;
  private searchDebounceTimer: number | null = null;
  private searchQuery = '';
  private searchVersion = 0;
  /** All daily note files sorted newest→oldest, set at search start. */
  private searchFileQueue: TFile[] = [];
  /** Index into searchFileQueue: next file to scan in loadMoreSearchResults. */
  private searchCursor = 0;

  // DOM references (capture pane)
  private inputCardEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private sentinelEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private submitBtn!: HTMLButtonElement;
  private isTaskMode = false;

  // Autocomplete state
  private autocompletePopupEl!: HTMLElement;
  private autocompleteItemsEl!: HTMLElement;
  private autocompleteActive = false;
  private autocompleteType: '@' | '#' | null = null;
  private autocompleteSelectedIndex = 0;
  private autocompleteSuggestions: string[] = [];
  private autocompleteStartPos = 0;  // position of @ or #
  private autocompleteQuery = '';

  // DOM references (stats pane)
  private statsToolbarEl!: HTMLElement;
  private statsBodyEl!: HTMLElement;
  private statsYearLabelEl!: HTMLElement;

  // Stats state
  private statsLoading = false;
  private statsRefreshTimer: number | null = null;
  /** All years' stats for all-time aggregation. */
  private allYearStats: Map<number, YearStats> = new Map();
  /** All-time aggregated stats. */
  private allTimeStats: AllTimeStats | null = null;

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

  // ── Quick-record via URL scheme ──────────────────────────────────────────
  /** Bound to the inner startRecording closure once buildInputCard runs. */
  private startRecordingFn: (() => Promise<void>) | null = null;

  /**
   * Called by the plugin's URL handler when `cmd=record` is received.
   * Ensures the capture pane is visible, then starts recording immediately.
   * Safe to call before `buildInputCard` finishes (startRecordingFn will be
   * null until then, so we schedule a short retry).
   */
  public async beginRecording(): Promise<void> {
    // Make sure we're on the capture tab so the mic button is visible
    if (this.currentTab !== 'capture') this.switchTab('capture');

    if (this.startRecordingFn) {
      await this.startRecordingFn();
    } else {
      // If the view isn't fully built yet, retry once the event loop settles
      window.setTimeout(runAsync(async () => {
        if (this.startRecordingFn) await this.startRecordingFn();
      }), 200);
    }
  }

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
    this.buildInputCard(this.capturePaneEl);
    this.buildTimeline(this.capturePaneEl);

    // Stats pane (hidden initially; built lazily on first switch)
    this.statsPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-stats' });
    this.statsPaneEl.hide();

    // Review pane (hidden initially)
    this.reviewPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-review' });
    this.reviewPaneEl.hide();

    // ── Vault listeners ──
    // modify: refresh the affected day's section in place (no full rebuild)
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (!(file instanceof TFile)) return;
        const day = this.days.find(d => d.filePath === file.path);
        if (day) {
          this.scheduleDayRefresh(day);
        }
        if (file.extension === 'md') {
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
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleStatsRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
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
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
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

    this.captureTabBtn = this.makeTabBtn('feather', true, '快速记录');
    this.captureTabBtn.addEventListener('click', () => this.switchTab('capture'));

    this.reviewTabBtn = this.makeTabBtn('calendar', false, '随机回顾');
    this.reviewTabBtn.addEventListener('click', () => this.switchTab('review'));

    this.searchTabBtn = this.makeTabBtn('search', false, '搜索日记');
    this.searchTabBtn.addEventListener('click', () => this.switchTab('search'));

    this.statsTabBtn = this.makeTabBtn('bar-chart-2', false, '年度统计');
    this.statsTabBtn.addEventListener('click', () => this.switchTab('stats'));

    // Search bar — collapsed by default, shown when search tab is active
    this.searchBarEl = root.createDiv({ cls: 'jp-search-bar' });
    this.searchBarEl.hide();

    const searchIcon = this.searchBarEl.createSpan({ cls: 'jp-search-bar-icon' });
    setIcon(searchIcon, 'search');

    this.searchInputEl = this.searchBarEl.createEl('input', {
      cls: 'jp-search-input',
      attr: { placeholder: '搜索日记…', type: 'text' },
    });
    this.searchInputEl.addEventListener('input', () => {
      const q = this.searchInputEl.value;
      this.searchQuery = q;
      if (this.searchDebounceTimer !== null) window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = window.setTimeout(() => {
        this.searchDebounceTimer = null;
        void this.runSearch(q.trim());
      }, 300);
    });
  }

  /** Build one icon-only tab button. */
  private makeTabBtn(icon: string, active: boolean, tooltip?: string): HTMLButtonElement {
    const btn = this.tabBarEl.createEl('button', {
      cls: 'jp-tab-btn' + (active ? ' is-active' : ''),
      attr: tooltip ? { 'aria-label': tooltip, title: tooltip } : {},
    });
    const iconEl = btn.createSpan({ cls: 'jp-tab-btn-icon' });
    setIcon(iconEl, icon);
    return btn;
  }

  private switchTab(tab: 'capture' | 'stats' | 'search' | 'review') {
    if (this.currentTab === tab) return;
    const prevTab = this.currentTab;
    this.currentTab = tab;

    this.captureTabBtn.toggleClass('is-active', tab === 'capture');
    this.reviewTabBtn.toggleClass('is-active', tab === 'review');
    this.searchTabBtn.toggleClass('is-active', tab === 'search');
    this.statsTabBtn.toggleClass('is-active', tab === 'stats');

    if (tab === 'search') {
      this.capturePaneEl.show();
      this.statsPaneEl.hide();
      this.reviewPaneEl.hide();
      this.inputCardEl.hide();
      this.searchBarEl.show();
      this.searchActive = true;

      if (prevTab !== 'search') {
        if (this.searchQuery.length === 0) {
          this.disposeDays();
          this.timelineEl.empty();
          this.exhausted = false;
          this.searchFileQueue = [];
          this.searchCursor = 0;
          this.renderTopLevelMessage('输入关键词开始搜索');
        }
        this.searchInputEl.value = this.searchQuery;
        window.setTimeout(() => this.searchInputEl.focus(), 50);
      }
    } else if (tab === 'capture') {
      this.capturePaneEl.show();
      this.statsPaneEl.hide();
      this.reviewPaneEl.hide();
      this.inputCardEl.show();
      this.searchBarEl.hide();

      // Always clean up search state when returning to capture
      if (this.searchActive || prevTab === 'search') {
        this.searchActive = false;
        if (this.searchDebounceTimer !== null) {
          window.clearTimeout(this.searchDebounceTimer);
          this.searchDebounceTimer = null;
        }
      }
      // Rebuild if coming from any non-capture tab, or if timeline looks stale
      // (e.g. capture → search → review → capture leaves search content in timelineEl)
      if (prevTab !== 'capture') {
        void this.fullRebuild();
      }
    } else if (tab === 'review') {
      this.capturePaneEl.hide();
      this.statsPaneEl.hide();
      this.reviewPaneEl.show();
      this.searchBarEl.hide();
      void this.loadReview();
    } else {
      // stats tab
      this.capturePaneEl.hide();
      this.statsPaneEl.show();
      this.reviewPaneEl.hide();
      this.inputCardEl.show();
      this.searchBarEl.hide();

      if (this.statsPaneEl.childElementCount === 0) {
        this.buildStatsPane();
      }
      void this.loadAllStats();
    }
  }

  private toggleSearch() {
    if (this.currentTab === 'search') {
      this.switchTab('capture');
    } else {
      this.switchTab('search');
    }
  }

  private async runSearch(query: string) {
    if (!this.searchActive) return;

    // Version stamp — any newer call invalidates this one
    const version = ++this.searchVersion;

    this.disposeDays();
    this.timelineEl.empty();
    this.exhausted = false;
    this.searchFileQueue = [];
    this.searchCursor = 0;

    if (query.length === 0) {
      this.renderTopLevelMessage('输入关键词开始搜索');
      return;
    }

    if (!appHasDailyNotesPluginLoaded()) {
      this.renderTopLevelMessage('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return;
    }

    this.renderTopLevelMessage('搜索中…');

    // Build the sorted file queue (newest → oldest) once, then scan lazily
    const allNotes = getAllDailyNotes();
    const queue: Array<{ date: moment.Moment; file: TFile }> = [];
    for (const file of Object.values(allNotes)) {
      if (!(file instanceof TFile)) continue;
      const date = getDateFromFile(file, 'day');
      if (date) queue.push({ date: date.clone().startOf('day'), file });
    }
    queue.sort((a, b) => (a.date.isBefore(b.date) ? 1 : -1));
    this.searchFileQueue = queue.map(q => q.file);

    if (this.searchVersion !== version) return;

    // Kick off the first batch — sentinel / intersection observer handles the rest
    await this.loadMoreSearchResults();
  }

  /** Scan the next batch of files in searchFileQueue and append matching days. */
  private async loadMoreSearchResults(): Promise<void> {
    if (!this.searchActive || this.loadingMore) return;
    // No queue built yet (user hasn't typed anything) — do nothing
    if (this.searchFileQueue.length === 0) return;
    this.loadingMore = true;

    const version = this.searchVersion;
    const query = this.searchQuery;
    const lower = query.toLowerCase();
    const batchSize = 20;
    let found = 0;

    try {
      while (this.searchCursor < this.searchFileQueue.length && found < batchSize) {
        if (this.searchVersion !== version) return;

        const file = this.searchFileQueue[this.searchCursor++];
        const date = getDateFromFile(file, 'day');
        if (!date) continue;

        try {
          const content = await this.app.vault.cachedRead(file);
          const section = findSection(
            content,
            this.plugin.settings.targetHeading,
            this.plugin.settings.headingLevel,
          );
          if (!section) continue;
          const text = content.slice(section.from, section.to);
          const entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
          const matched = entries.filter(e => this.entryMatchesQuery(e.text, lower));
          if (matched.length === 0) continue;

          // Remove "搜索中…" placeholder on first hit
          if (this.days.length === 0) this.timelineEl.empty();

          const day: DaySection = {
            date: date.clone().startOf('day'),
            el: createDiv({ cls: 'jp-timeline-day' }),
            scope: new Component(),
            filePath: file.path,
          };
          day.scope.load();
          this.renderSearchDayContent(day, matched, query);
          this.timelineEl.appendChild(day.el);
          this.days.push(day);
          found++;
        } catch {
          // skip unreadable files
        }
      }

      if (this.searchVersion !== version) return;

      if (this.searchCursor >= this.searchFileQueue.length) {
        this.exhausted = true;
        if (this.days.length === 0) {
          this.timelineEl.empty();
          this.renderTopLevelMessage(`未找到包含「${query}」的记录`);
        } else {
          this.markEndOfTimeline();
        }
      }
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Check whether the searchable text of an entry contains the query.
   * Strips wiki-embeds and markdown image syntax before matching so that
   * file paths (e.g. "Recordings/2024-01-01_...m4a") don't cause false hits.
   */
  private entryMatchesQuery(text: string, lowerQuery: string): boolean {
    const stripped = text
      .replace(/!\[\[[^\]]*\]\]/g, '')  // remove ![[...]] embeds
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')  // remove ![alt](url) images
      .toLowerCase();
    return stripped.includes(lowerQuery);
  }

  /** Render search result entries with keyword highlight. */
  private renderSearchDayContent(day: DaySection, entries: JournalEntry[], query: string) {
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createDiv({ cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createDiv({ cls: 'jp-timeline-header-sub', text: `${entries.length} 条匹配` });
    this.addOpenNoteBtn(headerCard, day);

    const sourcePath = day.filePath ?? '';
    const sorted = sortJournalEntries(entries, this.plugin.settings.sortOrder);

    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });

      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createSpan({ cls: 'jp-timestamp', text: entry.timestamp });

      const bubble = row.createDiv({ cls: 'jp-timeline-bubble jp-search-bubble' });
      // Render markdown first, then highlight keywords in the resulting DOM text nodes
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, day.scope).then(() => {
        this.highlightKeyword(bubble, query);
      });

      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  /** Walk DOM text nodes and wrap keyword occurrences in highlight spans. */
  private highlightKeyword(el: HTMLElement, query: string) {
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);

    for (const textNode of nodes) {
      const text = textNode.nodeValue ?? '';
      const idx = text.toLowerCase().indexOf(lower);
      if (idx === -1) continue;

      const frag = createFragment();
      let cursor = 0;
      let pos = text.toLowerCase().indexOf(lower, cursor);
      while (pos !== -1) {
        if (pos > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, pos)));
        const mark = createEl('mark');
        mark.className = 'jp-search-highlight';
        mark.textContent = text.slice(pos, pos + query.length);
        frag.appendChild(mark);
        cursor = pos + query.length;
        pos = text.toLowerCase().indexOf(lower, cursor);
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }


  private buildInputCard(root: HTMLElement) {
    this.inputCardEl = root.createDiv({ cls: 'jp-capture-card' });

    // Wrapper for textarea
    const inputWrapper = this.inputCardEl.createDiv({ cls: 'jp-capture-input-wrapper' });

    this.textareaEl = inputWrapper.createEl('textarea', {
      cls: 'jp-capture-input',
      attr: {
        placeholder: '记录这一刻吧，使用 @ 或 [[ 引入文件，# 添加标签',
        rows: '3',
      },
    });
    this.textareaEl.addEventListener('input', () => {
      this.refreshSubmitState();
      this.autoResizeTextarea();
      this.updateAutocompleteSuggestions();
    });
    // Configurable shortcut to submit (default Shift+Enter).
    this.textareaEl.addEventListener('keydown', evt => {
      // Handle autocomplete navigation first
      if (this.autocompleteActive) {
        if (evt.key === 'ArrowUp') {
          evt.preventDefault();
          this.navigateSuggestions('up');
          return;
        } else if (evt.key === 'ArrowDown') {
          evt.preventDefault();
          this.navigateSuggestions('down');
          return;
        } else if (evt.key === 'Enter') {
          evt.preventDefault();
          this.selectCurrentSuggestion();
          return;
        } else if (evt.key === 'Escape') {
          evt.preventDefault();
          this.hideAutocompletePopup();
          return;
        }
      }

      if (evt.key !== 'Enter' || evt.isComposing) return;
      const shortcut = this.plugin.settings.submitShortcut;
      const matches =
        (shortcut.includes('shift') ? evt.shiftKey : !evt.shiftKey) &&
        (shortcut.includes('ctrl') ? evt.ctrlKey : !evt.ctrlKey) &&
        (shortcut.includes('alt') ? evt.altKey : !evt.altKey);
      if (matches) {
        evt.preventDefault();
        void this.handleSubmit();
      }
    });
    // Image paste: intercept at document level (capture phase) for reliability
    this.registerDomEvent(document, 'paste', async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // Only intercept if focus is inside our textarea
      if (!this.inputCardEl.contains(document.activeElement)) return;
      for (const item of Array.from(items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const blob = item.getAsFile();
        if (!blob) continue;
        try {
          const result = await this.saveImageToVault(blob);
          const textarea = this.textareaEl;
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const before = textarea.value.substring(0, start);
          const after = textarea.value.substring(end);
          textarea.value = before + result + ' ' + after;
          const newPos = start + result.length + 1;
          textarea.setSelectionRange(newPos, newPos);
          this.refreshSubmitState();
          this.autoResizeTextarea();
        } catch (err) {
          new Notice(`图片保存失败：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }, true);
    // Image drag & drop
    this.textareaEl.addEventListener('drop', runAsync(async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        e.preventDefault();
        e.stopPropagation();
        try {
          const result = await this.saveImageToVault(file);
          const start = this.textareaEl.selectionStart;
          const end = this.textareaEl.selectionEnd;
          const before = this.textareaEl.value.substring(0, start);
          const after = this.textareaEl.value.substring(end);
          this.textareaEl.value = before + result + ' ' + after;
          const newPos = start + result.length + 1;
          this.textareaEl.setSelectionRange(newPos, newPos);
          this.refreshSubmitState();
          this.autoResizeTextarea();
        } catch (err) {
          new Notice(`图片保存失败：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }));
    this.textareaEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    }, true);

    // Autocomplete popup
    this.autocompletePopupEl = inputWrapper.createDiv({ cls: 'jp-autocomplete-popup' });
    this.autocompleteItemsEl = this.autocompletePopupEl.createDiv({ cls: 'jp-autocomplete-items' });
    this.autocompletePopupEl.addEventListener('click', (evt) => {
      const item = (evt.target as HTMLElement).closest('.jp-autocomplete-item');
      if (!item) return;
      const index = Array.from(this.autocompleteItemsEl.querySelectorAll('.jp-autocomplete-item')).indexOf(item);
      if (index >= 0) {
        this.autocompleteSelectedIndex = index;
        this.selectCurrentSuggestion();
      }
    });


    // Hidden file input for image upload
    const fileInput = this.inputCardEl.createEl('input', {
      cls: 'jp-capture-image-input',
      attr: {
        type: 'file',
        accept: 'image/*',
      },
    });
    fileInput.hide();
    fileInput.addEventListener('change', runAsync(async () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.type.startsWith('image/')) return;
      fileInput.value = '';
      try {
        const result = await this.saveImageToVault(file);
        const textarea = this.textareaEl;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        textarea.value = before + result + ' ' + after;
        const newPos = start + result.length + 1;
        textarea.setSelectionRange(newPos, newPos);
        this.refreshSubmitState();
        this.autoResizeTextarea();
      } catch (err) {
        new Notice(`图片保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }));

    // Hidden file input for image upload
    const recBar = this.inputCardEl.createDiv({ cls: 'jp-recording-bar' });
    recBar.hide();
    const recWaveRow = recBar.createDiv({ cls: 'jp-recording-wave-row' });
    const recCanvas = recWaveRow.createEl('canvas', { cls: 'jp-recording-waveform' });
    const recMeta = recWaveRow.createDiv({ cls: 'jp-recording-meta' });
    const recTime = recMeta.createSpan({ cls: 'jp-recording-time', text: '00:00' });
    const recStatus = recMeta.createSpan({ cls: 'jp-recording-status', text: '录音中…' });
    // Centered stop button shown beneath the waveform while recording.
    const recStopBtn = recBar.createEl('button', {
      cls: 'jp-recording-stop',
      attr: { 'aria-label': '停止' },
    });
    setIcon(recStopBtn, 'square');

    let mediaRecorder: MediaRecorder | null = null;
    let audioChunks: Blob[] = [];
    let recordingTimeout: number | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let recordStartedAt = 0;
    // Realtime STT state
    let realtimeProcessor: ScriptProcessorNode | null = null;
    let realtimeTimer: number | null = null;
    let segmentFrames: Float32Array[] = []; // current VAD segment being built
    let vadSilenceSamples = 0; // consecutive silent samples within the segment
    let vadSegmentSamples = 0; // total samples in the current segment
    let lastTranscript = ''; // trailing text from the previous segment → prompt context
    let realtimeBaseCursor = 0; // insertion point for streamed text
    let realtimeRegionStart = 0; // textarea index where the streamed region begins
    let realtimeActive = false; // whether live streaming is on for this session
    let pendingFlush: Promise<void> = Promise.resolve(); // serialize segment sends
    let vadFirstSegment = true; // until the first segment flushes, allow an early first-word cut
    // VAD tuning (sample-based so it adapts to any sample rate).
    const VAD_FRAME = 4096;            // ScriptProcessor buffer size
    const VAD_ENERGY_RMS = 0.012;      // below this RMS → considered silence (lowered so brief in-speech dips aren't misread as pauses)
    const VAD_SILENCE_CUT_SAMPLES = 0.45; // 450ms of silence ends a segment — long enough to ride through mid-sentence breaths
    const VAD_MAX_SEG_SAMPLES = 4.0;   // force-cut a segment at 4s (caps worst-case latency)
    const VAD_MIN_SEG_SAMPLES = 0.8;   // drop segments shorter than 0.8s
    const VAD_FIRST_FLUSH_SAMPLES = 2.4; // first segment flushes early — but not so early it splits the opening sentence

    const formatDuration = (ms: number) => {
      const total = Math.floor(ms / 1000);
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    const teardownAnalyser = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (realtimeTimer !== null) {
        window.clearInterval(realtimeTimer);
        realtimeTimer = null;
      }
      if (realtimeProcessor) {
        try { realtimeProcessor.disconnect(); } catch { /* noop */ }
        realtimeProcessor = null;
      }
      if (audioCtx) {
        void audioCtx.close();
        audioCtx = null;
        analyser = null;
      }
      segmentFrames = [];
      vadSilenceSamples = 0;
      vadSegmentSamples = 0;
      lastTranscript = '';
    };

    // Pick the best supported recording mime, preferring m4a (mp4) and
    // gracefully degrading to webm. Chromium historically lacks audio/mp4
    // support, so探测 is mandatory rather than hard-coding.
    const pickRecordingMime = (): string => {
      const candidates = [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm',
      ];
      for (const t of candidates) {
        try {
          if (MediaRecorder.isTypeSupported(t)) return t;
        } catch { /* keep probing */ }
      }
      return ''; // let the UA decide
    };

    const drawWaveform = () => {
      if (!analyser || !recCanvas) {
        rafId = null;
        return;
      }
      const ctx2d = recCanvas.getContext('2d');
      if (!ctx2d) {
        rafId = null;
        return;
      }
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      const w = recCanvas.width;
      const h = recCanvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const stroke = getComputedStyle(recBar)
        .getPropertyValue('--jp-recording-stroke')
        .trim() || '#7c3aed';
      ctx2d.fillStyle = stroke;

      // Symmetric capsule bars mirrored around the horizontal mid-line.
      const barCount = 48;
      const gap = Math.max(1, w * 0.012);
      const barW = (w - gap * (barCount - 1)) / barCount;
      const mid = h / 2;
      const maxHalf = mid * 0.98; // let bars nearly touch the edges
      const minHalf = Math.max(1, h * 0.05); // baseline so bars always read
      const samplesPerBar = buf.length / barCount;
      const r = barW / 2; // fully rounded → capsule
      // Per-bar smoothing state, created once and reused across frames.
      const smoother = drawWaveform as unknown as { _smooth?: Float32Array };
      let smooth = smoother._smooth;
      if (!smooth) {
        smooth = new Float32Array(barCount);
        smoother._smooth = smooth;
      }
      const gain = 2.4; // amplify raw mic level (typically 0.1–0.3)

      for (let i = 0; i < barCount; i++) {
        // Peak amplitude in this bar's slice of samples.
        let peak = 0;
        const start = Math.floor(i * samplesPerBar);
        const end = Math.floor((i + 1) * samplesPerBar);
        for (let j = start; j < end; j++) {
          const v = Math.abs(buf[j] - 128) / 128; // 0..1
          if (v > peak) peak = v;
        }
        // Non-linear expansion so quiet speech still moves the bars visibly:
        // gain → clamp → sqrt curve lifts the lower end.
        const expanded = Math.sqrt(Math.min(1, peak * gain));
        // Smooth toward the new value to avoid jitter (attack/release).
        const prev = smooth[i];
        const target = expanded > prev ? expanded : prev * 0.82 + expanded * 0.18;
        smooth[i] = target;
        const half = Math.max(minHalf, target * maxHalf);
        const x = i * (barW + gap);
        // Top + bottom mirrored capsules.
        if (typeof ctx2d.roundRect === 'function') {
          ctx2d.beginPath();
          ctx2d.roundRect(x, mid - half, barW, half, r);
          ctx2d.fill();
          ctx2d.beginPath();
          ctx2d.roundRect(x, mid, barW, half, r);
          ctx2d.fill();
        } else {
          ctx2d.fillRect(x, mid - half, barW, half);
          ctx2d.fillRect(x, mid, barW, half);
        }
      }

      recTime.setText(formatDuration(performance.now() - recordStartedAt));
      rafId = window.requestAnimationFrame(drawWaveform);
    };

    const stopRecording = async () => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
      // Freeze the live UI immediately so the waveform/duration stop the
      // moment the user clicks stop — don't wait for onstop or network.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (realtimeTimer !== null) {
        window.clearInterval(realtimeTimer);
        realtimeTimer = null;
      }
      if (realtimeProcessor) {
        try { realtimeProcessor.disconnect(); } catch { /* noop */ }
        realtimeProcessor = null;
      }
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      if (recordingTimeout !== null) {
        window.clearTimeout(recordingTimeout);
        recordingTimeout = null;
      }
    };

    const sttConfigured = () => {
      const s = this.plugin.settings;
      return s.sttEndpoint.trim().length > 0 && s.sttApiKey.trim().length > 0;
    };

    const wantRealtime = () => sttConfigured() && this.plugin.settings.sttRealtime;

    // Append streamed text right after the streaming cursor, keeping the
    // caret at the end so the next chunk lands next to it.
    const appendStreamedText = (text: string) => {
      const ta = this.textareaEl;
      const pos = realtimeBaseCursor;
      const before = ta.value.substring(0, pos);
      const after = ta.value.substring(pos);
      ta.value = before + text + after;
      realtimeBaseCursor = pos + text.length;
      ta.setSelectionRange(realtimeBaseCursor, realtimeBaseCursor);
      this.refreshSubmitState();
      this.autoResizeTextarea();
    };

    // Encode captured Float32 PCM frames into a standalone 16-bit PCM WAV
    // blob — independently decodable, so every chunk transcribes on its own.
    const encodeWav = (frames: Float32Array[], sampleRate: number): Blob => {
      const total = frames.reduce((n, f) => n + f.length, 0);
      if (total === 0) return new Blob([], { type: 'audio/wav' });
      const buffer = new ArrayBuffer(44 + total * 2);
      const view = new DataView(buffer);
      const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + total * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);          // PCM
      view.setUint16(22, 1, true);          // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, total * 2, true);
      let off = 44;
      for (const frame of frames) {
        for (let i = 0; i < frame.length; i++) {
          let s = Math.max(-1, Math.min(1, frame[i]));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          off += 2;
        }
      }
      return new Blob([buffer], { type: 'audio/wav' });
    };

    // RMS energy of a PCM frame → drives voice-activity detection.
    const frameRms = (frame: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return Math.sqrt(sum / frame.length);
    };

    // Transcribe one VAD segment with the previous segment's trailing text as
    // `prompt` context, then append the result. Serialized so segments are
    // sent in order even if transcription outpaces real time.
    const transcribeSegment = (frames: Float32Array[], sr: number) => {
      pendingFlush = pendingFlush.then(async () => {
        const wav = encodeWav(frames, sr);
        if (wav.size < 4000) return; // too short → unstable transcript, skip
        try {
          // Feed the tail of the prior transcript as context so cross-segment
          // homophones / word-boundary carryover resolve correctly.
          const promptText = lastTranscript.slice(-64);
          const t = (await this.transcribeAudio(wav, promptText)).trim();
          if (t.length > 0) {
            appendStreamedText(t);
            lastTranscript = (lastTranscript + t).slice(-256);
          }
        } catch {
          // A failed segment shouldn't kill the live session — drop and continue.
        }
      });
    };

    // Flush whatever is currently accumulated in the segment buffer. Used both
    // by the max-length force-cut and by the final flush on stop.
    const flushCurrentSegment = () => {
      if (!audioCtx) return;
      if (segmentFrames.length === 0) return;
      const sr = audioCtx.sampleRate;
      const seg = segmentFrames;
      segmentFrames = [];
      vadSegmentSamples = 0;
      vadSilenceSamples = 0;
      if (seg.reduce((n, f) => n + f.length, 0) / sr < VAD_MIN_SEG_SAMPLES) return;
      vadFirstSegment = false;
      void transcribeSegment(seg, sr);
    };

    // Inspect an incoming PCM frame for voice activity; either accumulate it
    // into the current segment or cut at a silence boundary and transcribe.
    const ingestFrame = (frame: Float32Array) => {
      if (!audioCtx) return;
      const sr = audioCtx.sampleRate;
      segmentFrames.push(new Float32Array(frame));
      vadSegmentSamples += frame.length;

      const silent = frameRms(frame) < VAD_ENERGY_RMS;
      vadSilenceSamples = silent ? vadSilenceSamples + frame.length : 0;

      // Cut after a pause (natural phrase boundary) — best accuracy per send.
      if (vadSilenceSamples >= VAD_SILENCE_CUT_SAMPLES * sr
          && vadSegmentSamples >= VAD_MIN_SEG_SAMPLES * sr) {
        flushCurrentSegment();
        return;
      }
      // First segment flushes early (before any pause) so the user sees the
      // first words quickly instead of waiting for a silence boundary.
      if (vadFirstSegment && vadSegmentSamples >= VAD_FIRST_FLUSH_SAMPLES * sr) {
        flushCurrentSegment();
        return;
      }
      // Force-cut overly long segments so latency stays bounded.
      if (vadSegmentSamples >= VAD_MAX_SEG_SAMPLES * sr) {
        flushCurrentSegment();
      }
    };

    const insertAtCursor = (text: string) => {
      const textarea = this.textareaEl;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      const piece = text + ' ';
      textarea.value = before + piece + after;
      const newPos = start + piece.length;
      textarea.setSelectionRange(newPos, newPos);
      this.refreshSubmitState();
      this.autoResizeTextarea();
    };

    const startRecording = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        const mime = pickRecordingMime();
        mediaRecorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        const outType = mime.startsWith('audio/mp4') ? 'audio/mp4' : 'audio/webm';

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          // Flush the tail segment and snapshot the in-flight chain BEFORE
          // any await. We must insert the audio embed *after* every queued
          // segment's `appendStreamedText` has run, otherwise a slow final
          // segment would land AFTER the embed (re-ordering the text).
          //
          // We capture `pendingFlush` here and await it (no timeout race) so
          // the chain fully drains. The waveform is torn down immediately so
          // the UI doesn't appear stuck; only the final text append waits on
          // the network. A genuinely-hung segment is rare; if it happens the
          // user can reload the plugin and the text already on screen is kept.
          if (realtimeActive && audioCtx) flushCurrentSegment();
          const flushChain = pendingFlush;
          teardownAnalyser();
          const audioBlob = new Blob(audioChunks, { type: outType });
          const wantSTT = sttConfigured();
          // Keep the recBar visible with a breathing effect while we finish
          // the final transcription. The stop button is hidden (recording
          // already stopped) and the icon group + NOTE button stay hidden
          // until the final text has landed (so the user sees the result
          // appear together with the action buttons coming back).
          recStatus.setText('转写中…');
          recBar.addClass('is-transcribing');
          recBar.show();
          try {
            const audioEmbed = await this.saveAudioToVault(audioBlob);
            let text = '';
            // In realtime mode, keep the streamed draft as-is (faster, no
            // extra API call) and just append audio. In non-realtime mode,
            // transcribe the full recording now.
            if (!realtimeActive && wantSTT) {
              try {
                text = (await this.transcribeAudio(audioBlob)).trim();
              } catch (err) {
                new Notice(`转写失败：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // Drain any still-in-flight live segments before we touch the
            // text again. This guarantees the embed lands at the end of the
            // streamed text, never in the middle.
            await flushChain;
            if (realtimeActive) {
              // Keep the live draft; append the audio embed after it.
              appendStreamedText(` ${audioEmbed}`);
            } else {
              insertAtCursor(text.length > 0 ? `${text} ${audioEmbed}` : audioEmbed);
            }
          } catch (err) {
            new Notice(`录音保存失败：${err instanceof Error ? err.message : String(err)}`);
          } finally {
            // RecBar fades out and the action bar (icon group + NOTE button)
            // comes back together — the user sees the result and the controls
            // to act on it arrive in the same beat.
            recBar.removeClass('is-transcribing');
            recBar.removeClass('jp-bar-entering');
            recBar.hide();
            actions.removeClass('is-recording');
          }
        };

        mediaRecorder.start();

        // Decide live-streaming for this session.
        realtimeActive = wantRealtime();

        // Wire up the live waveform + duration. Do NOT connect analyser to
        // destination — that would route mic back to speakers and cause feedback.
        try {
          const Ctor = window.AudioContext
            || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctor) throw new Error('AudioContext unavailable');
          audioCtx = new Ctor();
          const source = audioCtx.createMediaStreamSource(stream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);

          // Realtime capture: tap the same source via a ScriptProcessor and
          // segment by voice activity (silence boundaries) for transcription.
          if (realtimeActive) {
            realtimeRegionStart = this.textareaEl.selectionStart;
            realtimeBaseCursor = realtimeRegionStart;
            lastTranscript = '';
            segmentFrames = [];
            vadSilenceSamples = 0;
            vadSegmentSamples = 0;
            vadFirstSegment = true;
            const sp = audioCtx.createScriptProcessor(VAD_FRAME, 1, 1);
            sp.onaudioprocess = (ev: AudioProcessingEvent) => {
              ingestFrame(ev.inputBuffer.getChannelData(0));
            };
            source.connect(sp);
            // ScriptProcessor must connect somewhere to fire; analyser suffices.
            sp.connect(analyser);
            realtimeProcessor = sp;
          }

          // Reveal the bar FIRST, then measure — reading clientWidth while
          // display:none returns 0 and the canvas ends up 1px wide (invisible).
          // The `jp-bar-entering` class triggers a one-shot fade+slide
          // animation; we remove it after hide so the next show replays it.
          recStatus.setText(realtimeActive ? '实时转写中…' : '录音中…');
          recBar.show();
          recBar.addClass('jp-bar-entering');
          const dpr = window.devicePixelRatio || 1;
          recCanvas.width = Math.max(1, recCanvas.clientWidth) * dpr;
          recCanvas.height = Math.max(1, recCanvas.clientHeight) * dpr;
          recordStartedAt = performance.now();
          rafId = window.requestAnimationFrame(drawWaveform);
        } catch {
          // Analyser/realtime are optional — recording still works without them.
        }

        // Switch the mic icon to a stop square first so the user gets
        // immediate click feedback, then add the is-recording class so the
        // colour change is animated (not a flash). Trigger the focus-
        // recording mode (icon group + submit collapse) at the same time
        // as the recBar reveal so the two animations overlap and feel like
        // a single transition rather than a sequence.
        setIcon(micBtn, 'square');
        micBtn.addClass('is-recording');
        actions.addClass('is-recording');

        recordingTimeout = window.setTimeout(() => {
          void stopRecording();
          new Notice('录音已自动停止（最长5分钟）');
        }, 5 * 60 * 1000);
      } catch (err) {
        new Notice(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Expose to beginRecording() so the URL handler can trigger recording.
    this.startRecordingFn = startRecording;

    const actions = this.inputCardEl.createDiv({ cls: 'jp-capture-actions' });

    // Left icon group: image + mic
    const buttonRow = actions.createDiv({ cls: 'jp-capture-button-row' });

    // Image upload button
    const imageBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-image-btn',
      attr: { 'aria-label': '上传图片' },
    });
    setIcon(imageBtn, 'image');
    imageBtn.addEventListener('click', () => {
      fileInput.click();
    });

    // Microphone button
    const micBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-mic-btn',
      attr: { 'aria-label': '录音' },
    });
    setIcon(micBtn, 'mic');

    // Shared stop path: stop recording + restore the idle UI (icon group,
    // submit button) with a smooth transition. The actual text insert /
    // transcription runs async in onstop, independent of this UI restore.
    //
    // We deliberately keep `actions.is-recording` set here so the icon group
    // and NOTE button stay hidden until the final text has been written. The
    // recBar is switched to its "transcribing" state by onstop, and only
    // removed from .is-recording once the last segment has landed.
    const doStop = async () => {
      await stopRecording();
      micBtn.removeClass('is-recording');
      setIcon(micBtn, 'mic');
    };

    micBtn.addEventListener('click', runAsync(async () => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        await startRecording();
      } else {
        await doStop();
      }
    }));

    // Stop button centered under the waveform.
    recStopBtn.addEventListener('click', () => void doStop());

    // Task button
    const taskBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-task-btn',
      attr: { 'aria-label': '切换任务模式' },
    });
    setIcon(taskBtn, 'list');
    taskBtn.addEventListener('click', () => {
      this.isTaskMode = !this.isTaskMode;
      taskBtn.toggleClass('is-active', this.isTaskMode);
      // Change icon based on mode
      if (this.isTaskMode) {
        setIcon(taskBtn, 'square-check');
      } else {
        setIcon(taskBtn, 'list');
      }
    });

    this.submitBtn = actions.createEl('button', {
      cls: 'jp-capture-submit',
      text: 'NOTE',
    });
    this.submitBtn.addEventListener('click', () => {
      void this.handleSubmit();
    });

    this.refreshSubmitState();
  }

  /**
   * Resolve the full vault path to save an attachment at.
   *
   * - No configured folder → defer entirely to Obsidian's
   *   `getAvailablePathForAttachment`: it reads the real "Files & links →
   *   Default location for new attachments" setting (`attachmentFolderPath`,
   *   NOT the new-file setting), honours the `.` (same folder as note) and
   *   `/` (vault root) special values, creates the parent dir, and de-dupes.
   * - Configured folder (or `/` for vault root) → de-dupe the base name
   *   against THAT folder and ensure it exists. `getAvailablePathForAttachment`
   *   can't be reused here: it de-dupes against the *attachment*-setting
   *   folder, so when the two differ the suffix would be wrong — it would
   *   skip a name that collides in our folder, or append one needlessly.
   *
   * Note: `FileManager.getNewFileParent` reads the *new-note* location
   * (`newFileLocation` / `newFileFolderPath`), a different setting from the
   * attachment folder — using it here was a bug that landed files in the
   * new-note folder instead of the attachment folder.
   */
  private async resolveAttachmentPath(configuredFolder: string, baseName: string): Promise<string> {
    const configured = configuredFolder.trim();
    if (configured.length === 0) {
      const todayNote = getDailyNote(moment(), getAllDailyNotes());
      const sourcePath = todayNote?.path ?? '';
      return this.app.fileManager.getAvailablePathForAttachment(baseName, sourcePath);
    }
    // User-configured folder (`/` → vault root). De-dupe against it directly.
    const folder = configured === '/' ? '' : configured;
    const prefix = folder ? `${folder}/` : '';
    let candidate = `${prefix}${baseName}`;
    if (this.app.vault.getAbstractFileByPath(candidate)) {
      const dot = baseName.lastIndexOf('.');
      const stem = dot === -1 ? baseName : baseName.slice(0, dot);
      const ext = dot === -1 ? '' : baseName.slice(dot);
      let n = 1;
      candidate = `${prefix}${stem} ${n}${ext}`;
      while (this.app.vault.getAbstractFileByPath(candidate)) {
        n++;
        candidate = `${prefix}${stem} ${n}${ext}`;
      }
    }
    await this.ensureAttachmentFolder(folder);
    return candidate;
  }

  /**
   * Create `folder` and any missing parents. `vault.createFolder` only
   * creates a single level, so a nested configured path like `Assets/Audio`
   * would fail if `Assets` doesn't exist yet. No-op for empty (vault root).
   */
  private async ensureAttachmentFolder(folder: string): Promise<void> {
    if (!folder) return;
    let current = '';
    for (const part of folder.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async saveImageToVault(blob: Blob): Promise<string> {
    const ext = blob.type === 'image/png' ? 'png'
      : blob.type === 'image/gif' ? 'gif'
      : blob.type === 'image/webp' ? 'webp'
      : blob.type === 'image/jpeg' ? 'jpg' : 'png';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const baseName = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
    const filePath = await this.resolveAttachmentPath(this.plugin.settings.imageFolder, baseName);
    const buffer = await blob.arrayBuffer();
    const file = await this.app.vault.createBinary(filePath, buffer);
    return `![](${file.path})`;
  }

  private async saveAudioToVault(blob: Blob): Promise<string> {
    const ext = blob.type === 'audio/mp4' ? 'm4a' : 'webm';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const baseName = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
    const filePath = await this.resolveAttachmentPath(this.plugin.settings.recordingFolder, baseName);
    const buffer = await blob.arrayBuffer();
    const file = await this.app.vault.createBinary(filePath, buffer);
    return `![[${file.path}]]`;
  }

  /**
   * Transcribe an audio blob via an OpenAI-compatible /audio/transcriptions
   * endpoint. Builds the multipart/form-data body by hand because Obsidian's
   * `requestUrl` has no multipart helper. Returns the plain-text transcript.
   */
  private async transcribeAudio(blob: Blob, prompt = ''): Promise<string> {
    const s = this.plugin.settings;
    const endpoint = s.sttEndpoint.trim();
    const apiKey = s.sttApiKey.trim();
    if (endpoint.length === 0 || apiKey.length === 0) return '';

    const boundary = '----JPBoundary' + Math.floor(Math.random() * 1e9).toString(16);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];

    const field = (name: string, value: string) => {
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    };
    field('model', s.sttModel.trim() || 'whisper-1');
    field('response_format', 'json');
    const lang = s.sttLanguage.trim();
    if (lang.length > 0) field('language', lang);
    // Prior-segment context — improves cross-boundary word accuracy. Whisper
    // and SenseVoice both honour the `prompt` field as a style/context hint.
    const promptText = prompt.trim();
    if (promptText.length > 0) field('prompt', promptText);

    const fileBytes = new Uint8Array(await blob.arrayBuffer());
    // Derive filename from the blob's mime so the endpoint sees a sensible ext.
    const ext = blob.type.includes('mp4') ? 'm4a'
      : blob.type.includes('wav') ? 'wav' : 'webm';
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${blob.type || 'audio/webm'}\r\n\r\n`,
      ),
    );
    parts.push(fileBytes);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      body.set(p, offset);
      offset += p.length;
    }

    const resp = await requestUrl({
      url: endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body.buffer,
    });
    const text = (resp.json as { text?: string } | undefined)?.text;
    return typeof text === 'string' ? text : '';
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

  /**
   * Confirm-then-clear the capture textarea. Any `![[*.m4a]]` audio embeds
   * in the text are extracted and their files moved to Obsidian's trash
   * (recoverable), matching the timeline's delete-with-audio behaviour.
   * Image embeds are text-only cleared (no file deletion) — clearing is for
   * discarding a draft, not housekeeping attachments.
   */
  private async confirmClearInput(value: string): Promise<void> {
    const audioPaths = extractAudioEmbeds(value);
    const modal = new Modal(this.app);
    modal.titleEl.setText('清空输入框');
    modal.contentEl.addClass('jp-clear-confirm');
    modal.contentEl.createEl('p', {
      cls: 'jp-clear-confirm-question',
      text: audioPaths.length > 0
        ? `确定清空输入框吗？将同时删除 ${audioPaths.length} 个录音文件（移入回收站，可恢复）。`
        : '确定清空输入框吗？',
    });
    if (audioPaths.length > 0) {
      const list = modal.contentEl.createEl('ul', { cls: 'jp-clear-confirm-list' });
      for (const p of audioPaths) list.createEl('li', { text: p });
    }
    const actions = modal.contentEl.createDiv({ cls: 'jp-delete-confirm-actions' });
    const cancelBtn = actions.createEl('button', { cls: 'jp-delete-confirm-cancel', text: '取消' });
    cancelBtn.addEventListener('click', () => modal.close());
    const confirmBtn = actions.createEl('button', {
      cls: 'mod-warning jp-delete-confirm-confirm',
      text: '清空',
    });
    confirmBtn.addEventListener('click', runAsync(async () => {
      modal.close();
      // Trash embedded audio files (recoverable via Obsidian trash).
      let trashed = 0;
      for (const path of audioPaths) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) continue;
        try {
          await this.app.fileManager.trashFile(af);
          trashed++;
        } catch (err) {
          console.error(`[Journal Partner] trash audio failed: ${path}`, err);
        }
      }
      this.textareaEl.value = '';
      this.refreshSubmitState();
      this.autoResizeTextarea();
      new Notice(
        audioPaths.length > 0
          ? `🧹 已清空，${trashed}/${audioPaths.length} 个录音文件移入回收站`
          : '🧹 已清空',
      );
    }));
    window.setTimeout(() => cancelBtn.focus(), 0);
    modal.open();
  }

  private autoResizeTextarea() {
    this.textareaEl.setCssProps({ height: 'auto' });
    const next = Math.min(this.textareaEl.scrollHeight, 240);
    this.textareaEl.setCssProps({ height: `${next}px` });
  }

  private scheduleFullRebuild() {
    // Only skip when actively on the search tab — other tabs don't hold timeline state
    if (this.currentTab === 'search') return;
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

  async fullRebuild(): Promise<void> {
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
    if (this.searchActive) {
      await this.loadMoreSearchResults();
      return;
    }
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
      file = getDailyNote(date, getAllDailyNotes());
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
      file = getDailyNote(day.date, getAllDailyNotes());
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
    headerText.createDiv({ cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createDiv({ cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });
    this.addOpenNoteBtn(headerCard, day);

    if (entries.length === 0) {
      // Today with no entries — soft hint only
      day.el.createDiv({ cls: 'jp-capture-empty', text: '还没有 memo，写点什么吧 →' });
      return;
    }

    // Sort entries within the day
    const latestTs = entries.reduce<string>(
      (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
      '',
    );
    const sorted = sortJournalEntries(entries, this.plugin.settings.sortOrder);

    const sourcePath = day.filePath ?? '';
    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });

      // Add task-specific classes if this is a task entry
      if (entry.type === 'task') {
        row.addClass('jp-entry-task');
        if (entry.completed) {
          row.addClass('jp-task-completed');
        }
      }

      const dot = row.createDiv({ cls: 'jp-timeline-dot' });

      // Regular memos: always filled dot
      if (entry.type === 'memo') {
        dot.addClass('jp-timeline-dot--filled');
      }
      // Tasks: special outlined dot with ring
      else if (entry.type === 'task') {
        dot.addClass('jp-timeline-dot--task-marker');
      }

      // Header: timestamp pill anchored to the dot via a short connector line.
      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createSpan({ cls: 'jp-timestamp', text: entry.timestamp });

      // Add checkbox icon after timestamp for task entries
      if (entry.type === 'task') {
        const checkbox = head.createDiv({ cls: 'jp-task-icon' });
        if (entry.completed) {
          setIcon(checkbox, 'check-square-2');
        } else {
          setIcon(checkbox, 'square');
        }

        // Make checkbox clickable to toggle completion status
        checkbox.addEventListener('click', runAsync(async () => {
          if (!day.filePath) return;
          try {
            const file = this.app.vault.getAbstractFileByPath(day.filePath);
            if (!(file instanceof TFile)) return;

            const content = await this.app.vault.read(file);
            const newContent = editEntryInSection(
              content,
              this.plugin.settings,
              entry.lineIndex,
              buildTaskLine(entry.text, entry.timestamp, !entry.completed),
            );

            await this.app.vault.modify(file, newContent);
            // Update entry state
            entry.completed = !entry.completed;
            // Refresh the icon
            checkbox.empty();
            if (entry.completed) {
              setIcon(checkbox, 'check-square-2');
            } else {
              setIcon(checkbox, 'square');
            }
          } catch (err) {
            console.error('[Journal Partner] toggle task failed:', err);
            new Notice('切换任务状态失败');
          }
        }));
      }

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

  // ── Review pane ─────────────────────────────────────────────────────────

  /** Load a random past daily note and render its entries as a timeline. */
  private async loadReview(): Promise<void> {
    this.reviewPaneEl.empty();

    if (!appHasDailyNotesPluginLoaded()) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '请先启用 Obsidian 自带的「Daily Notes」核心插件' });
      return;
    }

    const allNotes = getAllDailyNotes();
    const today = moment().startOf('day');
    const files = Object.values(allNotes).filter((f): f is TFile => {
      if (!(f instanceof TFile)) return false;
      const d = getDateFromFile(f, 'day');
      return !!d && d.isBefore(today, 'day');
    });

    if (files.length === 0) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '还没有过去的日记可以回顾' });
      return;
    }

    // Pick a random file
    const file = files[Math.floor(Math.random() * files.length)];
    const date = getDateFromFile(file, 'day').clone().startOf('day');

    // Header with date + re-roll button
    const header = this.reviewPaneEl.createDiv({ cls: 'jp-review-header' });
    const dateEl = header.createDiv({ cls: 'jp-review-date' });
    const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.day()];
    dateEl.setText(date.format('YYYY年M月D日') + ' · ' + weekdayZh);

    const rerollBtn = header.createEl('button', {
      cls: 'jp-review-reroll-btn',
      attr: { 'aria-label': '换一天' },
    });
    setIcon(rerollBtn, 'dice');
    rerollBtn.addEventListener('click', () => void this.loadReview());

    const openBtn = header.createEl('button', {
      cls: 'jp-review-reroll-btn',
      attr: { 'aria-label': '打开日记' },
    });
    setIcon(openBtn, 'crosshair');
    openBtn.addEventListener('click', () => void this.openDailyNoteByDate(date));

    // Parse entries
    let entries: Array<{ timestamp: string; text: string; lineIndex: number }> = [];
    try {
      const content = await this.app.vault.cachedRead(file);
      const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
      if (section) {
        const text = content.slice(section.from, section.to);
        // First try normal timestamped entries
        const parsed = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        if (parsed.length > 0) {
          entries = parsed;
        } else {
          // Fallback: treat every non-empty list item as an entry with 00:00
          entries = this.parseLooseEntries(text);
        }
      }
    } catch (err) {
      console.error('[Journal Partner] review read failed', err);
    }

    if (entries.length === 0) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '这天没有日记内容' });
      return;
    }

    // Respect the configured sort order (newest or oldest first)
    const sorted = sortJournalEntries(entries, this.plugin.settings.sortOrder);

    const scope = new Component();
    scope.load();
    this.register(() => scope.unload());

    const timeline = this.reviewPaneEl.createDiv({ cls: 'jp-timeline' });
    const sourcePath = file.path;

    for (const entry of sorted) {
      const row = timeline.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });
      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createSpan({ cls: 'jp-timestamp', text: entry.timestamp });
      const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, scope);
    }
  }

  /**
   * Loose parser: treat every top-level list item as an entry timestamped 00:00.
   * Used when the section has no standard `- HH:MM ...` format.
   */
  private parseLooseEntries(sectionText: string): Array<{ timestamp: string; text: string; lineIndex: number }> {
    const result: Array<{ timestamp: string; text: string; lineIndex: number }> = [];
    const lines = sectionText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^[-*+]\s+(.+)$/);
      if (!m) continue;
      let text = m[1].trim();
      // Collect indented continuation lines
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        text += '\n' + lines[j].replace(/^\s{0,2}/, '');
        j++;
      }
      result.push({ timestamp: '00:00', text, lineIndex: i });
    }
    return result;
  }

  // ── Stats pane ──────────────────────────────────────────────────────────

  /** Build the static scaffold of the stats pane (toolbar + body). */
  private buildStatsPane() {
    // Toolbar with title
    this.statsToolbarEl = this.statsPaneEl.createDiv({ cls: 'jp-stats-toolbar' });

    this.statsToolbarEl.createDiv({ cls: 'jp-stats-toolbar-spacer' });

    this.statsYearLabelEl = this.statsToolbarEl.createDiv({
      cls: 'jp-stats-year-label',
      text: '全量数据',
    });

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
      void this.loadAllStats();
    }, 300);
  }

  /** Load + render stats for all available years. */
  private async loadAllStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;

    this.statsYearLabelEl.setText('全量数据');
    this.renderStatsLoading();

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderStatsError('请先启用 Obsidian 自带的「Daily Notes」核心插件');
        return;
      }

      const all = getAllDailyNotes();
      const yearMap = new Map<number, Array<{ key: string; sectionText: string }>>();

      // Group all daily notes by year
      for (const file of Object.values(all)) {
        if (!(file instanceof TFile)) continue;
        const d = getDateFromFile(file, 'day');
        if (!d) continue;
        const year = d.year();
        const key = d.format('YYYY-MM-DD');

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

        if (!yearMap.has(year)) yearMap.set(year, []);
        yearMap.get(year).push({ key, sectionText });
      }

      // Compute stats for each year
      this.allYearStats.clear();
      for (const [year, dayInputs] of yearMap) {
        const ys = computeYearStats(year, dayInputs, this.plugin.settings.timestampPattern);
        this.allYearStats.set(year, ys);
      }

      // Compute all-time stats
      this.allTimeStats = computeAllTimeStats([...this.allYearStats.values()]);

      this.renderStatsContent();
    } catch (err) {
      console.error('[Journal Partner] stats load failed', err);
      this.renderStatsError(`加载失败：${err instanceof Error ? err.message : String(err)}`);
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
  private renderStatsLoading() {
    this.statsBodyEl.empty();
    const loading = this.statsBodyEl.createDiv({ cls: 'jp-stats-loading' });
    loading.createDiv({ cls: 'jp-stats-spinner' });
    loading.createDiv({
      text: '正在加载日记数据…',
      cls: 'jp-stats-loading-text',
    });
  }

  private renderStatsError(msg: string) {
    this.statsBodyEl.empty();
    this.statsBodyEl.createDiv({ cls: 'jp-stats-empty', text: msg });
  }

  private renderStatsContent() {
    this.statsBodyEl.empty();
    const allTime = this.allTimeStats;
    if (!allTime) return;

    // ── All-time hero ────────────────────────────────────────────────────
    const hero = this.statsBodyEl.createDiv({ cls: 'jp-stats-hero' });
    const top = hero.createDiv({ cls: 'jp-stats-hero-top' });

    const numLine = top.createDiv({ cls: 'jp-stats-hero-number' });
    const formatted = formatChineseWordCount(allTime.totalWords);
    if (formatted.includes('万')) {
      const [num, unit] = formatted.split(' ');
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: num });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: unit });
    } else {
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: formatted });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: '字' });
    }

    const sub = top.createDiv({ cls: 'jp-stats-hero-sub' });
    const yearsStr = allTime.yearsWithData.length > 0
      ? `${allTime.yearsWithData[0]}–${allTime.yearsWithData[allTime.yearsWithData.length - 1]} 年`
      : '暂无数据';
    sub.createSpan({ text: yearsStr });

    const grid = hero.createDiv({ cls: 'jp-stats-hero-kpis' });
    this.makeStatsKPI(grid, 'file-text', `${allTime.writingDays}`, '天', '写作天数');
    this.makeStatsKPI(grid, 'pencil', `${allTime.totalEntries}`, '条', '总条数');
    this.makeStatsKPI(grid, 'mic', `${allTime.totalAudios}`, '段', '录音数');
    this.makeStatsKPI(grid, 'flame', `${allTime.longestStreak}`, '天', '最长连续');

    // ── Per-year heatmaps ─────────────────────────────────────────────────
    const years = [...this.allYearStats.keys()].sort((a, b) => b - a);
    for (const year of years) {
      const ys = this.allYearStats.get(year);
      this.renderStatsHeatmapSection(year, ys);
    }
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

  private renderStatsHeatmapSection(year: number, stats: YearStats) {
    const section = this.statsBodyEl.createDiv({ cls: 'jp-stats-heatmap-section' });

    const header = section.createDiv({ cls: 'jp-stats-heatmap-header' });
    header.createDiv({ cls: 'jp-stats-heatmap-title', text: `${year} 年` });

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
      `${stats.writingDays} 天 · ${stats.totalWords.toLocaleString('en-US')} 字 · ${stats.totalEntries} 条` +
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
    const paddedDays: (typeof allDays[number] | null)[] = [];
    for (let i = 0; i < startPad; i++) paddedDays.push(null);
    paddedDays.push(...allDays);
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

  /** Add a locate button to the right side of a day header card. */
  private addOpenNoteBtn(headerCard: HTMLElement, day: DaySection) {
    if (!day.filePath) return;
    const btn = headerCard.createEl('button', {
      cls: 'jp-timeline-open-btn',
      attr: { 'aria-label': '打开日记' },
    });
    setIcon(btn, 'crosshair');
    btn.addEventListener('click', () => void this.openDailyNoteByDate(day.date));
  }

  /** Open the daily note for `date` in a new center tab. */
  private async openDailyNoteByDate(date: moment.Moment): Promise<void> {
    try {
      const file = getDailyNote(date, getAllDailyNotes());
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
   *   - 仅删除录音文件       — keeps the memo text, trashes audio + strips ![[..]]
   *
   * The audio-related item is only added when the entry actually
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

    menu.addItem(item =>
      item
        .setTitle('编辑')
        .setIcon('pencil')
        .onClick(() => {
          void this.openEditEntry(day, entry);
        }),
    );

    menu.addSeparator();

    menu.addItem(item =>
      item
        .setTitle('删除 memo')
        .setIcon('trash-2')
        .onClick(() => {
          const mode: DeleteMode = audioPaths.length > 0 ? 'memo+audio' : 'memo';
          this.confirmAndDelete(day, entry, mode, audioPaths);
        }),
    );

    if (audioPaths.length > 0) {
      menu.addItem(item =>
        item
          .setTitle(
            audioPaths.length === 1
              ? '仅删除录音文件（保留文字）'
              : `仅删除 ${audioPaths.length} 个录音文件（保留文字）`,
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
   * Open a modal pre-filled with the entry's body text. On save, rewrite the
   * entry's head + continuation lines in the daily note via
   * `editEntryInSection`, preserving the original list marker and timestamp.
   */
  private async openEditEntry(day: DaySection, entry: JournalEntry): Promise<void> {
    if (!day.filePath) {
      new Notice('找不到对应的日记文件');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) {
      new Notice('找不到对应的日记文件');
      return;
    }
    new EditEntryModal(this.app, entry, async newText => {
      try {
        const content = await this.app.vault.read(file);
        const next = editEntryInSection(
          content,
          this.plugin.settings,
          entry.lineIndex,
          newText,
        );
        if (next === content) {
          // lineIndex no longer points at a head line — file changed.
          new Notice('日记内容已变化，请刷新后重试');
          await this.refreshDay(day);
          return;
        }
        await this.app.vault.modify(file, next);
        new Notice('✏️ 已更新');
      } catch (err) {
        console.error('[Journal Partner] edit entry failed', err);
        new Notice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }).open();
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
      // Format entry based on mode
      let text: string;
      if (this.isTaskMode) {
        // Task format: "[ ] text" (Obsidian checkbox syntax)
        // writeToTodayJournal will add the "- HH:MM" prefix
        text = `[ ] ${raw}`;
      } else {
        text = raw;
      }
      const ok = await this.plugin.writeToTodayJournal(text);
      if (!ok) return;

      this.textareaEl.value = '';
      this.isTaskMode = false;
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

      // Scroll to top so user sees the new entry land
      const scroller = this.containerEl.children[1] as HTMLElement;
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('[Journal Partner] submit failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.submitBtn.setText(originalText ?? 'NOTE');
      this.refreshSubmitState();
    }
  }

  // ── Autocomplete ───────────────────────────────────────────────────────────

  /**
   * Called on every input event. Detects @ or # trigger and updates suggestions.
   */
  private updateAutocompleteSuggestions(): void {
    const trigger = this.getTriggerInfo();
    if (!trigger) {
      this.hideAutocompletePopup();
      return;
    }

    const { type, query, pos } = trigger;
    // Store type as @ or #, treat [[ as @
    this.autocompleteType = type === '[[' ? '@' : type;
    this.autocompleteQuery = query;
    this.autocompleteStartPos = pos;
    this.autocompleteSelectedIndex = 0;

    let suggestions: string[] = [];
    if (type === '@' || type === '[[') {
      suggestions = this.getFileSuggestions(query);
    } else if (type === '#') {
      suggestions = this.getTagSuggestions(query);
    }

    if (suggestions.length === 0) {
      this.hideAutocompletePopup();
    } else {
      this.showAutocompletePopup(type, suggestions);
    }
  }

  /**
   * Find the nearest @ or # to the cursor, working backwards from current position.
   * Returns null if no trigger found or if # is at line start (markdown heading).
   */
  /**
   * Find the nearest @, #, or [[ to the cursor, working backwards from current position.
   * For @ and [[: always trigger (file mention)
   * For #: trigger unless it's a markdown heading (i.e., followed by space at line start)
   */
  private getTriggerInfo(): { type: '@' | '#' | '[['; query: string; pos: number } | null {
    const textarea = this.textareaEl;
    const cursorPos = textarea.selectionStart;
    const text = textarea.value;

    // Scan backwards to find @, #, or [[
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];
      const nextChar = text[i + 1];

      // Check for [[ trigger
      if (char === '[' && nextChar === '[') {
        // [[ can trigger anywhere for file mention
        const rawQuery = text.slice(i + 2, cursorPos);
        // Only trigger if no ] closes the bracket yet and no spaces
        if (!/[\]\s]/.test(rawQuery)) {
          return { type: '[[', query: rawQuery, pos: i };
        }
        break;
      } else if (char === '@') {
        // @ can trigger anywhere
        const rawQuery = text.slice(i + 1, cursorPos);
        // Only trigger if no spaces between @ and cursor
        if (!/\s/.test(rawQuery)) {
          return { type: '@', query: rawQuery, pos: i };
        }
        break;
      } else if (char === '#') {
        // Check if this is a markdown heading: "# " at line start
        // Only skip if: it's at line start AND immediately followed by space
        const lineStart = text.lastIndexOf('\n', i) + 1;
        const beforeTrigger = text.slice(lineStart, i);
        const afterTrigger = text[i + 1];

        const isLineStart = /^\s*$/.test(beforeTrigger);
        const hasSpaceAfter = afterTrigger === ' ' || afterTrigger === '\t';
        const isMarkdownHeading = isLineStart && hasSpaceAfter;

        if (isMarkdownHeading) {
          // This looks like "# " at line start, skip and continue searching
          continue;
        }

        // This # can trigger tag suggestion
        const rawQuery = text.slice(i + 1, cursorPos);
        if (!/\s/.test(rawQuery)) {
          return { type: '#', query: rawQuery, pos: i };
        }
        break;
      } else if (char === '\n') {
        // Hit newline, stop searching
        break;
      } else if (char === ' ' || char === '\t') {
        // Hit whitespace, stop searching
        break;
      }
    }

    return null;
  }

  /**
   * Get file suggestions matching the query.
   * Returns paths like "folder/file" (without extension).
   */
  private getFileSuggestions(query: string): string[] {
    const lower = query.toLowerCase();
    const suggestions: string[] = [];

    try {
      const allFiles = this.app.vault.getFiles();

      // If query is empty, just return first 8 files
      if (lower.length === 0) {
        return allFiles.slice(0, 8).map(f => f.path);
      }

      // Otherwise, search all files and return matching ones (up to 8)
      for (const file of allFiles) {
        const basename = file.basename.toLowerCase();
        const fullPath = file.path.toLowerCase();

        // Match against both basename and full path for better search
        if (basename.includes(lower) || fullPath.includes(lower)) {
          suggestions.push(file.path);
          if (suggestions.length >= 8) break;
        }
      }
    } catch (err) {
      console.error('[Journal Partner] getFileSuggestions error', err);
    }

    return suggestions;
  }

  /**
   * Get tag suggestions matching the query.
   * Returns tags like "tag-name" (without the # prefix).
   */
  private getTagSuggestions(query: string): string[] {
    const lower = query.toLowerCase();
    const suggestions: Set<string> = new Set();

    try {
      const cache = this.app.metadataCache;
      const allFiles = this.app.vault.getFiles();

      for (const file of allFiles) {
        const metadata = cache.getFileCache(file);
        if (!metadata) continue;

        // Check inline tags in the file content
        // metadata.tags is an array of { tag: '#mytag', position: ... }
        if (metadata.tags && Array.isArray(metadata.tags)) {
          for (const tagObj of metadata.tags) {
            if (typeof tagObj !== 'object' || !tagObj.tag) continue;

            // tagObj.tag is like "#mytag" or "#parent/child"
            let tagName = tagObj.tag;
            if (tagName.startsWith('#')) {
              tagName = tagName.slice(1);
            }

            const tagLower = tagName.toLowerCase();
            if (lower.length === 0 || tagLower.includes(lower)) {
              suggestions.add(tagName);
              if (suggestions.size >= 8) break;
            }
          }
        }

        // Also check frontmatter tags
        if (metadata.frontmatter?.tags) {
          const fm = metadata.frontmatter.tags as string | string[];
          const tagsArray: string[] = [];

          if (typeof fm === 'string') {
            tagsArray.push(fm);
          } else if (Array.isArray(fm)) {
            for (const item of fm) {
              if (typeof item === 'string') {
                tagsArray.push(item);
              }
            }
          }

          for (const tag of tagsArray) {
            const tagLower = tag.toLowerCase();
            if (lower.length === 0 || tagLower.includes(lower)) {
              suggestions.add(tag);
              if (suggestions.size >= 8) break;
            }
          }
        }

        if (suggestions.size >= 8) break;
      }
    } catch (err) {
      console.error('[Journal Partner] getTagSuggestions error', err);
    }

    return Array.from(suggestions);
  }

  /**
   * Display the autocomplete popup with suggestions.
   */
  private showAutocompletePopup(type: '@' | '#' | '[[', suggestions: string[]): void {
    this.autocompleteSuggestions = suggestions;
    this.autocompleteItemsEl.empty();

    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const item = this.autocompleteItemsEl.createDiv({
        cls: 'jp-autocomplete-item' + (i === 0 ? ' is-active' : ''),
      });

      // Only show icon for tags
      if (type === '#') {
        const icon = item.createSpan({ cls: 'jp-autocomplete-item-icon' });
        icon.setText('#');
      }

      const text = item.createSpan({ cls: 'jp-autocomplete-item-text' });
      text.setText(suggestion);
    }

    this.autocompleteActive = true;
    this.autocompletePopupEl.addClass('is-active');
  }

  /**
   * Hide the autocomplete popup.
   */
  private hideAutocompletePopup(): void {
    this.autocompleteActive = false;
    this.autocompletePopupEl.removeClass('is-active');
    this.autocompleteItemsEl.empty();
  }

  /**
   * Navigate suggestions up or down.
   */
  private navigateSuggestions(direction: 'up' | 'down'): void {
    if (!this.autocompleteActive || this.autocompleteSuggestions.length === 0) return;

    // Remove active class from current
    const items = this.autocompleteItemsEl.querySelectorAll('.jp-autocomplete-item');
    if (items[this.autocompleteSelectedIndex]) {
      items[this.autocompleteSelectedIndex].removeClass('is-active');
    }

    // Move index
    if (direction === 'down') {
      this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex + 1) % items.length;
    } else {
      this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex - 1 + items.length) % items.length;
    }

    // Add active class to new current
    if (items[this.autocompleteSelectedIndex]) {
      items[this.autocompleteSelectedIndex].addClass('is-active');
      items[this.autocompleteSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Insert the selected suggestion into the textarea.
   */
  private selectCurrentSuggestion(): void {
    if (!this.autocompleteActive || this.autocompleteSelectedIndex < 0) return;

    const suggestion = this.autocompleteSuggestions[this.autocompleteSelectedIndex];
    if (!suggestion) return;

    this.insertSuggestion(suggestion, this.autocompleteType || '@');
  }

  /**
   * Replace the trigger + query with the formatted suggestion.
   */
  private insertSuggestion(suggestion: string, type: '@' | '#'): void {
    const textarea = this.textareaEl;
    const trigger = this.getTriggerInfo();
    if (!trigger) return;

    const startPos = trigger.pos;
    const endPos = textarea.selectionStart;

    // Replace @query or #query with the suggestion
    let replacement = '';
    if (type === '@') {
      replacement = `[[${suggestion}]]`;
    } else if (type === '#') {
      replacement = `#${suggestion}`;
    }

    const before = textarea.value.substring(0, startPos);
    const after = textarea.value.substring(endPos);
    textarea.value = before + replacement + ' ' + after;

    // Move cursor after the inserted suggestion + space
    const newPos = startPos + replacement.length + 1;
    textarea.setSelectionRange(newPos, newPos);

    this.hideAutocompletePopup();
    this.refreshSubmitState();
    this.autoResizeTextarea();

    // Focus back on textarea
    textarea.focus();
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
    preview.createSpan({
      cls: 'jp-timestamp',
      text: this.opts.timestamp,
    });
    preview.createSpan({
      cls: 'jp-delete-confirm-preview-text',
      text: this.opts.preview.length > 0 ? this.opts.preview : '(空 memo)',
    });

    // Audio file list (only when audio is being trashed)
    if (this.opts.audioPaths.length > 0) {
      const audioBlock = contentEl.createDiv({ cls: 'jp-delete-confirm-audio' });
      audioBlock.createDiv({
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

/**
 * Modal for editing one journal entry's body text. Pre-fills a textarea with
 * the entry's raw text (which may include continuation lines and audio
 * embeds); on 保存, calls back with the new text. Empty input is rejected.
 */
class EditEntryModal extends Modal {
  private readonly entry: JournalEntry;
  private readonly onSave: (newText: string) => Promise<void>;

  constructor(
    app: import('obsidian').App,
    entry: JournalEntry,
    onSave: (newText: string) => Promise<void>,
  ) {
    super(app);
    this.entry = entry;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`编辑 ${this.entry.timestamp}`);

    contentEl.addClass('jp-edit-entry');

    const textarea = contentEl.createEl('textarea', {
      cls: 'jp-edit-entry-textarea',
    });
    textarea.value = this.entry.text;
    // Multi-line body deserves a roomy editor.
    textarea.rows = Math.max(4, this.entry.text.split('\n').length + 1);

    const actions = contentEl.createDiv({ cls: 'jp-edit-entry-actions' });
    const cancelBtn = actions.createEl('button', {
      cls: 'jp-edit-entry-cancel',
      text: '取消',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = actions.createEl('button', {
      cls: 'mod-cta jp-edit-entry-save',
      text: '保存',
    });
    saveBtn.addEventListener('click', async () => {
      const next = textarea.value;
      if (next.trim().length === 0) {
        new Notice('内容不能为空');
        return;
      }
      saveBtn.disabled = true;
      try {
        await this.onSave(next);
        this.close();
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Enter to save, Shift+Enter for newline — matches the capture input.
    textarea.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        void saveBtn.click();
      }
    });

    window.setTimeout(() => {
      textarea.focus();
      // Place cursor at the end so the user can append/edit immediately.
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
