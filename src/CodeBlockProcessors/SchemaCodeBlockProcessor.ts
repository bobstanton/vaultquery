import { App, Component, MarkdownPostProcessorContext } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { trackVaultQueryBlock, isBlockUnloaded } from './ProcessorUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { getErrorMessage } from '../utils/ErrorMessages';
import { renderHelpSchema } from './HelpRendering';

export class SchemaCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (el.closest('.display-only')) {
      return;
    }

    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-schema' });

    trackVaultQueryBlock(container, ctx);
    void this.plugin.indexingReadiness.wait(container).then(() => {
      if (!isBlockUnloaded(container)) return this.renderSchema(container);
    }).catch(error => {
      if (!isBlockUnloaded(container)) BaseRenderer.renderError(container, { title: 'Error', message: getErrorMessage(error) });
    });
  }

  private async renderSchema(container: HTMLElement): Promise<void> {
    await renderHelpSchema(this.app, this.plugin, this.component, container);
  }

  public unload(): void {
    this.component.unload();
  }
}
