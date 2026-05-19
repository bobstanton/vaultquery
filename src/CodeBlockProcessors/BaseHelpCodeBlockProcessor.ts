import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer, setIcon } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { RenderContext } from '../generated-help/index.generated';

interface HelpPageModule {
  render(container: HTMLElement, ctx: RenderContext): void;
}

export abstract class BaseHelpCodeBlockProcessor {
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
    return {
      app: this.app,
      component: this.component,
      renderDynamic: (parent: HTMLElement, key: string) => {
        this.renderDynamicContent(parent, key);
      },
      setIcon: (element: HTMLElement, iconId: string) => {
        setIcon(element, iconId);
      },
    };
  }

  protected renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'schema' && this.schemaLoadingMessage) {
      this.renderSchema(container, this.schemaLoadingMessage);
      return;
    }

    container.createDiv({
      cls: 'vaultquery-help-error',
      text: `Unknown dynamic content: ${key}`
    });
  }

  protected renderSchema(container: HTMLElement, loadingMessage: string): void {
    const api = this.plugin.api;
    if (api) {
      void api.getSchemaInfo().then(schemaInfo => {
        void MarkdownRenderer.render(this.app, schemaInfo, container, '', this.component);
      });
    }
    else {
      container.createDiv({ text: loadingMessage, cls: 'vaultquery-help-loading' });
    }
  }

  public unload(): void {
    this.component.unload();
  }
}
