/**
 * Random WeRead highlight ("金句") support for the capture input.
 *
 * Data source: the official WeRead agent gateway, authenticated with an API
 * key — no dependency on the weread sync plugin or on synced markdown notes.
 *
 * Cost model (intentionally simple, no preheating):
 *   - notebook list: 1 request per session, then memory + disk cache (24h TTL)
 *   - one book's highlights + popular list: 2 requests on first use, then
 *     memory + disk cache (7d TTL). Re-picking the same book costs nothing.
 *   - every pick therefore starts from cache and only occasionally hits the
 *     network.
 */

import { App, TFile, requestUrl } from 'obsidian';
import type { JournalPartnerSettings } from './section';

// ── Constants ───────────────────────────────────────────────────────────────

const GATEWAY_URL = 'https://i.weread.qq.com/api/agent/gateway';
/** Latest skill version advertised by the gateway (upgrade_info said 1.0.4). */
const SKILL_VERSION = '1.0.4';
const NOTEBOOK_TTL_MS = 24 * 60 * 60 * 1000;
const BOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Highlights shorter/longer than this are skipped — they are not usable 金句. */
const MIN_QUOTE_LEN = 8;
const MAX_QUOTE_LEN = 200;
/** How many books to try before giving up on finding a usable quote. */
const REROLL_LIMIT = 8;
/**
 * Books the user finished are this many times more likely to be picked. These
 * are the ones worth re-reading a line from — verified 208/563 finished books.
 */
const FINISHED_BOOK_BOOST = 3;
/**
 * Bump whenever a cache shape changes, so stale shards are refetched instead of
 * being read with missing fields.
 *  v2 — notebook entries carry `finished`.
 */
const CACHE_VERSION = 2;

/** frontmatter marker written by the weread plugin; used to resolve [[links]]. */
export const WEREAD_DOC_TYPE = 'weread-highlights-reviews';

// ── Gateway response shapes ─────────────────────────────────────────────────

interface AgentEnvelope {
  errcode?: number;
  errmsg?: string;
}

interface RawNotebookBook {
  bookId?: string;
  noteCount?: number;
  /** Paging cursor — pass the last book's `sort` back as `lastSort`. */
  sort?: number;
  /** 1=unmarked, 2=reading, 3=read, 4=finished. */
  markedStatus?: number;
  readingProgress?: number;
  book?: { title?: string; author?: string; cover?: string };
}

interface RawNotebooks extends AgentEnvelope {
  books?: RawNotebookBook[];
  totalBookCount?: number;
  hasMore?: number;
}

interface RawBookmark {
  bookmarkId?: string;
  markText?: string;
  chapterUid?: number;
  range?: string;
  createTime?: number;
}

interface RawBookmarkList extends AgentEnvelope {
  updated?: RawBookmark[];
  chapters?: { chapterUid?: number; title?: string }[];
  synckey?: number;
}

interface RawPopularItem {
  bookmarkId?: string;
  markText?: string;
  chapterUid?: number;
  range?: string;
  totalCount?: number;
}

interface RawBestBookmarks extends AgentEnvelope {
  items?: RawPopularItem[];
  totalCount?: number;
  synckey?: number;
}

// ── Cache shapes ────────────────────────────────────────────────────────────

export interface CachedHighlight {
  bookmarkId: string;
  markText: string;
  chapterUid: number;
  range: string;
  createTime: number;
}

export interface CachedPopular {
  bookmarkId: string;
  markText: string;
  chapterUid: number;
  range: string;
  totalCount: number;
}

export interface CachedChapter {
  chapterUid: number;
  title: string;
}

export interface CachedBook {
  version: number;
  bookId: string;
  title: string;
  author: string;
  fetchedAt: number;
  synckey: number;
  popularSynckey: number;
  chapters: CachedChapter[];
  highlights: CachedHighlight[];
  popular: CachedPopular[];
}

/** One book in the notebook list — the pool a random quote is drawn from. */
export interface NotebookEntry {
  bookId: string;
  title: string;
  author: string;
  /** Highlights in the book, straight from the notebook list (no extra request). */
  noteCount: number;
  /** WeRead `markedStatus === 4` (读完). */
  finished: boolean;
}

