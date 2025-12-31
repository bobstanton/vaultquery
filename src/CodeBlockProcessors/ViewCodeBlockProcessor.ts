import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import VaultQueryPlugin from '../main';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import type { RenderContext } from '../Renderers/BaseRenderer';

export class ViewCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container vaultquery-view' });

    const ready = waitForIndexingWithProgress(
      () => this.plugin.api,
      container,
      () => this.createView(container, source)
    );

    if (ready) {
      void this.createView(container, source);
    }
  }

  private parseViewName(sql: string): string | null {
    const match = sql.match(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+AS/i);
    return match ? match[1] : null;
  }

  private async createView(container: HTMLElement, source: string): Promise<void> {
    const sql = source.trim();

    if (!sql.toUpperCase().startsWith('CREATE VIEW')) {
      this.renderError(container, 'vaultquery-view blocks must start with a CREATE VIEW statement');
      return;
    }

    const viewName = this.parseViewName(sql);
    if (!viewName) {
      this.renderError(container, 'Could not parse view name from CREATE VIEW statement');
      return;
    }

    try {
      this.plugin.api.execute(`DROP VIEW IF EXISTS "${viewName}"`);
      this.plugin.api.execute(sql);

      await this.renderViewPreview(container, viewName);
    }

    catch (error) {
      this.renderError(container, `Failed to create view: ${getErrorMessage(error)}`);
    }
  }

  private async renderViewPreview(container: HTMLElement, viewName: string): Promise<void> {
    try {
      const limit = this.plugin.settings.viewPreviewLimit;
      
      const query = `SELECT * FROM "${viewName}" LIMIT ${Math.max(1, limit)}`;
      const results = await this.plugin.api.query(query);

      const successDiv = container.createDiv({ cls: 'vaultquery-success' });
      successDiv.createEl('strong', { text: `View "${viewName}" created` });

      if (limit === 0) {
        successDiv.createEl('p', { text: 'View preview is disabled in settings.' });
        return;
      }

      if (results.length === 0) {
        successDiv.createEl('p', { text: 'View is empty (no rows)' });
        return;
      }

      const renderContext: RenderContext = {
        results,
        parsed: { query },
        container,
        app: this.app,
        openFile: (path: string) => this.app.workspace.openLinkText(path, ''),
        MarkdownRenderer,
        pluginContext: this.component,
        settings: this.plugin.settings
      };

      SlickGridRenderer.render(renderContext);
    }

    catch (error) {
      const errorDiv = container.createDiv({ cls: 'vaultquery-error' });
      errorDiv.createEl('strong', { text: `View "${viewName}" created with errors` });
      errorDiv.createEl('p', { text: getErrorMessage(error) });
    }
  }

  private renderError(container: HTMLElement, message: string): void {
    container.createDiv({
      cls: 'vaultquery-error',
      text: message
    });
  }
}
