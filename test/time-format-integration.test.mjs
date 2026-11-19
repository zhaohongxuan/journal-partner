import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outfile = path.join(tmpdir(), `jp-time-integration-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export * from './src/section'; export * from './src/stats'; export * from './src/time-format';`,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const S = await import(pathToFileURL(outfile).href);
const settings = {
  ...S.DEFAULT_SETTINGS,
  timestampFormat: 'hh:mm A',
  timestampFormatHistory: ['HH时mm分 [记录]', 'HH:mm:ss'],
  // Captures in a manual pattern must not shift entry body or checkbox groups.
  timestampPattern: '(\\d{2}):(\\d{2})|手写(早|晚)',
};
const pattern = S.getTimestampPattern(settings);
const body = [
  '- 08:10 old',
  '- [ ] 01:05 PM current ![[voice.m4a]]',
  '  child line',
  '* 09时02分 记录 [x] legacy ![[picture.png]]',
  '+ 手写早 manual',
].join('\n');
const doc = `## Before\n- 08:10 outside\n## Journal\n${body}\n## After\n- 01:05 PM outside\n`;
const formats = S.getTimestampFormats(settings);

test('timestamp insertion retains the legacy default and supports explicit local dates', () => {
  const date = new Date(2026, 0, 2, 13, 5, 9);
  assert.equal(S.generateTimestamp(undefined, date), '13:05');
  assert.equal(S.generateTimestamp(settings.timestampFormat, date), '01:05 PM');
  assert.equal(S.generateTimestamp('HH时mm分 [记录]', date), '13时05分 记录');
  assert.equal(S.DEFAULT_SETTINGS.openOnStartup, false);
});

test('mixed formats sort chronologically including seconds, midnight, noon and source ties', () => {
  const entries = S.parseJournalEntries([
    '- 12:00 PM noon',
    '- 08:10:30 seconds',
    '- 12:00 AM midnight',
    '- 09时02分 记录 chinese',
    '- 08:10 legacy',
    '- 08:10 AM same minute',
    '- 01:05 PM afternoon',
  ].join('\n'), pattern);
  const asc = S.sortJournalEntries(entries, 'asc', formats);
  assert.deepEqual(asc.map(e => e.text), ['midnight', 'legacy', 'same minute', 'seconds', 'chinese', 'noon', 'afternoon']);
  assert.deepEqual(S.sortJournalEntries(entries, 'desc', formats), [...asc].reverse());
  assert.deepEqual(entries.map(e => e.lineIndex), [0, 1, 2, 3, 4, 5, 6]);
});

test('unknown manual timestamps have deterministic lexical and source-index fallback', () => {
  const entries = [
    { timestamp: 'zebra', lineIndex: 0 },
    { timestamp: 'alpha', lineIndex: 2 },
    { timestamp: '08:00', lineIndex: 3 },
    { timestamp: 'alpha', lineIndex: 1 },
  ];
  const asc = S.sortJournalEntries(entries, 'asc', formats);
  assert.deepEqual(asc.map(e => e.lineIndex), [3, 1, 2, 0]);
  assert.deepEqual(S.sortJournalEntries(entries, 'desc', formats), [...asc].reverse());
});

test('readonly ranges and decorations cover full mixed timestamps only within the journal', () => {
  const ranges = S.getTimestampRanges(doc, settings);
  assert.deepEqual(ranges.map(({ from, to }) => doc.slice(from, to)), [
    '08:10', '01:05 PM', '09时02分 记录', '手写早',
  ]);
  const decorations = [];
  S.buildDecorations(doc, settings).between(0, doc.length, (from, to, mark) => {
    decorations.push({ from, to });
    assert.equal(mark.spec.class, 'jp-timestamp');
  });
  assert.deepEqual(decorations, ranges);
  const partialSettings = { targetHeading: 'Journal', headingLevel: 2, timestampPattern: '\\d{2}:\\d{2}' };
  assert.deepEqual(S.getTimestampRanges('## Journal\n- 08:10 old', partialSettings).map(r => r.to - r.from), [5]);
});

test('editing, toggling, deleting and audio removal preserve mixed timestamp heads', () => {
  const entries = S.parseJournalEntries(body, pattern);
  const current = entries.find(e => e.timestamp === '01:05 PM').lineIndex;
  const legacy = entries.find(e => e.timestamp === '09时02分 记录').lineIndex;
  const manual = entries.find(e => e.timestamp === '手写早').lineIndex;
  assert.ok(S.editEntryInSection(doc, settings, current, 'edited').includes('- [ ] 01:05 PM edited\n'));
  assert.ok(S.editEntryInSection(doc, settings, legacy, 'edited').includes('* 09时02分 记录 [x] edited\n'));
  assert.ok(S.editEntryInSection(doc, settings, manual, 'edited').includes('+ 手写早 edited\n'));
  assert.ok(S.toggleTaskInSection(doc, settings, current, true).includes('- [x] 01:05 PM current ![[voice.m4a]]\n  child line'));
  assert.ok(S.toggleTaskInSection(doc, settings, legacy, false).includes('* 09时02分 记录 [ ] legacy ![[picture.png]]'));
  const removed = S.removeAudioEmbedsFromEntry(doc, settings, current);
  assert.ok(removed.includes('- [ ] 01:05 PM current\n  child line'));
  assert.ok(!removed.includes('voice.m4a'));
  const deleted = S.deleteEntryFromSection(doc, settings, current);
  assert.ok(!deleted.includes('current ![['));
  assert.ok(!deleted.includes('child line'));
  assert.ok(deleted.includes('* 09时02分 记录 [x] legacy'));
  assert.ok(deleted.includes('## After\n- 01:05 PM outside'));
});

test('audio removal preserves literal whitespace within a timestamp', () => {
  const spaced = { ...settings, timestampFormat: 'HH:mm [ 记录]' };
  const original = '## Journal\n- 13:05  记录 body ![[voice.m4a]]\n';
  assert.equal(S.removeAudioEmbedsFromEntry(original, spaced, 0), '## Journal\n- 13:05  记录 body\n');
});

test('hour histograms share the effective pattern and count each line once across formats', () => {
  const text = [
    '- 01:05 PM first mentions 18:00',
    '- [x] 13:12:30 seconds',
    '13时22分 记录 paragraph',
    '- 12:00 AM midnight',
    '- 12:00 PM noon',
    '- 08:10 old',
    '- 手写早 unknown',
  ].join('\r\n');
  const histogram = Array(24).fill(0);
  S.accumulateHourHistogram(text, pattern, histogram, formats);
  assert.equal(histogram[13], 3);
  assert.equal(histogram[0], 1);
  assert.equal(histogram[12], 1);
  assert.equal(histogram[8], 1);
  assert.equal(histogram[18], 0);
  assert.equal(histogram.reduce((sum, count) => sum + count, 0), 6);
  assert.equal(S.computeYearStats(2026, [{ key: '2026-01-02', sectionText: text }], pattern, formats).mostCommonHour, '13:00');
  assert.equal(S.computeYearStats(2026, [{ key: '2026-01-02', sectionText: '- 08:10 old' }], '\\d{2}:\\d{2}').mostCommonHour, '08:00');
  assert.equal(S.computeYearStats(2026, [{ key: '2026-01-02', sectionText: '8:10 legacy' }], '\\d{1,2}:\\d{2}').mostCommonHour, '08:00');
});

test('mixed current, historical, and manual timestamps preserve their entry bodies', () => {
  const entries = S.parseJournalEntries([
    '- 08:10 old',
    '- [x] 01:05 PM task',
    '* 09时02分 记录 中文 内容',
    '+ 08:10:30 [ ] seconds task',
    '- 手写早 manual body',
  ].join('\n'), pattern);
  assert.deepEqual(entries.map(({ timestamp, text, type, completed }) => ({ timestamp, text, type, completed })), [
    { timestamp: '08:10', text: 'old', type: 'memo', completed: undefined },
    { timestamp: '01:05 PM', text: 'task', type: 'task', completed: true },
    { timestamp: '09时02分 记录', text: '中文 内容', type: 'memo', completed: undefined },
    { timestamp: '08:10:30', text: 'seconds task', type: 'task', completed: false },
    { timestamp: '手写早', text: 'manual body', type: 'memo', completed: undefined },
  ]);
});
