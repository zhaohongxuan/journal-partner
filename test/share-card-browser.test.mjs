import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('real browser exports all templates as PNG and scales previews to a mobile container', {
  skip: !existsSync(chrome) && 'Set CHROME_BIN to run share-card browser checks',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jp-share-browser-'));
  try {
    const bundle = await build({ entryPoints: [new URL('../src/share-card-renderer.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'ShareCard', write: false, logLevel: 'silent' });
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    const fixture = path.join(directory, 'fixture.html');
    await writeFile(fixture, `<!doctype html><meta charset="utf-8"><style>
      ${css}
      body { width: 320px; margin: 0; }
      .jp-share-preview { width: 320px; box-sizing: border-box; }
    </style><div class="jp-share-preview"><canvas class="jp-share-canvas"></canvas></div>
    <script>${bundle.outputFiles[0].text}</script><script>
      const canvas = document.querySelector('canvas');
      const content = {
        blocks: [{ type: 'text', text: '早上出门，发现银杏已经黄了。\\n\\n站在树下看了一会儿，突然觉得，生活里那些很小的瞬间，也值得认真记下来。' }],
        date: '2026-11-19', timestamp: '08:42', weekday: '周四', month: '2026 年 11 月',
        tags: ['#生活碎片'], title: '分享此刻', subtitle: '记录生活，留住此刻'
      };
      const options = { template: 'paper', showDate: true, showTags: true, showAuthor: true, author: '分享测试' };
      const results = [];
      try {
        for (const template of ['paper', 'calendar', 'night']) {
          ShareCard.renderShareCard(canvas, content, {...options, template});
          const rect = canvas.getBoundingClientRect();
          const data = canvas.toDataURL('image/png');
          const bytes = atob(data.split(',')[1]);
          const pngWidth = new DataView(Uint8Array.from(bytes.slice(0,24), char => char.charCodeAt(0)).buffer).getUint32(16);
          const ctx = canvas.getContext('2d');
          const corner = Array.from(ctx.getImageData(0, 0, 1, 1).data);
          results.push({template, width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height,
            png: data.startsWith('data:image/png;base64,iVBOR'), pngWidth, corner});
        }
        const shortHeight = canvas.height;
        ShareCard.renderShareCard(canvas, {...content, blocks:[{type:'text', text:'完整的长记录，不能被裁切。\\n'.repeat(50)}]}, options);
        const longHeight = canvas.height;
        const result = { results, shortHeight, longHeight };
        const output = document.createElement('output'); output.id = 'measurements'; output.textContent = JSON.stringify(result); document.body.append(output);
      } catch(error) {
        const output = document.createElement('output'); output.id = 'measurements'; output.textContent = JSON.stringify({error:String(error)}); document.body.append(output);
      }
    </script>`);
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href,
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const match = stdout.match(/<output id="measurements">([^<]+)<\/output>/);
    assert.ok(match, 'Browser must report canvas measurements');
    const measured = JSON.parse(match[1]);
    assert.equal(measured.error, undefined);
    assert.equal(measured.results.length, 3);
    for (const result of measured.results) {
      assert.equal(result.width, 780);
      assert.equal(result.pngWidth, 780);
      assert.equal(result.png, true);
      assert.ok(result.cssWidth <= 320, 'Mobile preview must fit its container');
      assert.ok(Math.abs(result.cssHeight / result.cssWidth - result.height / result.width) < 0.02, 'Responsive canvas must keep its aspect ratio');
      assert.equal(result.corner[3], 255, 'Export must have an opaque background');
    }
    assert.notDeepEqual(measured.results[0].corner, measured.results[2].corner, 'Night export uses its own background');
    assert.ok(measured.longHeight > measured.shortHeight, 'Long entries grow the PNG');
  } finally {
    assert.ok(directory.startsWith(path.join(tmpdir(), 'jp-share-browser-')));
    await rm(directory, { recursive: true, force: true });
  }
});
