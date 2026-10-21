import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { MarkdownRenderChild } from 'obsidian';
import type { App, MarkdownPostProcessorContext } from 'obsidian';

const unloadedContainers = new WeakSet<HTMLElement>();

class VaultQueryBlock extends MarkdownRenderChild {
  public onunload(): void {
    unloadedContainers.add(this.containerEl);
    cleanupRenderedOutput(this.containerEl);
  }
}

export function isBlockUnloaded(container: HTMLElement): boolean {
  return unloadedContainers.has(container);
}

export function createVaultQueryCodeBlockContainer(el: HTMLElement, ctx: MarkdownPostProcessorContext): HTMLElement | null {
  if (el.closest('.display-only')) {
    return null;
  }

  cleanupRenderedOutput(el);
  el.empty();
  const container = el.createDiv({ cls: 'vaultquery-container' });
  trackVaultQueryBlock(container, ctx);

  return container;
}

export function trackVaultQueryBlock(container: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  ctx.addChild(new VaultQueryBlock(container));
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
