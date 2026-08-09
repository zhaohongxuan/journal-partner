/**
 * Shared section + timestamp utilities.
 *
 * Used by both the editor extensions in `main.ts` and the capture sidebar
 * view in `capture-view.ts`. Keeps the source of truth for section detection
 * and timestamp parsing in one place.
 */

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';

// ── Types & defaults ────────────────────────────────────────────────────────

export interface JournalPartnerSettings {
  /** The heading text that activates the plugin (without # symbols) */
  targetHeading: string;
  /** Heading level: 1 → #, 2 → ##, … */
  headingLevel: number;
  /** Regex pattern whose first match (or capture group 1) is the timestamp */
  timestampPattern: string;
  /** Foreground color of the timestamp badge (light theme) */
  timestampColor: string;
  /** Background color of the timestamp badge (light theme) */
  timestampBgColor: string;
  /** Foreground color of the timestamp badge (dark theme) */
  timestampColorDark: string;
  /** Background color of the timestamp badge (dark theme) */
  timestampBgColorDark: string;
  /** When true, editing a timestamp in the editor is blocked */
  readonlyTimestamps: boolean;
  /** When true, pressing Enter inside the journal section auto-inserts a timestamp on the new line */
  autoTimestamp: boolean;
  /** OpenAI-compatible audio transcription endpoint (e.g. https://api.openai.com/v1/audio/transcriptions). Empty disables STT. */
  sttEndpoint: string;
  /** Bearer API key sent to the STT endpoint. */
  sttApiKey: string;
  /** Model name passed in the multipart `model` field (e.g. whisper-1, whisper-large-v3). */
  sttModel: string;
  /** ISO-639-1 language hint passed as `language` (e.g. zh, en). Empty lets the model auto-detect. */
  sttLanguage: string;
  /** When true, transcription runs live in ~1.5s chunks while recording (dictation-style). */
  sttRealtime: boolean;
  /** Vault-relative folder for saving audio recordings. Empty uses Obsidian's attachment folder. */
  recordingFolder: string;
  /** Vault-relative folder for saving pasted/uploaded images. Empty uses Obsidian's attachment folder. */
  imageFolder: string;
  /** Keyboard shortcut to submit entry: 'shift+enter' | 'ctrl+enter' | 'alt+enter' | 'ctrl+shift+enter' */
  submitShortcut: string;
  /** Entry display order in the timeline: 'desc' (newest first, default) | 'asc' (oldest first) */
  sortOrder: 'desc' | 'asc';
}

export const DEFAULT_SETTINGS: JournalPartnerSettings = {
  targetHeading: 'Journal',
  headingLevel: 2,
  timestampPattern: '\\d{2}:\\d{2}',
  timestampColor: '#7c3aed',
  timestampBgColor: '#ede9fe',
  timestampColorDark: '#a78bfa',
  timestampBgColorDark: '#2e1065',
  readonlyTimestamps: true,
  autoTimestamp: true,
  sttEndpoint: '',
  sttApiKey: '',
  sttModel: 'whisper-1',
  sttLanguage: 'zh',
  sttRealtime: true,
  recordingFolder: '',
  imageFolder: '',
  submitShortcut: 'shift+enter',
  sortOrder: 'desc',
};

export type Rng = { from: number; to: number };

/** A single parsed timeline entry from the journal section. */
export interface JournalEntry {
  /** Raw timestamp text, e.g. "16:17" */
  timestamp: string;
  /** Body text after the timestamp, may include continuation from indented child lines */
  text: string;
  /** Source line index inside the section (0-based, for stable ordering) */
  lineIndex: number;
  /** Entry type: 'memo' (default) or 'task' (checkbox-based) */
  type?: 'memo' | 'task';
  /** For task entries: whether the task is completed */
  completed?: boolean;
}

// ── Section detection ──────────────────────────────────────────────────────

/**
 * Find the character range occupied by the body of a heading section.
 * Returns null if the heading is not found.
 */
