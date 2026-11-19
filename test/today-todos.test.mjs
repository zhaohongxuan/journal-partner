/** Component integration tests with real task parsing and mocked host APIs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const host = globalThis.__jpTodayTodosTest = {};
const outfile = path.join(tmpdir(), `jp-today-todos-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/today-todos.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
  plugins: [{
    name: 'mock-obsidian-host',
    setup(build) {
      build.onResolve({ filter: /^(obsidian|obsidian-daily-notes-interface)$/ }, args => ({ path: args.path, namespace: 'host' }));
      build.onLoad({ filter: /.*/, namespace: 'host' }, args => ({
        loader: 'js',
        contents: args.path === 'obsidian' ? `
          const host = globalThis.__jpTodayTodosTest;
          export class Component {
            children = []; cleanups = []; loaded = false;
            load() { this.loaded = true; this.onload?.(); }
            unload() {
              if (!this.loaded) return;
              this.loaded = false; this.onunload?.();
              this.children.splice(0).forEach(child => child.unload());
              this.cleanups.splice(0).forEach(cleanup => cleanup());
            }
            addChild(child) { this.children.push(child); if (this.loaded) child.load(); return child; }
            removeChild(child) { this.children = this.children.filter(c => c !== child); child.unload(); }
            registerEvent(ref) { this.cleanups.push(() => ref.off()); }
            registerDomEvent(el, event, fn) {
              el.addEventListener(event, fn);
              this.cleanups.push(() => el.removeEventListener(event, fn));
            }
            registerInterval(id) { this.cleanups.push(() => window.clearInterval(id)); }
          }
          export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
          export class MarkdownView { constructor(file, editor) { this.file = file; this.editor = editor; } }
          host.TFile = TFile; host.MarkdownView = MarkdownView;
          export const MarkdownRenderer = { render: async (_app, text, el) => { el.text = text; } };
          export class Notice { constructor(text) { host.notices.push(text); } }
          export const moment = () => ({ format: () => '2026-11-11' });
          export const setIcon = () => {};
        ` : `
          const host = globalThis.__jpTodayTodosTest;
          export const appHasDailyNotesPluginLoaded = () => host.dailyAvailable;
          export const getAllDailyNotes = () => ({});
          export const getDailyNote = () => host.file;
          export const createDailyNote = async () => { host.file = new host.TFile('daily/2026-11-11.md'); return host.file; };
        `,
      }));
    },
  }],
});
const { TodayTodos } = await import(pathToFileURL(outfile).href);

class EventTargetStub {
  listeners = new Map();
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this, preventDefault() {} }); }
  on(name, fn) { this.addEventListener(name, fn); return { off: () => this.removeEventListener(name, fn) }; }
}

