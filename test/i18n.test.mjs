import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-i18n-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/i18n.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { resolveLanguage, setLanguage, getLanguage, t } = await import(pathToFileURL(outfile).href);

test('system language recognises Chinese device locales', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans-CN', 'zh-Hant-HK', 'ZH_cn']) {
    assert.equal(resolveLanguage('system', locale), 'zh');
  }
});

test('unsupported device languages fall back to English', () => {
  for (const locale of ['en-US', 'ja-JP', 'fr-FR', '']) {
    assert.equal(resolveLanguage('system', locale), 'en');
  }
});

test('explicit language choices override device locale', () => {
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
});

test('switching language updates translated labels', () => {
  const previous = setLanguage('zh');
  assert.equal(getLanguage(), 'zh');
  assert.equal(t('settings.languageSystem'), '跟随系统');
  setLanguage('en');
  assert.equal(t('settings.languageSystem'), 'Follow system');
  setLanguage(previous);
});
