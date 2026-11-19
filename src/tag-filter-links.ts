import { normalizeTag } from './section';

/** Keep rendered hashtag clicks inside the timeline instead of Obsidian search. */
export function hookUpTagFilters(el: HTMLElement, onFilter: (tag: string) => void): void {
  el.querySelectorAll<HTMLAnchorElement>('a.tag').forEach(link => {
    if (link.dataset.jpTagFilterHooked === 'true') return;
    link.dataset.jpTagFilterHooked = 'true';
    link.addEventListener('click', event => {
      const tag = [link.getAttribute('data-href'), link.textContent, link.getAttribute('href')]
        .map(value => normalizeTag(value ?? '')).find(Boolean);
      if (!tag) return;
      event.preventDefault();
      // Core tag handlers can already be installed on this anchor. Capture the
      // click before those handlers and prevent the workspace-wide search.
      event.stopImmediatePropagation();
      onFilter(tag.slice(1));
    }, { capture: true });
  });
}
