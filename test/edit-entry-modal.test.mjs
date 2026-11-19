import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Keep the draft, tag parsing, and translations real; replace Obsidian's host
// lifecycle and the CodeMirror input at their runtime boundaries.
class Element {
  children = [];
  listeners = new Map();
  disabled = false;
  value = '';
  constructor(tag = 'div', options = {}) {
    this.tag = tag;
    this.cls = options.cls ?? '';
    this.text = options.text ?? '';
    this.attr = options.attr ?? {};
  }
  createEl(tag, options) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addClass(cls) { this.cls += ` ${cls}`; }
  setText(text) { this.text = text; }
  setAttr(name, value) { this.attr[name] = value; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  hide() { this.hidden = true; }
  show() { this.hidden = false; }
  empty() { this.children = []; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener));
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  find(predicate) {
    return this.children.flatMap(child => [
      ...(predicate(child) ? [child] : []), ...child.find(predicate),
    ]);
  }
  byClass(cls) { return this.find(el => el.cls.split(' ').includes(cls)); }
}

class Component {
  children = new Set();
  cleanups = [];
  loaded = false;
  unloads = 0;
  load() { this.loaded = true; }
  unload() {
    this.unloads++;
    this.loaded = false;
    for (const child of this.children) child.unload();
    for (const cleanup of this.cleanups) cleanup();
  }
  addChild(child) {
    this.children.add(child);
    if (this.loaded) child.load();
    return child;
  }
  removeChild(child) {
    this.children.delete(child);
    child.unload();
    return child;
  }
  registerDomEvent(el, name, listener) {
    el.addEventListener(name, listener);
    this.cleanups.push(() => el.removeEventListener(name, listener));
  }
}
class Modal {
  modalEl = new Element();
  contentEl = new Element();
  titleEl = new Element();
  isOpen = false;
  constructor(app) { this.app = app; }
  open() { this.isOpen = true; this.onOpen(); }
  close() { this.isOpen = false; this.onClose(); }
}
const host = globalThis.__jpEditEntryModalTest = {
  Modal, Component,
  Notice: class { constructor(message) { host.notices.push(message); } },
  createCaptureInput(app, container, owner, options) {
    const textarea = container.createEl('textarea');
    const input = {
      app, container, owner, options, textarea, destroyed: 0,
      getValue: () => textarea.value,
      setValue: value => { textarea.value = value; },
      focus() {},
      getSelection: () => ({ from: 0, to: 0 }),
      replaceRange(text, from, to) {
        textarea.value = textarea.value.slice(0, from) + text + textarea.value.slice(to);
        options.onChange();
      },
      destroy() { input.destroyed++; },
    };
    textarea.addEventListener('input', () => options.onChange());
    host.inputs.push(input);
    return input;
  },
};
const { outputFiles } = await build({
  entryPoints: [new URL('../src/edit-entry-modal.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{
    name: 'modal-host',
    setup(build) {
      build.onResolve({ filter: /^obsidian$|^\.\/capture-input$/ }, args => ({
        path: args.path, namespace: 'modal-host',
      }));
      build.onLoad({ filter: /.*/, namespace: 'modal-host' }, args => ({
        contents: args.path === 'obsidian'
          ? 'export const { Modal, Component, Notice } = globalThis.__jpEditEntryModalTest; export const setIcon = () => {};'
          : 'export const { createCaptureInput } = globalThis.__jpEditEntryModalTest;',
        loader: 'js',
      }));
    },
  }],
});
const { EditEntryModal } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

function openModal(t, text, onSave = async () => {}, presets) {
  host.inputs = [];
  host.notices = [];
  const app = { workspace: { openLinkText() {} } };
  const args = [app, { timestamp: '09:42', text }, 'Journal/2026-11-11.md', onSave];
  if (presets !== undefined) args.push(presets);
  const modal = new EditEntryModal(...args);
  modal.open();
  const input = host.inputs[0];
  t.after(() => { if (modal.isOpen) modal.close(); });
  return {
    modal, input,
    save: modal.contentEl.find(el => el.tag === 'button' && el.text === 'Save')[0],
    cancel: modal.contentEl.find(el => el.tag === 'button' && el.text === 'Cancel')[0],
  };
}
const settleSave = () => new Promise(resolve => setImmediate(resolve));
const chipTexts = modal => modal.contentEl.byClass('jp-tag-chip-text').map(el => el.text);

