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
  dispatch(name) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this }); }
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
  const settings = { todoEnabled: true, todoShowCompleted: false, todoStartHeading: '## Planning', todoEndHeading: '## Journal', language: 'en', ...overrides };
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
  const component = new TodayTodos({ vault, workspace }, parent, () => settings);
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
        const start = offset(from), end = offset(to);
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
