import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise real main.onload(), loadSettings(), activateCaptureView(), and the
// startup lifecycle. Only host registration and the capture UI are replaced.
class Plugin {
  cleanups = [];
  views = new Map();
  constructor(app) { this.app = app; }
  async loadData() { return this.app.saved; }
  register(cleanup) { this.cleanups.push(cleanup); }
  unload() { for (const cleanup of this.cleanups) cleanup(); }
  registerView(type, factory) { this.views.set(type, factory); }
  registerEditorExtension() {}
  registerEditorSuggest() {}
  registerMarkdownPostProcessor() {}
  registerDomEvent() {}
  addSettingTab() {}
  addCommand() {}
  addRibbonIcon() {}
  registerObsidianProtocolHandler() {}
}
class CaptureView {
  focusRequests = [];
  draft = { text: 'unsaved capture draft' };
  constructor(leaf, plugin) { this.leaf = leaf; this.plugin = plugin; }
  focusInputOnOpen(request) { this.focusRequests.push(request); }
}
const host = globalThis.__jpStartupViewTest = {
  Plugin,
  CaptureView,
  Platform: { isMobile: false },
  Base: class {},
};
globalThis.window ??= {};

const { outputFiles } = await build({
  entryPoints: [new URL('../src/main.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{
    name: 'startup-host',
    setup(build) {
      build.onResolve({ filter: /^(obsidian|obsidian-daily-notes-interface|\.\/capture-view|\.\/mention-suggest)$/ }, args => ({
        path: args.path, namespace: 'startup-host',
      }));
      build.onLoad({ filter: /.*/, namespace: 'startup-host' }, args => {
        if (args.path === './capture-view') return { contents: `
          export const CAPTURE_VIEW_TYPE = 'journal-partner-capture';
          export const JournalCaptureView = globalThis.__jpStartupViewTest.CaptureView;
        ` };
        if (args.path === './mention-suggest') return { contents: 'export class MentionSuggest {}' };
        if (args.path === 'obsidian-daily-notes-interface') return { contents: `
          export const appHasDailyNotesPluginLoaded = () => false;
          export const createDailyNote = () => {};
          export const getAllDailyNotes = () => ({});
          export const getDailyNote = () => undefined;
        ` };
        return { contents: `
          const host = globalThis.__jpStartupViewTest;
          export const Plugin = host.Plugin;
          export const Platform = host.Platform;
          export const PluginSettingTab = host.Base;
          export const FuzzySuggestModal = host.Base;
          export const App = host.Base, ButtonComponent = host.Base,
            DropdownComponent = host.Base, ExtraButtonComponent = host.Base,
            MarkdownView = host.Base, Notice = host.Base, Setting = host.Base,
            TFile = host.Base, TFolder = host.Base, TextComponent = host.Base;
          export const moment = () => {}, setIcon = () => {}, requestUrl = () => {};
        ` };
      });
    },
  }],
});
const { default: JournalPartnerPlugin } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