test('leading tags become chips while body and original separators survive an unchanged save', async t => {
  const body = '  Read #inline\n```md\n#inside-code\n```\n  trailing spaces  \n';
  const original = ` \t#reading\t#中文 ${body}`;
  const saved = [];
  const { modal, input, save } = openModal(t, original, async text => { saved.push(text); });
  assert.deepEqual(chipTexts(modal), ['#reading', '#中文']);
  assert.equal(input.getValue(), body);
  assert.equal(modal.titleEl.text, 'Edit 09:42');
  save.click();
  await settleSave();
  assert.deepEqual(saved, [original]);
  assert.equal(modal.isOpen, false);
});

test('one source-aware CaptureInput preserves body embeds through editing and save', async t => {
  const body = '![[photo #1.png|300]]\n![image](images/picture.png)\n![[recording.webm]]\n';
  const saved = [];
  const { modal, input, save } = openModal(t, `#media ${body}`, async text => { saved.push(text); });
  assert.equal(host.inputs.length, 1);
  assert.equal(input.app, modal.app);
  assert.equal(input.options.sourcePath, 'Journal/2026-11-11.md');
  assert.equal(input.owner.loaded, true);
  assert.equal(input.getValue(), body);
  assert.equal(modal.contentEl.find(el => el.cls.split(' ').some(cls => cls.startsWith('jp-edit-preview'))).length, 0);
  input.textarea.value = body + '\nUpdated #inline';
  input.textarea.dispatch('input');
  save.click();
  await settleSave();
  assert.deepEqual(saved, [`#media ${body}\nUpdated #inline`]);
  assert.equal(input.destroyed, 1);
  assert.equal(input.owner.unloads, 1);
});

const pickerOptions = modal => modal.contentEl.byClass('jp-tag-picker-item');
const optionText = option => option.byClass('jp-tag-picker-item-text')[0].text;
const pickerOption = (modal, tag) => pickerOptions(modal).find(option => optionText(option) === tag);
const isSelected = option => option.cls.split(' ').includes('is-selected');

test('picker and chip removal change saved tags while retaining body Markdown verbatim', async t => {
  const body = '  Body #inline\n  ![[clip.webm]]  \n';
  const saved = [];
  const { modal, input, save } = openModal(t, `#old #keep ${body}`, async text => { saved.push(text); }, ['new/topic']);
  const toggle = modal.contentEl.byClass('jp-edit-tag-toggle')[0];
  const panel = modal.contentEl.byClass('jp-tag-picker')[0];
  modal.contentEl.byClass('jp-tag-chip-remove')[0].click();
  toggle.click();
  assert.equal(isSelected(pickerOption(modal, '#old')), false);
  pickerOption(modal, '#new/topic').click();
  assert.deepEqual(chipTexts(modal), ['#keep', '#new/topic']);
  assert.equal(isSelected(pickerOption(modal, '#new/topic')), true);
  pickerOption(modal, '#keep').click();
  assert.deepEqual(chipTexts(modal), ['#new/topic']);
  assert.equal(isSelected(pickerOption(modal, '#keep')), false);
  pickerOption(modal, '#keep').click();
  assert.deepEqual(chipTexts(modal), ['#new/topic', '#keep']);
  modal.contentEl.byClass('jp-tag-chip-remove')[0].click();
  assert.equal(isSelected(pickerOption(modal, '#new/topic')), false);
  assert.equal(panel.hidden, false);
  assert.equal(input.getValue(), body);
  save.click();
  await settleSave();
  assert.deepEqual(saved, [`#keep ${body}`]);
});

