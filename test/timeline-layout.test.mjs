import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('rendered Markdown lists do not turn HTML formatting newlines into blank lines', {
  skip: !existsSync(chrome) && 'Set CHROME_BIN to run the browser layout regression',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jp-timeline-layout-'));
  try {
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    // Markdown renderers emit newline text nodes between block elements. They
    // are HTML formatting, distinct from explicit Markdown hard-break <br>s.
    const markup = '<p>#log/thinking Some thoughts:</p>\n<ul>\n<li>First point about writing software.</li>\n<li>Second point that wraps onto another line with some more details to read.</li>\n<li>Third point about deciding what matters.</li>\n<li>Fourth point with a <a href="#">reference</a>.</li>\n</ul>\n';
    const fixture = path.join(directory, 'fixture.html');
    await writeFile(fixture, `<!doctype html><meta charset="utf-8"><style>
      :root { --background-primary: white; --text-normal: #222; --jp-tl-dot: #7c3aed; }
      body { width: 560px; font-family: sans-serif; }
      ${css}
    </style><div id="actual" class="jp-timeline-bubble">${markup}</div>
    <div id="reference" class="jp-timeline-bubble" style="white-space:normal">${markup}</div>
    <div class="jp-timeline-bubble"><pre id="code">first\n  indented</pre><p id="hardbreak">one<br>two</p></div>
    <script>
      const actual = document.querySelector('#actual');
      const reference = document.querySelector('#reference');
      const gap = node => node.querySelector('li:nth-child(2)').getBoundingClientRect().top - node.querySelector('li:first-child').getBoundingClientRect().bottom;
      const result = {
        height: actual.getBoundingClientRect().height,
        normalHeight: reference.getBoundingClientRect().height,
        gap: gap(actual), normalGap: gap(reference),
        codeWhitespace: getComputedStyle(document.querySelector('#code')).whiteSpace,
        hardBreakHeight: document.querySelector('#hardbreak').getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(actual).lineHeight)
      };
      const out = document.createElement('output'); out.id = 'measurements'; out.textContent = JSON.stringify(result); document.body.append(out);
    </script>`);
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href,
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const match = stdout.match(/<output id="measurements">([^<]+)<\/output>/);
    assert.ok(match, 'Browser must report layout measurements');
    const measured = JSON.parse(match[1]);
    console.log('Timeline layout:', measured);
    assert.ok(measured.height <= measured.normalHeight + 1,
      `HTML newlines inflate bubble height: ${measured.height}px vs ${measured.normalHeight}px`);
    assert.ok(measured.gap <= measured.normalGap + 1, 'List rows must not gain blank lines');
    assert.ok(['pre', 'pre-wrap', 'break-spaces'].includes(measured.codeWhitespace), 'Code indentation must remain preserved');
    assert.ok(measured.hardBreakHeight >= measured.lineHeight * 1.9, 'Explicit hard breaks must remain visible');
  } finally {
    // mkdtemp creates this exact directory; never remove a user-supplied path.
    assert.ok(directory.startsWith(path.join(tmpdir(), 'jp-timeline-layout-')));
    await rm(directory, { recursive: true, force: true });
  }
});
