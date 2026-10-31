/**
 * Unit tests for the pure journal-section helpers (src/section.ts).
 *
 * Obsidian itself has no scriptable UI-test harness. These tests bundle the
 * pure logic with esbuild and run under Node's built-in test runner, so the
 * destructive operations (delete / edit / remove-audio) are exercised without
 * touching a real vault.
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-section-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/section.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const S = await import(pathToFileURL(outfile).href);

const settings = {
  targetHeading: 'Journal',
  headingLevel: 2,
  timestampPattern: '\\d{2}:\\d{2}',
};

const content = [
  '## Journal',
  '',
  '- [ ] 08:37 未完成的任务',
  '- [x] 08:38 已完成的任务',
  '- 09:00 普通 memo',
  '- 09:10 [ ] 旧格式未完成',
  '- 09:11 [x] 旧格式完成',
  '- [ ] 10:00 多行任务第一行  ',
  '  第二行',
  '',
  '### Other',
  'ignore me',
].join('\n');

const sec = S.findSection(content, settings.targetHeading, settings.headingLevel);
const sectionText = content.slice(sec.from, sec.to);
const entries = S.parseJournalEntries(sectionText, settings.timestampPattern);
const lineOf = ts => entries.find(e => e.timestamp === ts).lineIndex;

test('parseJournalEntries recognises memo / current task / legacy task', () => {
  const byTs = Object.fromEntries(entries.map(e => [e.timestamp, e]));
  assert.equal(byTs['09:00'].type, 'memo');
  assert.equal(byTs['08:37'].type, 'task');
  assert.equal(byTs['08:37'].completed, false);
  assert.equal(byTs['08:38'].completed, true);
  assert.equal(byTs['09:10'].type, 'task');
  assert.equal(byTs['09:10'].completed, false);
  assert.equal(byTs['09:11'].completed, true);
});

test('deleteEntryFromSection deletes current-format tasks', () => {
  const out = S.deleteEntryFromSection(content, settings, lineOf('08:37'));
  assert.ok(!out.includes('08:37'));
  assert.ok(out.includes('08:38'));
});

test('deleteEntryFromSection deletes legacy tasks', () => {
  const out = S.deleteEntryFromSection(content, settings, lineOf('09:10'));
  assert.ok(!out.includes('09:10'));
  assert.ok(out.includes('09:11'));
});

test('deleteEntryFromSection deletes a multi-line task with its continuation', () => {
  const out = S.deleteEntryFromSection(content, settings, lineOf('10:00'));
  assert.ok(!out.includes('10:00'));
  assert.ok(!out.includes('第二行'));
});

test('deleteEntryFromSection ignores out-of-range / non-head lines', () => {
  assert.equal(S.deleteEntryFromSection(content, settings, 999), content);
});

test('editEntryInSection keeps task type and completion state', () => {
  const done = S.editEntryInSection(content, settings, lineOf('08:38'), '改过的完成');
  assert.ok(done.includes('- [x] 08:38 改过的完成'));
  const todo = S.editEntryInSection(content, settings, lineOf('08:37'), '改过的任务');
  assert.ok(todo.includes('- [ ] 08:37 改过的任务'));
});

test('editEntryInSection preserves legacy task layout', () => {
  const out = S.editEntryInSection(content, settings, lineOf('09:11'), '改过的旧完成');
  assert.ok(out.includes('- 09:11 [x] 改过的旧完成'));
});

test('editEntryInSection keeps ordinary memo a memo', () => {
  const out = S.editEntryInSection(content, settings, lineOf('09:00'), '改过的 memo');
  assert.ok(out.includes('- 09:00 改过的 memo'));
  assert.ok(!out.includes('09:00 ['));
});

test('toggleTaskInSection flips both layouts', () => {
  const a = S.toggleTaskInSection(content, settings, lineOf('08:37'), true);
  assert.ok(a.includes('- [x] 08:37'));
  const b = S.toggleTaskInSection(content, settings, lineOf('09:10'), true);
  assert.ok(b.includes('- 09:10 [x]'));
});

test('removeAudioEmbedsFromEntry keeps text + non-audio attachments on tasks', () => {
  const withAudio = [
    '## Journal', '',
    '- [ ] 08:37 未完成 ![[voice.m4a]] ![[pic.png]]',
    '- 09:00 memo ![[other.m4a]]',
    '',
  ].join('\n');
  const s = S.findSection(withAudio, settings.targetHeading, settings.headingLevel);
  const es = S.parseJournalEntries(withAudio.slice(s.from, s.to), settings.timestampPattern);
  const taskLine = es.find(e => e.timestamp === '08:37').lineIndex;
  const out = S.removeAudioEmbedsFromEntry(withAudio, settings, taskLine);
  assert.ok(out.includes('- [ ] 08:37 未完成 ![[pic.png]]'));
  assert.ok(!out.includes('voice.m4a'));
});

test('deleteEntryFromSection tolerates CRLF files', () => {
  const crlf = '## Journal\r\n\r\n- [ ] 08:37 任务\r\n- 09:00 memo\r\n';
  const s = S.findSection(crlf, settings.targetHeading, settings.headingLevel);
  const es = S.parseJournalEntries(crlf.slice(s.from, s.to), settings.timestampPattern);
  const out = S.deleteEntryFromSection(crlf, settings, es[0].lineIndex);
  assert.ok(!out.includes('08:37'));
  assert.ok(out.includes('09:00'));
});
