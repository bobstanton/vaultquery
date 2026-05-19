import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';

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
    const schema = await this.plugin.api!.getSchemaInfo();
    void MarkdownRenderer.render(this.app, schema, container, '', this.component);
  }
}
