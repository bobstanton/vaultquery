import { App, MarkdownPostProcessorContext } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseUserDefinedProcessor } from './BaseUserDefinedProcessor';
import { parseFunctionName, validateFunctionSyntax } from '../utils/SQLParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export class FunctionCodeBlockProcessor extends BaseUserDefinedProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
  }

  protected getContainerClass(): string {
    return 'vaultquery-container vaultquery-function';
  }

  protected processContent(container: HTMLElement, source: string, _ctx: MarkdownPostProcessorContext): void {
    if (!this.plugin.settings.enableJavaScriptFunctions) {
      this.renderError(container, 'JavaScript SQL functions are disabled. Enable them in VaultQuery settings before using vaultquery-function blocks.');
      return;
    }

    const trimmedSource = source.trim();

    const validation = validateFunctionSyntax(trimmedSource);
    if (!validation.valid) {
      this.renderError(container, validation.error!);
      return;
    }

    const functionName = parseFunctionName(trimmedSource);
    if (!functionName) {
      this.renderError(container, 'Function must have a name: function myFunc(...) { ... }');
      return;
    }

    try {
      if (this.plugin.api.functionNeedsRecreation(functionName, trimmedSource)) {
        this.plugin.api.registerCustomFunction(functionName, trimmedSource);
      }
      this.renderSuccess(container, functionName, trimmedSource);
    }
    catch (error) {
      this.renderError(container, `Failed to create function: ${getErrorMessage(error)}`);
    }
  }

  private renderSuccess(container: HTMLElement, functionName: string, source: string): void {
    const header = container.createDiv({ cls: 'vaultquery-sql-preview-section' });

    const signatureMatch = source.match(/function\s+\w+\s*\([^)]*\)/);
    if (signatureMatch) {
      header.createEl('code', {
        text: signatureMatch[0]
      });
      header.appendText(' registered');
    }
    else {
      header.createEl('span', {
        text: `Function "${functionName}" registered`
      });
    }
  }
}
