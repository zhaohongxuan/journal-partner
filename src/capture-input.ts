/**
 * The capture card's text input.
 *
 * Preferred implementation: Obsidian's own Markdown editor (the CM6 editor
 * used by notes), embedded in the sidebar so drafts get real Live Preview —
 * bold/italic hide their markers, tags/links are styled, checkboxes render,
 * and the native `[[` / `#` suggesters, editor hotkeys and the mobile editing
 * toolbar all work. Obsidian doesn't export that class, so it is borrowed from
 * a throwaway markdown embed (the same trick the Kanban plugin uses).
 *
 * Because that is private API, a plain `<textarea>` with the same interface is
 * kept as a fallback: if a future Obsidian release changes the internals, the
 * capture box degrades to the old behaviour instead of breaking the view.
 */

import { App, Component, Editor, Modifier, Scope, TFile } from 'obsidian';
import { Extension } from '@codemirror/state';
import { EditorView, ViewUpdate, placeholder as cmPlaceholder } from '@codemirror/view';

/** Submit-shortcut setting values → modifiers held together with Enter. */
const SUBMIT_MODIFIERS: Record<string, Modifier[]> = {
  'shift+enter': ['Shift'],
  'ctrl+enter': ['Ctrl'],
  'alt+enter': ['Alt'],
  'ctrl+shift+enter': ['Ctrl', 'Shift'],
};

export interface CaptureInputOptions {
  placeholder: string;
  /**
   * Fired after every content change. `userEdit` is false for changes made
   * through this interface (setValue / replaceRange), true for typing, paste,
   * undo, suggestions, etc. Always invoked outside of a CM update cycle, so the
   * callback may write back into the input.
   */
  onChange: (userEdit: boolean) => void;
  /** Current submit shortcut setting, e.g. `shift+enter` (read on every key). */
  submitShortcut: () => string;
  onSubmit: () => void;
}

export interface CaptureInput {
  /** Root element — mount point, focus/paste/drop listeners attach here. */
  readonly el: HTMLElement;
  /** True when Obsidian's own `[[` / `#` suggesters run inside this input. */
  readonly nativeSuggest: boolean;
  getValue(): string;
  /** Replace the whole text; the cursor moves to the end. */
  setValue(text: string): void;
  getSelection(): { from: number; to: number };
  /** Replace [from, to) with `text`; the cursor lands right after it. */
  replaceRange(text: string, from: number, to: number): void;
  /** Empty the input and drop its undo history (after submit / clear). */
  clear(): void;
  focus(): void;
  /**
   * Make this input the workspace's active editor without focusing it, so
   * plugins that insert into `workspace.activeEditor` (e.g. image uploaders
   * opened from the image button) target the capture box.
   */
  markActive(): void;
  /** Release resources (editor state, active-editor registration). */
  destroy(): void;
}

/**
 * Build the capture input inside `parent`. `owner` is the component whose
 * lifecycle the editor follows (the capture view).
 */
export function createCaptureInput(
  app: App,
  parent: HTMLElement,
  owner: Component,
  options: CaptureInputOptions,
): CaptureInput {
  try {
    return new EmbeddedMarkdownInput(app, parent, owner, options);
  } catch (err) {
    console.error('[Journal Partner] embedded editor unavailable, falling back to textarea', err);
    parent.querySelector(':scope > .jp-capture-input')?.remove();
    return new TextareaInput(parent, options);
  }
}

// ── Embedded Obsidian editor ──────────────────────────────────────────────

/** Fields the embedded editor reads from its owner (a MarkdownFileInfo-alike). */
interface EditorOwner {
  app: App;
  file: TFile | null;
  path: string;
  editMode: unknown;
  editor: Editor | null;
  getMode(): 'source';
  syncScroll(): void;
  onMarkdownScroll(): void;
  onMarkdownFold(): void;
  getFoldInfo(): null;
  showPreview(): void;
  applyScope(): void;
  save(): void;
}

/** The slice of Obsidian's internal MarkdownEditor class we rely on. */
interface InternalMarkdownEditor extends Component {
  app: App;
  owner: EditorOwner;
  editor: Editor;
  cm: EditorView;
  editorEl: HTMLElement;
  sourceMode: boolean;
  set(text: string, clear: boolean): void;
  focus(): void;
  destroy(): void;
  buildLocalExtensions(): Extension[];
  onUpdate(update: ViewUpdate, changed: boolean): void;
}

type InternalMarkdownEditorCtor = new (
  app: App,
  containerEl: HTMLElement,
  owner: EditorOwner,
) => InternalMarkdownEditor;

interface WidgetEditorView {
  editable: boolean;
  editMode?: object;
  showEditor(): void;
  unload(): void;
}

