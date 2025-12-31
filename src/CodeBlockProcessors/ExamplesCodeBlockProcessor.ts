import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer, setIcon } from 'obsidian';
import VaultQueryPlugin from '../main';
import * as examplesFunctions from '../generated-help/examples-functions.generated';
import * as examplesViews from '../generated-help/examples-views.generated';
import type { RenderContext } from '../generated-help/index.generated';

type ExamplePage = 'functions' | 'views';

export class ExamplesCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private _plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-examples' });

    const page = source.trim().toLowerCase() as ExamplePage;

    switch (page) {
      case 'functions':
        examplesFunctions.render(container, this.createRenderContext());
        break;
      case 'views':
        examplesViews.render(container, this.createRenderContext());
        break;
      default:
        this.renderIndex(container);
    }
  }

  private renderIndex(container: HTMLElement): void {
    const markdown = `## Example Documentation

Choose an example category:

- \`functions\` - Custom function examples (text, date, JSON, utilities)
- \`views\` - Custom view examples (tasks, tags, links, organization)

Usage:
\`\`\`vaultquery-examples
functions
\`\`\`
`;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    MarkdownRenderer.render(this.app, markdown, container, '', this.component);
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
        parent.createDiv({
          cls: 'vaultquery-help-error',
          text: `Unknown dynamic content: ${key}`
        });
      },
      setIcon: (element: HTMLElement, iconId: string) => {
        setIcon(element, iconId);
      },
    };
  }
}
