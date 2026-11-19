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

test('completed-today visibility hides current tasks, preserves memos and history, and restores without reloading', {
  skip: !existsSync(chrome) && 'Set CHROME_BIN to run browser visibility checks',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jp-task-visibility-'));
  try {
    const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    const fixture = path.join(directory, 'fixture.html');
    await writeFile(fixture, `<!doctype html><meta charset="utf-8"><style>${css}</style>
      <div id="timeline" class="jp-hide-completed-today">
        <div class="jp-timeline-day jp-timeline-today">
          <div id="done" class="jp-timeline-entry jp-entry-task jp-task-completed">Done today</div>
          <div id="pending" class="jp-timeline-entry jp-entry-task">Pending</div>
          <div id="memo" class="jp-timeline-entry jp-entry-memo">Memo</div>
        </div>
        <div class="jp-timeline-day"><div id="history" class="jp-timeline-entry jp-entry-task jp-task-completed">Earlier day</div></div>
      </div><script>
        const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
        const hiddenState = { done:shown('done'), pending:shown('pending'), memo:shown('memo'), history:shown('history') };
        document.getElementById('timeline').classList.remove('jp-hide-completed-today');
        const restored = shown('done');
        document.getElementById('timeline').classList.add('jp-hide-completed-today');
        document.getElementById('done').classList.remove('jp-task-completed');
        const unchecked = shown('done');
        const output = document.createElement('output'); output.id = 'measurements';
        output.textContent = JSON.stringify({ hiddenState, restored, unchecked }); document.body.append(output);
      </script>`);
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href,
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const match = stdout.match(/<output id="measurements">([^<]+)<\/output>/);
    assert.ok(match);
    const result = JSON.parse(match[1]);
    assert.deepEqual(result.hiddenState, { done: false, pending: true, memo: true, history: true });
    assert.equal(result.restored, true);
    assert.equal(result.unchecked, true);
  } finally {
    assert.ok(directory.startsWith(path.join(tmpdir(), 'jp-task-visibility-')));
    await rm(directory, { recursive: true, force: true });
  }
});