interface CachedNotebooks {
  version: number;
  fetchedAt: number;
  books: NotebookEntry[];
}

// ── Public types ────────────────────────────────────────────────────────────

/** One pickable highlight, already merged (mine + popular) and weighted. */
export interface ReadingQuote {
  /** Stable identity of the underlying highlight. */
  key: string;
  bookId: string;
  title: string;
  author: string;
  chapter: string;
  text: string;
  /** My own highlight (vault-side) */
  isMine: boolean;
  /** Listed in the book's popular highlights */
  isPopular: boolean;
  /** Readers who highlighted it (0 when unknown) */
  readers: number;
  /** Sampling weight — see `buildCandidates`. */
  weight: number;
  /** 'YYYY-MM-DD' the highlight was made, empty when unknown (others' popular highlights carry no date). */
  date: string;
  /** 'HH:MM' the highlight was made, empty when unknown. */
  time: string;
}

// ── Session-level memory cache ──────────────────────────────────────────────

let notebooksMemo: CachedNotebooks | null = null;
const bookMemo = new Map<string, CachedBook>();
/** bookId → vault path of the synced weread note, for building [[links]]. */
let notePathMemo: Map<string, string> | null = null;

/** Forget every in-memory cache (used by the settings "clear cache" action). */
export function clearQuoteMemo(): void {
  notebooksMemo = null;
  bookMemo.clear();
  notePathMemo = null;
}

// ── Gateway client ──────────────────────────────────────────────────────────

/**
 * Call one gateway endpoint. Returns `null` on any error (network, HTTP,
 * non-zero `errcode`) so callers can degrade gracefully instead of throwing.
 */
async function callAgent<T extends AgentEnvelope>(
  apiKey: string,
  apiName: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const resp = await requestUrl({
      url: GATEWAY_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ api_name: apiName, skill_version: SKILL_VERSION, ...params }),
      throw: false,
    });
    if (resp.status < 200 || resp.status >= 300) return null;
    const json: unknown = resp.json;
    if (typeof json !== 'object' || json === null) return null;
    const envelope = json as T;
    if (envelope.errcode !== undefined && envelope.errcode !== 0) return null;
    return envelope;
  } catch (err) {
    console.error(`[Journal Partner] weread ${apiName} failed`, err);
    return null;
  }
}

// ── Disk cache ──────────────────────────────────────────────────────────────

function cacheRoot(pluginDir: string): string {
  return `${pluginDir}/cache`;
}

function bookCachePath(pluginDir: string, bookId: string): string {
  return `${cacheRoot(pluginDir)}/books/${bookId}.json`;
}

/**
 * Create `dir` and any missing parents. Obsidian's adapter `mkdir` is not
 * recursive, so `cache/books` would fail on a cold start otherwise (the cache
 * write is best-effort, so that failure would silently disable persistence).
 */
async function ensureDir(app: App, dir: string): Promise<void> {
  const adapter = app.vault.adapter;
  const parts = dir.split('/').filter(p => p.length > 0);
  let current = '';
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

async function readJson<T>(app: App, path: string): Promise<T | null> {
  try {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    const raw = await adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as T;
  } catch (err) {
    console.error('[Journal Partner] quote cache read failed', err);
    return null;
  }
}

async function writeJson(app: App, path: string, data: unknown): Promise<void> {
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    await ensureDir(app, dir);
    await app.vault.adapter.write(path, JSON.stringify(data));
  } catch (err) {
    // A failed cache write must never break the pick — memory cache still works.
    console.error('[Journal Partner] quote cache write failed', err);
  }
}

// ── Notebook list ───────────────────────────────────────────────────────────

/**
 * Books that have at least one note. Memory → disk (24h) → gateway.
 * Returns an empty array when unavailable.
 */
