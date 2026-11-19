/** Pure local-time formatting and parsing shared by capture, sections, and stats. */
export interface TimeSettings {
  timestampPattern?: string;
  timestampFormat?: string;
  timestampFormatHistory?: readonly string[];
}

type Unit = 'hour' | 'minute' | 'second' | 'meridiem';
type Part = { literal: string } | { token: string; unit: Unit };

function parseFormat(format: string): Part[] {
  if (typeof format !== 'string' || format.length === 0) {
    throw new Error('Timestamp format must be a non-empty string.');
  }
  if (format.length > 80) throw new Error('Timestamp format must be at most 80 characters.');
  if (/[\r\n\u2028\u2029]/.test(format)) throw new Error('Timestamp format must fit on one line.');

  const parts: Part[] = [];
  const units = new Set<Unit>();
  let twelveHour = false;
  for (let index = 0; index < format.length;) {
    const character = format[index];
    if (character === '[') {
      const end = format.indexOf(']', index + 1);
      if (end < 0) throw new Error('Timestamp format has an unclosed literal block; add ].');
      const literal = format.slice(index + 1, end);
      if (literal.includes('[')) throw new Error('Timestamp literal blocks cannot be nested.');
      parts.push({ literal });
      index = end + 1;
      continue;
    }
    if (character === ']') throw new Error('Timestamp format has an unmatched ].');
    let unit: Unit | undefined;
    if ('Hh'.includes(character)) unit = 'hour';
    else if (character === 'm') unit = 'minute';
    else if (character === 's') unit = 'second';
    else if ('Aa'.includes(character)) unit = 'meridiem';
    if (unit) {
      const doubled = unit !== 'meridiem' && format[index + 1] === character;
      const token = doubled ? character + character : character;
      if (units.has(unit)) throw new Error(`Timestamp format has a duplicate ${unit} token.`);
      units.add(unit);
      parts.push({ token, unit });
      if (unit === 'hour') twelveHour = character === 'h';
      index += token.length;
    } else {
      if (/[A-Za-z]/.test(character)) {
        throw new Error(`Unsupported timestamp token "${character}"; put literal text in [brackets].`);
      }
      parts.push({ literal: character });
      index++;
    }
  }
  if (!units.has('hour') || !units.has('minute')) {
    throw new Error('Timestamp format requires one hour token (HH/H or hh/h) and one minute token (mm/m).');
  }
  const sample = parts.map(part => 'literal' in part ? part.literal : '0').join('');
  if (sample.trim() !== sample) {
    throw new Error('Timestamp format must not begin or end with whitespace.');
  }
  if (twelveHour && !units.has('meridiem')) {
    throw new Error('12-hour timestamps (hh/h) require a meridiem token (A/a).');
  }
  if (!twelveHour && units.has('meridiem')) {
    throw new Error('Meridiem (A/a) is only allowed with 12-hour timestamps (hh/h).');
  }
  return parts;
}

export function validateTimestampFormat(format: string): void {
  parseFormat(format);
}

export function formatTimestamp(format = 'HH:mm', date: Date = new Date()): string {
  const parts = parseFormat(format);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('Cannot format an invalid date.');
  }
  return parts.map(part => {
    if ('literal' in part) return part.literal;
    const { token, unit } = part;
    if (unit === 'meridiem') {
      const meridiem = date.getHours() < 12 ? 'AM' : 'PM';
      return token === 'a' ? meridiem.toLowerCase() : meridiem;
    }
    const value = unit === 'hour'
      ? (token[0] === 'h' ? date.getHours() % 12 || 12 : date.getHours())
      : unit === 'minute' ? date.getMinutes() : date.getSeconds();
    return token.length === 2 ? String(value).padStart(2, '0') : String(value);
  }).join('');
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenPattern(token: string): string {
  switch (token) {
    case 'HH': return '(?:[01]\\d|2[0-3])';
    case 'H': return '(?:[01]?\\d|2[0-3])';
    case 'hh': return '(?:0[1-9]|1[0-2])';
    case 'h': return '(?:0?[1-9]|1[0-2])';
    case 'mm': case 'ss': return '[0-5]\\d';
    case 'm': case 's': return '[0-5]?\\d';
    case 'A': return '(?:AM|PM)';
    case 'a': return '(?:am|pm)';
    default: throw new Error(`Unsupported timestamp token "${token}".`);
  }
}

function formatPattern(parts: Part[], capture = false): string {
  return parts.map(part => 'literal' in part
    ? escapeRegex(part.literal)
    : capture ? `(${tokenPattern(part.token)})` : tokenPattern(part.token)).join('');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item: unknown): item is string => typeof item === 'string')
    : [];
}

/** Parse exact timestamps, preserving seconds for chronological sorting. */
export function timestampToSeconds(timestamp: string, formats: readonly string[] = []): number | null {
  if (typeof timestamp !== 'string') return null;
  const candidates = [...stringArray(formats), 'HH:mm:ss', 'HH:mm'];
  for (const format of new Set(candidates)) {
    let parts: Part[];
    try { parts = parseFormat(format); } catch { continue; }
    // Unlike $, this end assertion cannot accept a trailing newline.
    const match = new RegExp(`^${formatPattern(parts, true)}(?![\\s\\S])`).exec(timestamp);
    if (!match) continue;
    let hour = 0;
    let minute = 0;
    let second = 0;
    let meridiem = '';
    let group = 1;
    for (const part of parts) {
      if ('literal' in part) continue;
      const value = match[group++];
      if (part.unit === 'hour') hour = Number(value);
      else if (part.unit === 'minute') minute = Number(value);
      else if (part.unit === 'second') second = Number(value);
      else meridiem = value;
    }
    if (meridiem) hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    return hour * 3600 + minute * 60 + second;
  }
  return null;
}

/** Invalid saved formats are ignored; they never become generated regex sources. */
export function getTimestampFormats(settings: TimeSettings): string[] {
  const current = settings?.timestampFormat;
  const history = settings?.timestampFormatHistory;
  const candidates = [current === undefined ? 'HH:mm' : current,
    ...stringArray(history), 'HH:mm', 'HH:mm:ss'];
  return [...new Set(candidates.filter(format => {
    try { validateTimestampFormat(format); return true; } catch { return false; }
  }))];
}

/** Keep the user's advanced regex as a fallback without rewriting its source. */
export function getTimestampPattern(settings: TimeSettings): string {
  const legacyPattern = '\\d{2}:\\d{2}';
  let fallback = settings?.timestampPattern;
  if (typeof fallback !== 'string' || !fallback || /[\r\n\u2028\u2029]/.test(fallback)) {
    fallback = legacyPattern;
  }
  try { new RegExp(fallback); } catch { fallback = legacyPattern; }
  // Prefer more specific formats when one timestamp is a prefix of another.
  const generated = getTimestampFormats(settings)
    .sort((left, right) => right.length - left.length)
    .map(format => `(?:${formatPattern(parseFormat(format))})`);
  return `(?:${generated.join('|')}|(?:${fallback}))`;
}
