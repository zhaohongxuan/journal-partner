import { App, Component, MarkdownRenderer, Modal, Notice, Platform, TFile, requestUrl } from 'obsidian';
import { extractTags, JournalEntry } from './section';
import { isChinese, t, weekdayShort } from './i18n';
import {
  renderShareCard, ShareBlock, ShareCardContent, ShareCardOptions, ShareTemplate,
} from './share-card-renderer';

const TEMPLATES: ShareTemplate[] = ['paper', 'calendar', 'night'];
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#|]|$)/i;

export interface ShareCardPreferences {
  template: ShareTemplate;
  author: string;
}

/** The preview itself is the export canvas, so saved images match it exactly. */
export class ShareCardModal extends Modal {
  private owner = new Component();
  private closed = false;
  private busy = false;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private content: ShareCardContent | null = null;
  private warning = '';
  private controls: HTMLButtonElement[] = [];
  private options: ShareCardOptions;

  constructor(app: App, private entry: JournalEntry, private date: string,
    private sourcePath: string, preferences: ShareCardPreferences,
    private savePreferences: (preferences: ShareCardPreferences) => Promise<void>) {
    super(app);
    this.options = {
      template: TEMPLATES.includes(preferences.template) ? preferences.template : 'paper',
      author: preferences.author || '', showDate: true, showTags: true, showAuthor: true,
    };
  }

  onOpen(): void {
    this.owner.load();
    this.modalEl.addClass('jp-share-modal');
    this.titleEl.setText(t('share.title'));
    this.contentEl.addClass('jp-share-content');
    const preview = this.contentEl.createDiv({ cls: 'jp-share-preview' });
    this.canvas = preview.createEl('canvas', { cls: 'jp-share-canvas', attr: {
      role: 'img', 'aria-label': t('share.preview'),
    } });
    this.canvas.hidden = true;
    this.status = this.contentEl.createDiv({ cls: 'jp-share-status', text: t('share.loading'), attr: { role: 'status', 'aria-live': 'polite' } });
    const templates = this.contentEl.createDiv({ cls: 'jp-share-templates', attr: { role: 'group', 'aria-label': t('share.template') } });
    for (const template of TEMPLATES) {
      const button = templates.createEl('button', { text: t(`share.${template}`), attr: { type: 'button' } });
      button.dataset.template = template;
      button.setAttr('aria-pressed', String(this.options.template === template));
      button.toggleClass('is-selected', this.options.template === template);
      button.addEventListener('click', () => {
        this.options.template = template;
        for (const sibling of Array.from(templates.children)) {
          const selected = (sibling as HTMLButtonElement).dataset.template === template;
          sibling.toggleClass('is-selected', selected);
          sibling.setAttr('aria-pressed', String(selected));
        }
        this.render();
      });
    }
    const toggles = this.contentEl.createDiv({ cls: 'jp-share-options' });
    for (const [key, label] of [
      ['showDate', 'share.showDate'], ['showTags', 'share.showTags'], ['showAuthor', 'share.showAuthor'],
    ] as const) {
      const row = toggles.createEl('label');
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.options[key];
      row.createSpan({ text: t(label) });
      checkbox.addEventListener('change', () => { this.options[key] = checkbox.checked; this.render(); });
    }
    const authorRow = this.contentEl.createEl('label', { cls: 'jp-share-author' });
    authorRow.createSpan({ text: t('share.author') });
    const author = authorRow.createEl('input', { type: 'text', attr: { maxlength: '60', placeholder: t('share.authorPlaceholder') } });
    author.value = this.options.author;
    author.addEventListener('input', () => { this.options.author = author.value; this.render(); });
    const actions = this.contentEl.createDiv({ cls: 'jp-share-actions' });
    for (const action of ['copy', 'save'] as const) {
      const button = actions.createEl('button', { text: t(`share.${action}`), cls: action === 'save' ? 'mod-cta' : '', attr: { type: 'button' } });
      button.disabled = true;
      button.addEventListener('click', () => { void this.exportImage(action); });
      this.controls.push(button);
    }
    this.contentEl.createDiv({ cls: 'jp-share-hint', text: t('share.hint') });
    void this.prepare();
  }

