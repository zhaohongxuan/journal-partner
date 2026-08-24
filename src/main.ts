import {
  App,
  ExtraButtonComponent,
  FuzzySuggestModal,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  ObsidianProtocolData,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  TextComponent,
  WorkspaceLeaf,
  moment,
  setIcon,
} from 'obsidian';
import {
  EditorState,
  Extension,
  Prec,
  StateEffect,
  Transaction,
} from '@codemirror/state';
import {
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  keymap,
} from '@codemirror/view';
import {
  appHasDailyNotesPluginLoaded,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from 'obsidian-daily-notes-interface';

import {
  DEFAULT_SETTINGS,
  JournalPartnerSettings,
  appendToJournalSection,
  buildDecorations,
  buildEntryLine,
  buildTaskLine,
  findSection,
  generateTimestamp,
  getTimestampRanges,
} from './section';
import { CAPTURE_VIEW_TYPE, JournalCaptureView } from './capture-view';

// ── CM6 utilities ───────────────────────────────────────────────────────────

/** Effect that forces decoration recomputation after settings change. */
const forceUpdateEffect = StateEffect.define<null>();

// ── Plugin ──────────────────────────────────────────────────────────────────

export default class JournalPartnerPlugin extends Plugin {
  settings: JournalPartnerSettings;

  async onload() {
    await this.loadSettings();
    this.applyCSSVariables();
    this.registerEditorExtension(this.createEditorExtensions());
    this.registerMarkdownPostProcessor((el, ctx) => this.postProcessor(el, ctx));
    this.addSettingTab(new JournalPartnerSettingTab(this.app, this));

    // Capture sidebar view
    this.registerView(
      CAPTURE_VIEW_TYPE,
      leaf => new JournalCaptureView(leaf, this),
    );
    this.addCommand({
      id: 'open-capture-view',
      name: '打开快速记录侧边栏',
      callback: () => void this.activateCaptureView(),
    });
    this.addRibbonIcon('feather', '快速记录', () => void this.activateCaptureView());

    // ── URL protocol handler (Path B: Action Button + Shortcuts) ──
    // Registers obsidian://journal-partner so that an iOS Shortcut (or any
    // tool that can open URLs) can write to today's `## Journal` section
    // without opening the capture view or any other UI.
    //
    // Usage (from a Shortcut):
    //   obsidian://journal-partner?text=<urlencoded>
    //   obsidian://journal-partner?text=<...>&time=15:30
    //
    // (`action` is reserved by Obsidian for the protocol name itself —
    // don't use it as a custom routing key.)
    this.registerObsidianProtocolHandler('journal-partner', params => {
      void this.handleProtocol(params);
    });
  }

  async activateCaptureView() {
    const existing = this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = Platform.isMobile
      ? this.app.workspace.getLeaf(true)
      : this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CAPTURE_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  // ── Quick-capture write path (shared) ─────────────────────────────────────

  /**
   * Append a single entry to today's `## Journal` section.
   *
   * Used by both the in-app capture textarea and the URL protocol handler.
   * Creates today's daily note and the journal heading if they don't exist
   * yet.
   *
   * @param text     Raw user content (may contain newlines).
   * @param ts       Timestamp string in `HH:MM` form. Defaults to now.
   * @param audio    Optional vault-relative path to an audio attachment;
   *                 when provided, ` ![[path]]` is appended to the entry.
   * @returns        true on success, false if Daily Notes plugin is missing
   *                 or the write fails.
   */
  async writeToTodayJournal(text: string, ts?: string, audio?: string, images?: string[]): Promise<boolean> {
    if (!appHasDailyNotesPluginLoaded()) {
      new Notice('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return false;
    }
    const trimmed = text.trim();
    const audioPath = audio?.trim() ?? '';
    const imageList = (images ?? []).filter(Boolean);
    // Require at least one of text / audio / images — an entry with none is junk.
    if (trimmed.length === 0 && audioPath.length === 0 && imageList.length === 0) return false;

    // Images append at the very END, after all text, each on its own line.
    const imagesText = imageList.join('\n');
    const withImages = (body: string) => {
      const parts = [body, imagesText].filter(Boolean);
      return parts.join('\n\n');
    };

    const stamp = ts ?? generateTimestamp();

    // Check if this is a task entry (starts with [ ] or [x])
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(trimmed);
    let line: string;

    if (taskMatch) {
      // Task format: extract checkbox state and content
      const isCompleted = taskMatch[1].toLowerCase() === 'x';
      const taskContent = taskMatch[2];
      const body = audioPath.length > 0
        ? `${taskContent}${taskContent.length > 0 ? ' ' : ''}![[${audioPath}]]`
        : taskContent;
      line = buildTaskLine(withImages(body).replace(/\r\n/g, '\n'), stamp, isCompleted);
    } else {
      // Regular memo entry
      const body = audioPath.length > 0
        ? `${trimmed}${trimmed.length > 0 ? ' ' : ''}![[${audioPath}]]`
        : trimmed;
      line = buildEntryLine(withImages(body).replace(/\r\n/g, '\n'), stamp);
    }

    try {
      let file = getDailyNote(moment(), getAllDailyNotes());
      if (!file) {
        file = (await createDailyNote(moment()));
      }
      await this.app.vault.process(file, content =>
        appendToJournalSection(content, this.settings, line),
      );
      return true;
    } catch (err) {
      console.error('[Journal Partner] writeToTodayJournal failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Handle `obsidian://journal-partner?...` URLs.
   *
   * The protocol handler is registered specifically for `journal-partner`,
   * so every invocation is implicitly the quick-capture action. We accept:
   *   - `cmd`  optional command: "record" → open sidebar and start recording
   *   - `text`  (optional if `audio` is given) — entry body
   *   - `time`  optional `HH:MM` override
   *   - `audio` optional vault-relative attachment path; rendered as
   *             `![[path]]` so Obsidian shows the inline audio player
   *
   * Note: `params.action` is reserved by Obsidian and will always equal
   * the protocol handler name (`journal-partner`) here — do NOT use it
   * as a routing key.
   */
  private async handleProtocol(params: ObsidianProtocolData): Promise<void> {
    // ── cmd=record: open sidebar and immediately start recording ──────────
    if (params.cmd === 'record') {
      await this.activateCaptureView();
      // Give Obsidian a tick to mount the leaf before we touch the view
      window.setTimeout(() => {
        const leaves = this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE);
        const view = leaves[0]?.view as JournalCaptureView | undefined;
        if (view) void view.beginRecording();
      }, 150);
      return;
    }

    const text = params.text ?? '';
    const audio = params.audio ?? '';

    if (text.trim().length === 0 && audio.trim().length === 0) {
      new Notice('Quick capture 至少需要 text 或 audio 参数之一');
      return;
    }

    const time = params.time;
    const tsValid = typeof time === 'string' && /^\d{2}:\d{2}$/.test(time);
    const ts = tsValid ? time : undefined;

    const ok = await this.writeToTodayJournal(text, ts, audio);
    if (ok) {
      const previewSrc = text.trim().length > 0 ? text : (audio || '语音');
      const preview = previewSrc.trim().replace(/\s+/g, ' ').slice(0, 20);
      const ellip = previewSrc.length > 20 ? '…' : '';
      const tag = audio.trim().length > 0 ? '🎙️' : '📝';
      new Notice(`${tag} 已记录：${preview}${ellip}`);
    }
  }

  // ── Editor extension (source + live-preview) ───────────────────────────────

  private createEditorExtensions(): Extension[] {
    const getSettings = () => this.settings;

    // ViewPlugin renders timestamp decorations
    const viewPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(
            view.state.doc.toString(),
            getSettings(),
          );
        }

        update(update: ViewUpdate) {
          const needsRebuild =
            update.docChanged ||
            update.viewportChanged ||
            update.transactions.some(tr =>
              tr.effects.some(e => e.is(forceUpdateEffect)),
            );
          if (needsRebuild) {
            this.decorations = buildDecorations(
              update.state.doc.toString(),
              getSettings(),
            );
          }
        }
      },
      { decorations: v => v.decorations },
    );

    // Transaction filter: reject changes that overlap a timestamp range
    const readonlyFilter = EditorState.transactionFilter.of(
      (tr: Transaction) => {
        if (!this.settings.readonlyTimestamps || !tr.docChanged) return tr;

        const timestamps = getTimestampRanges(
          tr.startState.doc.toString(),
          this.settings,
        );
        let blocked = false;

        tr.changes.iterChanges((fromA, toA) => {
          if (blocked) return;
          for (const { from, to } of timestamps) {
            if (fromA < to && toA > from) {
              blocked = true;
              break;
            }
          }
        });

        if (blocked) {
          new Notice('⏰ 时间戳不可修改');
          return []; // reject the transaction
        }

        return tr;
      },
    );

    return [viewPlugin, readonlyFilter, this.createEnterKeymap(), this.createTabKeymap()];
  }

  /**
   * Returns a high-priority keymap extension that intercepts Enter inside the
   * target section.
   */
  private createEnterKeymap(): Extension {
    return Prec.high(
      keymap.of([
        {
          key: 'Enter',
          run: (view: EditorView): boolean => {
            if (!this.settings.autoTimestamp) return false;

            const state = view.state;
            const doc = state.doc.toString();
            const section = findSection(
              doc,
              this.settings.targetHeading,
              this.settings.headingLevel,
            );
            if (!section) return false;

            const cursor = state.selection.main;
            if (cursor.head < section.from || cursor.head > section.to) {
              return false;
            }

            const line = state.doc.lineAt(cursor.head);

            const indentMatch = line.text.match(/^(\s*)/);
            const currentIndent = indentMatch?.[1] ?? '';
            const isNested = currentIndent.length > 0;

            const markerMatch = line.text.match(/^\s*([-*+]\s+)/);
            const listMarker = markerMatch ? markerMatch[1] : '';

            if (!listMarker) return false;

            let insertion: string;

            if (isNested) {
              insertion = '\n' + currentIndent + listMarker;
            } else {
              const ts = generateTimestamp();
              insertion = '\n' + listMarker + ts + ' ';
            }

            view.dispatch(
              state.update({
                changes: { from: cursor.from, to: cursor.to, insert: insertion },
                selection: { anchor: cursor.from + insertion.length },
                scrollIntoView: true,
              }),
            );

            return true;
          },
        },
      ]),
    );
  }

  /**
   * Returns a high-priority keymap extension that intercepts Tab inside the
   * target section.
   */
  private createTabKeymap(): Extension {
    return Prec.high(
      keymap.of([
        {
          key: 'Tab',
          run: (view: EditorView): boolean => {
            const state = view.state;
            const doc = state.doc.toString();
            const section = findSection(
              doc,
              this.settings.targetHeading,
              this.settings.headingLevel,
            );
            if (!section) return false;

            const cursor = state.selection.main;
            if (cursor.head < section.from || cursor.head > section.to) {
              return false;
            }

            const line = state.doc.lineAt(cursor.head);

            const indentMatch = line.text.match(/^(\s*)/);
            const currentIndent = indentMatch?.[1] ?? '';
            const isTopLevel = currentIndent.length === 0;

            if (!isTopLevel) return false;

            const timestampMatch = line.text.match(
              new RegExp(`^([-*+]\\s+)(${this.settings.timestampPattern})\\s+`),
            );

            if (!timestampMatch) return false;

            const markerAndSpace = timestampMatch[1];
            const timestampText = timestampMatch[2];

            const afterTimestampMatch = line.text.match(
              new RegExp(`^([-*+]\\s+)(${this.settings.timestampPattern})\\s+(.*)`),
            );
            const contentAfterTimestamp = afterTimestampMatch?.[3] ?? '';

            const newLinePrefix = '\t' + markerAndSpace + contentAfterTimestamp;

            const replaceEnd =
              line.from +
              markerAndSpace.length +
              timestampText.length +
              1 +
              contentAfterTimestamp.length;

            const changes = [
              { from: line.from, to: replaceEnd, insert: newLinePrefix },
            ];

            view.dispatch(
              state.update({
                changes,
                selection: { anchor: line.from + 1 + markerAndSpace.length },
                scrollIntoView: true,
              }),
            );

            return true;
          },
        },
      ]),
    );
  }

  // ── Reading-view post processor ────────────────────────────────────────────

  private postProcessor(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    if (!this.isInTargetSection(info.text, info.lineStart)) return;
    this.highlightTimestampsInElement(el);
  }

  private isInTargetSection(docText: string, lineStart: number): boolean {
    const section = findSection(
      docText,
      this.settings.targetHeading,
      this.settings.headingLevel,
    );
    if (!section) return false;

    const sectionStartLine =
      docText.slice(0, section.from).split('\n').length - 1;
    const sectionEndLine =
      docText.slice(0, section.to).split('\n').length - 1;

    return lineStart >= sectionStartLine && lineStart < sectionEndLine;
  }

  private highlightTimestampsInElement(el: HTMLElement) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    for (const textNode of textNodes) {
      const raw = textNode.textContent ?? '';
      const m = new RegExp(this.settings.timestampPattern).exec(raw);
      if (!m) continue;

      const before = raw.slice(0, m.index);
      const after = raw.slice(m.index + m[0].length);
      const span = createSpan({ cls: 'jp-timestamp', text: m[0] });

      const parent = textNode.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      parent.insertBefore(span, textNode);
      if (after) parent.insertBefore(document.createTextNode(after), textNode);
      parent.removeChild(textNode);
    }
  }

  // ── CSS variables & settings plumbing ─────────────────────────────────────

  applyCSSVariables() {
    const root = document.documentElement;

    // Clear any legacy inline variables previously set on <html>; inline
    // styles would otherwise override the theme-scoped rules below.
    root.style.removeProperty('--jp-ts-color');
    root.style.removeProperty('--jp-ts-bg');
    root.style.removeProperty('--jp-ts-color-dark');
    root.style.removeProperty('--jp-ts-bg-dark');

    // Set the timestamp colors as CSS variables on <html>. Light values
    // define the defaults; the `.theme-dark` mapping in styles.css remaps
    // `--jp-ts-color` to `--jp-ts-color-dark` on <body>, which wins via
    // DOM inheritance when the dark theme is active.
    root.style.setProperty('--jp-ts-color', this.settings.timestampColor);
    root.style.setProperty('--jp-ts-bg', this.settings.timestampBgColor);
    root.style.setProperty('--jp-ts-color-dark', this.settings.timestampColorDark);
    root.style.setProperty('--jp-ts-bg-dark', this.settings.timestampBgColorDark);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<JournalPartnerSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCSSVariables();
    this.refreshEditors();
  }

  private refreshEditors() {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) {
        const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
        cm?.dispatch({ effects: forceUpdateEffect.of(null) });
      }
    });
  }

  /**
   * Re-render any open capture sidebar views. Used after settings that affect
   * the timeline's display (e.g. sort order) change, so the new value applies
   * immediately instead of waiting for the next natural refresh.
   */
  refreshCaptureViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE)) {
      if (leaf.view instanceof JournalCaptureView) {
        void leaf.view.fullRebuild();
      }
    }
  }

  /**
   * Re-seed the tag-chip selection on every open capture view from the
   * current `defaultTags` setting — used when the default-tag setting changes
   * so the chips update immediately without a full timeline rebuild.
   */
  refreshDefaultTagsOnCaptureViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE)) {
      if (leaf.view instanceof JournalCaptureView) {
        leaf.view.resetSelectedTags();
      }
    }
  }
}

