import { App, Component, Modal, Notice, setIcon } from 'obsidian';
import { CaptureInput, createCaptureInput } from './capture-input';
import { splitEntryDraft, joinEntryDraft } from './entry-draft';
import { JournalEntry, normalizeTag } from './section';
import { t } from './i18n';

/** One Live Preview editor sharing the capture input’s tag chips and picker. */
export class EditEntryModal extends Modal {
  private input: CaptureInput | null = null;
  private owner = new Component();
  private tags: string[] = [];
  private closed = false;
  private saving = false;

  constructor(app: App, private entry: JournalEntry, private sourcePath: string,
    private onSave: (text: string) => Promise<void>, private presetTags: readonly string[] = []) {
    super(app);
  }

  onOpen(): void {
    this.closed = false;
    this.owner.load();
    this.modalEl.addClass('jp-edit-modal');
    this.contentEl.addClass('jp-edit-entry');
    this.titleEl.setText(t('menu.editTitle', { timestamp: this.entry.timestamp }));
    const draft = splitEntryDraft(this.entry.text);
    this.tags = draft.tags;

    const tagSection = this.contentEl.createDiv({ cls: 'jp-edit-tags-section' });
    const chips = tagSection.createDiv({ cls: 'jp-tag-chips' });
    const picker = tagSection.createDiv({ cls: 'jp-tag-picker' });
    picker.hide();
    const toolbar = this.contentEl.createDiv({ cls: 'jp-edit-toolbar' });
    const tagToggle = toolbar.createEl('button', {
      cls: 'clickable-icon jp-edit-tag-toggle',
      attr: { type: 'button', title: t('capture.tagPickerTitle'), 'aria-label': t('capture.tagPickerTitle'), 'aria-expanded': 'false' },
    });
    setIcon(tagToggle, 'tag');
    let pickerOpen = false;
    const choices = [...new Set([...this.presetTags, ...draft.tags].map(normalizeTag).filter(Boolean))];
    const setPickerOpen = (open: boolean) => {
      pickerOpen = open;
      tagToggle.setAttr('aria-expanded', String(open));
      if (open) { renderPicker(); picker.show(); }
      else picker.hide();
    };
    const toggleTag = (tag: string) => {
      if (this.saving) return;
      if (this.tags.includes(tag)) this.tags = this.tags.filter(value => value !== tag);
      else this.tags.push(tag);
      renderTags();
      if (pickerOpen) renderPicker();
    };
    const renderTags = () => {
      chips.empty();
      if (this.tags.length) chips.show();
      else chips.hide();
      for (const tag of this.tags) {
        const chip = chips.createDiv({ cls: 'jp-tag-chip' });
        chip.createSpan({ cls: 'jp-tag-chip-text', text: tag });
        const remove = chip.createEl('button', {
          cls: 'jp-tag-chip-remove', attr: { type: 'button', 'aria-label': t('capture.removeTag', { tag }) },
        });
        setIcon(remove, 'x');
        remove.addEventListener('click', () => toggleTag(tag));
      }
    };
    const renderPicker = () => {
      picker.empty();
      const header = picker.createDiv({ cls: 'jp-tag-picker-header' });
      header.createSpan({ cls: 'jp-tag-picker-title', text: t('capture.tagPickerTitle') });
      const close = header.createEl('button', {
        cls: 'jp-tag-picker-close', attr: { type: 'button', 'aria-label': t('capture.tagPickerClose') },
      });
      setIcon(close, 'x');
      close.addEventListener('click', () => setPickerOpen(false));
      if (!choices.length) picker.createDiv({ cls: 'jp-tag-picker-empty', text: t('capture.noPresetTags') });
      for (const tag of choices) {
        const selected = this.tags.includes(tag);
        const item = picker.createEl('button', {
          cls: `jp-tag-picker-item${selected ? ' is-selected' : ''}`,
          attr: { type: 'button', 'aria-pressed': String(selected) },
        });
        setIcon(item.createSpan({ cls: 'jp-tag-picker-item-icon' }), 'tag');
        item.createSpan({ cls: 'jp-tag-picker-item-text', text: tag });
        item.addEventListener('click', event => {
          event.stopPropagation();
          toggleTag(tag);
        });
      }
    };
    tagToggle.addEventListener('click', () => setPickerOpen(!pickerOpen));
    this.owner.registerDomEvent(this.contentEl, 'click', event => {
      if (!picker.contains(event.target as Node) && !tagToggle.contains(event.target as Node)) setPickerOpen(false);
    });
    this.owner.registerDomEvent(this.contentEl, 'keydown', event => {
      if (pickerOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setPickerOpen(false);
      }
    }, { capture: true });
    renderTags();

    const inputHost = this.contentEl.createDiv({ cls: 'jp-edit-input-host' });
    this.input = createCaptureInput(this.app, inputHost, this.owner, {
      placeholder: t('edit.placeholder'), sourcePath: this.sourcePath, onChange: () => {},
      submitShortcut: () => 'ctrl+enter', onSubmit: () => { void save(); },
    });
    this.input.setValue(draft.body);

    const tool = (icon: string, label: string, prefix: string, suffix = '') => {
      const button = toolbar.createEl('button', {
        cls: 'clickable-icon', attr: { type: 'button', title: label, 'aria-label': label },
      });
      setIcon(button, icon);
      button.addEventListener('click', () => {
        if (this.saving || !this.input) return;
        const { from, to } = this.input.getSelection();
        const selection = this.input.getValue().slice(from, to);
        this.input.replaceRange(prefix + selection + suffix, from, to);
        this.input.focus();
      });
    };
    tool('bold', t('edit.bold'), '**', '**');
    tool('italic', t('edit.italic'), '*', '*');
    tool('list', t('edit.list'), '\n- ');
    tool('list-todo', t('edit.task'), '\n- [ ] ');
    tool('quote', t('edit.quote'), '\n> ');
    tool('link', t('edit.link'), '[', '](https://)');
    tool('image', t('edit.image'), '![[', ']]');
    tool('code', t('edit.code'), '`', '`');
    toolbar.createSpan({ cls: 'jp-edit-shortcut', text: t('edit.shortcut') });

    const actions = this.contentEl.createDiv({ cls: 'jp-edit-entry-actions' });
    const cancel = actions.createEl('button', { text: t('common.cancel') });
    cancel.addEventListener('click', () => { if (!this.saving) this.close(); });
    const saveButton = actions.createEl('button', { cls: 'mod-cta', text: t('common.save') });
    const save = async () => {
      if (this.saving || this.closed || !this.input) return;
      const next = joinEntryDraft(this.tags, this.input.getValue(), draft.prefix);
      if (!next.trim()) { new Notice(t('notice.contentEmpty')); return; }
      this.saving = true;
      saveButton.disabled = cancel.disabled = true;
      try {
        await this.onSave(next);
        this.close();
      } catch (error) {
        new Notice(t('notice.saveFailed', { msg: error instanceof Error ? error.message : String(error) }));
      } finally {
        this.saving = false;
        saveButton.disabled = cancel.disabled = false;
      }
    };
    saveButton.addEventListener('click', () => { void save(); });
    this.owner.registerDomEvent(inputHost, 'keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    }, { capture: true });
    this.input.focus();
  }

  onClose(): void {
    this.closed = true;
    this.input?.destroy();
    this.input = null;
    this.owner.unload();
    this.contentEl.empty();
  }
}
