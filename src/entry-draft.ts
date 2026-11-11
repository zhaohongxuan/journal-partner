import { normalizeTag } from './section';

export interface EntryDraft {
  /** Canonical #tags, deduplicated in their original order. */
  tags: string[];
  /** The body is always a verbatim suffix of the source draft. */
  body: string;
  /** Original tag prefix, including one separator, for lossless rejoining. */
  prefix?: string;
}

function canonicalTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
}

/**
 * Split only complete hashtag tokens at the start of a draft. Stop at the
 * first body token, leaving inline tags, Markdown and embeds untouched.
 * One whitespace separator belongs to the prefix; any further whitespace
 * belongs to the body (a CRLF pair counts as one separator).
 */
export function splitEntryDraft(text: string): EntryDraft {
  const tags: string[] = [];
  const tokens = /\S+/g;
  let prefixEnd = 0;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text)) !== null) {
    const normalized = normalizeTag(token[0]);
    // normalizeTag also accepts bare tags and repeated # characters, which
    // must remain body text when parsing an existing Markdown draft.
    if (!token[0].startsWith('#') || normalized !== token[0]) break;
    tags.push(normalized);
    prefixEnd = tokens.lastIndex;
  }
  if (tags.length === 0) return { tags: [], body: text };

  if (text.slice(prefixEnd, prefixEnd + 2) === '\r\n') prefixEnd += 2;
  else if (/\s/.test(text.charAt(prefixEnd)) && prefixEnd < text.length) prefixEnd++;

  return {
    tags: canonicalTags(tags),
    body: text.slice(prefixEnd),
    prefix: text.slice(0, prefixEnd),
  };
}

/**
 * Join canonical, deduplicated tags with an entirely unchanged body. Passing
 * the prefix returned by splitEntryDraft preserves its original formatting
 * when its tags are unchanged; otherwise the prefix uses single spaces.
 */
export function joinEntryDraft(tags: readonly string[], body: string, prefix?: string): string {
  const normalized = canonicalTags(tags);
  if (normalized.length === 0) return body;
  if (prefix !== undefined) {
    const original = splitEntryDraft(prefix);
    if (original.body === '' && original.tags.length === normalized.length
      && original.tags.every((tag, index) => tag === normalized[index])) {
      return prefix + body;
    }
  }
  return normalized.join(' ') + (body.length > 0 ? ` ${body}` : '');
}