async function loadNotebooks(
  app: App,
  pluginDir: string,
  apiKey: string,
): Promise<CachedNotebooks | null> {
  if (notebooksMemo && Date.now() - notebooksMemo.fetchedAt < NOTEBOOK_TTL_MS) {
    return notebooksMemo;
  }

  const path = `${cacheRoot(pluginDir)}/index.json`;
  const onDisk = await readJson<CachedNotebooks>(app, path);
  if (onDisk && onDisk.version === CACHE_VERSION && Date.now() - onDisk.fetchedAt < NOTEBOOK_TTL_MS) {
    notebooksMemo = onDisk;
    return onDisk;
  }

  const books: CachedNotebooks['books'] = [];
  let lastSort: number | undefined;
  // The endpoint pages at 300 books; 563 books in a real account = 2 pages.
  for (let page = 0; page < 10; page++) {
    const params: Record<string, unknown> = { count: 300 };
    if (lastSort !== undefined) params.lastSort = lastSort;
    const resp = await callAgent<RawNotebooks>(apiKey, '/user/notebooks', params);
    if (!resp || !resp.books) break;

    for (const b of resp.books) {
      const bookId = b.bookId;
      if (typeof bookId !== 'string' || bookId.length === 0) continue;
      books.push({
        bookId,
        title: b.book?.title ?? '',
        author: b.book?.author ?? '',
        noteCount: typeof b.noteCount === 'number' ? b.noteCount : 0,
        // Verified on the live account: `markedStatus === 4` is exactly the set
        // with `readingProgress >= 100`, i.e. the finished books.
        finished: b.markedStatus === 4 || (b.readingProgress ?? 0) >= 100,
      });
    }
    if (resp.hasMore !== 1) break;
    const last = resp.books[resp.books.length - 1];
    lastSort = typeof last?.sort === 'number' ? last.sort : undefined;
    if (lastSort === undefined) break;
  }

  if (books.length === 0) {
    // Network/API failure — keep serving a stale on-disk copy if we have one.
    if (onDisk && onDisk.version === CACHE_VERSION) {
      notebooksMemo = onDisk;
      return onDisk;
    }
    return null;
  }

  const fresh: CachedNotebooks = { version: CACHE_VERSION, fetchedAt: Date.now(), books };
  notebooksMemo = fresh;
  await writeJson(app, path, fresh);
  return fresh;
}

// ── One book ────────────────────────────────────────────────────────────────

const EMPTY_BOOK_BASE = {
  version: CACHE_VERSION,
  synckey: 0,
  popularSynckey: 0,
};

/**
 * A book's highlights and popular list. Memory → disk (7d) → gateway.
 * `/book/bookmarklist` returns every highlight in one call (verified with a
 * 769-highlight book), and `/book/bestbookmarks` with `chapterUid: 0` returns
 * the book-wide top 20 with reader counts.
 */
async function loadBook(
  app: App,
  pluginDir: string,
  apiKey: string,
  book: { bookId: string; title: string; author: string },
): Promise<CachedBook | null> {
  const memo = bookMemo.get(book.bookId);
  if (memo && Date.now() - memo.fetchedAt < BOOK_TTL_MS) return memo;

  const path = bookCachePath(pluginDir, book.bookId);
  const onDisk = await readJson<CachedBook>(app, path);
  const diskFresh =
    onDisk && onDisk.version === CACHE_VERSION && Date.now() - onDisk.fetchedAt < BOOK_TTL_MS;
  if (onDisk && diskFresh) {
    bookMemo.set(book.bookId, onDisk);
    return onDisk;
  }

  const base: CachedBook = onDisk && onDisk.version === CACHE_VERSION
    ? onDisk
    : {
        ...EMPTY_BOOK_BASE,
        bookId: book.bookId,
        title: book.title,
        author: book.author,
        fetchedAt: 0,
        chapters: [],
        highlights: [],
        popular: [],
      };

  const [bookmarks, popular] = await Promise.all([
    callAgent<RawBookmarkList>(apiKey, '/book/bookmarklist', {
      bookId: book.bookId,
      synckey: base.synckey,
    }),
    callAgent<RawBestBookmarks>(apiKey, '/book/bestbookmarks', {
      bookId: book.bookId,
      chapterUid: 0,
      synckey: base.popularSynckey,
    }),
  ]);

  if (!bookmarks && !popular) {
    // Total failure — a stale on-disk copy is still better than nothing.
    if (base.highlights.length > 0 || base.popular.length > 0) {
      bookMemo.set(book.bookId, base);
      return base;
    }
    return null;
  }

  const fresh: CachedBook = {
    version: CACHE_VERSION,
    bookId: book.bookId,
    title: book.title,
    author: book.author,
    fetchedAt: Date.now(),
    synckey: bookmarks?.synckey ?? base.synckey,
    popularSynckey: popular?.synckey ?? base.popularSynckey,
    chapters: (bookmarks?.chapters ?? []).map(c => ({
      chapterUid: typeof c.chapterUid === 'number' ? c.chapterUid : 0,
      title: c.title ?? '',
    })),
    highlights: (bookmarks?.updated ?? []).map(h => ({
      bookmarkId: h.bookmarkId ?? '',
      markText: h.markText ?? '',
      chapterUid: typeof h.chapterUid === 'number' ? h.chapterUid : 0,
      range: h.range ?? '',
      createTime: typeof h.createTime === 'number' ? h.createTime : 0,
    })),
    // Some books have no popular data at all (verified on an English title,
    // where items came back empty) — that simply yields an empty list.
    popular: (popular?.items ?? []).map(p => ({
      bookmarkId: p.bookmarkId ?? '',
      markText: p.markText ?? '',
      chapterUid: typeof p.chapterUid === 'number' ? p.chapterUid : 0,
      range: p.range ?? '',
      totalCount: typeof p.totalCount === 'number' ? p.totalCount : 0,
    })),
  };

  bookMemo.set(book.bookId, fresh);
  await writeJson(app, path, fresh);
  return fresh;
}

