import {
  App,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import {
  EditorState,
  Extension,
  Prec,
  RangeSetBuilder,
  StateEffect,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  keymap,
} from '@codemirror/view';

// ── Types & defaults ────────────────────────────────────────────────────────

interface JournalPartnerSettings {
  /** The heading text that activates the plugin (without # symbols) */
  targetHeading: string;
  /** Heading level: 1 → #, 2 → ##, … */
  headingLevel: number;
  /** Regex pattern whose first match (or capture group 1) is the timestamp */
  timestampPattern: string;
  /** Foreground color of the timestamp badge */
  timestampColor: string;
  /** Background opacity of the timestamp badge (0-100) */
  timestampBgOpacity: number;
  /** When true, use Obsidian's accent color for timestamp badge */
  useAccentColor: boolean;
  /** When true, editing a timestamp in the editor is blocked */
  readonlyTimestamps: boolean;
  /** When true, pressing Enter inside the journal section auto-inserts a timestamp on the new line */
  autoTimestamp: boolean;
  /** When true, render checkboxes as circles instead of squares */
  circularCheckboxes: boolean;
}

const DEFAULT_SETTINGS: JournalPartnerSettings = {
  targetHeading: 'Journal',
  headingLevel: 2,
  timestampPattern: '\\d{2}:\\d{2}',
  timestampColor: '',
  timestampBgOpacity: 20,
  useAccentColor: true,
  readonlyTimestamps: true,
  autoTimestamp: true,
  circularCheckboxes: false,
};

type Rng = { from: number; to: number };

// ── CM6 utilities ───────────────────────────────────────────────────────────

/** Effect that forces decoration recomputation after settings change. */
const forceUpdateEffect = StateEffect.define<null>();

/**
 * Find the character range occupied by the body of a heading section.
 * Returns null if the heading is not found.
 */
function findSection(
  doc: string,
  headingName: string,
  headingLevel: number,
): Rng | null {
  const prefix = '#'.repeat(headingLevel) + ' ';
  const lines = doc.split('\n');
  let charOffset = 0;
  let startOffset = -1;

  for (const line of lines) {
    if (startOffset === -1) {
      if (
        line.startsWith(prefix) &&
        line.slice(prefix.length).trim() === headingName
      ) {
        // Section body starts on the next line
        startOffset = charOffset + line.length + 1;
      }
    } else {
      // A heading of the same level or higher ends the section
      const m = line.match(/^(#+)\s/);
      if (m && m[1].length <= headingLevel) {
        return { from: startOffset, to: charOffset };
      }
    }
    charOffset += line.length + 1;
  }

  return startOffset === -1 ? null : { from: startOffset, to: doc.length };
}

/**
 * Collect the document character ranges that contain timestamp text inside
 * the target section.
 */
function getTimestampRanges(
  doc: string,
  settings: JournalPartnerSettings,
): Rng[] {
  const section = findSection(
    doc,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return [];

  // Match optional list-marker prefix, then capture the timestamp
  const linePattern = new RegExp(
    `^(?:[-*+]\\s+)?(${settings.timestampPattern})(?=\\s|$)`,
  );

  const sectionText = doc.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  const result: Rng[] = [];
  let offset = section.from;

  for (const line of lines) {
    const m = linePattern.exec(line);
    if (m?.[1] !== undefined) {
      // The prefix before the captured group
      const prefixLen = m[0].length - m[1].length;
      const from = offset + (m.index ?? 0) + prefixLen;
      result.push({ from, to: from + m[1].length });
    }
    offset += line.length + 1; // +1 for the newline character
  }

  return result;
}

/** Generate a timestamp string for the current local time in HH:MM format. */
function generateTimestamp(): string {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, '0') +
    ':' +
    String(now.getMinutes()).padStart(2, '0')
  );
}

/** Build a CM6 DecorationSet that marks every timestamp in the target section. */
function buildDecorations(
  doc: string,
  settings: JournalPartnerSettings,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.mark({
    class: 'jp-timestamp',
    inclusiveStart: false,
    inclusiveEnd: false,
  });

  for (const { from, to } of getTimestampRanges(doc, settings)) {
    builder.add(from, to, mark);
  }

  return builder.finish();
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default class JournalPartnerPlugin extends Plugin {
  settings: JournalPartnerSettings;

  async onload() {
    await this.loadSettings();
    this.applyCSSVariables();
    this.updateCheckboxStyle();
    this.registerEditorExtension(this.createEditorExtensions());
    this.registerMarkdownPostProcessor(this.postProcessor.bind(this));
    this.addSettingTab(new JournalPartnerSettingTab(this.app, this));

    // Listen for theme changes to update accent-based colors
    // @ts-ignore - theme-change is a valid Obsidian event but not in all type definitions
    this.app.workspace.on('theme-change', () => {
      if (this.settings.useAccentColor) {
        this.applyCSSVariables();
        this.refreshEditors();
      }
    });
  }

  // ── Editor extension (source + live-preview) ───────────────────────────────

  private createEditorExtensions(): Extension[] {
    const plugin = this;

    // ViewPlugin renders timestamp decorations
    const viewPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(
            view.state.doc.toString(),
            plugin.settings,
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
              plugin.settings,
            );
          }
        }
      },
      { decorations: v => v.decorations },
    );

    // Transaction filter: reject changes that overlap a timestamp range
    const readonlyFilter = EditorState.transactionFilter.of(
      (tr: Transaction) => {
        if (!plugin.settings.readonlyTimestamps || !tr.docChanged) return tr;

        const timestamps = getTimestampRanges(
          tr.startState.doc.toString(),
          plugin.settings,
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

    return [viewPlugin, readonlyFilter, this.createEnterKeymap()];
  }

  /**
   * Returns a high-priority keymap extension that intercepts Enter inside the
   * target section and prepends a fresh timestamp to the newly created line.
   */
  private createEnterKeymap(): Extension {
    const plugin = this;

    return Prec.high(
      keymap.of([
        {
          key: 'Enter',
          run(view: EditorView): boolean {
            if (!plugin.settings.autoTimestamp) return false;

            const state = view.state;
            const doc = state.doc.toString();
            const section = findSection(
              doc,
              plugin.settings.targetHeading,
              plugin.settings.headingLevel,
            );
            if (!section) return false;

            const cursor = state.selection.main;
            // Only act when the cursor head is inside the journal section.
            // Use > (not >=) because when the journal section is the last
            // section in the document, section.to === doc.length, and the
            // cursor is legitimately at doc.length when at the very end of
            // the file — the most common journaling position.
            if (cursor.head < section.from || cursor.head > section.to) {
              return false;
            }

            // Detect the list marker used on the current line (-, *, +)
            const line = state.doc.lineAt(cursor.head);
            const markerMatch = line.text.match(/^([-*+]\s+)/);
            const listMarker = markerMatch ? markerMatch[1] : '';

            const ts = generateTimestamp();
            const insertion = '\n' + listMarker + ts + ' ';

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

  /** Check whether a given source line falls inside the target heading section. */
  private isInTargetSection(docText: string, lineStart: number): boolean {
    const section = findSection(
      docText,
      this.settings.targetHeading,
      this.settings.headingLevel,
    );
    if (!section) return false;

    // Convert character offsets → 0-indexed line numbers
    const sectionStartLine =
      docText.slice(0, section.from).split('\n').length - 1;
    const sectionEndLine =
      docText.slice(0, section.to).split('\n').length - 1;

    return lineStart >= sectionStartLine && lineStart < sectionEndLine;
  }

  /**
   * Walk all text nodes inside `el` and wrap each timestamp occurrence
   * in a <span class="jp-timestamp">.
   */
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
      const span = createEl('span', { cls: 'jp-timestamp', text: m[0] });

      const parent = textNode.parentNode!;
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      parent.insertBefore(span, textNode);
      if (after) parent.insertBefore(document.createTextNode(after), textNode);
      parent.removeChild(textNode);
    }
  }

  // ── CSS variables & settings plumbing ─────────────────────────────────────

  /**
   * Get Obsidian's current accent color from CSS variables.
   * Returns the interactive-accent color which adapts to light/dark theme.
   */
  private getObsidianAccentColor(): string {
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--interactive-accent')
      .trim();
    return accent || '#7c3aed'; // fallback to purple if not found
  }

  /**
   * Derive a light background color from the accent color.
   * Creates a pastel version of the accent for the badge background.
   */
  private deriveAccentBgColor(accentColor: string, opacity: number): string {
    // Convert hex to RGB, then create a light version
    const hex = accentColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Lighten: blend accent with white based on opacity (0-100)
    const ratio = opacity / 100;
    const lightR = Math.round(r * ratio + 255 * (1 - ratio));
    const lightG = Math.round(g * ratio + 255 * (1 - ratio));
    const lightB = Math.round(b * ratio + 255 * (1 - ratio));

    return `rgb(${lightR}, ${lightG}, ${lightB})`;
  }

  /** Push current color settings into CSS custom properties. */
  applyCSSVariables() {
    const root = document.documentElement;

    if (this.settings.useAccentColor) {
      const accentColor = this.getObsidianAccentColor();
      const bgColor = this.deriveAccentBgColor(accentColor, this.settings.timestampBgOpacity);
      root.style.setProperty('--jp-ts-color', accentColor);
      root.style.setProperty('--jp-ts-bg', bgColor);
    } else {
      root.style.setProperty('--jp-ts-color', this.settings.timestampColor || '#7c3aed');
      root.style.setProperty('--jp-ts-bg', this.deriveAccentBgColor(this.settings.timestampColor || '#7c3aed', this.settings.timestampBgOpacity));
    }
  }

  /** Reset colors to Obsidian accent color and enable accent mode. */
  async resetToAccentColor() {
    const accentColor = this.getObsidianAccentColor();
    this.settings.timestampColor = accentColor;
    this.settings.useAccentColor = true;
    await this.saveSettings();
  }

  /** Apply or remove circular checkbox styling based on settings. */
  private updateCheckboxStyle() {
    const el = document.documentElement;
    if (this.settings.circularCheckboxes) {
      el.classList.add('jp-circular-checkboxes');
    } else {
      el.classList.remove('jp-circular-checkboxes');
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
    // Migration: ensure useAccentColor is set (default to true for new installs)
    if (this.settings.useAccentColor === undefined) {
      this.settings.useAccentColor = true;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCSSVariables();
    this.updateCheckboxStyle();
    this.refreshEditors();
  }

  /** Dispatch a force-update effect to every open Markdown editor. */
  private refreshEditors() {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cm: EditorView | undefined = (leaf.view.editor as any)?.cm;
        cm?.dispatch({ effects: forceUpdateEffect.of(null) });
      }
    });
  }
}

// ── Settings tab ────────────────────────────────────────────────────────────

class JournalPartnerSettingTab extends PluginSettingTab {
  plugin: JournalPartnerPlugin;

  constructor(app: App, plugin: JournalPartnerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Journal Partner' });

    // ── Scope ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '📍 作用范围' });

    new Setting(containerEl)
      .setName('目标标题名称')
      .setDesc(
        '插件生效的标题文字（不含 # 符号），例如填写 Journal 则作用于 ## Journal 下的内容',
      )
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

    // ── Style ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🎨 时间戳样式' });

    new Setting(containerEl)
      .setName('使用 Obsidian 强调色')
      .setDesc('自动使用 Obsidian 主题的强调色，并跟随主题切换而变化')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.useAccentColor)
          .onChange(async value => {
            this.plugin.settings.useAccentColor = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('文字颜色')
      .setDesc('时间戳徽标的前景色（关闭「使用强调色」时生效）')
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings.timestampColor || '#7c3aed')
          .onChange(async value => {
            this.plugin.settings.timestampColor = value;
            this.plugin.settings.useAccentColor = false;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton(btn =>
        btn
          .setIcon('reset')
          .setTooltip('恢复强调色')
          .onClick(async () => {
            await this.plugin.resetToAccentColor();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('背景透明度')
      .setDesc('时间戳徽标的背景色透明度（值越大颜色越深）')
      .addSlider(slider =>
        slider
          .setValue(this.plugin.settings.timestampBgOpacity)
          .setLimits(5, 80, 5)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.timestampBgOpacity = value;
            await this.plugin.saveSettings();
          }),
      );

    // Preview badge
    const previewEl = containerEl.createDiv({ cls: 'jp-settings-preview' });
    previewEl.style.cssText =
      'margin-top: 24px; padding: 16px; border-radius: 8px;' +
      'background: var(--background-secondary); display: flex; align-items: center; gap: 10px;';
    previewEl.createEl('span', { text: '预览：' }).style.color =
      'var(--text-muted)';

    const timestampSpan = previewEl.createEl('span', {
      cls: 'jp-timestamp',
      text: '07:31',
    });

    // Update preview badge colors based on settings
    const updatePreview = () => {
      const color = this.plugin.settings.useAccentColor
        ? (getComputedStyle(document.documentElement)
            .getPropertyValue('--interactive-accent')
            .trim() || '#7c3aed')
        : (this.plugin.settings.timestampColor || '#7c3aed');
      const hex = color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const opacity = this.plugin.settings.timestampBgOpacity / 100;
      const lightR = Math.round(r * opacity + 255 * (1 - opacity));
      const lightG = Math.round(g * opacity + 255 * (1 - opacity));
      const lightB = Math.round(b * opacity + 255 * (1 - opacity));
      timestampSpan.style.color = color;
      timestampSpan.style.backgroundColor = `rgb(${lightR}, ${lightG}, ${lightB})`;
    };

    // Initial preview update
    updatePreview();

    // Listen for theme changes to update preview
    const themeChangeHandler = () => updatePreview();
    this.plugin.registerEvent(
      // @ts-ignore - workspace exists
      this.plugin.app.workspace.on('theme-change', themeChangeHandler),
    );

    previewEl.createEl('span', { text: '这里是日记内容…' });

    // ── Behavior ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '⚙️ 行为' });

    new Setting(containerEl)
      .setName('时间戳只读')
      .setDesc(
        '开启后，在编辑器中无法修改已存在的时间戳，防止意外删除或改动',
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.readonlyTimestamps)
          .onChange(async value => {
            this.plugin.settings.readonlyTimestamps = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('回车自动插入时间戳')
      .setDesc(
        '在 Journal 区块内按下回车时，自动在新行开头插入当前时间（HH:MM）',
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoTimestamp)
          .onChange(async value => {
            this.plugin.settings.autoTimestamp = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('圆形复选框')
      .setDesc('在日记区域内将 checkbox 渲染为圆形而非方形')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.circularCheckboxes)
          .onChange(async value => {
            this.plugin.settings.circularCheckboxes = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Advanced ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🔧 高级' });

    new Setting(containerEl)
      .setName('时间戳匹配正则')
      .setDesc(
        '用于识别时间戳的正则表达式。默认匹配 HH:MM 格式（如 07:31）。' +
          '修改后立即生效，无效的正则会被忽略。',
      )
      .addText(text =>
        text
          .setPlaceholder('\\d{2}:\\d{2}')
          .setValue(this.plugin.settings.timestampPattern)
          .onChange(async value => {
            try {
              new RegExp(value); // validate before saving
              this.plugin.settings.timestampPattern = value;
              await this.plugin.saveSettings();
            } catch {
              new Notice('❌ 无效的正则表达式，请检查后重试');
            }
          }),
      );

    previewEl.createEl('span', { text: '这里是日记内容…' });
  }
}
