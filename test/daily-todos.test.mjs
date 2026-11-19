/** Daily task parsing and guarded updates, bundled like the planning task tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-daily-todos-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/todos.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const T = await import(pathToFileURL(outfile).href);
const defaults = {
  todoStartHeading: '## Planning',
  todoEndHeading: '## Journal',
  todoIncludeTimelineTasks: true,
  targetHeading: 'Journal',
  headingLevel: 2,
  timestampPattern: '\\d{2}:\\d{2}',
};
const parse = (content, overrides = {}) => T.parseDailyTodos(content, { ...defaults, ...overrides });
const set = (content, todo, completed, overrides = {}) =>
  T.setDailyTodoCompleted(content, todo, completed, { ...defaults, ...overrides });

test('disabled flag returns exactly the planning parser results with planning sources', () => {
  const content = '## Planning\n- [ ] plan\n+ [X] done\n## Journal\n- [ ] 08:00 task\n- 09:00 [ ] legacy';
  assert.deepEqual(parse(content, { todoIncludeTimelineTasks: false }),
    T.parsePlanningTodos(content, defaults.todoStartHeading, defaults.todoEndHeading)
      .map(todo => ({ ...todo, source: 'planning' })));
});

test('merges both journal formats, excludes memos, and preserves multiline entry text', () => {
  const lines = [
    '# Today', '- [ ] 06:00 outside', '## Planning', '- [ ] plan', '## Journal',
    '- [ ] 08:00 first  ', '  continuation **bold**  ', '    - child',
    '* 09:00 [X] legacy', '+ [x] 10:00 modern done', '- 10:30 memo [ ] example',
    '- [ ] plain checkbox without a timestamp', '### Nested', '- 11:00 [ ] nested task',
    '## Other', '- [ ] 12:00 outside again',
  ];
  assert.deepEqual(parse(lines.join('\n')), [
    { lineIndex: 3, text: 'plan', completed: false, sourceLine: lines[3], source: 'planning' },
    { lineIndex: 5, text: 'first  \ncontinuation **bold**  \n  - child', completed: false, sourceLine: lines[5], source: 'journal', timestamp: '08:00' },
    { lineIndex: 8, text: 'legacy', completed: true, sourceLine: lines[8], source: 'journal', timestamp: '09:00' },
    { lineIndex: 9, text: 'modern done', completed: true, sourceLine: lines[9], source: 'journal', timestamp: '10:00' },
    { lineIndex: 13, text: 'nested task', completed: false, sourceLine: lines[13], source: 'journal', timestamp: '11:00' },
  ]);
});

test('uses the configured journal heading, heading level, and timestamp pattern', () => {
  const settings = { targetHeading: 'Daily log', headingLevel: 3, timestampPattern: '\\d{2}h\\d{2}' };
  const content = [
    '## Journal', '- [ ] 08:00 wrong section', '### Daily log',
    '- [ ] 09h15 custom', '- 10h20 [ ] legacy custom', '- [ ] 11:30 wrong pattern',
    '#### Child', '- [X] 12h30 child', '### Next', '- [ ] 13h00 outside',
  ].join('\n');
  const todos = parse(content, settings);
  assert.deepEqual(todos.map(todo => [todo.lineIndex, todo.timestamp, todo.text]), [
    [3, '09h15', 'custom'], [4, '10h20', 'legacy custom'], [7, '12h30', 'child'],
  ]);
  assert.equal(set(content, todos[1], true, settings), content.replace('10h20 [ ]', '10h20 [x]'));
  assert.deepEqual(parse('## Journal\n- [ ] 08:00 task', settings), []);
});

test('ignores YAML and fenced headings, tasks, and fake journal section boundaries', () => {
  const lines = [
    '\uFEFF---', '## Journal', '- [ ] 00:00 YAML', '---',
    '```md', '## Journal', '- 01:00 [ ] fenced section', '```',
    '## Planning', '- [ ] plan', '## Journal', '- [ ] 08:00 real',
    '  ````md', '- [ ] 09:00 fenced task', '## Other', '```',
    '- 10:00 [ ] still fenced', '````', '~~~', '- [ ] 11:00 tilde fence',
    '## Other', '~~~~', '- 12:00 [ ] real legacy', '## Other', '- [ ] 13:00 outside',
  ];
  const todos = parse(lines.join('\n'));
  assert.deepEqual(todos.map(todo => [todo.lineIndex, todo.text]), [[9, 'plan'], [11, 'real'], [22, 'real legacy']]);
  assert.equal(set(lines.join('\n'), todos[2], true), lines.join('\n').replace('12:00 [ ]', '12:00 [x]'));
  assert.deepEqual(parse('---\n## Journal\n- [ ] 08:00 hidden'), []);
  assert.deepEqual(parse('## Journal\n```\n- [ ] 08:00 hidden'), []);
});

test('overlapping scopes deduplicate by source line and prefer the journal representation', () => {
  const content = [
    '## Planning', '- [ ] plan before', '## Journal', '- [ ] 08:00 shared  ',
    '  continuation', '- 09:00 [ ] legacy', '- [ ] plain planning', '## End',
  ].join('\n');
  const settings = { todoEndHeading: '## End' };
  const todos = parse(content, settings);
  assert.deepEqual(todos.map(todo => [todo.lineIndex, todo.source, todo.text, todo.timestamp]), [
    [1, 'planning', 'plan before', undefined],
    [3, 'journal', 'shared  \ncontinuation', '08:00'],
    [6, 'planning', 'plain planning', undefined],
    [5, 'journal', 'legacy', '09:00'],
  ]);
  assert.equal(set(content, todos[1], true, settings), content.replace('[ ] 08:00', '[x] 08:00'));
  const disabled = { ...settings, todoIncludeTimelineTasks: false };
  assert.equal(parse(content, disabled).find(todo => todo.lineIndex === 3).source, 'planning');
  assert.throws(() => set(content, todos[1], true, disabled), /changed|section/);
});

test('identical text on separate planning and journal lines remains distinct and indexed', () => {
  const content = '## Planning\n- [ ] repeat\n- [ ] repeat\n## Journal\n- [ ] 08:00 repeat\n- [ ] 08:00 repeat\n- 09:00 [ ] repeat';
  const todos = parse(content);
  assert.equal(todos.length, 5);
  assert.deepEqual(todos.map(todo => todo.lineIndex), [1, 2, 4, 5, 6]);
  const lines = content.split('\n');
  lines[5] = '- [x] 08:00 repeat';
  assert.equal(set(content, todos[3], true), lines.join('\n'));
});

test('preserves every byte except the checkbox character for both formats and planning tasks', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const trailing of ['', newline]) {
      const content = [
        '## Planning', '\t12)  [ ]  planning [ ]  ', '## Journal',
        '*\t[ ]\t08:00\tfirst [ ]  ', '  continuation  ', '+  09:00  [ ]\tlegacy [ ]  ',
      ].join(newline) + trailing;
      for (const todo of parse(content)) {
        const sourceOffset = content.indexOf(todo.sourceLine);
        const checkboxOffset = sourceOffset + todo.sourceLine.indexOf('[ ]') + 1;
        const expected = content.slice(0, checkboxOffset) + 'x' + content.slice(checkboxOffset + 1);
        const output = set(content, todo, true);
        assert.equal(output, expected);
        assert.equal(output.length, content.length);
        assert.equal(set(output, parse(output).find(current => current.lineIndex === todo.lineIndex), false), content);
      }
    }
  }
});

test('idempotent completion preserves uppercase X for new and legacy journal entries', () => {
  const content = '## Journal\r\n- [X] 08:00 new\r\n- 09:00 [X] old\r\n';
  for (const todo of parse(content)) {
    assert.equal(set(content, todo, true), content);
    const offset = content.indexOf(todo.sourceLine) + todo.sourceLine.indexOf('[X]') + 1;
    assert.equal(set(content, todo, false), content.slice(0, offset) + ' ' + content.slice(offset + 1));
  }
});

test('rejects stale head text, timestamp, checkbox, absolute index, and source snapshots', () => {
  const content = '# Note\n## Journal\n- [ ] 08:00 original\n- 09:00 [ ] legacy';
  const todo = parse(content)[0];
  for (const changed of [
    content.replace('original', 'edited'), content.replace('08:00', '08:01'),
    content.replace('[ ]', '[x]'), content.replace('## Journal\n', '## Journal\ninserted\n'),
  ]) {
    assert.throws(() => set(changed, todo, true), /changed|section/);
  }
  for (const forged of [{ ...todo, lineIndex: -1 }, { ...todo, lineIndex: 99 }, { ...todo, source: 'planning' }]) {
    assert.throws(() => set(content, forged, true), /changed|section/);
  }
});

test('rejects unchanged task lines moved outside scope, hidden in fences, or disabled by settings', () => {
  const content = '## Journal\nplain\n- 09:00 [ ] task\n';
  const todo = parse(content)[0];
  for (const changed of [
    content.replace('plain', '## Other'), content.replace('plain', '```'),
    content.replace('## Journal', '## Other'),
  ]) {
    assert.throws(() => set(changed, todo, true), /changed|section/);
  }
  for (const settings of [
    { todoIncludeTimelineTasks: false }, { targetHeading: 'Other' },
    { headingLevel: 3 }, { timestampPattern: '\\d{2}h\\d{2}' },
  ]) {
    assert.throws(() => set(content, todo, true, settings), /changed|section/);
  }
  const planning = '## Planning\nplain\n- [ ] plan\n## Journal';
  const plan = parse(planning)[0];
  assert.throws(() => set(planning.replace('plain', '## Journal'), plan, true), /changed|section/);
  assert.throws(() => set(planning, plan, true, { todoStartHeading: '## Other' }), /changed|section/);
});