/** Only the element operations used by the component; no layout emulation. */
class Element extends EventTargetStub {
  children = [];
  hidden = false;
  checked = false;
  disabled = false;
  text = '';
  constructor(tag = 'div', options = {}, ownerDocument = null) {
    super();
    this.tag = tag;
    this.cls = options.cls ?? '';
    this.text = options.text ?? '';
    this.attr = options.attr ?? {};
    this.ownerDocument = ownerDocument;
  }
  createEl(tag, options) {
    const child = new Element(tag, options, this.ownerDocument);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  value = '';
  setAttr(key, value) { this.attr[key] = value; }
  focus() {}
  hide() { this.hidden = true; }
  show() { this.hidden = false; }
  empty() { this.children.forEach(child => { child.parent = null; }); this.children = []; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  querySelectorAll(selector) {
    const cls = selector.slice(1);
    return this.children.flatMap(child => [
      ...(child.cls.split(' ').includes(cls) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, content, overrides = {}) {
  const timers = new Map();
  let timerId = 0;
  globalThis.window = {
    setInterval(fn) { timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  host.dailyAvailable = true;
  host.file = new host.TFile('daily/2026-11-11.md');
  host.notices = [];
  const doc = new EventTargetStub();
  doc.defaultView = new EventTargetStub();
  doc.visibilityState = 'visible';
  const parent = new Element('div', {}, doc);
  const settings = { todoEnabled: true, todoShowCompleted: false, todoIncludeTimelineTasks: false,
    todoStartHeading: '## Planning', todoEndHeading: '## Journal', targetHeading: 'Journal', headingLevel: 2,
    timestampPattern: '\\d{2}:\\d{2}', language: 'en', ...overrides };
  const state = { disk: content, reads: 0, processes: 0, editor: null, active: true, replacements: [] };
  const vault = new EventTargetStub();
  vault.cachedRead = async () => { state.reads++; return state.disk; };
  vault.process = async (_file, update) => {
    state.processes++;
    const next = update(state.disk);
    state.disk = next;
  };
  const workspace = new EventTargetStub();
  workspace.getActiveViewOfType = () => state.active && state.editor ? new host.MarkdownView(host.file, state.editor) : null;
  workspace.iterateAllLeaves = fn => {
    if (state.editor) fn({ view: new host.MarkdownView(host.file, state.editor) });
  };
  state.taskChanges = 0;
  state.preferenceSaves = 0;
  const component = new TodayTodos({ vault, workspace }, parent, () => settings, () => { state.taskChanges++; }, async () => {
    state.preferenceSaves++;
    if (state.savePreferences) await state.savePreferences();
  });
  t.after(() => component.unload());
  const boxes = () => parent.querySelectorAll('.jp-todo-checkbox');
  const root = () => parent.children[0];
  function openEditor(buffer) {
    state.buffer = buffer;
    state.editor = {
      getValue: () => state.buffer,
      offsetToPos(offset) {
        const before = state.buffer.slice(0, offset).split('\n');
        return { line: before.length - 1, ch: before.at(-1).length };
      },
      replaceRange(text, from, to) {
        const offset = pos => state.buffer.split('\n').slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
        const start = offset(from), end = offset(to ?? from);
        state.replacements.push({ text, start, end });
        state.buffer = state.buffer.slice(0, start) + text + state.buffer.slice(end);
      },
    };
  }
  return { component, parent, root, settings, state, vault, boxes, openEditor, timers };
}

const note = '## Planning\n- [ ] first\n- [x] finished\n## Journal\n- [ ] journal';

test('disabled module stays hidden without reading; enabling and disabling refreshes the component', async t => {
  const f = fixture(t, note, { todoEnabled: false });
  f.component.load();
  await settle();
  assert.equal(f.root().hidden, true);
  assert.equal(f.state.reads, 0);
  assert.equal(f.boxes().length, 0);
  f.settings.todoEnabled = true;
  f.component.refreshNow();
  await settle();
  assert.equal(f.root().hidden, false);
  assert.equal(f.boxes().length, 1);
  f.settings.todoEnabled = false;
  f.component.refreshNow();
  assert.equal(f.root().hidden, true);
  assert.equal(f.boxes().length, 0);
});

test('counts only unfinished tasks regardless of completed-task visibility', async t => {
  const f = fixture(t, note);
  f.component.load();
  await settle();
  assert.deepEqual(f.boxes().map(box => box.checked), [false]);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '1');
  f.settings.todoShowCompleted = true;
  f.component.refreshNow();
  await settle();
  assert.deepEqual(f.boxes().map(box => box.checked), [false, true]);
  assert.equal(f.parent.querySelectorAll('.is-done').length, 1);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '1');
});

test('counts unfinished tasks for empty and entirely unfinished lists', async t => {
  const f = fixture(t, '## Planning\n- [ ] first\n- [ ] second\n- [ ] third\n## Journal');
  f.component.load();
  await settle();
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '3');
  f.state.disk = '## Planning\n## Journal';
  f.component.refreshNow();
  await settle();
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '0');
});

test('closed daily note checkbox writes via vault.process against current disk content', async t => {
  const f = fixture(t, note);
  f.component.load();
  await settle();
  // A concurrent unrelated edit must survive the atomic update.
  f.state.disk = note + '\nnew unrelated text';
  const box = f.boxes()[0];
  box.checked = true;
  box.dispatch('change');
  await settle();
  assert.equal(f.state.processes, 1);
  assert.equal(f.state.disk, note.replace('- [ ] first', '- [x] first') + '\nnew unrelated text');
  assert.equal(f.boxes().length, 0);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '0');
  assert.equal(host.notices.length, 0);
});

for (const active of [true, false]) {
  test(`open ${active ? 'active' : 'background'} editor reads unsaved buffer and changes one character without disk writes`, async t => {
    const f = fixture(t, '## Planning\n- [ ] disk version\n## Journal');
    const buffer = '## Planning\r\n  2) [ ] unsaved [ ] text  \r\n## Journal\r\n';
    f.openEditor(buffer);
    f.state.active = active;
    f.component.load();
    await settle();
    assert.equal(f.state.reads, 0);
    assert.equal(f.boxes()[0].attr['aria-label'], 'unsaved [ ] text');
    f.boxes()[0].checked = true;
    f.boxes()[0].dispatch('change');
    await settle();
    assert.equal(f.state.buffer, buffer.replace('2) [ ]', '2) [x]'));
    assert.deepEqual(f.state.replacements, [{ text: 'x', start: buffer.indexOf('[ ]') + 1, end: buffer.indexOf('[ ]') + 2 }]);
    assert.equal(f.state.disk, '## Planning\n- [ ] disk version\n## Journal');
    assert.equal(f.state.processes, 0);
    assert.equal(f.state.reads, 0);
  });
}

for (const open of [false, true]) {
  test(`stale sourceLine refuses ${open ? 'editor' : 'disk'} changes and refreshes to current text`, async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture(t, note);
    if (open) f.openEditor(note);
    f.component.load();
    await settle();
    const box = f.boxes()[0];
    const changed = note.replace('first', 'concurrently changed');
    if (open) f.state.buffer = changed;
    else f.state.disk = changed;
    box.checked = true;
    box.dispatch('change');
    await settle();
    assert.equal(open ? f.state.buffer : f.state.disk, changed);
    assert.equal(f.state.replacements.length, 0);
    assert.equal(host.notices.length, 1);
    assert.equal(f.boxes()[0].attr['aria-label'], 'concurrently changed');
    assert.equal(f.boxes()[0].checked, false);
  });
}

test('a pending read cannot recreate content after component unload', async t => {
  const f = fixture(t, note);
  const read = deferred();
  f.vault.cachedRead = () => read.promise;
  f.component.load();
  assert.equal(f.parent.children.length, 1);
  f.component.unload();
  assert.equal(f.parent.children.length, 0);
  assert.equal(f.timers.size, 0);
  read.resolve(note);
  await settle();
  f.component.refreshNow();
  await settle();
  assert.equal(f.parent.children.length, 0);
  assert.equal(f.boxes().length, 0);
});

test('completion of an in-flight write after unload cannot revive the component', async t => {
  const f = fixture(t, note);
  const write = deferred();
  f.vault.process = async (_file, update) => {
    f.state.processes++;
    await write.promise;
    f.state.disk = update(f.state.disk);
  };
  f.component.load();
  await settle();
  f.boxes()[0].checked = true;
  f.boxes()[0].dispatch('change');
  assert.equal(f.state.processes, 1);
  f.component.unload();
  write.resolve();
  await settle();
  assert.equal(f.state.disk, note.replace('- [ ] first', '- [x] first'));
  assert.equal(f.parent.children.length, 0);
  assert.equal(f.boxes().length, 0);
  assert.equal(f.timers.size, 0);
});

test('adding a task writes the current disk and preserves the input across refresh', async t => {
  const f = fixture(t, note);
  f.component.load(); await settle();
  const input = f.parent.querySelectorAll('.jp-todo-add-input')[0];
  const form = f.parent.querySelectorAll('.jp-todo-add-form')[0];
  assert.equal(form.hidden, true);
  const toggle = f.parent.querySelectorAll('.jp-todo-add-toggle')[0];
  assert.equal(toggle.parent.cls, 'jp-todo-head-actions');
  toggle.dispatch('click');
  assert.equal(form.hidden, false);
  assert.equal(toggle.attr['aria-expanded'], 'true');
  input.value = 'new task';
  f.component.refreshNow(); await settle();
  assert.equal(f.parent.querySelectorAll('.jp-todo-add-input')[0], input);
  assert.equal(input.value, 'new task');
  f.parent.querySelectorAll('.jp-todo-add-form')[0].dispatch('submit');
  await settle();
  assert.equal(f.state.processes, 1);
  assert.ok(f.state.disk.includes('## Planning\n- [ ] new task\n'));
  assert.equal(input.value, '');
  assert.equal(form.hidden, true);
});

for (const active of [true, false]) {
  test(`adding a task uses the ${active ? 'active' : 'background'} editor buffer`, async t => {
    const f = fixture(t, note);
    f.openEditor(note + '\nunsaved'); f.state.active = active;
    f.component.load(); await settle();
    f.parent.querySelectorAll('.jp-todo-add-input')[0].value = 'live task';
    f.parent.querySelectorAll('.jp-todo-add-form')[0].dispatch('submit');
    await settle();
    assert.equal(f.state.processes, 0);
    assert.equal(f.state.disk, note);
    assert.ok(f.state.buffer.includes('- [ ] live task'));
    assert.ok(f.state.buffer.endsWith('unsaved'));
    assert.equal(f.state.replacements.length, 1);
  });
}

test('adding creates today note and planning heading when missing', async t => {
  const f = fixture(t, ''); host.file = null;
  f.component.load(); await settle();
  f.parent.querySelectorAll('.jp-todo-add-input')[0].value = 'first task';
  f.parent.querySelectorAll('.jp-todo-add-form')[0].dispatch('submit'); await settle();
  assert.ok(host.file);
  assert.ok(f.state.disk.includes('## Planning\n- [ ] first task'));
});

test('failed additions retain draft and blank submissions write nothing', async t => {
  const f = fixture(t, note);
  f.component.load(); await settle();
  const input = f.parent.querySelectorAll('.jp-todo-add-input')[0];
  input.value = '   ';
  f.parent.querySelectorAll('.jp-todo-add-form')[0].dispatch('submit'); await settle();
  assert.equal(f.state.processes, 0);
  f.settings.todoStartHeading = 'invalid'; input.value = 'keep draft';
  f.parent.querySelectorAll('.jp-todo-add-form')[0].dispatch('submit'); await settle();
  assert.equal(input.value, 'keep draft');
  assert.equal(f.state.processes, 0);
});

test('timeline inclusion refreshes immediately and completed visibility applies to both task sources', async t => {
  const source = '## Planning\n- [ ] plan\n- [x] finished plan\n## Journal\n- [ ] 08:00 journal\n- 09:00 [x] finished journal\n- 10:00 memo';
  const f = fixture(t, source);
  f.component.load(); await settle();
  assert.equal(f.boxes().length, 1);
  f.settings.todoIncludeTimelineTasks = true;
  f.component.refreshNow(); await settle();
  assert.deepEqual(f.boxes().map(box => box.attr['aria-label']), ['plan', 'journal']);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '2');
  assert.equal(f.parent.querySelectorAll('.jp-todo-source')[0].attr.title, 'Timeline · 08:00');
  assert.equal(f.parent.querySelectorAll('.jp-todo-source')[0].text, '');
  f.settings.todoShowCompleted = true;
  f.component.refreshNow(); await settle();
  assert.equal(f.boxes().length, 4);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '2');
  f.settings.todoIncludeTimelineTasks = false;
  f.component.refreshNow(); await settle();
  assert.equal(f.boxes().length, 2);
  assert.equal(f.state.disk, source);
});