// ── Settings tab ────────────────────────────────────────────────────────────

class JournalPartnerSettingTab extends PluginSettingTab {
  plugin: JournalPartnerPlugin;

  /** Container for the preset-tag input rows in the settings tab. */
  private presetTagListEl!: HTMLElement;
  /** Container for the default-tag toggle rows in the settings tab. */
  private defaultTagListEl!: HTMLElement;

  constructor(app: App, plugin: JournalPartnerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Collect all vault folder paths, sorted and deduplicated. */
  private getFolderPaths(): string[] {
    const folders = this.app.vault
      .getAllFolders()
      .filter((file): file is TFolder => file instanceof TFolder);
    const folderPaths = folders.map((folder) => (folder.path === '' ? '/' : folder.path));
    if (!folderPaths.includes('/')) {
      folderPaths.unshift('/');
    }
    return Array.from(new Set(folderPaths)).sort();
  }

  /**
   * Render one timestamp color setting row with two pickers — light theme
   * (left) and dark theme (right) — plus a reset button that restores both
   * to their defaults.
   */
  private addColorSetting(
    name: string,
    desc: string,
    lightKey: 'timestampColor' | 'timestampBgColor',
    darkKey: 'timestampColorDark' | 'timestampBgColorDark',
    lightDefault: string,
    darkDefault: string,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings[lightKey])
          .onChange(async value => {
            this.plugin.settings[lightKey] = value;
            await this.plugin.saveSettings();
          }),
      )
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings[darkKey])
          .onChange(async value => {
            this.plugin.settings[darkKey] = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton(btn =>
        btn
          .setIcon('rotate-ccw')
          .setTooltip('恢复默认')
          .onClick(async () => {
            this.plugin.settings[lightKey] = lightDefault;
            this.plugin.settings[darkKey] = darkDefault;
            await this.plugin.saveSettings();
            // Re-render so the color pickers reflect the reset values.
            this.display();
          }),
      );
  }

  /**
   * Best-effort synchronous read of Obsidian's configured attachment folder,
   * for the settings placeholder so users see the real fallback (not a
   * hard-coded "Attachments") when they leave the field blank.
   *
   * `app.getConfig('attachmentFolderPath')` returns undefined on some Obsidian
   * versions, so we read the in-memory vault config object directly — it's a
   * plain property access, cheap and safe to call during settings render.
   * Special values: `.` = same folder as the note, `/` or empty = vault root.
   */
  private attachmentFolderLabel(): string {
    type VaultConfig = { config?: { attachmentFolderPath?: string } };
    const folder = (this.app.vault as unknown as VaultConfig).config?.attachmentFolderPath;
    if (!folder || folder === '/' || folder === '') return 'Vault 根目录';
    if (folder === '.') return '与日记同目录';
    return folder;
  }

  /**
   * A folder-picker setting row shared by the recording and image folders: a
   * text field (placeholder = Obsidian's real attachment folder) plus a 📁
   * button that opens the fuzzy folder-suggest modal. `key` selects which
   * settings field to read/write.
   */
  private addFolderSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: 'recordingFolder' | 'imageFolder',
  ): void {
    let textComp: TextComponent | null = null;
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText(text => {
        textComp = text;
        text
          .setPlaceholder(this.attachmentFolderLabel())
          .setValue(this.plugin.settings[key])
          .onChange(async value => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton(btn => {
        btn
          .setButtonText('📁')
          .setTooltip('选择目录')
          .onClick(() => {
            const modal = this.createFolderSuggestModal((path: string) => {
              this.plugin.settings[key] = path;
              void this.plugin.saveSettings();
              textComp?.setValue(path);
            });
            modal.open();
          });
      });
  }

  /** Creates a FuzzySuggestModal pre-populated with vault folder paths. */
  private createFolderSuggestModal(onSelect: (value: string) => void): FolderSuggestModal {
    const folders = this.getFolderPaths();
    return new FolderSuggestModal(this.app, folders, onSelect);
  }

  /**
   * Render one text row per preset tag: an input bound to
   * `settings.presetTags[i]` plus a delete button. Rows are rebuilt whenever
   * the list length changes (add / delete). A blank row is kept while the
   * user types; empty entries are pruned on save.
   */
  private renderPresetTagInputs(): void {
    this.presetTagListEl.empty();
    const tags = this.plugin.settings.presetTags;

    // Keep exactly one trailing blank row (the open input the user can type
    // into). "添加标签" pushes a new empty row; if a run of blanks has
    // accumulated (e.g. adding twice without typing), collapse it to one so
    // the list doesn't grow with invisible rows.
    while (tags.length > 1 && tags[tags.length - 1].trim().length === 0 && tags[tags.length - 2].trim().length === 0) {
      tags.pop();
    }
    if (tags.length === 0) tags.push('');

    tags.forEach((tag, index) => {
      const row = this.presetTagListEl.createDiv({ cls: 'jp-settings-tag-row' });

      new Setting(row)
        .addText(text =>
          text
            .setPlaceholder('#log/fitness')
            .setValue(tag)
            .onChange(async value => {
              this.plugin.settings.presetTags[index] = value.trim();
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton(btn =>
          btn
            .setIcon('trash')
            .setTooltip('删除该标签')
            .onClick(() => {
              const removedTag = tag.startsWith('#') ? tag : `#${tag}`;
              this.plugin.settings.presetTags.splice(index, 1);
              if (this.plugin.settings.presetTags.length === 0) {
                this.plugin.settings.presetTags.push('');
              }
              void this.plugin.saveSettings().then(() => {
                // Keep defaultTags in sync — a deleted preset tag can no
                // longer be a default, so drop it from the selection too.
                const dIdx = this.plugin.settings.defaultTags.indexOf(removedTag);
                if (dIdx !== -1) {
                  this.plugin.settings.defaultTags.splice(dIdx, 1);
                  void this.plugin.saveSettings();
                }
                this.renderPresetTagInputs();
                this.renderDefaultTagToggles();
                this.plugin.refreshDefaultTagsOnCaptureViews();
              });
            }),
        );
    });
  }

  /**
   * Render the default-tag selector as a clickable tag-group: every preset
   * tag is a chip; clicking toggles it in/out of `settings.defaultTags`.
   * Selected chips are highlighted — reads like a multi-select of tags
   * instead of a row of toggles.
   */
  private renderDefaultTagToggles(): void {
    // (Re)create the container only when needed: after display() empties the
    // tab, the old element is detached — reuse it otherwise so chip clicks
    // re-render in place instead of stacking containers.
    if (!this.defaultTagListEl || !this.defaultTagListEl.isConnected) {
      this.defaultTagListEl = this.containerEl.createDiv({ cls: 'jp-settings-tag-select' });
    }
    this.defaultTagListEl.empty();

    const presetTags = (this.plugin.settings.presetTags ?? [])
      .map(t => t.trim())
      .filter(t => t.length > 0);

    if (presetTags.length === 0) {
      this.defaultTagListEl.createDiv({
        cls: 'jp-settings-empty-hint',
        text: '请先在「预设标签」中添加标签。',
      });
      return;
    }

    const defaults = new Set(this.plugin.settings.defaultTags ?? []);

    for (const rawTag of presetTags) {
      const tag = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
      const isSelected = defaults.has(tag);
      const chip = this.defaultTagListEl.createDiv({
        cls: 'jp-settings-tag-chip' + (isSelected ? ' is-selected' : ''),
      });
      chip.createSpan({ cls: 'jp-settings-tag-chip-text', text: tag });
      // Small check icon on selected chips for extra affordance.
      if (isSelected) {
        const check = chip.createSpan({ cls: 'jp-settings-tag-chip-check' });
        setIcon(check, 'check');
      }
      // Toggle the tag in/out of defaultTags. saveSettings is async; the
      // re-render + capture-view refresh happen after it resolves.
      chip.addEventListener('click', () => {
        const list = this.plugin.settings.defaultTags ?? [];
        const idx = list.indexOf(tag);
        if (idx === -1) {
          list.push(tag);
        } else {
          list.splice(idx, 1);
        }
        this.plugin.settings.defaultTags = list;
        void this.plugin.saveSettings().then(() => {
          this.renderDefaultTagToggles();
          this.plugin.refreshDefaultTagsOnCaptureViews();
        });
      });
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // ── Timestamp Settings ────────────────────────────────────────────────
    new Setting(containerEl).setName('时间戳设置').setHeading();

    new Setting(containerEl)
      .setName('日记标题')
      .setDesc('插件生效的标题，如 Journal')
      .addText(text =>
        text
          .setPlaceholder('Journal')
          .setValue(this.plugin.settings.targetHeading)
          .onChange(async value => {
            this.plugin.settings.targetHeading = value.trim() || 'Journal';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('标题层级')
      .setDesc('目标标题的层级，H2 对应 ## Journal')
      .addDropdown(dd => {
        for (let i = 1; i <= 6; i++) {
          dd.addOption(String(i), `H${i}  ${'#'.repeat(i)}`);
        }
        dd.setValue(String(this.plugin.settings.headingLevel));
        dd.onChange(async value => {
          this.plugin.settings.headingLevel = parseInt(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('只读保护')
      .setDesc('开启后，无法在编辑器中修改已存在的时间戳')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.readonlyTimestamps)
          .onChange(async value => {
            this.plugin.settings.readonlyTimestamps = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('回车自动插入')
      .setDesc('在 Journal 区块内按回车时，自动在新行插入当前时间')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoTimestamp)
          .onChange(async value => {
            this.plugin.settings.autoTimestamp = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('匹配正则')
      .setDesc('识别时间戳的正则表达式，默认 \\d{2}:\\d{2}（HH:MM）')
      .addText(text =>
        text
          .setPlaceholder('\\d{2}:\\d{2}')
          .setValue(this.plugin.settings.timestampPattern)
          .onChange(async value => {
            try {
              new RegExp(value);
              this.plugin.settings.timestampPattern = value;
              await this.plugin.saveSettings();
            } catch {
              new Notice('❌ 无效的正则表达式');
            }
          }),
      );

    new Setting(containerEl)
      .setName('排序方式')
      .setDesc('时间线中日记条目的排列顺序')
      .addDropdown(dropdown =>
        dropdown
          .addOption('desc', '最新在上（默认）')
          .addOption('asc', '最早在上')
          .setValue(this.plugin.settings.sortOrder)
          .onChange(async (value: string) => {
            this.plugin.settings.sortOrder = value as 'asc' | 'desc';
            await this.plugin.saveSettings();
            this.plugin.refreshCaptureViews();
          }),
      );

    // Preview badge
    const previewEl = containerEl.createDiv({ cls: 'jp-settings-preview' });
    previewEl.createSpan({ cls: 'jp-settings-preview-label', text: '预览：' });
    previewEl.createSpan({ cls: 'jp-timestamp', text: '07:31' });
    previewEl.createSpan({ text: '这里是日记内容…' });

    // ── Tag Settings ──────────────────────────────────────────────────────
    new Setting(containerEl).setName('标签设置').setHeading();

    new Setting(containerEl)
      .setName('预设标签')
      .setDesc('快速插入的标签，点击输入框左下角的 # 图标即可选择。每个标签独占一行。')
      .addButton(btn =>
        btn
          .setButtonText('+ 添加标签')
          .setTooltip('添加一个预设标签')
          .onClick(() => {
            this.plugin.settings.presetTags.push('');
            this.renderPresetTagInputs();
            this.renderDefaultTagToggles();
          }),
      );

    this.presetTagListEl = containerEl.createDiv({ cls: 'jp-settings-tag-list' });
    this.renderPresetTagInputs();

    new Setting(containerEl)
      .setName('默认标签')
      .setDesc('每次打开输入框时自动带上的标签（显示为输入框顶部的状态标签）。不选则默认为无。');
    this.renderDefaultTagToggles();

    new Setting(containerEl)
      .setName('日记标签展示数量')
      .setDesc('标签筛选菜单里「日记汇总」展示的标签数量上限（按高频+近期排名）。设为 0 则展示全部。')
      .addSlider(slider =>
        slider
          .setLimits(0, 50, 1)
          .setValue(this.plugin.settings.maxDiaryTags ?? 15)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.maxDiaryTags = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Color Settings ───────────────────────────────────────────────────
    new Setting(containerEl).setName('颜色设置').setHeading();

    this.addColorSetting(
      '文字颜色',
      '时间戳徽标的前景色（左：白天 ☀　右：深色 🌙）',
      'timestampColor',
      'timestampColorDark',
      DEFAULT_SETTINGS.timestampColor,
      DEFAULT_SETTINGS.timestampColorDark,
    );
    this.addColorSetting(
      '背景颜色',
      '时间戳徽标的背景色（左：白天 ☀　右：深色 🌙）',
      'timestampBgColor',
      'timestampBgColorDark',
      DEFAULT_SETTINGS.timestampBgColor,
      DEFAULT_SETTINGS.timestampBgColorDark,
    );

    // ── Speech-to-text ────────────────────────────────────────────────────
    new Setting(containerEl).setName('语音转文字').setHeading();

    // Usage guide — explains how STT works here and lists mainstream / free models.
    const guide = containerEl.createDiv({ cls: 'jp-stt-guide' });
    guide.createEl('p', {
      text: '录音转文字使用 OpenAI 兼容的 /audio/transcriptions 接口。填好转写地址与 API Key 即可开启；留空则关闭转写，麦克风仅作纯录音。也可不配置，直接用系统听写（macOS 双击 Fn / iOS 键盘麦克风）往输入框输入。',
    });
    guide.createEl('p', {
      text: '实时转写模式：边说边出字，在停顿处切句并带上下文拼接。停止后默认保留实时草稿（快）；可在下方开启「停止后整段重转」用完整音频再转一次替换草稿（更准但需等待）。',
    });
    const table = guide.createEl('table', { cls: 'jp-stt-guide-table' });
    const thead = table.createEl('thead');
    const headRow = thead.createEl('tr');
    for (const h of ['服务商', '转写地址', '模型', '费用', '说明']) {
      headRow.createEl('th', { text: h });
    }
    const tbody = table.createEl('tbody');
    // [服务商, 官网, 转写地址, 模型, 费用, 说明]
    const rows: [string, string, string, string, string, string][] = [
      ['SiliconFlow（国内推荐）', 'https://siliconflow.cn', 'https://api.siliconflow.cn/v1/audio/transcriptions', 'FunAudioLLM/SenseVoiceSmall', '免费', '国内可直连，中文质量好，注册实名后生成 Key'],
      ['Groq', 'https://console.groq.com', 'https://api.groq.com/openai/v1/audio/transcriptions', 'whisper-large-v3', '有免费额度', '速度极快，需网络可达'],
      ['OpenAI', 'https://platform.openai.com', 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1', '付费', '官方接口，需外网'],
      ['阿里百炼', 'https://bailian.console.aliyun.com', '需用 DashScope 兼容端点', 'paraformer-v2', '有免费额度', '中文优秀，注意接口格式'],
      ['自建 faster-whisper', 'https://github.com/ahmetoner/whisper-asr-webservice', 'http://你的服务器:9000/v1/audio/transcriptions', 'whisper-1 / small / medium', '免费', 'Docker 部署 OpenAI 兼容服务，隐私无忧'],
    ];
    for (const r of rows) {
      const [name, nameUrl, endpoint, model, cost, note] = r;
      const tr = tbody.createEl('tr');
      const nameTd = tr.createEl('td');
      const nameA = nameTd.createEl('a', { text: name });
      nameA.href = nameUrl;
      nameA.target = '_blank';
      nameA.rel = 'noopener';
      const epTd = tr.createEl('td');
      const epA = epTd.createEl('a', { text: endpoint });
      epA.href = endpoint.startsWith('http') ? endpoint : nameUrl;
      epA.target = '_blank';
      epA.rel = 'noopener';
      tr.createEl('td', { text: model });
      tr.createEl('td', { text: cost });
      tr.createEl('td', { text: note });
    }
    const hintP = guide.createEl('p', { cls: 'jp-stt-guide-hint' });
    hintP.appendText('提示：以上服务的额度与模型名以官网公示为准，可能随时调整。SenseVoiceSmall 当前在 SiliconFlow 标注为免费 → ');
    const hintA = hintP.createEl('a', { text: 'SiliconFlow 定价' });
    hintA.href = 'https://siliconflow.cn/pricing';
    hintA.target = '_blank';
    hintA.rel = 'noopener';
    hintP.appendText('。');


    let apiKeyInputEl: HTMLInputElement | null = null;
    this.addFolderSetting(
      containerEl,
      '录音存放位置',
      'Vault 相对路径，用于存放录音文件。留空则使用 Obsidian 附件文件夹。',
      'recordingFolder',
    );

    new Setting(containerEl)
      .setName('转写地址')
      .setDesc('OpenAI 兼容的 /audio/transcriptions 地址。留空则关闭录音转文字。')
      .addText(text =>
        text
          .setPlaceholder('https://api.openai.com/v1/audio/transcriptions')
          .setValue(this.plugin.settings.sttEndpoint)
          .onChange(async value => {
            this.plugin.settings.sttEndpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('以 Bearer 形式发送的密钥。可填 OpenAI / Groq / 自建服务的密钥。')
      .addText(text => {
        text.inputEl.type = 'password';
        apiKeyInputEl = text.inputEl;
        text
          .setPlaceholder('sk-…')
          .setValue(this.plugin.settings.sttApiKey)
          .onChange(async value => {
            this.plugin.settings.sttApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        return text;
      })
      .addExtraButton((button: ExtraButtonComponent) => {
        let isPassword = true;
        button.setIcon('eye')
          .setTooltip('显示/隐藏 API Key')
          .onClick(() => {
            isPassword = !isPassword;
            if (apiKeyInputEl) {
              apiKeyInputEl.type = isPassword ? 'password' : 'text';
            }
            button.setIcon(isPassword ? 'eye' : 'eye-off');
          });
        return button;
      });

    new Setting(containerEl)
      .setName('模型')
      .setDesc('multipart 中的 model 字段，如 whisper-1、whisper-large-v3。')
      .addText(text =>
        text
          .setPlaceholder('whisper-1')
          .setValue(this.plugin.settings.sttModel)
          .onChange(async value => {
            this.plugin.settings.sttModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('语言')
      .setDesc('ISO-639-1 语言提示，如 zh、en。留空让模型自动识别。')
      .addText(text =>
        text
          .setPlaceholder('zh')
          .setValue(this.plugin.settings.sttLanguage)
          .onChange(async value => {
            this.plugin.settings.sttLanguage = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('实时转写')
      .setDesc('录音时边说边出字，在停顿处切句并带上下文拼接。关闭则录完整段后一次性转写。')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.sttRealtime)
          .onChange(async value => {
            this.plugin.settings.sttRealtime = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Shortcut ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName('其他').setHeading();

    this.addFolderSetting(
      containerEl,
      '图片存放位置',
      'Vault 相对路径，用于存放粘贴/上传的图片。留空则使用 Obsidian 附件文件夹。',
      'imageFolder',
    );

    new Setting(containerEl)
      .setName('提交快捷键')
      .setDesc('在输入框中提交日记的快捷键组合')
      .addDropdown(dropdown =>
        dropdown
          .addOption('shift+enter', 'Shift + Enter')
          .addOption('ctrl+enter', 'Ctrl + Enter')
          .addOption('alt+enter', 'Alt + Enter')
          .addOption('ctrl+shift+enter', 'Ctrl + Shift + Enter')
          .setValue(this.plugin.settings.submitShortcut)
          .onChange(async (value: string) => {
            this.plugin.settings.submitShortcut = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Apple Shortcut')
      .setDesc('配合 iPhone Action Button 使用，快速录音并写入日记')
      .addButton(btn =>
        btn
          .setButtonText('获取捷径')
          .setCta()
          .onClick(() => {
            window.open(
              'https://www.icloud.com/shortcuts/2b5bbc7c721a4010807c4ed337245360',
              '_blank',
            );
          }),
      );

    // URL scheme reference
    const urlSection = containerEl.createDiv({ cls: 'jp-settings-url-section' });
    urlSection.createDiv({ text: 'URL Scheme', cls: 'jp-settings-url-title' });

    urlSection.createDiv({
      text: '可在浏览器地址栏、快捷指令、自动化 App 等任意位置调用，自动打开侧边栏并开始录音。',
      cls: 'jp-settings-url-desc',
    });

    const url = 'obsidian://journal-partner?cmd=record';
    const row = urlSection.createDiv({ cls: 'jp-settings-url-row' });
    const code = row.createEl('code', { text: url, cls: 'jp-settings-url-code' });
    code.setAttr('title', '点击复制');
    code.addEventListener('click', () => {
      void navigator.clipboard.writeText(url).then(() => new Notice('已复制 URL'));
    });
  }
}

/** Fuzzy-suggest modal for selecting a vault folder path. */
class FolderSuggestModal extends FuzzySuggestModal<string> {
  private folders: string[];
  private onSelectFolder: (value: string) => void;

  constructor(app: App, folders: string[], onSelect: (value: string) => void) {
    super(app);
    this.folders = folders;
    this.onSelectFolder = onSelect;
    this.setPlaceholder('选择或搜索文件夹路径');
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onSelectFolder(item);
  }
}
