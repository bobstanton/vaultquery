import { App, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseUserDefinedProcessor } from './BaseUserDefinedProcessor';
import { parseSQLObjectName, validateSQLObjectStart } from '../utils/SQLParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import type { RenderContext } from '../Renderers/BaseRenderer';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('ViewBlocks');

export class ViewCodeBlockProcessor extends BaseUserDefinedProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
  }

  protected getContainerClass(): string {
    return 'vaultquery-container vaultquery-view';
  }

  protected async processContent(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, renderVersion: number): Promise<void> {
    const sql = source.trim();

    if (!validateSQLObjectStart(sql, 'VIEW')) {
      this.renderError(container, 'vaultquery-view blocks must start with a CREATE VIEW statement');
      return;
    }

    const viewName = parseSQLObjectName(sql, 'VIEW');
    if (!viewName) {
      this.renderError(container, 'Could not parse view name from CREATE VIEW statement');
      return;
    }

    try {
      const duplicatePath = await this.findDuplicateViewPath(viewName, ctx.sourcePath);
      if (!this.isCurrentRender(container, renderVersion)) {
        return;
      }
      if (duplicatePath) {
        this.renderError(container, `Another vaultquery-view block already defines "${viewName}" in ${duplicatePath}`);
        return;
      }

      const needsRecreation = await this.shouldCreateOrRecreateView(viewName, sql);
      logger.debug(`view="${viewName}" needsRecreation=${needsRecreation} source="${ctx.sourcePath}"`);
      if (needsRecreation) {
        logger.debug(`dropping and recreating view "${viewName}"`);
        await this.plugin.api.execute(`DROP VIEW IF EXISTS "${viewName}"`);
        if (!this.isCurrentRender(container, renderVersion)) {
          return;
        }
        await this.plugin.api.execute(sql);
        if (!this.isCurrentRender(container, renderVersion)) {
          return;
        }
        logger.debug(`calling reindexNote for "${ctx.sourcePath}"`);
        await this.plugin.api.reindexNote(ctx.sourcePath);
        if (!this.isCurrentRender(container, renderVersion)) {
          return;
        }
        logger.debug(`reindexNote complete for "${ctx.sourcePath}"`);
      }

      await this.renderViewPreview(container, viewName, renderVersion);
    }
    catch (error) {
      if (!this.isCurrentRender(container, renderVersion)) {
        return;
      }
      this.renderError(container, `Failed to create view: ${getErrorMessage(error)}`);
    }
  }

  private async renderViewPreview(container: HTMLElement, viewName: string, renderVersion: number): Promise<void> {
    try {
      const limit = this.plugin.settings.viewPreviewLimit;

      const query = `SELECT * FROM "${viewName}" LIMIT ${Math.max(1, limit)}`;
      const results = await this.plugin.api.query(query);
      if (!this.isCurrentRender(container, renderVersion)) {
        return;
      }

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
        openFile: (path: string) => { void this.app.workspace.openLinkText(path, ''); },
        MarkdownRenderer,
        pluginContext: this.component,
        settings: this.plugin.settings
      };

      SlickGridRenderer.render(renderContext);
    }
    catch (error) {
      if (!this.isCurrentRender(container, renderVersion)) {
        return;
      }
      BaseRenderer.renderError(container, {
        title: `View "${viewName}" created with errors`,
        message: getErrorMessage(error)
      });
    }
  }

  private async findDuplicateViewPath(viewName: string, sourcePath: string): Promise<string | null> {
    const views = await this.plugin.api.getAllUserViews();
    const duplicate = views.find(view =>
      view.view_name === viewName &&
      view.path !== sourcePath
    );

    return duplicate?.path ?? null;
  }

  private async shouldCreateOrRecreateView(viewName: string, sql: string): Promise<boolean> {
    if (this.plugin.api.viewNeedsRecreation(viewName, sql)) {
      return true;
    }

    const existing = await this.plugin.api.query(
      `SELECT name FROM sqlite_master WHERE type = 'view' AND name = "${viewName.replace(/"/g, '""')}" LIMIT 1`
    );

    return existing.length === 0;
  }
}
