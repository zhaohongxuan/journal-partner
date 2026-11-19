import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('rendered tag clicks activate the local filter before core handlers and leave ordinary links alone', {
  skip: !existsSync(chrome) && 'Set CHROME_BIN to run the tag-click browser regression',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jp-tag-filter-links-'));
  try {
    const bundle = await build({ entryPoints: [new URL('../src/tag-filter-links.ts', import.meta.url).pathname], bundle: true,
      format: 'iife', globalName: 'TagLinks', write: false, logLevel: 'silent' });
    const fixture = path.join(directory, 'fixture.html');
    await writeFile(fixture, `<!doctype html><meta charset="utf-8">
      <div id="bubble">
        <a id="nested" class="tag" data-href="#项目/开发" href="#项目/开发"><span>项目/开发</span></a>
        <a id="plain" class="tag" href="#log/reading">#log/reading</a>
        <a id="unicode" class="tag" href="app://obsidian.md/#中文">#中文</a>
        <a id="invalid" class="tag" href="#invalid tag">#invalid tag</a>
        <a id="wiki" class="internal-link" href="#note">A note</a>
        <code>#not-a-link</code>
      </div><script>${bundle.outputFiles[0].text}</script><script>
        const root = document.getElementById('bubble');
        const calls = [], coreCalls = [], prevented = [];
        root.querySelectorAll('a').forEach(link => link.addEventListener('click', event => {
          coreCalls.push(link.id); event.preventDefault();
        }));
        const activate = tag => calls.push(tag);
        TagLinks.hookUpTagFilters(root, activate);
        TagLinks.hookUpTagFilters(root, activate);
        for (const id of ['nested', 'plain', 'unicode', 'invalid', 'wiki']) {
          const link = document.getElementById(id);
          const event = new MouseEvent('click', {bubbles:true, cancelable:true});
          (link.querySelector('span') || link).dispatchEvent(event);
          prevented.push(event.defaultPrevented);
        }
        document.getElementById('plain').click();
        const output = document.createElement('output'); output.id = 'result';
        output.textContent = JSON.stringify({calls, coreCalls, prevented}); document.body.append(output);
      </script>`);
    const { stdout } = await promisify(execFile)(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const match = stdout.match(/<output id="result">([^<]+)<\/output>/);
    assert.ok(match, 'Browser must report click results');
    const result = JSON.parse(match[1]);
    assert.deepEqual(result.calls, ['项目/开发', 'log/reading', '中文', 'log/reading']);
    assert.deepEqual(result.coreCalls, ['invalid', 'wiki']);
    assert.ok(result.prevented.every(Boolean));
  } finally {
    assert.ok(directory.startsWith(path.join(tmpdir(), 'jp-tag-filter-links-')));
    await rm(directory, { recursive: true, force: true });
  }
});
