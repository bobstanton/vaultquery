import { App, Component, MarkdownPostProcessorContext } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export abstract class BaseUserDefinedProcessor {
  protected component: Component;
  private renderVersions = new WeakMap<HTMLElement, number>();

  constructor(protected app: App, protected plugin: VaultQueryPluginContext) {
    this.component = new Component();
    this.component.load();
  }

  public process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (el.closest('.display-only')) {
      return;
    }

    cleanupRenderedOutput(el);
    const container = el.createDiv({ cls: this.getContainerClass() });

    const ready = waitForIndexingWithProgress(
      () => this.plugin.api,
      container,
      () => this.renderWithRefresh(container, source, ctx)
    );

    if (ready) {
      void this.renderWithRefresh(container, source, ctx);
    }
  }

  protected abstract getContainerClass(): string;

  protected abstract processContent(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, renderVersion: number): void | Promise<void>;

  protected isCurrentRender(container: HTMLElement, renderVersion: number): boolean {
    return this.renderVersions.get(container) === renderVersion;
  }

  protected renderError(container: HTMLElement, message: string): void {
    BaseRenderer.renderError(container, {
      title: 'Error',
      message
    });
  }

  private async renderWithRefresh(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    const renderVersion = (this.renderVersions.get(container) ?? 0) + 1;
    this.renderVersions.set(container, renderVersion);

    cleanupRenderedOutput(container);

    const refresh = async () => {
      await this.renderWithRefresh(container, source, ctx);
    };
    QueryRefreshRegistry.register(container, { onRefresh: refresh });

    try {
      await this.processContent(container, source, ctx, renderVersion);
    }
    catch (error) {
      if (!this.isCurrentRender(container, renderVersion)) {
        return;
      }
      this.renderError(container, getErrorMessage(error));
    }

    if (!this.isCurrentRender(container, renderVersion)) {
      return;
    }

    const buttonContainer = container.createDiv('vaultquery-floating-buttons');
    BaseRenderer.addRefreshButton(buttonContainer, refresh);
  }

  public unload(): void {
    this.component.unload();
  }
}