export function findSection(
  doc: string,
  headingName: string,
  headingLevel: number,
): Rng | null {
  const prefix = '#'.repeat(headingLevel) + ' ';
  const lines = doc.split('\n');
  let charOffset = 0;
  let startOffset = -1;

  for (const line of lines) {
    if (startOffset === -1) {
      if (
        line.startsWith(prefix) &&
        line.slice(prefix.length).trim() === headingName
      ) {
        // Section body starts on the next line
        startOffset = charOffset + line.length + 1;
      }
    } else {
      // A heading of the same level or higher ends the section
      const m = line.match(/^(#+)\s/);
      if (m && m[1].length <= headingLevel) {
        return { from: startOffset, to: charOffset };
      }
    }
    charOffset += line.length + 1;
  }

  return startOffset === -1 ? null : { from: startOffset, to: doc.length };
}

/**
 * Collect the document character ranges that contain timestamp text inside
 * the target section.
 */
export function getTimestampRanges(
  doc: string,
  settings: JournalPartnerSettings,
): Rng[] {
  const section = findSection(
    doc,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return [];

  // Match optional list-marker prefix with optional checkbox, then capture the timestamp
  // Handles both:
  // - Memo: `- HH:MM text`
  // - Task: `- [ ] HH:MM text` or `- [x] HH:MM text`
  const linePattern = new RegExp(
    `^(?:[-*+]\\s+(?:\\[[\\sx]\\]\\s+)?)?(${settings.timestampPattern})(?=\\s|$)`,
  );

  const sectionText = doc.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  const result: Rng[] = [];
  let offset = section.from;

  for (const line of lines) {
    const m = linePattern.exec(line);
    if (m?.[1] !== undefined) {
      const prefixLen = m[0].length - m[1].length;
      const from = offset + (m.index ?? 0) + prefixLen;
      result.push({ from, to: from + m[1].length });
    }
    offset += line.length + 1; // +1 for the newline character
  }

  return result;
}

/** Generate a timestamp string for the current local time in HH:MM format. */
export function generateTimestamp(): string {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, '0') +
    ':' +
    String(now.getMinutes()).padStart(2, '0')
  );
}

/** Build a CM6 DecorationSet that marks every timestamp in the target section. */
export function buildDecorations(
  doc: string,
  settings: JournalPartnerSettings,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.mark({
    class: 'jp-timestamp',
    inclusiveStart: false,
    inclusiveEnd: false,
  });

  for (const { from, to } of getTimestampRanges(doc, settings)) {
    builder.add(from, to, mark);
  }

  return builder.finish();
}

// ── Capture-view helpers ───────────────────────────────────────────────────

/**
 * Parse the body of a journal section into ordered timeline entries.
 *
 * Rules:
 * - Top-level list items (`- HH:MM ...`, `* HH:MM ...`, `+ HH:MM ...`) become entries
 * - Indented continuation lines (any leading whitespace) are appended to the
 *   previous entry's text, joined with a space — supports markdown soft breaks
 *   produced by `buildEntryLine` for multi-line input
 * - Lines without a timestamp at the top level are skipped
 */
/**
 * Parse the body of a journal section into ordered timeline entries.
 *
 * Rules:
 * - Top-level list items (`- HH:MM ...`, `* HH:MM ...`, `+ HH:MM ...`) become entries
 * - Indented continuation lines (any leading whitespace) are appended to the
 *   previous entry's text, joined with a newline so the markdown renderer
 *   sees the original structure (soft breaks, lists, etc.)
 * - Lines without a timestamp at the top level are skipped
 */
export function parseJournalEntries(
  sectionText: string,
  pattern: string,
): JournalEntry[] {
  // Match list items with optional checkbox: `- [ ] ...`, `- [x] ...`, or `- ...`
  // Format 1 (new): `- [ ] HH:MM text` or `- [x] HH:MM text`
  // Format 2 (legacy): `- HH:MM [ ] text` or `- HH:MM [x] text`
  // Format 3 (memo): `- HH:MM text`
  const taskListRe = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
  const tsRe = new RegExp(`^[-*+]\\s+(${pattern})\\s+(.*)$`);
  const legacyTaskRe = /^\s*\[([ xX])\]\s*(.*)$/;

  // Normalize line endings (CRLF / lone CR → LF). Otherwise a trailing "\r"
  // breaks the `(.*)$` anchor below — `.` won't match CR and `$` (no `m`
  // flag) won't anchor before it, so every entry silently fails to parse on
  // Windows/iCloud-synced files.
  const lines = sectionText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const entries: JournalEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Indented line → continuation of previous entry. Strip the 2-space
    // continuation indent that buildEntryLine adds, but preserve the rest
    // (including a trailing soft-break "  ") so MarkdownRenderer sees the
    // original line structure.
    if (entries.length > 0 && /^\s+\S/.test(raw)) {
      const cont = raw.replace(/^\s{0,2}/, '');
      entries[entries.length - 1].text += '\n' + cont;
      continue;
    }

    // Try to match new task format first: `- [ ] HH:MM text`
    const taskMatch = taskListRe.exec(raw);
    if (taskMatch) {
      const checkbox = taskMatch[1];
      const content = taskMatch[2];
      // Extract timestamp from the rest of content
      const tsMatch = new RegExp(`^(${pattern})\\s+(.*)$`).exec(content);
      if (tsMatch) {
        entries.push({
          timestamp: tsMatch[1],
          text: tsMatch[2],
          lineIndex: i,
          type: 'task',
          completed: checkbox.toLowerCase() === 'x',
        });
        continue;
      }
    }

    // Try to match memo/legacy task format: `- HH:MM text`
    const m = tsRe.exec(raw);
    if (!m) continue;

    const content = m[2];
    // Check for legacy task format: `HH:MM [ ] text` or `HH:MM [x] text`
    const legacyMatch = legacyTaskRe.exec(content);

    if (legacyMatch) {
      // This is a legacy task entry
      const checkbox = legacyMatch[1];
      const taskText = legacyMatch[2];
      entries.push({
        timestamp: m[1],
        text: taskText,
        lineIndex: i,
        type: 'task',
        completed: checkbox.toLowerCase() === 'x',
      });
    } else {
      // Regular memo entry
      entries.push({
        timestamp: m[1],
        text: content,
        lineIndex: i,
        type: 'memo',
      });
    }
  }

  return entries;
}