  private async prepare(): Promise<void> {
    const host = this.contentEl.createDiv({ cls: 'jp-share-markdown-source', attr: { 'aria-hidden': 'true' } });
    host.hidden = true;
    try {
      // Render Markdown locally first: export visible words instead of Markdown
      // delimiters, vault paths or raw HTML. Do not execute a DOM screenshot.
      await MarkdownRenderer.render(this.app, this.entry.text, host, this.sourcePath, this.owner);
      if (this.closed) return;
      const blocks: ShareBlock[] = [];
      let text = '';
      let missingMedia = false;
      const flush = () => {
        const cleaned = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (cleaned) blocks.push({ type: 'text', text: cleaned });
        text = '';
      };
      const walk = async (node: Node): Promise<void> => {
        if (this.closed) return;
        if (node.nodeType === 3) {
          const value = node.textContent || '';
          // Ignore HTML formatting between blocks, while retaining <br> and
          // literal whitespace in code. Markdown paragraphs add their own breaks.
          if (!value.trim() && value.includes('\n') && !node.parentElement?.closest('code, pre')) return;
          // Keep code and link labels verbatim; move ordinary hashtag tokens
          // into the optional tag row after Markdown has been interpreted.
          text += node.parentElement?.closest('code, pre, a') ? value
            : value.replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, '$1');
          return;
        }
        if (!node.instanceOf(HTMLElement)) return;
        if (['SCRIPT', 'STYLE', 'BUTTON'].includes(node.tagName) || node.matches('a.tag')) return;
        const embed = node.matches('.internal-embed') ? node.getAttribute('src') : null;
        if (node.tagName === 'IMG' || (embed && IMAGE_EXTENSION.test(embed))) {
          flush();
          const src = embed || node.getAttribute('src') || '';
          try { blocks.push({ type: 'image', image: await this.loadImage(src) }); }
          catch { blocks.push({ type: 'text', text: t('share.imageUnavailable') }); missingMedia = true; }
          return;
        }
        if (node.matches('audio, video, .internal-embed')) {
          text += `\n${t('share.attachment')}\n`;
          return;
        }
        if (node.tagName === 'INPUT') {
          if ((node as HTMLInputElement).type === 'checkbox') text += (node as HTMLInputElement).checked ? '☑ ' : '☐ ';
          return;
        }
        if (node.tagName === 'BR') { text += '\n'; return; }
        const block = /^(P|DIV|H[1-6]|BLOCKQUOTE|UL|OL|LI|PRE|TABLE|TR)$/.test(node.tagName);
        if (block && text && !text.endsWith('\n')) text += '\n';
        if (node.tagName === 'LI' && !node.querySelector('input[type="checkbox"]')) text += '• ';
        if (node.tagName === 'TD' || node.tagName === 'TH') text += '  ';
        for (const child of Array.from(node.childNodes)) await walk(child);
        if (block) text += node.tagName === 'P' ? '\n\n' : '\n';
      };
      for (const child of Array.from(host.childNodes)) await walk(child);
      flush();
      if (this.closed) return;
      if (this.canvas.ownerDocument.fonts) await this.canvas.ownerDocument.fonts.ready;
      if (this.closed) return;
      const [year, month, day] = this.date.split('-').map(Number);
      this.content = {
        blocks, tags: extractTags(this.entry.text).map(tag => `#${tag}`),
        date: this.date, timestamp: this.entry.timestamp,
        title: t('share.cardTitle'), subtitle: t('share.cardSubtitle'),
        weekday: weekdayShort(new Date(year, month - 1, day).getDay()),
        month: isChinese() ? `${year} 年 ${month} 月` : new Date(year, month - 1, day).toLocaleDateString('en', { month: 'long', year: 'numeric' }),
        task: this.entry.type === 'task', completed: this.entry.completed,
        taskLabel: t(this.entry.completed ? 'share.completedTask' : 'share.task'),
      };
      this.warning = missingMedia ? t('share.mediaWarning') : '';
      this.render();
    } catch (error) {
      if (!this.closed) this.status.setText(t('share.failed', { msg: this.message(error) }));
    } finally { host.remove(); }
  }

  private async loadImage(src: string): Promise<HTMLImageElement> {
    const link = src.split('|')[0].split('#')[0];
    const file = this.app.metadataCache.getFirstLinkpathDest(link, this.sourcePath);
    let blob: Blob;
    if (file instanceof TFile) {
      const bytes = await this.app.vault.readBinary(file);
      const mime = file.extension.toLowerCase() === 'svg' ? 'image/svg+xml' : `image/${file.extension.toLowerCase().replace('jpg', 'jpeg')}`;
      blob = new Blob([bytes], { type: mime });
    } else if (/^https?:\/\//i.test(src)) {
      // Blob URLs avoid a remote image tainting the export canvas.
      let timer: number | undefined;
      try {
        const response = await Promise.race([
          requestUrl({ url: src }),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('Image request timed out')), 15000);
          }),
        ]);
        if (response.status >= 400) throw new Error('Image request failed');
        blob = new Blob([response.arrayBuffer], { type: response.headers['content-type'] || 'image/png' });
      } finally { window.clearTimeout(timer); }
    } else { throw new Error('Image not found'); }
    if (blob.size > 20 * 1024 * 1024) throw new Error('Image too large');
    const url = URL.createObjectURL(blob);
    try {
      const image = this.canvas.ownerDocument.createEl('img');
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { image.src = ''; reject(new Error('Image load timed out')); }, 15000);
        image.onload = () => { window.clearTimeout(timer); resolve(); };
        image.onerror = () => { window.clearTimeout(timer); reject(new Error('Image decode failed')); };
        image.src = url;
      });
      return image;
    } finally { URL.revokeObjectURL(url); }
  }

  private render(): void {
    if (!this.content || this.closed) return;
    try {
      renderShareCard(this.canvas, this.content, this.options);
      this.canvas.hidden = false;
      this.status.setText(this.warning);
      this.canvas.setAttr('aria-label', `${t('share.preview')}: ${this.options.showDate ? this.date : ''} ${this.entry.text}`);
      for (const button of this.controls) button.disabled = this.busy;
    } catch (error) {
      this.canvas.hidden = true;
      for (const button of this.controls) button.disabled = true;
      this.status.setText(t('share.failed', { msg: this.message(error) }));
    }
  }

  private async exportImage(action: 'copy' | 'save'): Promise<void> {
    if (this.busy || !this.content || this.closed || this.canvas.hidden) return;
    this.busy = true;
    for (const button of this.controls) button.disabled = true;
    try {
      if (action === 'copy' && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')) {
        throw new Error(t('share.copyUnsupported'));
      }
      const blobPromise = new Promise<Blob>((resolve, reject) => this.canvas.toBlob(blob => {
        if (blob) resolve(blob); else reject(new Error(t('share.encodeFailed')));
      }, 'image/png'));
      // Some WebViews reject clipboard writes before consuming the promise.
      // Attach a rejection handler even when the consumer never reads it.
      void blobPromise.catch(() => {});
      if (action === 'copy') {
        // Pass the PNG promise immediately to retain Safari's user gesture.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        new Notice(t('share.copied'));
      } else {
        const blob = await blobPromise;
        if (this.closed) return;
        const filename = `journal-${this.date}-${this.entry.timestamp.replace(/[^\d]/g, '')}-${this.options.template}.png`;
        const file = new File([blob], filename, { type: 'image/png' });
        if (Platform.isMobile && navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file] });
        } else {
          const url = URL.createObjectURL(blob);
          const link = this.contentEl.createEl('a', { attr: { href: url, download: filename } });
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        new Notice(t('share.failed', { msg: this.message(error) }));
      }
    }
    finally {
      this.busy = false;
      if (!this.closed) for (const button of this.controls) button.disabled = this.canvas.hidden;
    }
  }

  private message(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : t('share.unknownError');
  }

  onClose(): void {
    this.closed = true;
    this.owner.unload();
    this.contentEl.empty();
    this.content = null;
    void this.savePreferences({ template: this.options.template, author: this.options.author.trim() })
      .catch(error => { new Notice(t('share.preferencesFailed', { msg: this.message(error) })); });
  }
}