interface EmbedRegistryHost {
  embedRegistry: {
    embedByExtension: {
      md: (ctx: { app: App; containerEl: HTMLElement }, file: TFile | null, subpath: string) => WidgetEditorView;
    };
  };
}

let editorCtorCache: InternalMarkdownEditorCtor | null = null;

/**
 * Pull the editor class out of a markdown embed: an editable embed creates
 * its edit mode lazily, and that object's grandparent prototype is the plain
 * scrollable Markdown editor (the parent adds embed-only iframe/save logic).
 */
function resolveEditorCtor(app: App): InternalMarkdownEditorCtor {
  if (editorCtorCache) return editorCtorCache;
  const host = app as unknown as EmbedRegistryHost;
  const widget = host.embedRegistry.embedByExtension.md(
    { app, containerEl: createDiv() },
    null,
    '',
  );
  try {
    widget.editable = true;
    widget.showEditor();
    if (!widget.editMode) throw new Error('markdown embed has no edit mode');
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(widget.editMode)) as {
      constructor: InternalMarkdownEditorCtor;
    };
    if (typeof proto?.constructor !== 'function') throw new Error('editor class not found');
    editorCtorCache = proto.constructor;
    return editorCtorCache;
  } finally {
    widget.unload();
  }
}
interface EditorHooks {
  placeholder: string;
  onDocChanged: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/** Subclass the borrowed editor to add our extensions and change hook. */
function makeCaptureEditorClass(Base: InternalMarkdownEditorCtor) {
  return class CaptureMarkdownEditor extends Base {
    declare hooks: EditorHooks;

    buildLocalExtensions(): Extension[] {
      const extensions = super.buildLocalExtensions();
      extensions.push(cmPlaceholder(this.hooks.placeholder));
      extensions.push(EditorView.domEventHandlers({
        focus: () => { this.hooks.onFocus(); },
        blur: () => { this.hooks.onBlur(); },
      }));
      return extensions;
    }

    onUpdate(update: ViewUpdate, changed: boolean): void {
      super.onUpdate(update, changed);
      if (update.docChanged) this.hooks.onDocChanged();
    }
  };
}

class EmbeddedMarkdownInput implements CaptureInput {
  readonly el: HTMLElement;
  readonly nativeSuggest = true;
  private readonly app: App;
  private readonly editor: InternalMarkdownEditor;
  private readonly ownerInfo: EditorOwner;
  private readonly options: CaptureInputOptions;
  /** Set while we dispatch our own changes, so onChange reports userEdit=false. */
  private programmatic = false;
  /** Keymap scope holding the submit shortcut, pushed while focused. */
  private submitScope: Scope | null = null;
  private destroyed = false;

  constructor(app: App, parent: HTMLElement, owner: Component, options: CaptureInputOptions) {
    const EditorClass = makeCaptureEditorClass(resolveEditorCtor(app));
    this.app = app;
    this.options = options;
    this.el = parent.createDiv({ cls: 'jp-capture-input jp-capture-editor' });

    const noop = (): void => {};
    this.ownerInfo = {
      app,
      file: null,
      path: '',
      editMode: null,
      editor: null,
      getMode: () => 'source',
      syncScroll: noop,
      onMarkdownScroll: noop,
      onMarkdownFold: noop,
      getFoldInfo: () => null,
      showPreview: noop,
      applyScope: noop,
      save: noop,
    };

    const editor = new EditorClass(app, this.el, this.ownerInfo);
    editor.hooks = {
      placeholder: options.placeholder,
      onDocChanged: () => this.emitChange(!this.programmatic),
      onFocus: () => this.handleFocus(),
      onBlur: () => this.popSubmitScope(),
    };
    // Always Live Preview, even if the vault's default mode is Source.
    editor.sourceMode = false;
    this.ownerInfo.editMode = editor;
    this.ownerInfo.editor = editor.editor;
    this.editor = editor;

    // First `set` builds the CM state with all extensions.
    editor.set('', true);
    owner.addChild(editor);
    owner.register(() => this.destroy());
  }

  getValue(): string {
    return this.editor.cm.state.doc.toString();
  }

  setValue(text: string): void {
    const len = this.editor.cm.state.doc.length;
    this.dispatchProgrammatic(text, 0, len);
  }

  getSelection(): { from: number; to: number } {
    const { from, to } = this.editor.cm.state.selection.main;
    return { from, to };
  }

  replaceRange(text: string, from: number, to: number): void {
    this.dispatchProgrammatic(text, from, to);
  }

  clear(): void {
    this.programmatic = true;
    try {
      // `set(…, true)` rebuilds the state → empty doc and fresh undo history.
      this.editor.set('', true);
    } finally {
      this.programmatic = false;
    }
    // setState doesn't go through onUpdate, so report the change ourselves.
    this.emitChange(false);
  }

