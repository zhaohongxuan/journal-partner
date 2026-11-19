/** Pure planning task tests; run with node --test test/todos.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-todos-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/todos.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const T = await import(pathToFileURL(outfile).href);
const parse = (content, start = '## Planning', end = '## Journal') =>
  T.parsePlanningTodos(content, start, end);
const set = (content, todo, completed, start = '## Planning', end = '## Journal') =>
  T.setPlanningTodoCompleted(content, todo, completed, start, end);
const texts = content => parse(content).map(todo => todo.text);
const add = (content, text = 'new task', start = '## Planning', end = '## Journal') =>
  T.addPlanningTodo(content, text, start, end);

test('adds directly after the existing heading and preserves all surrounding bytes', () => {
  const content = '# Note\n  ## Planning  \n\n- [x] old  \n### Child\n- [ ] nested\n## Journal\nentry';
  const offset = content.indexOf('\n\n- [x]') + 1;
  const output = add(content, '  **new** [link](url)  ');
  assert.equal(output, content.slice(0, offset) + '- [ ] **new** [link](url)\n' + content.slice(offset));
  assert.deepEqual(texts(output), ['**new** [link](url)', 'old', 'nested']);
});

test('adds after an EOF heading, including when its terminator is missing', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const ending of ['', newline]) {
      const content = `# Note${newline}## Planning${ending}`;
      assert.equal(add(content), `# Note${newline}## Planning${newline}- [ ] new task${newline}`);
    }
  }
});

test('creates a planning section before the first visible Journal after YAML', () => {
  const content = '\uFEFF---\n## Journal\n## Planning\n---\n```md\n## Journal\n## Planning\n```\n## Journal\nentry\n';
  const offset = content.lastIndexOf('## Journal');
  const output = add(content);
  assert.equal(output, content.slice(0, offset) + '## Planning\n- [ ] new task\n' + content.slice(offset));
  assert.deepEqual(texts(output), ['new task']);
});

test('creates an empty document section and safely separates an appended section', () => {
  assert.equal(add(''), '## Planning\n- [ ] new task\n');
  for (const content of ['paragraph', 'paragraph\n', 'paragraph\n\n']) {
    assert.equal(add(content), 'paragraph\n\n## Planning\n- [ ] new task\n');
  }
  assert.equal(add('---\ntitle: Note\n...'), '---\ntitle: Note\n...\n\n## Planning\n- [ ] new task\n');
});

test('preserves CRLF when adding to existing, new, or appended sections', () => {
  for (const [content, expected] of [
    ['## Planning\r\n- [ ] old\r\n## Journal\r\n', '## Planning\r\n- [ ] new task\r\n- [ ] old\r\n## Journal\r\n'],
    ['---\r\ntitle: Note\r\n---\r\n## Journal\r\nentry', '---\r\ntitle: Note\r\n---\r\n## Planning\r\n- [ ] new task\r\n## Journal\r\nentry'],
    ['# Note\r\nbody', '# Note\r\nbody\r\n\r\n## Planning\r\n- [ ] new task\r\n'],
  ]) {
    assert.equal(add(content), expected);
  }
});

test('adds a visible task before nested headings and an unclosed section fence', () => {
  const content = '## Planning\n### Child\n```\nhidden\n## Journal';
  const output = add(content);
  assert.equal(output, '## Planning\n- [ ] new task\n### Child\n```\nhidden\n## Journal');
  assert.deepEqual(texts(output), ['new task']);
});

test('rejects unsafe appends but allows closed fences and safe insertion before Journal', () => {
  for (const content of ['---', '\uFEFF---\ntitle: Note', '```md\n## Planning\n## Journal', '~~~\nhidden']) {
    assert.throws(() => add(content), /unclosed/);
  }
  for (const content of ['```md\n## Planning\n```', '~~~~\nhidden\n~~~~']) {
    const output = add(content);
    assert.equal(output, content + '\n\n## Planning\n- [ ] new task\n');
    assert.deepEqual(texts(output), ['new task']);
  }
  assert.equal(add('## Journal\n```\nhidden'), '## Planning\n- [ ] new task\n## Journal\n```\nhidden');
});

test('validates task text and headings before modifying content', () => {
  for (const text of ['', ' \t ', 'one\ntwo', 'one\rtwo', 'one\r\ntwo', 'one\u2028two', 'one\u2029two']) {
    assert.throws(() => add('## Planning\n', text), /single line/);
  }
  for (const [start, end] of [
    ['', '## Journal'], ['Planning', '## Journal'], ['####### Plan', '## Journal'],
    ['##Plan', '## Journal'], ['## Planning', 'Journal'], ['## Planning', '## Planning'],
    [' ## Planning ', '## Planning  '], ['## Planning\n', '## Journal'],
    ['## Planning', '## Journal\n# Extra'],
  ]) {
    assert.throws(() => add('', 'task', start, end), /headings/);
  }
  const output = add('', 'task', ' ### My plan ', ' #### Done ');
  assert.equal(output, '### My plan\n- [ ] task\n');
  assert.deepEqual(parse(output, '### My plan', '#### Done').map(todo => todo.text), ['task']);
});

test('parses only supported task markers with absolute line indices and original lines', () => {
  const lines = [
    '- [ ] outside', '  ## Planning  ', '- [ ] first', '* [x] second',
    '+ [X] third', '  - [ ] nested  ', '\t12. [x]\tordered', '2) [ ] ordered paren',
    '- [-] cancelled', '- [/] partial', '- [!] important', '- [] malformed',
    '- [xx] malformed', '- [ ]no separator', '[ ] no list', '- memo [ ] no task',
    '- [ ]', '## Journal', '- [ ] outside again',
  ];
  assert.deepEqual(parse(lines.join('\n')), [
    { lineIndex: 2, text: 'first', completed: false, sourceLine: lines[2] },
    { lineIndex: 3, text: 'second', completed: true, sourceLine: lines[3] },
    { lineIndex: 4, text: 'third', completed: true, sourceLine: lines[4] },
    { lineIndex: 5, text: 'nested', completed: false, sourceLine: lines[5] },
    { lineIndex: 6, text: 'ordered', completed: true, sourceLine: lines[6] },
    { lineIndex: 7, text: 'ordered paren', completed: false, sourceLine: lines[7] },
    { lineIndex: 16, text: '', completed: false, sourceLine: lines[16] },
  ]);
});

test('matches full configured headings after trimming, with no text-only or prefix match', () => {
  const content = '## Planning extra\n- [ ] wrong\n  ### My plan  \n- [ ] right\n### Done\n- [ ] wrong';
  assert.equal(parse(content).length, 0);
  assert.deepEqual(parse(content, ' ### My plan ', ' ### Done ').map(t => t.text), ['right']);
  assert.deepEqual(parse(content, 'My plan', 'Done'), []);
  assert.deepEqual(parse('', '## Planning', '## Journal'), []);
});

test('explicit end delimits the full interval even across other peer or higher headings', () => {
  const content = [
    '## Journal', '- [ ] before', '## Planning', '- [ ] first',
    '## Other', '- [ ] peer', '# Other parent', '- [ ] parent',
    '## Journal', '- [ ] after', '## Planning', '- [ ] later start',
  ].join('\n');
  assert.deepEqual(texts(content), ['first', 'peer', 'parent']);
});

test('missing end falls back to the next same-level or higher heading', () => {
  for (const boundary of ['## Other', '# Parent', '  ## Other  ']) {
    const content = `## Planning\n- [ ] first\n### Child\n  - [ ] child\n${boundary}\n- [ ] outside`;
    assert.deepEqual(texts(content), ['first', 'child']);
  }
});

test('end before start is ignored; missing end allows nested content through EOF', () => {
  const content = '## Journal\n- [ ] before\n## Planning\n- [ ] first\n### Child\n- [x] last';
  assert.deepEqual(texts(content), ['first', 'last']);
  assert.deepEqual(texts('## Planning\n## Journal\n- [ ] after'), []);
});

test('configured nested end stops before it; nested headings otherwise stay included', () => {
  const content = '## Planning\n### Child\n- [ ] child\n#### End\n- [ ] after';
  assert.deepEqual(parse(content, '## Planning', '#### End').map(t => t.text), ['child']);
});

test('ignores YAML frontmatter including fake headings, tasks and fences', () => {
  for (const terminator of ['---', '...']) {
    const content = [
      '\uFEFF---', '## Planning', '- [ ] metadata', '```', terminator,
      '## Planning', '- [ ] real', '## Journal',
    ].join('\n');
    assert.deepEqual(parse(content), [
      { lineIndex: 6, text: 'real', completed: false, sourceLine: '- [ ] real' },
    ]);
  }
  assert.deepEqual(texts('---\n## Planning\n- [ ] unclosed YAML'), []);
});

test('ignores fenced headings and tasks, including longer fences and mismatched closers', () => {
  const content = [
    '```md', '## Planning', '- [ ] fake start', '```',
    '## Planning', '- [ ] first', '  ````markdown', '## Journal',
    '- [ ] hidden', '```', '- [ ] still hidden', '~~~~', '````',
    '~~~js', '## Other', '- [ ] hidden too', '~~~~',
    '- [ ] second', '## Journal', '- [ ] outside',
  ].join('\n');
  assert.deepEqual(texts(content), ['first', 'second']);
});

test('unclosed fence hides remainder and fake explicit end cannot extend fallback bounds', () => {
  assert.deepEqual(texts('## Planning\n- [ ] real\n```\n- [ ] hidden\n## Journal'), ['real']);
  const content = '## Planning\n- [ ] real\n## Other\n- [ ] outside\n~~~\n## Journal\n~~~';
  assert.deepEqual(texts(content), ['real']);
});

test('CRLF parsing keeps source lines and absolute indices without including terminators', () => {
  const content = '# Note\r\n## Planning\r\n\t3) [X]  原文  \r\n## Journal\r\n';
  assert.deepEqual(parse(content), [
    { lineIndex: 2, text: '原文', completed: true, sourceLine: '\t3) [X]  原文  ' },
  ]);
});

test('switch changes exactly the checkbox character and preserves every other byte', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const trailing of ['', newline]) {
      const content = ['## Planning', '\t12)  [ ]  text [ ] **bold**  ', '## Journal', '- [ ] other'].join(newline) + trailing;
      const out = set(content, parse(content)[0], true);
      const offset = content.indexOf('[ ]') + 1;
      assert.equal(out, content.slice(0, offset) + 'x' + content.slice(offset + 1));
      assert.equal(out.length, content.length);
      assert.equal(set(out, parse(out)[0], false), content);
    }
  }
});

test('already-completed uppercase checkbox stays unchanged on an idempotent set', () => {
  const content = '## Planning\n+ [X] done';
  assert.equal(set(content, parse(content)[0], true), content);
  assert.equal(set(content, parse(content)[0], false), '## Planning\n+ [ ] done');
});

test('duplicate text selects only the indexed occurrence', () => {
  const content = '## Planning\n- [ ] repeat\n- [ ] repeat\n## Journal\n- [ ] repeat';
  assert.equal(set(content, parse(content)[1], true), '## Planning\n- [ ] repeat\n- [x] repeat\n## Journal\n- [ ] repeat');
});

test('rejects changed or shifted lines instead of searching duplicate text', () => {
  const content = '## Planning\n- [ ] first\n- [ ] repeat\n- [ ] repeat\n## Journal';
  const todo = parse(content)[1];
  for (const changed of [
    content.replace('- [ ] repeat', '- [ ] edited'),
    content.replace('## Planning\n', '## Planning\ninserted\n'),
    content.replace('- [ ] repeat', '- [x] repeat'),
    content.replace('## Planning', '## Something else'),
  ]) {
    assert.throws(() => set(changed, todo, true), Error);
  }
  assert.throws(() => set(content, { ...todo, lineIndex: 999 }, true), Error);
  assert.throws(() => set(content, { ...todo, lineIndex: -1 }, true), Error);
});

test('revalidation rejects an unchanged source line moved out of scope or into a fence', () => {
  const content = '## Planning\nplain\n- [ ] task\n## Journal';
  const todo = parse(content)[0];
  assert.throws(() => set(content.replace('plain', '## Journal'), todo, true), Error);
  assert.throws(() => set(content.replace('plain', '```'), todo, true), Error);
  assert.throws(() => set(content, todo, true, '## Other', '## Journal'), Error);
});