test('toolbar opens the capture tag picker with canonical ordered choices and persistent multiselect', async t => {
  const saved = [];
  const { modal, save } = openModal(t, '#work #entry/topic Body', async text => { saved.push(text); }, [
    ' reading ', '#work', '##reading', '中文', '#中文', '', 'invalid tag',
  ]);
  const toolbar = modal.contentEl.byClass('jp-edit-toolbar')[0];
  const toggle = toolbar.byClass('jp-edit-tag-toggle')[0];
  const panel = modal.contentEl.byClass('jp-tag-picker')[0];
  assert.equal(toggle.tag, 'button');
  assert.equal(toggle.attr.type, 'button');
  assert.ok(toggle.cls.split(' ').includes('clickable-icon'));
  assert.equal(toggle.attr['aria-expanded'], 'false');
  assert.equal(panel.hidden, true);
  assert.equal(modal.contentEl.byClass('jp-edit-tag-form').length, 0);
  assert.equal(modal.contentEl.find(el => el.tag === 'input').length, 0);
  assert.equal(modal.contentEl.find(el => el.cls.split(' ').some(cls => cls.startsWith('jp-edit-tag-tone-'))).length, 0);
  assert.equal(modal.contentEl.byClass('jp-tag-chip').length, 2);
  toggle.click();
  assert.equal(toggle.attr['aria-expanded'], 'true');
  assert.equal(panel.hidden, false);
  const header = panel.byClass('jp-tag-picker-header')[0];
  assert.ok(header.byClass('jp-tag-picker-title')[0].text);
  const close = header.byClass('jp-tag-picker-close')[0];
  assert.equal(close.tag, 'button');
  assert.deepEqual(pickerOptions(modal).map(optionText), ['#reading', '#work', '#中文', '#entry/topic']);
  for (const option of pickerOptions(modal)) {
    assert.equal(option.tag, 'button');
    assert.equal(option.attr.type, 'button');
    assert.equal(option.byClass('jp-tag-picker-item-text')[0].tag, 'span');
  }
  assert.deepEqual(pickerOptions(modal).filter(isSelected).map(optionText), ['#work', '#entry/topic']);
  pickerOption(modal, '#reading').click();
  assert.deepEqual(chipTexts(modal), ['#work', '#entry/topic', '#reading']);
  assert.equal(isSelected(pickerOption(modal, '#reading')), true);
  assert.equal(panel.hidden, false);
  assert.equal(toggle.attr['aria-expanded'], 'true');
  pickerOption(modal, '#work').click();
  assert.deepEqual(chipTexts(modal), ['#entry/topic', '#reading']);
  assert.equal(isSelected(pickerOption(modal, '#work')), false);
  assert.equal(panel.hidden, false);
  close.click();
  assert.equal(panel.hidden, true);
  assert.equal(toggle.attr['aria-expanded'], 'false');
  toggle.click();
  assert.equal(panel.hidden, false);
  assert.deepEqual(pickerOptions(modal).filter(isSelected).map(optionText), ['#reading', '#entry/topic']);
  toggle.click();
  assert.equal(panel.hidden, true);
  assert.equal(toggle.attr['aria-expanded'], 'false');
  save.click();
  await settleSave();
  assert.deepEqual(saved, ['#entry/topic #reading Body']);
});

test('picker stays open for clicks inside its panel or toolbar toggle and closes for outside clicks', t => {
  const { modal, input } = openModal(t, '#work Body', undefined, ['reading']);
  const toggle = modal.contentEl.byClass('jp-edit-tag-toggle')[0];
  const panel = modal.contentEl.byClass('jp-tag-picker')[0];
  toggle.click();
  modal.contentEl.dispatch('click', { target: toggle });
  assert.equal(panel.hidden, false);
  modal.contentEl.dispatch('click', { target: pickerOption(modal, '#reading').byClass('jp-tag-picker-item-text')[0] });
  assert.equal(panel.hidden, false);
  modal.contentEl.dispatch('click', { target: input.textarea });
  assert.equal(panel.hidden, true);
  assert.equal(toggle.attr['aria-expanded'], 'false');
});

test('a rejected save reports the error, keeps the draft open, and allows a successful retry', async t => {
  const saved = [];
  let rejectSave;
  const { modal, input, save, cancel } = openModal(t, '#work Body', text => {
    saved.push(text);
    if (saved.length === 1) return new Promise((resolve, reject) => { rejectSave = reject; });
    return Promise.resolve();
  });
  input.textarea.value = 'Edited ![[image.png]]';
  save.click();
  assert.equal(save.disabled, true);
  assert.equal(cancel.disabled, true);
  save.click();
  assert.equal(saved.length, 1);
  rejectSave(new Error('Vault is read-only'));
  await settleSave();
  assert.deepEqual(host.notices, ['Save failed: Vault is read-only']);
  assert.equal(modal.isOpen, true);
  assert.equal(input.getValue(), 'Edited ![[image.png]]');
  assert.equal(input.destroyed, 0);
  assert.equal(save.disabled, false);
  assert.equal(cancel.disabled, false);
  save.click();
  await settleSave();
  assert.deepEqual(saved, ['#work Edited ![[image.png]]', '#work Edited ![[image.png]]']);
  assert.equal(modal.isOpen, false);
});

test('cancel never saves and closing destroys input, unloads owner and removes keyboard listeners', t => {
  const saved = [];
  const { modal, input, cancel } = openModal(t, '#work Body', async text => { saved.push(text); });
  input.textarea.value = 'Unsaved changes';
  input.textarea.dispatch('input');
  cancel.click();
  assert.deepEqual(saved, []);
  assert.equal(modal.isOpen, false);
  assert.equal(input.destroyed, 1);
  assert.equal(input.owner.loaded, false);
  assert.equal(input.owner.unloads, 1);
  assert.equal(modal.contentEl.children.length, 0);
  assert.equal(input.container.listeners.get('keydown').length, 0);
});