/**
 * Candidate books for a pick.
 *
 * Books with only a handful of highlights are dropped — a book with one or two
 * lines would otherwise get the same chance as a heavily annotated one while
 * contributing almost nothing. Verified distribution on the live account:
 * noteCount median 9, so the default floor of 10 keeps 277/563 books.
 *
 * Falls back to the full list when the floor would empty the pool.
 */
export function selectBookPool(books: NotebookEntry[], minNotes: number): NotebookEntry[] {
  const floor = Math.max(0, minNotes);
  const kept = books.filter(b => b.noteCount >= floor);
  return kept.length > 0 ? kept : books;
}

/** Finished books are favoured; see `FINISHED_BOOK_BOOST`. */
export function weightedPickBook(
  books: NotebookEntry[],
  rnd: () => number = Math.random,
): NotebookEntry | null {
  if (books.length === 0) return null;
  let total = 0;
  for (const b of books) total += b.finished ? FINISHED_BOOK_BOOST : 1;
  let roll = rnd() * total;
  for (const b of books) {
    roll -= b.finished ? FINISHED_BOOK_BOOST : 1;
    if (roll < 0) return b;
  }
  return books[books.length - 1];
}

// ── Candidate construction (pure — unit-testable) ───────────────────────────

function normalize(text: string): string {
  return text.replace(/\s+/gu, '');
}

function quoteLengthOk(text: string): boolean {
  const len = normalize(text).length;
  return len >= MIN_QUOTE_LEN && len <= MAX_QUOTE_LEN;
}

/**
 * The popular list and my own highlights can describe the same sentence with
 * different truncation — verified: popular `2415-2461` (46 chars) vs mine
 * `2415-2548` (133 chars) for one highlight. So matching is done per chapter
 * with a substring test rather than an exact range comparison.
 */