/**
 * Sort parsed journal entries by timestamp, respecting the configured
 * direction. Ties (identical timestamps) break by source line order scaled
 * to the direction: descending puts the most recently typed entry on top,
 * ascending keeps insertion order.
 *
 * `order === 'desc'` reproduces the previous hard-coded behaviour exactly.
 */
export function sortJournalEntries<T extends { timestamp: string; lineIndex: number }>(
  entries: readonly T[],
  order: 'asc' | 'desc',
): T[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const cmp =
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
    if (cmp !== 0) return cmp * dir;
    return (a.lineIndex - b.lineIndex) * dir;
  });
}

/**
 * Construct a task entry line to append to the section.
 *
 * Format: `- [ ] HH:MM text` (incomplete) or `- [x] HH:MM text` (completed)
 * This matches Obsidian's native task checkbox syntax.
 */
export function buildTaskLine(text: string, ts: string, completed: boolean, marker = '-'): string {
  const checkbox = completed ? '[x]' : '[ ]';
  const trimmed = text.trim();
  if (trimmed.length === 0) return `${marker} ${checkbox} ${ts} `;

  const parts = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (parts.length === 1) {
    return `${marker} ${checkbox} ${ts} ${parts[0]}`;
  }

  const head = `${marker} ${checkbox} ${ts} ${parts[0]}  `;
  const tail = parts
    .slice(1)
    .map((line, idx) =>
      idx === parts.length - 2 ? `  ${line}` : `  ${line}  `,
    );
  return [head, ...tail].join('\n');
}

/**
 * Construct a journal entry line to append to the section.
 *
 * Single-line input becomes `- HH:MM text`.
 * Multi-line input uses markdown soft-breaks (two trailing spaces) so the
 * entry stays inside the same list item:
 *
 *   - 16:17 first line
 *     second line
 *     third line
 *
 * Each line (except possibly the last) ends with two spaces to render as a
 * soft break in markdown. Continuation lines are indented with two spaces so
 * they belong to the same list item.
 */
export function buildEntryLine(text: string, ts: string, marker = '-'): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return `${marker} ${ts} `;

  const parts = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (parts.length === 1) {
    return `${marker} ${ts} ${parts[0]}`;
  }

  const head = `${marker} ${ts} ${parts[0]}  `;
  const tail = parts
    .slice(1)
    .map((line, idx) =>
      idx === parts.length - 2 ? `  ${line}` : `  ${line}  `,
    );
  return [head, ...tail].join('\n');
}

