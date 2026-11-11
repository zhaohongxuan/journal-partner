import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment';

const host = globalThis.__jpSidePanelTest = { moment };
const outfile = path.join(tmpdir(), `jp-side-panel-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/side-panel.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{
    name: 'mock-obsidian',
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
      build.onLoad({ filter: /.*/, namespace: 'host' }, () => ({
        contents: 'export const moment = globalThis.__jpSidePanelTest.moment; export const setIcon = () => {};',
        loader: 'js',
      }));
    },
  }],
});
const { renderSidePanel } = await import(pathToFileURL(outfile).href);

class Element {
  children = [];
  listeners = new Map();
  disabled = false;
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
  empty() { this.children = []; }
  addClass(cls) { this.cls += ` ${cls}`; }
  setAttr(key, value) { this.attr[key] = value; }
  addEventListener(event, fn) { this.listeners.set(event, fn); }
  click() { if (!this.disabled) this.listeners.get('click')?.({ stopPropagation() {} }); }
  find(cls) {
    return this.children.flatMap(child => [
      ...(child.cls.split(' ').includes(cls) ? [child] : []), ...child.find(cls),
    ]);
  }
}

function render(t, date, overrides = {}) {
  const previousNow = moment.now;
  moment.now = () => new Date(`${date}T12:00:00`).valueOf();
  t.after(() => { moment.now = previousNow; });
  const calls = [];
  const root = new Element();
  renderSidePanel(root, {
    allTime: null, yearStats: new Map(), favorites: [], random: null, loading: false, ...overrides,
  }, {
    openStats: () => calls.push('stats'),
    openFavorites: () => calls.push('favorites'),
    openReview: () => calls.push('review'),
    openDate: date => calls.push(date.format('YYYY-MM-DD')),
    reroll: () => calls.push('reroll'),
  });
  return { root, calls };
}

function stats(entries) {
  const years = new Map();
  for (const [key, entryCount] of entries) {
    const year = Number(key.slice(0, 4));
    if (!years.has(year)) years.set(year, { year, dailyMap: new Map() });
    years.get(year).dailyMap.set(key, { key, entryCount });
  }
  return years;
}

test('contribution grid has 20 week columns of 7 days and future padding', t => {
  const { root, calls } = render(t, '2026-11-11', { loading: true });
  const grid = root.find('jp-side-recent-grid')[0];
  const days = root.find('jp-side-recent-day');
  const start = moment('2026-11-11').isoWeekday(1).subtract(19, 'weeks');
  assert.equal(grid.children.length, 140);
  assert.equal(days.length, 136);
  assert.equal(root.find('jp-side-recent-padding').length, 4);
  assert.equal(start.isoWeekday(), 1);
  assert.deepEqual(days.map(day => day.attr.title.split(':')[0]),
    Array.from({ length: 136 }, (_, i) => start.clone().add(i, 'days').format('YYYY-MM-DD')));
  assert.equal(days.at(-1).attr['aria-current'], 'date');
  assert.ok(days.every(day => day.cls.includes('level-0')));
  days[0].click(); days.at(-1).click();
  assert.deepEqual(calls, [start.format('YYYY-MM-DD'), '2026-11-11']);
});

test('contribution summary spans years and excludes outside dates', t => {
  const start = moment('2027-01-10').isoWeekday(1).subtract(19, 'weeks');
  const { root } = render(t, '2027-01-10', {
    yearStats: stats([[start.clone().subtract(1, 'day').format('YYYY-MM-DD'), 50],
      [start.format('YYYY-MM-DD'), 1], ['2026-12-31', 3], ['2027-01-10', 8], ['2027-01-11', 25]]),
  });
  const days = root.find('jp-side-recent-day');
  assert.equal(days.length, 140);
  assert.deepEqual(root.find('jp-side-num-value').map(el => el.text), ['12', '3']);
  assert.ok(days[0].cls.includes('level-1'));
  assert.ok(days.at(-1).cls.includes('level-4'));
  assert.deepEqual(root.find('jp-side-recent-range')[0].children.map(el => el.text),
    [start.format('YYYY-MM-DD'), '2027-01-10']);
});

test('contribution grid includes leap day once with correct count', t => {
  const { root, calls } = render(t, '2024-03-01', {yearStats: stats([['2024-02-29', 6]])});
  const leap = root.find('jp-side-recent-day').filter(day => day.attr.title.startsWith('2024-02-29:'));
  assert.equal(leap.length, 1);
  assert.equal(leap[0].attr.title, '2024-02-29: 6 entries');
  leap[0].click();
  assert.deepEqual(calls, ['2024-02-29']);
  assert.deepEqual(root.find('jp-side-num-value').map(el => el.text), ['6', '1']);
});

test('review remains accessible without a random entry and favorites still open', t => {
  const { root, calls } = render(t, '2026-11-11', {
    favorites: [{ date: '2026-10-02', timestamp: '09:00', text: 'Saved note' }],
  });
  root.find('jp-side-card-more')[2].click();
  root.find('jp-side-card-more')[1].click();
  root.find('jp-side-fav')[0].click();
  assert.deepEqual(calls, ['review', 'favorites', '2026-10-02']);
});

test('random note retains date opening, reroll, and review actions', t => {
  const { root, calls } = render(t, '2026-11-11', {
    random: { date: moment('2026-10-03'), entry: { timestamp: '10:00', text: 'Random note' } },
  });
  root.find('jp-side-random')[0].click();
  root.find('jp-side-reroll')[0].click();
  root.find('jp-side-card-more')[2].click();
  assert.deepEqual(calls, ['2026-10-03', 'reroll', 'review']);
});
