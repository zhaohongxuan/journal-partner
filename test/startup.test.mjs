import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-startup-${process.pid}.mjs`);
await build({entryPoints:[new URL('../src/startup.ts',import.meta.url).pathname], bundle:true, platform:'node', format:'esm', outfile,logLevel:'silent'});
const { registerStartupOpen } = await import(pathToFileURL(outfile).href);

function host(enabled = false) {
  const state = { enabled, opens: 0, errors: [], ready: null, cleanup: null };
  registerStartupOpen({onLayoutReady: callback => { state.ready = callback; }},
    {register: callback => {state.cleanup=callback;}}, () => state.enabled,
    async () => {state.opens++; if(state.reject) throw new Error('Open failed');}, error => state.errors.push(error));
  return state;
}

test('startup stays off by default and waits for layout restoration when enabled', () => {
  const disabled = host(); disabled.ready(); assert.equal(disabled.opens,0);
  const enabled=host(true); assert.equal(enabled.opens,0); enabled.ready(); assert.equal(enabled.opens,1);
});
test('startup checks the latest preference before opening and runs at most once', () => {
  const state=host(); state.enabled=true; state.ready(); state.ready(); assert.equal(state.opens,1);
  const cancelled=host(true); cancelled.enabled=false; cancelled.ready(); assert.equal(cancelled.opens,0);
});
test('unloading before layout restoration prevents opening the view', () => {
  const state=host(true); state.cleanup(); state.ready(); assert.equal(state.opens,0);
});
test('a failed startup open is reported without an unhandled rejection or duplicate retry', async () => {
  const state=host(true); state.reject=true; state.ready(); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.errors.length,1); assert.equal(state.errors[0].message,'Open failed');
  state.ready(); assert.equal(state.opens,1);
});
