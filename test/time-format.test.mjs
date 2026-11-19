import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outfile = path.join(tmpdir(), `jp-time-format-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/time-format.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const T = await import(pathToFileURL(outfile).href);
const date = (hour, minute = 4, second = 5) => new Date(2026, 0, 2, hour, minute, second);

for (const [format, expected] of [
  ['HH:mm', '09:04'], ['HH:mm:ss', '09:04:05'], ['H:m:s', '9:4:5'],
  ['hh:mm A', '09:04 AM'], ['h:m:s a', '9:4:5 am'],
  ['HH时mm分ss秒', '09时04分05秒'], ['[at] HH:mm', 'at 09:04'],
]) {
  test(`format and parse preset ${format}`, () => {
    T.validateTimestampFormat(format);
    assert.equal(T.formatTimestamp(format, date(9)), expected);
    assert.equal(T.timestampToSeconds(expected, [format]), 9 * 3600 + 4 * 60 + (format.includes('s') ? 5 : 0));
  });
}

test('default stays 24-hour HH:mm and uses local date fields', () => {
  assert.match(T.formatTimestamp(), /^\d{2}:\d{2}$/);
  assert.equal(T.formatTimestamp(undefined, date(23, 59, 58)), '23:59');
  assert.equal(T.formatTimestamp('HH:mm:ss', date(0, 0, 0)), '00:00:00');
});

test('12-hour conversion handles midnight, noon, and afternoon', () => {
  for (const [hour, expected, lower] of [
    [0, '12:00 AM', '12:00 am'], [12, '12:00 PM', '12:00 pm'],
    [13, '01:00 PM', '1:00 pm'], [23, '11:00 PM', '11:00 pm'],
  ]) {
    assert.equal(T.formatTimestamp('hh:mm A', date(hour, 0)), expected);
    assert.equal(T.formatTimestamp('h:mm a', date(hour, 0)), lower);
    assert.equal(T.timestampToSeconds(expected, ['hh:mm A']), hour * 3600);
    assert.equal(T.timestampToSeconds(lower, ['h:mm a']), hour * 3600);
  }
  assert.equal(T.timestampToSeconds('01:00 pm', ['hh:mm A']), null);
  assert.equal(T.timestampToSeconds('1:00 PM', ['h:mm a']), null);
});

test('Chinese, bracket literals, and regex metacharacters round trip exactly', () => {
  const format = '[at (now)?] HH时mm分ss秒.*+?^${}()|\\';
  const expected = 'at (now)? 09时04分05秒.*+?^${}()|\\';
  assert.equal(T.formatTimestamp(format, date(9)), expected);
  assert.equal(T.timestampToSeconds(expected, [format]), 32645);
  const pattern = new RegExp(`^(?:${T.getTimestampPattern({ timestampFormat: format })})$`);
  assert.equal(pattern.test(expected), true);
  assert.equal(pattern.test(expected.replace('(now)?', 'now')), false);
  assert.equal(T.timestampToSeconds(expected.replace('.', 'x'), [format]), null);
});

test('validation gives actionable errors for malformed formats', () => {
  for (const [format, message] of [
    ['', /non-empty/], [' ', /hour.*minute/], ['HH', /hour.*minute/], ['mm:ss', /hour.*minute/],
    ['HH:mm HH', /duplicate hour/], ['HH:mm:m', /duplicate minute/],
    ['HH:mm:ss:s', /duplicate second/], ['hh:mm A a', /duplicate meridiem/],
    ['HHH:mm', /duplicate hour/], ['HH:mm h', /duplicate hour/],
    ['hh:mm', /require.*meridiem/], ['HH:mm A', /only allowed.*12-hour/],
    ['HH:MM', /Unsupported.*M/], ['HH:mm at', /Unsupported.*t/],
    ['HH:mm [at', /unclosed/], ['HH:mm at]', /Unsupported|unmatched/],
    ['HH:mm ]', /unmatched/], ['HH:mm [[at]]', /nested/],
    ['HH:mm\n', /one line/], ['HH:mm\r', /one line/], ['HH:mm\u2028', /one line/],
    ['HH:mm[\n]', /one line/], ['HH:mm' + '.'.repeat(76), /80 characters/],
    [' HH:mm', /whitespace/], ['HH:mm ', /whitespace/], ['[ ]HH:mm', /whitespace/], ['HH:mm [ ]', /whitespace/],
  ]) assert.throws(() => T.validateTimestampFormat(format), message, format);
  assert.doesNotThrow(() => T.validateTimestampFormat('HH:mm' + '.'.repeat(75)));
  assert.throws(() => T.formatTimestamp('HH:mm', new Date(NaN)), /invalid date/);
  assert.throws(() => T.formatTimestamp('HH:MM', date(9)), /Unsupported/);
});

test('parsing is exact and rejects out-of-range hours, minutes, seconds', () => {
  for (const value of ['24:00', '99:99', '23:60', '23:59:60', '24:00:00',
    '09:04\n', ' 09:04', '09:04 ', '09:04 rest', 'x09:04', '9:4', '9:04']) {
    assert.equal(T.timestampToSeconds(value), null, value);
  }
  for (const value of ['00:30 AM', '13:30 PM', '12:60 AM']) {
    assert.equal(T.timestampToSeconds(value, ['hh:mm A']), null, value);
  }
  assert.equal(T.timestampToSeconds('23:59:59'), 86399);
  assert.equal(T.timestampToSeconds('00:00'), 0);
  assert.equal(T.timestampToSeconds('9:4', ['H:m']), 32640);
  assert.equal(T.timestampToSeconds('24:4', ['H:m']), null);
  assert.equal(T.timestampToSeconds('9:60', ['H:m']), null);
  assert.equal(T.timestampToSeconds('9:4:60', ['H:m:s']), null);
  assert.equal(T.timestampToSeconds('11:59:59 PM', ['hh:mm:ss A']), 86399);
});

test('requested formats have priority; invalid formats are skipped before legacy fallback', () => {
  assert.equal(T.timestampToSeconds('12:09', ['mm:HH']), 9 * 3600 + 12 * 60);
  assert.equal(T.timestampToSeconds('09:04', ['bad', 'hh:mm']), 32640);
  // mm:HH is valid, but 34 is outside the hour range: legacy parsing succeeds.
  assert.equal(T.timestampToSeconds('12:34', ['mm:HH']), 12 * 3600 + 34 * 60);
});

test('saved formats retain all valid history, deduplicate, and include legacy formats', () => {
  const history = Object.freeze(['H时m分', 'HH:mm:ss', 'hh:mm a', 'H时m分', 'bad', '', 'hh:mm']);
  const settings = Object.freeze({ timestampFormat: 'hh:mm A', timestampFormatHistory: history });
  assert.deepEqual(T.getTimestampFormats(settings), ['hh:mm A', 'H时m分', 'HH:mm:ss', 'hh:mm a', 'HH:mm']);
  assert.deepEqual(T.getTimestampFormats({}), ['HH:mm', 'HH:mm:ss']);
  assert.deepEqual(T.getTimestampFormats({ timestampFormat: 'bad' }), ['HH:mm', 'HH:mm:ss']);
  for (const settings of [undefined, null, { timestampFormat: 42, timestampFormatHistory: 42 }]) {
    assert.deepEqual(T.getTimestampFormats(settings), ['HH:mm', 'HH:mm:ss']);
    assert.doesNotThrow(() => new RegExp(T.getTimestampPattern(settings)));
  }
  const formats = T.getTimestampFormats(settings);
  assert.equal(T.timestampToSeconds('9时4分', formats), 32640);
  assert.equal(T.timestampToSeconds('09:04:05', formats), 32645);
});

test('combined pattern includes strict current/history formats and advanced legacy regex', () => {
  const settings = {
    timestampFormat: 'hh:mm A',
    timestampFormatHistory: ['HH时mm分', 'HH:mm ss'],
    timestampPattern: '(?<=@)(?:\\d{1,2})点(?=!)',
  };
  const source = T.getTimestampPattern(settings);
  assert.ok(source.includes(`(?:${settings.timestampPattern})`));
  const pattern = new RegExp(source);
  assert.equal(pattern.exec('01:04 PM entry')[0], '01:04 PM');
  assert.equal(pattern.exec('09时04分 entry')[0], '09时04分');
  assert.equal(pattern.exec('@9点!')[0], '9点');
  assert.equal(pattern.exec('09:04 05 entry')[0], '09:04 05');
  assert.equal(pattern.exec('09:04:05 entry')[0], '09:04:05');
  const exact = new RegExp(`^(?:${source})$`);
  assert.equal(exact.test('13:04 PM'), false);
  assert.equal(exact.test('24时00分'), false);
  assert.equal(exact.test('09时60分'), false);
  assert.equal(exact.test('09:04 60'), false);
  // The legacy default remains deliberately compatible with the original regex.
  assert.equal(new RegExp(T.getTimestampPattern({})).test('09:04'), true);
  for (const timestampPattern of ['(', '', null, 42, '\n']) {
    assert.doesNotThrow(() => new RegExp(T.getTimestampPattern({ timestampPattern, timestampFormat: 'bad' })));
  }
});

test('seconds provide chronological sort values across mixed formats', () => {
  const formats = ['h:mm:ss a', 'HH时mm分ss秒'];
  const times = ['1:00:01 pm', '12:00:00 am', '13时00分00秒', '12:00:00 pm', '00:00:01'];
  assert.deepEqual(times.map(value => T.timestampToSeconds(value, formats)), [46801, 0, 46800, 43200, 1]);
  assert.deepEqual([...times].sort((a, b) => T.timestampToSeconds(a, formats) - T.timestampToSeconds(b, formats)),
    ['12:00:00 am', '00:00:01', '12:00:00 pm', '13时00分00秒', '1:00:01 pm']);
});
