import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer, setIcon } from 'obsidian';
import VaultQueryPlugin from '../main';
import * as apiGuide from '../generated-help/api-guide.generated';
import type { RenderContext } from '../generated-help/index.generated';

export class ApiGuideCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-help vaultquery-api-guide' });

    apiGuide.render(container, this.createRenderContext());
  }

  private createRenderContext(): RenderContext {
    return {
      renderCode: (parent: HTMLElement, language: string, code: string) => {
        const wrapper = parent.createDiv();
        const codeBlockMarkdown = '```' + language + '\n' + code + '\n```';
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget render in sync callback
        MarkdownRenderer.render(this.app, codeBlockMarkdown, wrapper, '', this.component);
      },
      renderDynamic: (parent: HTMLElement, key: string) => {
        this.renderDynamicContent(parent, key);
      },
      setIcon: (element: HTMLElement, iconId: string) => {
        setIcon(element, iconId);
      },
    };
  }

  private renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'schema') {
      this.renderSchema(container);
    }
    else {
      container.createDiv({
        cls: 'vaultquery-help-error',
        text: `Unknown dynamic content: ${key}`
      });
    }
  }

  private renderSchema(container: HTMLElement): void {
    const api = this.plugin.api;
    if (api) {
      const schemaInfo = api.getSchemaInfo();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget render
      MarkdownRenderer.render(this.app, schemaInfo, container, '', this.component);
    }
    else {
      container.createDiv({
        text: 'Database not yet initialized.',
        cls: 'vaultquery-help-loading'
      });
    }
  }
}
