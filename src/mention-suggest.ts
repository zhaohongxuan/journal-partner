/**
 * `@` file mentions in the capture box, behaving like Obsidian's own `[[`
 * suggester: recent files when the query is empty, fuzzy search otherwise,
 * same native popup, and the pick is inserted as a link that follows the
 * vault's link-format settings.
 *
 * Registered globally (EditorSuggest has no per-editor scope) but only
 * triggers inside the capture box's embedded editor, so `@` in notes is left
 * alone.
 */

import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  SearchResult,
  TFile,
  prepareFuzzySearch,
  renderResults,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';

interface MentionItem {
  file: TFile;
  /** Fuzzy match against the file path; null for the recent-files list. */
  match: SearchResult | null;
}

const MAX_SUGGESTIONS = 20;

export class MentionSuggest extends EditorSuggest<MentionItem> {
  constructor(app: App) {
    super(app);
    this.limit = MAX_SUGGESTIONS;
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    if (!isCaptureEditor(editor)) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    // `@` followed by a run of non-space characters up to the cursor. Skip
    // `@` glued to an ASCII word (emails, handles like a@b).
    const m = /(^|[^A-Za-z0-9._%+-])@([^\s@]*)$/.exec(before);
    if (!m) return null;
    const at = cursor.ch - m[2].length - 1;
    return {
      start: { line: cursor.line, ch: at },
      end: cursor,
      query: m[2],
    };
  }

  getSuggestions(context: EditorSuggestContext): MentionItem[] {
    const query = context.query.trim();
    if (query.length === 0) return this.recentFiles();

    const search = prepareFuzzySearch(query);
    const items: MentionItem[] = [];
    for (const file of this.app.vault.getFiles()) {
      const match = search(file.path);
      if (match) items.push({ file, match });
    }
    // Higher score first; on ties prefer shorter paths (closer to the name).
    items.sort((a, b) =>
      (b.match?.score ?? 0) - (a.match?.score ?? 0) || a.file.path.length - b.file.path.length);
    return items.slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion(item: MentionItem, el: HTMLElement): void {
    el.addClass('mod-complex');
    const content = el.createDiv({ cls: 'suggestion-content' });
    const title = content.createDiv({ cls: 'suggestion-title' });
    if (item.match) {
      renderResults(title, item.file.path, item.match);
    } else {
      title.setText(item.file.extension === 'md' ? item.file.basename : item.file.name);
      const parent = item.file.parent?.path;
      if (parent && parent !== '/') content.createDiv({ cls: 'suggestion-note', text: parent });
    }
  }

  selectSuggestion(item: MentionItem): void {
    const context = this.context;
    if (!context) return;
    const link = this.app.fileManager.generateMarkdownLink(item.file, '');
    context.editor.replaceRange(`${link} `, context.start, context.end);
    this.close();
  }

  /** Recently opened files that still exist — what `[[` shows with no query. */
  private recentFiles(): MentionItem[] {
    const items: MentionItem[] = [];
    for (const path of this.app.workspace.getLastOpenFiles()) {
      const file = this.app.vault.getFileByPath(path);
      if (file) items.push({ file, match: null });
    }
    return items;
  }
}

/** True when `editor` is the capture box's embedded editor (vs. a note). */
function isCaptureEditor(editor: Editor): boolean {
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  return !!cm?.dom.closest('.jp-capture-input');
}
