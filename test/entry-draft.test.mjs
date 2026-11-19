import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [new URL('../src/entry-draft.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { splitEntryDraft, joinEntryDraft } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

function roundtrip(text) {
  const { tags, body, prefix } = splitEntryDraft(text);
  assert.equal(joinEntryDraft(tags, body, prefix), text);
}

test('extracts only valid whole leading hashtag tokens', () => {
  const draft = splitEntryDraft('#log/reading #中文 #under_score #with-dash Body #inline');
  assert.deepEqual(draft.tags, ['#log/reading', '#中文', '#under_score', '#with-dash']);
  assert.equal(draft.body, 'Body #inline');
  for (const text of ['#tag, body', '##heading body', '# body', '#tag#other body', 'bare #tag']) {
    assert.deepEqual(splitEntryDraft(text), { tags: [], body: text });
  }
  assert.equal(splitEntryDraft('#valid #invalid! #later').body, '#invalid! #later');
});

test('leaves inline tags and everything after the first body token intact', () => {
  const body = 'Read #inline\n#later\n  trailing whitespace  \n';
  assert.deepEqual(splitEntryDraft(body), { tags: [], body });
  assert.equal(splitEntryDraft(`#prefix ${body}`).body, body);
  assert.equal(joinEntryDraft(['prefix'], body), `#prefix ${body}`);
});

test('preserves fenced code and tags inside code', () => {
  for (const fence of ['```', '~~~']) {
    const body = `${fence}markdown\n#code-tag\n  indented #inline\n${fence}\n`;
    assert.equal(splitEntryDraft(`#work ${body}`).body, body);
    assert.deepEqual(splitEntryDraft(body), { tags: [], body });
    roundtrip(`#work ${body}`);
  }
});

test('preserves image and audio embeds verbatim', () => {
  const body = '![[photo #1.png|300]]\n![image](images/picture.png)\n![[recording.webm]]\n<audio src="clip.mp3"></audio>  ';
  assert.equal(splitEntryDraft(`#media ${body}`).body, body);
  assert.equal(joinEntryDraft(['#media'], body), `#media ${body}`);
  roundtrip(body);
  roundtrip(`#media ${body}`);
});

test('drafts without a tag prefix roundtrip including all whitespace', () => {
  for (const text of ['', ' ', '\n\t  ', '  Body #inline  \n', '\n```\n#tag\n```\n']) {
    const draft = splitEntryDraft(text);
    assert.deepEqual(draft, { tags: [], body: text });
    assert.equal(joinEntryDraft(draft.tags, draft.body), text);
  }
});

test('optional original prefix preserves separators and body indentation', () => {
  for (const text of ['#one body', ' \t#one\t#two   body  \n', '#one\n  ```\n#code\n```', '#one\r\n  body', '#one', '#one   ']) {
    roundtrip(text);
  }
  const draft = splitEntryDraft('#one   indented\n  body  ');
  assert.equal(draft.prefix, '#one ');
  assert.equal(draft.body, '  indented\n  body  ');
  assert.equal(joinEntryDraft(draft.tags, draft.body), '#one   indented\n  body  ');
});

test('adding and removing tags never rewrites body whitespace or inline tags', () => {
  const draft = splitEntryDraft('#old   Body #inline\n  ![[clip.webm]]  \n');
  assert.equal(joinEntryDraft(['new', '#extra'], draft.body, draft.prefix), '#new #extra   Body #inline\n  ![[clip.webm]]  \n');
  assert.equal(joinEntryDraft([], draft.body, draft.prefix), '  Body #inline\n  ![[clip.webm]]  \n');
  assert.equal(joinEntryDraft(['new'], '\n  Body  \n'), '#new \n  Body  \n');
  assert.equal(joinEntryDraft(['new'], ''), '#new');
});

test('normalizes and deduplicates tags without mutating the input', () => {
  const tags = Object.freeze(['work', ' #work ', '##work', '#中文', '中文', '', 'bad tag', '#bad!', '#Work']);
  assert.equal(joinEntryDraft(tags, 'Body'), '#work #中文 #Work Body');
  assert.equal(tags[0], 'work');
  assert.deepEqual(splitEntryDraft('#work #work #中文 Body').tags, ['#work', '#中文']);
  assert.equal(joinEntryDraft(splitEntryDraft('#work #work Body').tags, 'Body'), '#work Body');
  assert.equal(joinEntryDraft(['bad tag', ''], '  Body  '), '  Body  ');
});
