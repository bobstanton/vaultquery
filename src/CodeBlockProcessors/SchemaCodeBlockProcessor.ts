import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import VaultQueryPlugin from '../main';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';

export class SchemaCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-schema' });

    const ready = waitForIndexingWithProgress(
      () => this.plugin.api,
      container,
      () => this.renderSchema(container)
    );

    if (ready) {
      this.renderSchema(container);
    }
  }

  private renderSchema(container: HTMLElement): void {
    const schema = this.plugin.api!.getSchemaInfo();
    void MarkdownRenderer.render(this.app, schema, container, '', this.component);
  }
}
