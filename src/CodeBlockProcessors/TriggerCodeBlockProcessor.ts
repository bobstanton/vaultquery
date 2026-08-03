import { MarkdownPostProcessorContext } from 'obsidian';
import { BaseUserDefinedProcessor } from './BaseUserDefinedProcessor';
import { parseSQLObjectName, validateSQLObjectStart } from '../utils/SQLParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

/**
 * Processes vaultquery-trigger code blocks to register triggers
 * and display registration status.
 */
export class TriggerCodeBlockProcessor extends BaseUserDefinedProcessor {
  protected getContainerClass(): string {
    return 'vaultquery-container vaultquery-trigger';
  }

  protected async processContent(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (!this.plugin.settings.enableTriggers) {
      this.renderDisabled(container);
      return;
    }

    const sql = source.trim();

    if (!validateSQLObjectStart(sql, 'TRIGGER')) {
      this.renderError(container, 'vaultquery-trigger blocks must start with a CREATE TRIGGER statement');
      return;
    }

    const triggerName = parseSQLObjectName(sql, 'TRIGGER');
    if (!triggerName) {
      this.renderError(container, 'Could not parse trigger name from CREATE TRIGGER statement');
      return;
    }

    try {
      const api = this.requireApi();
      if (api.triggerNeedsRecreation(triggerName, sql)) {
        await api.registerTrigger(triggerName, sql, ctx.sourcePath);
      }
      this.renderSuccess(container, triggerName);
    }
    catch (error) {
      this.renderError(container, `Failed to register trigger: ${getErrorMessage(error)}`);
    }
  }

  private renderDisabled(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'vaultquery-sql-preview-section vaultquery-disabled' });
    header.createSpan({ text: 'Triggers are disabled. Enable them in ' });
    header.createEl('strong', { text: 'Settings → VaultQuery → Enable triggers' });
    header.createSpan({ text: '.' });
  }

  private renderSuccess(container: HTMLElement, triggerName: string): void {
    const header = container.createDiv({ cls: 'vaultquery-sql-preview-section' });
    header.createEl('code', { text: `Trigger "${triggerName}"` });
    header.appendText(' registered');
  }
}