async function setup({ saved, restored = false, dock = 'editor', mobile = false } = {}) {
  host.Platform.isMobile = mobile;
  const state = { ready: [], leaves: [], revealed: [], rightRequests: 0, editorRequests: 0, setStates: [], detached: [] };
  const rightSplit = {};
  let plugin;
  const makeLeaf = parent => {
    const leaf = {
      parent,
      detach() { state.detached.push(leaf); },
      async setViewState(viewState) {
        state.setStates.push(viewState);
        leaf.view = plugin.views.get(viewState.type)(leaf);
        state.leaves.push(leaf);
      },
    };
    return leaf;
  };
  const workspace = {
    rightSplit,
    onLayoutReady(callback) { state.ready.push(callback); },
    getLeavesOfType(type) {
      assert.equal(type, 'journal-partner-capture');
      return state.leaves;
    },
    async revealLeaf(leaf) { state.revealed.push(leaf); },
    getRightLeaf(split) { assert.equal(split, false); state.rightRequests++; return makeLeaf(rightSplit); },
    getLeaf(newLeaf) { assert.equal(newLeaf, true); state.editorRequests++; return makeLeaf({}); },
  };
  plugin = new JournalPartnerPlugin({ workspace, saved });
  // Avoid CSS and CodeMirror rendering; the startup paths remain real.
  plugin.applyCSSVariables = () => {};
  plugin.createEditorExtensions = () => [];
  let restoredView;
  if (restored) {
    const leaf = makeLeaf(dock === 'right' ? rightSplit : {});
    restoredView = leaf.view = new CaptureView(leaf, plugin);
    state.leaves.push(leaf);
  }
  await plugin.onload();
  const ready = async () => {
    for (const callback of state.ready) callback();
    // Layout callbacks intentionally return void; flush reveal/setViewState and
    // the startup helper's promise rejection handler without wall-clock waits.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { plugin, state, restoredView, ready };
}

test('real plugin onload registers a layout callback and defaults startup to disabled', async () => {
  const { plugin, state, ready } = await setup();
  assert.equal(plugin.settings.openOnStartup, false);
  assert.equal(state.ready.length, 1);
  assert.equal(state.leaves.length, 0);
  await ready();
  assert.equal(state.leaves.length, 0);
  assert.equal(state.rightRequests + state.editorRequests, 0);
  assert.deepEqual(state.revealed, []);
});

for (const [dock, mobile, mobileOpenInSidebar] of [
  ['editor', false, false], ['right', false, false],
  ['editor', true, true], ['right', true, false],
]) {
  test(`startup preserves restored ${dock} view and draft (mobile=${mobile}, sidebar=${mobileOpenInSidebar})`, async () => {
    const { state, restoredView, ready } = await setup({
      restored: true, dock, mobile, saved: { openOnStartup: true, mobileOpenInSidebar },
    });
    const draft = restoredView.draft;
    const leaf = state.leaves[0];
    assert.deepEqual(state.revealed, []);
    assert.deepEqual(restoredView.focusRequests, []);
    await ready();
    await ready();
    assert.deepEqual(state.revealed, [leaf]);
    assert.deepEqual(restoredView.focusRequests, [true]);
    assert.equal(leaf.view, restoredView);
    assert.equal(leaf.view.draft, draft);
    assert.equal(draft.text, 'unsaved capture draft');
    assert.deepEqual(state.detached, []);
    assert.deepEqual(state.setStates, []);
    assert.equal(state.rightRequests + state.editorRequests, 0);
    assert.equal(state.leaves.length, 1);
  });
}

for (const mobile of [false, true]) {
  test(`startup creates exactly one capture leaf across repeated ready notifications (mobile=${mobile})`, async () => {
    const { plugin, state, ready } = await setup({ mobile, saved: { openOnStartup: true, mobileOpenInSidebar: false } });
    assert.equal(state.leaves.length, 0);
    // Fire twice before asynchronous leaf setup completes, then once afterwards.
    state.ready[0]();
    await ready();
    await ready();
    assert.equal(state.leaves.length, 1);
    assert.equal(state.rightRequests, mobile ? 0 : 1);
    assert.equal(state.editorRequests, mobile ? 1 : 0);
    assert.deepEqual(state.setStates, [{ type: 'journal-partner-capture', active: true }]);
    const leaf = state.leaves[0];
    assert.equal(leaf.view.plugin, plugin);
    assert.deepEqual(state.revealed, [leaf]);
    assert.deepEqual(leaf.view.focusRequests, [true]);
    assert.deepEqual(state.detached, []);
  });
}

test('unloading the real plugin before layout ready prevents view creation and reveal', async () => {
  const { plugin, state, ready } = await setup({ saved: { openOnStartup: true } });
  plugin.unload();
  await ready();
  assert.equal(state.leaves.length, 0);
  assert.equal(state.rightRequests + state.editorRequests, 0);
  assert.deepEqual(state.revealed, []);
});
