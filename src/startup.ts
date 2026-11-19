import type { Component, Workspace } from 'obsidian';

/** Wait for workspace restoration and stop if the plugin unloads beforehand. */
export function registerStartupOpen(
  workspace: Pick<Workspace, 'onLayoutReady'>,
  owner: Pick<Component, 'register'>,
  enabled: () => boolean,
  open: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  let alive = true;
  let opened = false;
  owner.register(() => { alive = false; });
  workspace.onLayoutReady(() => {
    if (!alive || opened || !enabled()) return;
    opened = true;
    try { void open().catch(onError); }
    catch (error) { onError(error); }
  });
}
