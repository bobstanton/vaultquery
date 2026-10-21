import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import { createHelpRenderContext, renderHelpSchema, renderUnknownDynamicContent } from './HelpRendering';
import { getErrorMessage } from '../utils/ErrorMessages';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { RenderContext } from '../generated-help/index.generated';

interface HelpPageModule {
  render(container: HTMLElement, ctx: RenderContext): void;
}

export class BaseHelpCodeBlockProcessor {
  protected component: Component;

  public constructor(protected app: App, protected plugin: VaultQueryPluginContext, private readonly containerClassName: string, private readonly helpPage: HelpPageModule, private readonly schemaLoadingMessage?: string) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: this.containerClassName });
    this.helpPage.render(container, this.createRenderContext());
  }

  protected createRenderContext(): RenderContext {
    return createHelpRenderContext(this.app, this.component, (parent, key) => this.renderDynamicContent(parent, key));
  }

  protected renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'schema' && this.schemaLoadingMessage) {
      this.renderSchema(container, this.schemaLoadingMessage);

      return;
    }

    renderUnknownDynamicContent(container, key);
  }

  protected renderGeneratedMarkdown(container: HTMLElement, generate: () => Promise<string>): void {
    void generate()
      .then(markdown => MarkdownRenderer.render(this.app, markdown, container, '', this.component))
      .catch((error: unknown) => {
        container.empty();

        container.createDiv({
          cls: 'vaultquery-help-error',
          text: `Failed to load help content: ${getErrorMessage(error)}`
        });
      });
  }

  protected renderSchema(container: HTMLElement, loadingMessage: string): void {
    void renderHelpSchema(this.app, this.plugin, this.component, container, loadingMessage);
  }

  public unload(): void {
    this.component.unload();
  }
}