for (const mode of ['disk', 'active editor', 'background editor']) {
  test(`journal checkbox updates the original ${mode}, hides completion and notifies timeline`, async t => {
    const disk = '## Journal\n- [ ] 08:00 disk task';
    const current = '## Planning\r\n- [ ] plan\r\n## Journal\r\n- 09:00 [ ] task\r\n  continuation\r\n- 10:00 memo [ ] untouched\r\n';
    const f = fixture(t, mode === 'disk' ? current : disk, { todoIncludeTimelineTasks: true });
    if (mode !== 'disk') { f.openEditor(current); f.state.active = mode === 'active editor'; }
    f.component.load(); await settle();
    const task = f.boxes().find(box => box.attr['aria-label'] === 'task\ncontinuation');
    assert.ok(task);
    task.checked = true; task.dispatch('change'); await settle();
    assert.equal(mode === 'disk' ? f.state.disk : f.state.buffer, current.replace('09:00 [ ]', '09:00 [x]'));
    assert.deepEqual(f.boxes().map(box => box.attr['aria-label']), ['plan']);
    assert.equal(f.state.taskChanges, 1);
    assert.equal(host.notices.length, 0);
    if (mode !== 'disk') {
      assert.equal(f.state.disk, disk);
      assert.equal(f.state.processes, 0);
      assert.equal(f.state.replacements.length, 1);
      assert.equal(f.state.replacements[0].text, 'x');
    }
    f.settings.todoShowCompleted = true;
    f.component.refreshNow(); await settle();
    const completed = f.boxes().find(box => box.attr['aria-label'] === 'task\ncontinuation');
    assert.equal(completed.checked, true);
    completed.checked = false; completed.dispatch('change'); await settle();
    assert.equal(mode === 'disk' ? f.state.disk : f.state.buffer, current);
    assert.equal(f.state.taskChanges, 2);
  });
}