  focus(): void {
    this.editor.focus();
  }

  markActive(): void {
    (this.app.workspace as unknown as { activeEditor: unknown }).activeEditor = this.ownerInfo;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.popSubmitScope();
    const ws = this.app.workspace as unknown as { activeEditor: unknown };
    if (ws.activeEditor === this.ownerInfo) ws.activeEditor = null;
    // The borrowed class has no onunload hook of its own (the embed subclass
    // adds one), so tear the CM view down explicitly.
    try {
      this.editor.destroy();
    } catch (err) {
      console.error('[Journal Partner] capture editor destroy failed', err);
    }
  }

  private dispatchProgrammatic(text: string, from: number, to: number): void {
    this.programmatic = true;
    try {
      this.editor.cm.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
    } finally {
      this.programmatic = false;
    }
  }

  /** Defer out of the CM update cycle so the callback may dispatch again. */
  private emitChange(userEdit: boolean): void {
    if (this.destroyed) return;
    window.setTimeout(() => {
      if (!this.destroyed) this.options.onChange(userEdit);
    }, 0);
  }

  private handleFocus(): void {
    // The editor's own focus handler sets workspace.activeEditor, but the
    // leaf's `focusin` → setActiveLeaf that follows can reset it when focus
    // arrives from another pane. Re-assert once the event has settled.
    window.setTimeout(() => {
      if (!this.destroyed && this.editor.cm.hasFocus) this.markActive();
    }, 0);
    this.pushSubmitScope();
  }

  /**
   * Obsidian's hotkey manager sees keydown (window, capture phase) before
   * CodeMirror does — e.g. Mod+Enter toggles checkboxes. A pushed Scope wins
   * over app hotkeys, so the submit shortcut is registered there.
   */
  private pushSubmitScope(): void {
    this.popSubmitScope();
    const modifiers =
      SUBMIT_MODIFIERS[this.options.submitShortcut()] ?? SUBMIT_MODIFIERS['shift+enter'];
    const scope = new Scope(this.app.scope);
    scope.register(modifiers, 'Enter', (evt: KeyboardEvent) => {
      if (evt.isComposing) return true;
      this.options.onSubmit();
      return false;
    });
    this.app.keymap.pushScope(scope);
    this.submitScope = scope;
  }

  private popSubmitScope(): void {
    if (!this.submitScope) return;
    this.app.keymap.popScope(this.submitScope);
    this.submitScope = null;
  }
}

// ── Fallback: plain textarea ───────────────────────────────────────────────

class TextareaInput implements CaptureInput {
  readonly el: HTMLTextAreaElement;
  readonly nativeSuggest = false;
  private readonly options: CaptureInputOptions;

  constructor(parent: HTMLElement, options: CaptureInputOptions) {
    this.options = options;
    this.el = parent.createEl('textarea', {
      cls: 'jp-capture-input',
      attr: { placeholder: options.placeholder, rows: '3' },
    });
    // `input` covers typing and plugins that set .value + dispatch `input`
    // (github-image-uploader); our own writes below don't fire it.
    this.el.addEventListener('input', () => {
      this.autoResize();
      options.onChange(true);
    });
    this.el.addEventListener('keydown', evt => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      const shortcut = options.submitShortcut();
      const matches =
        (shortcut.includes('shift') ? evt.shiftKey : !evt.shiftKey) &&
        (shortcut.includes('ctrl') ? evt.ctrlKey : !evt.ctrlKey) &&
        (shortcut.includes('alt') ? evt.altKey : !evt.altKey);
      if (matches) {
        evt.preventDefault();
        options.onSubmit();
      }
    });
  }

  getValue(): string {
    return this.el.value;
  }

  setValue(text: string): void {
    this.el.value = text;
    this.el.setSelectionRange(text.length, text.length);
    this.afterWrite();
  }

  getSelection(): { from: number; to: number } {
    return { from: this.el.selectionStart, to: this.el.selectionEnd };
  }

  replaceRange(text: string, from: number, to: number): void {
    this.el.setRangeText(text, from, to, 'end');
    this.afterWrite();
  }

  clear(): void {
    this.setValue('');
  }

  focus(): void {
    this.el.focus();
  }

  markActive(): void {}

  destroy(): void {}

  private afterWrite(): void {
    this.autoResize();
    this.options.onChange(false);
  }

  private autoResize(): void {
    this.el.setCssProps({ height: 'auto' });
    const next = Math.min(this.el.scrollHeight, 240);
    this.el.setCssProps({ height: `${next}px` });
  }
}