/**
 * Append a built entry line to the journal section of `content`.
 *
 * - If the section exists, the line is inserted at the section's end (just
 *   before the next heading of the same/higher level, or end-of-file).
 * - If the section does not exist, the heading + line are appended to the
 *   end of the document.
 *
 * Whitespace handling: the result always has exactly one trailing newline
 * after the inserted line, and no duplicated blank lines stacked at the
 * insertion point.
 */
export function appendToJournalSection(
  content: string,
  settings: JournalPartnerSettings,
  line: string,
): string {
  const section = findSection(
    content,
    settings.targetHeading,
    settings.headingLevel,
  );

  if (!section) {
    // Section absent — create it at the end of the document
    const prefix = '#'.repeat(settings.headingLevel) + ' ' + settings.targetHeading;
    const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    const headingBlock = `${sep}\n${prefix}\n${line}\n`;
    return content + headingBlock;
  }

  // Section exists — insert just before section.to.
  // Trim any trailing blank-line run at the insertion point so we don't
  // accumulate empty lines on every append.
  const before = content.slice(0, section.to);
  const after = content.slice(section.to);

  const beforeTrimmed = before.replace(/\n+$/, '');
  const insertion = `\n${line}\n`;

  if (after.length === 0) {
    return beforeTrimmed + insertion;
  }
  // `after` starts at the next heading line — prepend a blank-line separator
  return beforeTrimmed + insertion + '\n' + after;
}

// ── Entry mutation helpers (delete / extract embedded audio) ───────────────

/** Recognized audio file extensions for the "delete-with-audio" feature. */
const AUDIO_EXT_RE = /\.(m4a|mp3|wav|ogg|flac|opus|aac|webm)$/i;

/**
 * Extract the vault-relative paths of all audio attachments wiki-embedded in
 * an entry's body text. Picks up `![[Assets/audio/x.m4a]]`, optional
 * `|alias`/`|size` segments are tolerated; the alias is stripped.
 *
 * Non-audio embeds (images, PDFs, other notes) are ignored, so this is safe
 * to call on any entry text.
 */