test('a journal row rendered before disabling inclusion cannot update the source', async t => {
  t.mock.method(console, 'error', () => {});
  const source = '## Journal\n- [ ] 08:00 task';
  const f = fixture(t, source, { todoIncludeTimelineTasks: true });
  f.component.load(); await settle();
  const old = f.boxes()[0];
  f.settings.todoIncludeTimelineTasks = false;
  old.checked = true; old.dispatch('change'); await settle();
  assert.equal(f.state.disk, source);
  assert.equal(f.state.taskChanges, 0);
  assert.equal(host.notices.length, 1);
  assert.equal(f.boxes().length, 0);
});

test('eye shortcut persists the shared completed setting, restores hidden tasks and preserves the composer draft', async t => {
  const f = fixture(t, '## Planning\n- [x] finished\n## Journal\n- [x] 08:00 finished journal', { todoIncludeTimelineTasks: true });
  f.component.load(); await settle();
  assert.equal(f.boxes().length, 0);
  f.parent.querySelectorAll('.jp-todo-add-toggle')[0].dispatch('click');
  f.parent.querySelectorAll('.jp-todo-add-input')[0].value = 'unsaved draft';
  let eye = f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0];
  assert.equal(eye.attr['aria-pressed'], 'false');
  assert.equal(eye.attr.title, 'Show today’s completed tasks');
  eye.dispatch('click'); await settle();
  assert.equal(f.settings.todoShowCompleted, true);
  assert.equal(f.state.preferenceSaves, 1);
  assert.equal(f.boxes().length, 2);
  assert.equal(f.parent.querySelectorAll('.jp-todo-count')[0].text, '0');
  assert.equal(f.parent.querySelectorAll('.jp-todo-add-input')[0].value, 'unsaved draft');
  assert.equal(f.parent.querySelectorAll('.jp-todo-add-form')[0].hidden, false);
  eye = f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0];
  assert.equal(eye.disabled, false);
  assert.equal(eye.attr['aria-pressed'], 'true');
  eye.dispatch('click'); await settle();
  assert.equal(f.settings.todoShowCompleted, false);
  assert.equal(f.state.preferenceSaves, 2);
  assert.equal(f.boxes().length, 0);
  assert.equal(f.state.processes, 0);
});