function sameHighlight(a: { chapterUid: number; markText: string }, b: { chapterUid: number; markText: string }): boolean {
  if (a.chapterUid !== b.chapterUid) return false;
  const x = normalize(a.markText);
  const y = normalize(b.markText);
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * `createTime` (unix seconds, returned by `/book/bookmarklist`) is the moment
 * the highlight was made in WeRead — not the moment it gets inserted into the
 * journal. Popular-only highlights come from other readers and have no such
 * timestamp, so they render without a date.
 */
function formatDate(createTime: number): string {
  const d = toDate(createTime);
  if (!d) return '';
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(createTime: number): string {
  const d = toDate(createTime);
  if (!d) return '';
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDate(createTime: number): Date | null {
  if (!createTime) return null;
  const d = new Date(createTime * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Build the candidate pool for one book: **only my own highlights**.
 *
 * Popular data is used purely as a weighting signal — a line I highlighted that
 * many others also marked is a better 金句 candidate, so it is sampled more
 * often. Other readers' highlights are never inserted into the journal.
 *
 *  - my highlight                        → 1
 *  - mine, and also a popular highlight  → 1 + quotePopularWeight
 *
 * The longer of the two texts wins when merging, because the popular variant is
 * often a truncated version of the sentence (verified: 46 vs 133 chars for the
 * same line).
 */
export function buildCandidates(
  book: CachedBook,
  settings: JournalPartnerSettings,
): ReadingQuote[] {
  const withAuthors = { title: book.title, author: book.author, bookId: book.bookId };
  const chapterTitle = new Map<number, string>();
  for (const c of book.chapters) chapterTitle.set(c.chapterUid, c.title);

  const popularWeight = Math.max(0, settings.quotePopularWeight);
  const candidates: ReadingQuote[] = [];

  for (const h of book.highlights) {
    if (!quoteLengthOk(h.markText)) continue;
    const hit = settings.quoteBoostPopular
      ? book.popular.find(p => sameHighlight(p, h)) ?? null
      : null;

    const text = hit && normalize(hit.markText).length > normalize(h.markText).length
      ? hit.markText
      : h.markText;
    candidates.push({
      key: `${book.bookId}:${h.chapterUid}:${h.range}`,
      ...withAuthors,
      chapter: chapterTitle.get(h.chapterUid) ?? '',
      text,
      isMine: true,
      isPopular: hit !== null,
      readers: hit?.totalCount ?? 0,
      weight: 1 + (hit ? popularWeight : 0),
      date: formatDate(h.createTime),
      time: formatTime(h.createTime),
    });
  }

  return candidates.filter(q => q.weight > 0);
}

/** Weighted random pick. `rnd` is injectable for tests. */
export function weightedPick(
  items: ReadingQuote[],
  rnd: () => number = Math.random,
): ReadingQuote | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const item of items) total += item.weight;
  if (total <= 0) return null;
  let roll = rnd() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

// ── Vault link resolution ───────────────────────────────────────────────────

/**
 * Map frontmatter `bookId` → synced weread note path, so a quote can carry a
 * `[[wikilink]]` even though the gateway only returns book ids.
 */
function buildNotePathIndex(app: App): Map<string, string> {
  if (notePathMemo) return notePathMemo;
  const index = new Map<string, string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const fm: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
    if (typeof fm !== 'object' || fm === null) continue;
    const record = fm as Record<string, unknown>;
    if (record['doc_type'] !== WEREAD_DOC_TYPE) continue;
    const bookId = record['bookId'];
    const key = typeof bookId === 'string'
      ? bookId
      : typeof bookId === 'number'
        ? String(bookId)
        : '';
    if (key.length > 0 && !index.has(key)) index.set(key, file.path);
  }
  notePathMemo = index;
  return index;
}

function escapeAlias(text: string): string {
  return text.replace(/[|\]\\[]/gu, '').trim();
}

/**
 * `[[note]]` / `[[path|alias]]` / plain text.
 *
 * Falls back to the plain book title when the note is not synced into the
 * vault, so we never emit a dangling link.
 */
export function resolveBookLink(app: App, bookId: string, displayName: string): string {
  const path = buildNotePathIndex(app).get(bookId);
  if (!path) return displayName;

  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return displayName;

  const alias = escapeAlias(displayName) || file.basename;
  const dest = app.metadataCache.getFirstLinkpathDest(file.basename, '');
  // Duplicate basenames (verified: 务虚笔记 exists twice) need the full path.
  if (dest && dest.path !== file.path) return `[[${file.path}|${alias}]]`;
  // Title differing from the file name (verified: 刘擎西方现代思想讲义-3003669677)
  if (alias !== file.basename) return `[[${file.basename}|${alias}]]`;
  return `[[${file.basename}]]`;
}

// ── Template rendering (pure) ───────────────────────────────────────────────

/**
 * Placeholders that may legitimately be empty. When one is empty it is removed
 * along with the separator that precedes it, so templates can be written
 * unconditionally (`… 《{link}》 · {date}` works for a dateless highlight too).
 */
const OPTIONAL_PLACEHOLDERS = ['author', 'chapter', 'date', 'time', 'count'];

/**
 * Expand `settings.quoteTemplate`. Supported placeholders:
 * `{quote} {title} {author} {chapter} {date} {time} {link} {count}`.
 *
 * `{date}` / `{time}` refer to when the highlight was made in WeRead, taken
 * from `/book/bookmarklist`'s `createTime` — not to the journal entry's own
 * `HH:MM` stamp.
 */
export function renderTemplate(
  quote: ReadingQuote,
  settings: JournalPartnerSettings,
  link: string,
): string {
  const values: Record<string, string> = {
    quote: quote.text.trim(),
    title: quote.title.trim(),
    author: quote.author.trim(),
    chapter: quote.chapter.trim(),
    date: quote.date,
    time: quote.time,
    link,
    count: quote.readers > 0 ? String(quote.readers) : '',
  };

  let out = settings.quoteTemplate;

  // Optional placeholders disappear together with the separator in front of
  // them, so an empty author does not leave ` —— ` and a missing date does not
  // leave a trailing ` · `.
  for (const key of OPTIONAL_PLACEHOLDERS) {
    if ((values[key] ?? '').length > 0) continue;
    out = out.replace(new RegExp(`[ \\t]*[·、,，;；\\-—–]*[ \\t]*\\{${key}\\}`, 'gu'), '');
  }

  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }

  out = out.replace(/[ \t]{2,}/gu, ' ');
  out = out.replace(/[ \t]+([》》。，、；])/gu, '$1');
  return out.trim();
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Options for one pick. */
export interface PickOptions {
  /**
   * Restrict the pick to this book — the Ctrl/Cmd+click "another line from the
   * same book" path. Bypasses the min-highlights pool filter, because the book
   * was already chosen once.
   */
  bookId?: string;
}

/**
 * Pick a random highlight across the user's notebook.
 *
 * Book selection: books with too few highlights are dropped
 * (`quoteMinBookHighlights`) and finished books are favoured
 * (`FINISHED_BOOK_BOOST`). Highlights come only from books the user actually
 * annotated, then one is drawn from that book with `buildCandidates` weights.
 */
export async function pickRandomQuote(
  app: App,
  pluginDir: string,
  settings: JournalPartnerSettings,
  recentKeys: string[] = [],
  options: PickOptions = {},
): Promise<ReadingQuote | null> {
  const apiKey = settings.wereadApiKey.trim();
  if (apiKey.length === 0) return null;

  const notebooks = await loadNotebooks(app, pluginDir, apiKey);
  if (!notebooks || notebooks.books.length === 0) return null;

  // Fixed-book mode: the caller wants another line out of a known book.
  const fixedBook = options.bookId
    ? notebooks.books.find(b => b.bookId === options.bookId) ?? null
    : null;
  if (options.bookId && !fixedBook) return null;

  const pool = selectBookPool(notebooks.books, settings.quoteMinBookHighlights);
  const recent = new Set(recentKeys);
  const tried = new Set<string>();

  for (let attempt = 0; attempt < REROLL_LIMIT; attempt++) {
    // Skip books already tried in this round so a reroll actually moves on.
    const remaining = pool.filter(b => !tried.has(b.bookId));
    const book = fixedBook ?? weightedPickBook(remaining.length > 0 ? remaining : pool);
    if (!book) break;
    tried.add(book.bookId);

    const cached = await loadBook(app, pluginDir, apiKey, book);
    if (cached) {
      const candidates = buildCandidates(cached, settings);
      if (candidates.length > 0) {
        const fresh = candidates.filter(c => !recent.has(c.key));
        const picked = weightedPick(fresh.length > 0 ? fresh : candidates);
        if (picked) return picked;
      }
    }

    // Only one book to try in fixed-book mode.
    if (fixedBook) break;
  }

  return null;
}

/** Format a picked quote into the text inserted into the capture textarea. */
export function formatQuoteInsertion(
  app: App,
  quote: ReadingQuote,
  settings: JournalPartnerSettings,
): string {
  const link = quote.title.length > 0
    ? resolveBookLink(app, quote.bookId, quote.title)
    : '';
  return renderTemplate(quote, settings, link);
}
