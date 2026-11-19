import { App, Component, Editor, MarkdownRenderer, MarkdownView, Notice, TAbstractFile, TFile, moment, setIcon } from 'obsidian';
import { appHasDailyNotesPluginLoaded, createDailyNote, getAllDailyNotes, getDailyNote } from 'obsidian-daily-notes-interface';
import type { JournalPartnerSettings } from './section';
import { addPlanningTodo, parseDailyTodos, DailyTodo, setDailyTodoCompleted } from './todos';
import { t } from './i18n';

/** Today's planning tasks, backed by the daily note rather than plugin storage. */
export class TodayTodos extends Component {
  private readonly el: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly addInput: HTMLInputElement;
  private readonly addButton: HTMLButtonElement;
  private readonly addForm: HTMLFormElement;
  private composerOpen = false;
  private addToggle: HTMLButtonElement | null = null;
  private timer: number | null = null;
  private generation = 0;
  private closed = false;
  private day = '';
  private todayPath: string | null = null;
  private snapshot = '';
  private busy = false;
  private completedVisibility: boolean | null = null;
  private defaultCompletedVisibility: boolean | undefined;
  private renderScope: Component | null = null;

  constructor(
    private readonly app: App,
    parent: HTMLElement,
    private readonly settings: () => JournalPartnerSettings,
    private readonly onTasksChanged: () => void = () => {},
  ) {
    super();
    this.el = parent.createDiv({ cls: 'jp-today-todos' });
    this.contentEl = this.el.createDiv({ cls: 'jp-todo-content' });
    const form = this.addForm = this.el.createEl('form', { cls: 'jp-todo-add-form' });
    form.hide();
    this.addInput = form.createEl('input', {
      cls: 'jp-todo-add-input', attr: { type: 'text' },
    });
    this.addButton = form.createEl('button', {
      cls: 'jp-todo-add-button', attr: { type: 'submit' },
    });
    setIcon(this.addButton, 'plus');
    let composing = false;
    this.addInput.addEventListener('compositionstart', () => { composing = true; });
    this.addInput.addEventListener('compositionend', () => { composing = false; });
    this.addInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || composing)) event.preventDefault();
      if (event.key === 'Escape' && !composing && !this.busy) {
        event.preventDefault();
        this.setComposerOpen(false);
        this.addToggle?.focus();
      }
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!composing) void this.addTodo();
    });
    this.el.hide();
  }

  onload(): void {
    this.closed = false;
    this.completedVisibility = null;
    this.defaultCompletedVisibility = undefined;
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file.path === this.todayPath || this.day !== this.today()) this.scheduleRefresh();
    }));
    // Creation/deletion/rename can change which file is today's daily note.
    const onFileChange = (file: TAbstractFile): void => {
      if (file instanceof TFile && file.extension === 'md') this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on('create', onFileChange));
    this.registerEvent(this.app.vault.on('delete', onFileChange));
    this.registerEvent(this.app.vault.on('rename', onFileChange));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      if (info.file?.path === this.todayPath) this.scheduleRefresh();
    }));
    const doc = this.el.ownerDocument;
    this.registerDomEvent(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'visible') this.refreshNow();
    });
    const win = doc.defaultView;
    if (win) this.registerDomEvent(win, 'focus', () => this.refreshNow());
    this.registerInterval(window.setInterval(() => {
      if (this.day !== this.today()) this.refreshNow();
    }, 30_000));
    this.refreshNow();
  }

  onunload(): void {
    this.closed = true;
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.clearRenderedContent();
    this.el.remove();
  }

  /** Settings and manual refreshes apply without rebuilding the capture view. */
  refreshNow(): void {
    if (this.closed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    void this.render(++this.generation);
  }

  private today(): string {
    return moment().format('YYYY-MM-DD');
  }

  private scheduleRefresh(): void {
    if (this.closed || !this.settings().todoEnabled) return;
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refreshNow(), 150);
  }

  /** Prefer a live buffer so unsaved edits are never replaced by an old disk copy. */
  private findEditor(file: TFile): Editor | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active.editor;
    let editor: Editor | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (!editor && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        editor = leaf.view.editor;
      }
    });
    return editor;
  }

  private clearRenderedContent(): void {
    if (this.renderScope) this.removeChild(this.renderScope);
    this.renderScope = null;
    this.contentEl.empty();
  }

  private paintHeader(file: TFile | null, remaining = 0): void {
    this.clearRenderedContent();
    const head = this.contentEl.createDiv({ cls: 'jp-todo-head' });
    setIcon(head.createSpan({ cls: 'jp-todo-icon' }), 'list-todo');
    head.createSpan({ cls: 'jp-todo-title', text: t('todo.title') });
    head.createSpan({ cls: 'jp-todo-count', text: String(remaining) });
    const actions = head.createDiv({ cls: 'jp-todo-head-actions' });
    const showCompleted = this.showCompleted();
    const visibilityLabel = t(showCompleted ? 'todo.hideCompleted' : 'todo.showCompleted');
    const visibility = actions.createEl('button', {
      cls: 'jp-todo-visibility-toggle',
      attr: { type: 'button', 'aria-label': visibilityLabel, title: visibilityLabel, 'aria-pressed': String(showCompleted) },
    });
    visibility.disabled = this.busy;
    setIcon(visibility, showCompleted ? 'eye' : 'eye-off');
    visibility.addEventListener('click', () => this.toggleCompletedVisibility());
    this.addToggle = actions.createEl('button', {
      cls: 'jp-todo-add-toggle',
      attr: { type: 'button', 'aria-label': t('todo.add'), title: t('todo.add'), 'aria-expanded': String(this.composerOpen) },
    });
    this.addToggle.disabled = this.busy || !appHasDailyNotesPluginLoaded();
    setIcon(this.addToggle, 'plus');
    this.addToggle.addEventListener('click', () => {
      if (!this.busy) this.setComposerOpen(!this.composerOpen);
    });
    if (file) {
      const open = actions.createEl('button', {
        cls: 'jp-todo-open',
        attr: { type: 'button', 'aria-label': t('todo.openNote'), title: t('todo.openNote') },
      });
      setIcon(open, 'arrow-up-right');
      open.addEventListener('click', () => {
        void this.app.workspace.getLeaf(false).openFile(file);
      });
    }
  }

  /** A card-local override; changing the global default starts a new override. */
  private showCompleted(): boolean {
    const defaultValue = this.settings().todoShowCompleted;
    if (this.defaultCompletedVisibility !== defaultValue) {
      this.defaultCompletedVisibility = defaultValue;
      this.completedVisibility = null;
    }
    return this.completedVisibility ?? defaultValue;
  }

  private toggleCompletedVisibility(): void {
    if (this.closed || this.busy) return;
    this.completedVisibility = !this.showCompleted();
    this.refreshNow();
  }

  private setComposerOpen(open: boolean): void {
    this.composerOpen = open;
    if (open) this.addForm.show();
    else this.addForm.hide();
    this.addToggle?.setAttr('aria-expanded', String(open));
    if (open) this.addInput.focus();
  }

  private async render(generation: number): Promise<void> {
    const settings = this.settings();
    if (!settings.todoEnabled) {
      this.completedVisibility = null;
      this.snapshot = '';
      this.clearRenderedContent();
      this.el.hide();
      return;
    }
    this.el.show();
    this.addInput.placeholder = t('todo.addPlaceholder');
    this.addInput.setAttr('aria-label', t('todo.addPlaceholder'));
    this.addButton.setAttr('aria-label', t('todo.add'));
    this.addButton.setAttr('title', t('todo.add'));
    this.addInput.disabled = this.busy || !appHasDailyNotesPluginLoaded();
    this.addButton.disabled = this.addInput.disabled;
    const day = this.today();
    if (this.day !== day) this.completedVisibility = null;
    this.day = day;
    const { todoStartHeading: start, todoEndHeading: end } = settings;
    const showCompleted = this.showCompleted();
    try {
      const available = appHasDailyNotesPluginLoaded();
      const file = available ? getDailyNote(moment(), getAllDailyNotes()) : null;
      this.todayPath = file?.path ?? null;
      const content = file ? this.findEditor(file)?.getValue() ?? await this.app.vault.cachedRead(file) : '';
      if (this.closed || generation !== this.generation) return;
      const todos = parseDailyTodos(content, settings);
      const snapshot = JSON.stringify([this.day, file?.path, todos, start, end, showCompleted, settings.todoIncludeTimelineTasks,
        settings.targetHeading, settings.headingLevel, settings.timestampPattern, settings.language, available, this.busy]);
      if (snapshot === this.snapshot) return;
      this.snapshot = snapshot;
      const remaining = todos.filter(todo => !todo.completed).length;
      this.paintHeader(file, remaining);
      const visible = todos.filter(todo => showCompleted || !todo.completed);
      if (!file || visible.length === 0) {
        this.contentEl.createDiv({
          cls: 'jp-todo-empty',
          text: !available ? t('notice.dailyNotesRequired') : !file ? t('todo.noNote') : todos.length > 0 ? t('todo.allDone') : t('todo.empty'),
        });
        return;
      }
      const scope = this.addChild(new Component());
      this.renderScope = scope;
      const list = this.contentEl.createDiv({ cls: 'jp-todo-list' });
      await Promise.all(visible.map(async todo => {
        const row = list.createDiv({ cls: `jp-todo-row${todo.completed ? ' is-done' : ''}${todo.source === 'journal' ? ' jp-todo-row--timeline' : ''}` });
        const checkTarget = row.createEl('label', { cls: 'jp-todo-check-target' });
        const checkbox = checkTarget.createEl('input', {
          cls: 'jp-todo-checkbox',
          attr: { type: 'checkbox', 'aria-label': todo.text || t('todo.untitled') },
        });
        checkbox.checked = todo.completed;
        checkbox.disabled = this.busy;
        checkbox.addEventListener('change', () => {
          void this.setCompleted(file, day, todo, checkbox.checked);
        });
        const body = row.createDiv({ cls: 'jp-todo-text' });
        const text = body.createDiv({ cls: 'jp-todo-body' });
        if (todo.source === 'journal') {
          text.setAttr('title', todo.text || t('todo.untitled'));
          const source = `${t('todo.timelineSource')} · ${todo.timestamp ?? ''}`;
          const badge = row.createSpan({ cls: 'jp-todo-source', attr: { title: source, 'aria-label': source, role: 'img' } });
          setIcon(badge, 'history');
        }
        await MarkdownRenderer.render(this.app, todo.text || t('todo.untitled'), text, file.path, scope);
      }));
    } catch (err) {
      if (this.closed || generation !== this.generation) return;
      console.error('[Journal Partner] reading today TODOs failed', err);
      this.snapshot = '';
      this.paintHeader(null);
      this.contentEl.createDiv({ cls: 'jp-todo-empty', text: t('todo.readFailed') });
    }
  }

  private async addTodo(): Promise<void> {
    const text = this.addInput.value.trim();
    if (!text || this.busy || this.closed || !this.settings().todoEnabled) return;
    if (!appHasDailyNotesPluginLoaded()) return;
    const day = this.today();
    const { todoStartHeading: start, todoEndHeading: end } = this.settings();
    this.busy = true;
    this.addInput.disabled = true;
    this.addButton.disabled = true;
    this.el.querySelectorAll<HTMLInputElement>('.jp-todo-checkbox').forEach(el => { el.disabled = true; });
    try {
      // Validate before creating a daily note so invalid settings create nothing.
      addPlanningTodo('', text, start, end);
      const date = moment();
      const file = getDailyNote(date, getAllDailyNotes()) ?? await createDailyNote(date);
      if (this.closed || day !== this.today()) return;
      const editor = this.findEditor(file);
      if (editor) {
        const content = editor.getValue();
        const next = addPlanningTodo(content, text, start, end);
        let offset = 0;
        while (offset < content.length && content[offset] === next[offset]) offset++;
        editor.replaceRange(next.slice(offset, offset + next.length - content.length), editor.offsetToPos(offset));
      } else {
        await this.app.vault.process(file, content => addPlanningTodo(content, text, start, end));
      }
      if (!this.closed) {
        this.addInput.value = '';
        this.setComposerOpen(false);
        this.addToggle?.focus();
      }
    } catch (err) {
      console.error('[Journal Partner] adding today TODO failed', err);
      if (!this.closed) new Notice(t('todo.writeFailed'));
    } finally {
      this.busy = false;
      this.snapshot = '';
      if (!this.closed) {
        this.addInput.disabled = false;
        this.addButton.disabled = false;
        this.refreshNow();
        if (this.composerOpen) this.addInput.focus();
      }
    }
  }

  private async setCompleted(
    file: TFile, day: string, todo: DailyTodo, completed: boolean,
  ): Promise<void> {
    if (this.busy || this.closed || !this.settings().todoEnabled) return;
    const settings = { ...this.settings() };
    this.busy = true;
    this.el.querySelectorAll<HTMLInputElement>('.jp-todo-checkbox').forEach(el => { el.disabled = true; });
    try {
      // A page left open across midnight must never edit yesterday as today.
      if (day !== this.today() || getDailyNote(moment(), getAllDailyNotes())?.path !== file.path) {
        throw new Error(t('todo.changed'));
      }
      const editor = this.findEditor(file);
      if (editor) {
        const content = editor.getValue();
        const next = setDailyTodoCompleted(content, todo, completed, settings);
        // The parser guarantees that only the checkbox character can change.
        // Let Obsidian persist the editor normally; preserve its undo history.
        if (next !== content) {
          let offset = 0;
          while (content[offset] === next[offset]) offset++;
          editor.replaceRange(next[offset], editor.offsetToPos(offset), editor.offsetToPos(offset + 1));
        }
      } else {
        // process() validates against the latest file contents atomically.
        await this.app.vault.process(file, content => setDailyTodoCompleted(content, todo, completed, settings));
      }
      if (!this.closed) this.onTasksChanged();
    } catch (err) {
      console.error('[Journal Partner] updating today TODO failed', err);
      new Notice(t('todo.writeFailed'));
    } finally {
      this.busy = false;
      this.snapshot = '';
      this.refreshNow();
    }
  }
}
