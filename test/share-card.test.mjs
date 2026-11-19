import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-share-card-${process.pid}.mjs`);
await build({ entryPoints: [new URL('../src/share-card-renderer.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { wrapShareText, renderShareCard } = await import(pathToFileURL(outfile).href);

// A deterministic measuring/drawing context checks layout invariants without
// depending on platform fonts. Pixel appearance still needs an Obsidian check.
function drawingCanvas() {
  const calls = [];
  const context = {
    font: '10px serif',
    measureText(value) {
      const size = Number(this.font.match(/([\d.]+)px/)?.[1] || 10);
      return { width: Array.from(value).reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? size : size * 0.55), 0) };
    },
    fillText(text, x, y) { calls.push({ type: 'text', text, x, y, font: this.font }); },
    drawImage(image, x, y, width, height) { calls.push({ type: 'image', x, y, width, height }); },
    fillRect(x, y, width, height) { calls.push({ type: 'rect', color: this.fillStyle, x, y, width, height }); },
    setTransform() {}, save() {}, restore() {}, translate() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  return { canvas, context, calls };
}
const content = {
  blocks: [{ type: 'text', text: '银杏黄了。\n\nLittle moments are worth remembering.' }],
  date: '2026-11-19', timestamp: '08:42', weekday: '周四', month: '2026 年 11 月',
  tags: ['#生活碎片'], title: '分享此刻', subtitle: '记录生活，留住此刻',
};
const options = { template: 'paper', showDate: true, showTags: true, showAuthor: true, author: 'Hank' };

test('wrap keeps CJK, paragraph breaks and English word boundaries', () => {
  const { context } = drawingCanvas();
  context.font = '10px serif';
  assert.deepEqual(wrapShareText(context, '春夏秋冬\n\nhello world', 22), ['春夏', '秋冬', '', 'hell', 'o', 'worl', 'd']);
  assert.deepEqual(wrapShareText(context, 'hello world', 30), ['hello', 'world']);
});

test('giant words make progress, preserve Unicode code points, and obey width', () => {
  const { context } = drawingCanvas();
  const input = 'a'.repeat(5000) + '𠮷'.repeat(100);
  const lines = wrapShareText(context, input, 31);
  assert.equal(lines.join(''), input);
  assert.ok(lines.every(line => context.measureText(line).width <= 31));
  assert.throws(() => wrapShareText(context, input, 0), /positive/);
});

for (const template of ['paper', 'calendar', 'night']) {
  test(`${template}: 2x output includes text, signature and date`, () => {
    const { canvas, calls } = drawingCanvas();
    renderShareCard(canvas, content, { ...options, template });
    assert.equal(canvas.width, 780);
    assert.ok(canvas.height >= 960);
    const text = calls.filter(call => call.type === 'text').map(call => call.text).join('\n');
    assert.match(text, /银杏黄了/);
    assert.match(text, /Hank/);
    assert.match(text, /2026\.11\.19/);
    assert.match(text, /#生活碎片/);
    assert.equal(canvas.style, undefined, 'renderer leaves responsive sizing to CSS');
  });
  test(`${template}: hidden metadata is absent from exported pixels`, () => {
    const { canvas, calls } = drawingCanvas();
    renderShareCard(canvas, content, { ...options, template, showDate: false, showTags: false, showAuthor: false });
    const text = calls.filter(call => call.type === 'text').map(call => call.text).join('\n');
    assert.doesNotMatch(text, /2026|08:42|#生活碎片|Hank|周四/);
    assert.match(text, /银杏黄了/);
  });
}

test('images fit within the card, retain aspect ratio and follow the text', () => {
  const { canvas, calls } = drawingCanvas();
  renderShareCard(canvas, { ...content, blocks: [content.blocks[0], { type: 'image', image: { naturalWidth: 2400, naturalHeight: 1200 } }] }, options);
  const image = calls.find(call => call.type === 'image');
  assert.ok(image.width <= 326);
  assert.equal(image.width / image.height, 2);
  assert.ok(image.y > calls.find(call => call.text === '银杏黄了。').y);
  assert.ok((image.y + image.height) * 2 < canvas.height);
});

test('long content grows the image and excessive height fails before allocation', () => {
  const { canvas } = drawingCanvas();
  renderShareCard(canvas, content, options);
  const shortHeight = canvas.height;
  renderShareCard(canvas, { ...content, blocks: [{ type: 'text', text: '一段完整的长记录。\n'.repeat(50) }] }, options);
  assert.ok(canvas.height > shortHeight);
  const previousHeight = canvas.height;
  assert.throws(() => renderShareCard(canvas, { ...content, blocks: [{ type: 'text', text: '记录\n'.repeat(500) }] }, options), /too long/);
  assert.equal(canvas.height, previousHeight, 'unsafe pixel allocation never occurs');
});

test('completed task gets a localized label and blank signatures do not create a byline', () => {
  const { canvas, calls } = drawingCanvas();
  renderShareCard(canvas, { ...content, task: true, completed: true, taskLabel: '已完成任务' }, { ...options, author: '   ' });
  const text = calls.filter(call => call.type === 'text').map(call => call.text).join('\n');
  assert.match(text, /已完成任务/);
  assert.doesNotMatch(text, /记录生活，留住此刻/);
});
