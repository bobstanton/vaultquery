import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export class SchemaCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    if (el.closest('.display-only')) {
      return;
    }

    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-schema' });

    const ready = waitForIndexingWithProgress(
      () => this.plugin.api,
      container,
      () => this.renderSchema(container)
    );

    if (ready) {
      void this.renderSchema(container);
    }
  }

  private async renderSchema(container: HTMLElement): Promise<void> {
    const api = this.plugin.api;
    if (!api) {
      container.createDiv({
        cls: 'vaultquery-help-loading',
        text: 'VaultQuery is still initializing — re-open this note to load the schema.'
      });
      return;
    }

    try {
      const schema = await api.getSchemaInfo();
      await MarkdownRenderer.render(this.app, schema, container, '', this.component);
    }
    catch (error: unknown) {
      container.empty();
      container.createDiv({
        cls: 'vaultquery-help-error',
        text: `Failed to load schema: ${getErrorMessage(error)}`
      });
    }
  }

  public unload(): void {
    this.component.unload();
  }
}