test('a failed eye setting save restores visibility and remains retryable', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t, '## Planning\n- [x] finished\n## Journal');
  f.state.savePreferences = async () => { throw new Error('disk unavailable'); };
  f.component.load(); await settle();
  f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0].dispatch('click'); await settle();
  assert.equal(f.settings.todoShowCompleted, false);
  assert.equal(f.boxes().length, 0);
  assert.equal(host.notices.length, 1);
  assert.equal(f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0].disabled, false);
  f.state.savePreferences = async () => {};
  f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0].dispatch('click'); await settle();
  assert.equal(f.settings.todoShowCompleted, true);
  assert.equal(f.boxes().length, 1);
});

test('eye shortcut ignores repeated clicks while saving', async t => {
  const f = fixture(t, note);
  const saving = deferred();
  f.state.savePreferences = () => saving.promise;
  f.component.load(); await settle();
  const eye = f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0];
  eye.dispatch('click'); eye.dispatch('click'); await settle();
  assert.equal(f.state.preferenceSaves, 1);
  assert.equal(f.settings.todoShowCompleted, true);
  assert.equal(f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0].disabled, true);
  saving.resolve(); await settle();
  assert.equal(f.parent.querySelectorAll('.jp-todo-visibility-toggle')[0].disabled, false);
});

test('an older pending refresh cannot replace the latest settings render', async t => {
  const f = fixture(t, note);
  const read = deferred();
  f.vault.cachedRead = () => read.promise;
  f.component.load();
  f.settings.todoEnabled = false;
  f.component.refreshNow();
  read.resolve(note);
  await settle();
  assert.equal(f.root().hidden, true);
  assert.equal(f.boxes().length, 0);
});
