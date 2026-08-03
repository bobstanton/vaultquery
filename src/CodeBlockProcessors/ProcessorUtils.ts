import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import type { App } from 'obsidian';

export function createVaultQueryCodeBlockContainer(el: HTMLElement): HTMLElement | null {
  if (el.closest('.display-only')) {
    return null;
  }

  cleanupRenderedOutput(el);
  el.empty();
  return el.createDiv({ cls: 'vaultquery-container' });
}

export function createOpenFileHandler(app: App): (path: string) => void {
  return (path: string) => { void app.workspace.openLinkText(path, ''); };
}

export class RenderVersionGuard {
  private versions = new WeakMap<HTMLElement, number>();

  public begin(container: HTMLElement): number {
    const version = (this.versions.get(container) ?? 0) + 1;
    this.versions.set(container, version);
    return version;
  }

  public isCurrent(container: HTMLElement, version: number): boolean {
    return this.versions.get(container) === version;
  }
}