export function extractAudioEmbeds(text: string): string[] {
  const out: string[] = [];
  const re = /!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    if (path.length > 0 && AUDIO_EXT_RE.test(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Remove one entry (identified by its `lineIndex` within the section body)
 * from the given full document content.
 *
 * Behaviour:
 * - Locates the journal section via `findSection`
 * - Deletes the head line at `lineIndex` *plus* any immediately following
 *   continuation lines (lines that start with whitespace + non-whitespace),
 *   matching the rule in `parseJournalEntries`
 * - Returns the new content. If the section is missing or `lineIndex` is
 *   out of range / not a valid entry head, returns the original content
 *   unchanged.
 *
 * Whitespace handling: we slice on full-line boundaries so the surrounding
 * document is left clean — no orphan blank lines accumulate.
 */
export function deleteEntryFromSection(
  content: string,
  settings: JournalPartnerSettings,
  lineIndex: number,
): string {
  const section = findSection(
    content,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return content;

  const sectionText = content.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return content;

  // Validate that the target line is an entry head, not a continuation or
  // unrelated line — avoids "deleting from the middle of a multi-line memo".
  const tsRe = new RegExp(`^[-*+]\\s+(${settings.timestampPattern})(?=\\s|$)`);
  if (!tsRe.test(lines[lineIndex])) return content;

  // Find end (exclusive) of the entry: head + continuation lines.
  let end = lineIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) {
    end++;
  }

  // Compute character offsets within the section body, then translate to
  // full-document offsets.
  let charStart = 0;
  for (let i = 0; i < lineIndex; i++) {
    charStart += lines[i].length + 1; // +1 for newline
  }
  let charEnd = charStart;
  for (let i = lineIndex; i < end; i++) {
    charEnd += lines[i].length + 1;
  }
  // If the entry ran to the very last line (no trailing newline), pull back
  // the +1 we over-counted on that last line.
  if (end === lines.length) {
    charEnd -= 1;
    // And also chew up the newline preceding the entry, if any, so we don't
    // leave a trailing blank line in the section body.
    if (charStart > 0 && sectionText[charStart - 1] === '\n') {
      charStart -= 1;
    }
  }

  const absStart = section.from + charStart;
  const absEnd = section.from + charEnd;
  return content.slice(0, absStart) + content.slice(absEnd);
}

/**
 * Replace the body of one entry (identified by its `lineIndex` within the
 * section body) with `newText`, preserving the original list marker and
 * timestamp.
 *
 * Behaviour mirrors `deleteEntryFromSection` for locating the entry head +
 * continuation lines; instead of dropping them, the whole block is replaced
 * by a rebuilt block produced via `buildEntryLine` (using the original
 * marker). Returns the new content, or the original content unchanged if the
 * section is missing / `lineIndex` is out of range / not a valid entry head
 * (e.g. the file changed under us).
 */
export function editEntryInSection(
  content: string,
  settings: JournalPartnerSettings,
  lineIndex: number,
  newText: string,
): string {
  const section = findSection(
    content,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return content;

  const sectionText = content.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return content;

  // Extract the original list marker + timestamp from the head line so the
  // rebuilt entry stays consistent with the surrounding list style.
  const tsRe = new RegExp(`^([-*+])\\s+(${settings.timestampPattern})(?=\\s|$)`);
  const headMatch = tsRe.exec(lines[lineIndex]);
  if (!headMatch) return content;
  const marker = headMatch[1];
  const ts = headMatch[2];

  // Find end (exclusive) of the entry: head + continuation lines.
  let end = lineIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) {
    end++;
  }

  const replacement = buildEntryLine(newText, ts, marker);
  const newLines = [
    ...lines.slice(0, lineIndex),
    ...replacement.split('\n'),
    ...lines.slice(end),
  ];
  const newSectionText = newLines.join('\n');
  return content.slice(0, section.from) + newSectionText + content.slice(section.to);
}

/**
 * Strip all audio wiki-embeds from one entry, in place inside the section,
 * leaving the rest of the entry's text intact.
 *
 * Used by the "仅删除录音文件" context-menu action: the user wants to keep
 * the typed memo but jettison the recording. The function:
 * 1. Locates the entry head at `lineIndex` (returns content unchanged if
 *    that line isn't a valid entry head, mirroring `deleteEntryFromSection`)
 * 2. Walks head + continuation lines, removing `![[*.m4a]]` etc. tokens
 * 3. Collapses whitespace left behind by removals so the rendered output
 *    doesn't have double spaces or a dangling separator
 *
 * Returns the new document content. Non-audio embeds are preserved.
 */
export function removeAudioEmbedsFromEntry(
  content: string,
  settings: JournalPartnerSettings,
  lineIndex: number,
): string {
  const section = findSection(
    content,
    settings.targetHeading,
    settings.headingLevel,
  );
  if (!section) return content;

  const sectionText = content.slice(section.from, section.to);
  const lines = sectionText.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return content;

  const tsRe = new RegExp(`^[-*+]\\s+(${settings.timestampPattern})(?=\\s|$)`);
  if (!tsRe.test(lines[lineIndex])) return content;

  // Find inclusive range of this entry: head + continuation lines.
  let end = lineIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) {
    end++;
  }

  // Audio-embed regex: must match the same shape as extractAudioEmbeds.
  const audioEmbedRe = /!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

  let changed = false;
  for (let i = lineIndex; i < end; i++) {
    const before = lines[i];
    const after = before.replace(audioEmbedRe, (full, path: string) => {
      if (AUDIO_EXT_RE.test(path.trim())) {
        changed = true;
        return '';
      }
      return full;
    });
    if (!changed && after === before) continue;
    // Tidy up: collapse internal double spaces and trim trailing spaces
    // left where the embed used to sit. Keep markdown soft-break "  "
    // intact at line end (parseJournalEntries relies on it).
    let tidy = after.replace(/[^\S\n]{2,}/g, ' ');
    // Restore intentional soft-break (two trailing spaces) if the line
    // was originally a non-final continuation row in a multi-line entry.
    const wasSoftBreak = /[^\S\n] {2}$/.test(before) || / {2}$/.test(before);
    if (wasSoftBreak && !/ {2}$/.test(tidy)) {
      tidy = tidy.replace(/\s+$/, '') + '  ';
    } else {
      tidy = tidy.replace(/[^\S\n]+$/, '');
    }
    lines[i] = tidy;
  }

  if (!changed) return content;

  // Edge case: if the head line is now just `- HH:MM` with no body, that's
  // still a valid (empty) entry — leave it. parseJournalEntries will show
  // it with an empty bubble, which matches the user's expectation: they
  // explicitly asked to keep the memo.

  const newSection = lines.join('\n');
  return content.slice(0, section.from) + newSection + content.slice(section.to);
}
