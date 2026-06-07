import { App, Component, MarkdownPostProcessorContext } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { CalendarRenderer } from '../Renderers/CalendarRenderer';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export abstract class BaseUserDefinedProcessor {
  protected component: Component;

  constructor(protected app: App, protected plugin: VaultQueryPluginContext) {
    this.component = new Component();
    this.component.load();
  }

  public process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (el.closest('.display-only')) {
      return;
    }

    SlickGridRenderer.cleanupContainer(el);
    CalendarRenderer.cleanupContainer(el);
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

  protected abstract processContent(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext): void | Promise<void>;

  protected renderError(container: HTMLElement, message: string): void {
    BaseRenderer.renderError(container, {
      title: 'Error',
      message
    });
  }

  private async renderWithRefresh(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    SlickGridRenderer.cleanupContainer(container);
    CalendarRenderer.cleanupContainer(container);

    const refresh = async () => {
      await this.renderWithRefresh(container, source, ctx);
    };
    QueryRefreshRegistry.register(container, { onRefresh: refresh });

    try {
      await this.processContent(container, source, ctx);
    }
    catch (error) {
      this.renderError(container, getErrorMessage(error));
    }

    const buttonContainer = container.createDiv('vaultquery-floating-buttons');
    BaseRenderer.addRefreshButton(buttonContainer, refresh);
  }

  public unload(): void {
    this.component.unload();
  }
}
