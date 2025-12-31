import { App, Component, MarkdownPostProcessorContext } from 'obsidian';
import VaultQueryPlugin from '../main';
import { waitForIndexingWithProgress } from '../utils/IndexingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export class FunctionCodeBlockProcessor {
  private component: Component;

  public constructor(private _app: App, private plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container vaultquery-function' });

    const ready = waitForIndexingWithProgress(
      () => this.plugin.api,
      container,
      () => this.createFunction(container, source)
    );

    if (ready) {
      void this.createFunction(container, source);
    }
  }

  private parseFunctionName(source: string): string | null {
    const match = source.match(/^\s*function\s+(\w+)\s*\(/);
    return match ? match[1] : null;
  }

  private validateFunctionSource(source: string): string | null {
    const trimmed = source.trim();

    if (!trimmed.startsWith('function')) {
      return 'Function must start with "function name(...) {"';
    }

    if (!this.parseFunctionName(trimmed)) {
      return 'Function must have a name: function myFunc(...) { ... }';
    }

    const openBraces = (trimmed.match(/{/g) || []).length;
    const closeBraces = (trimmed.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      return 'Mismatched braces in function definition';
    }

    if (openBraces === 0) {
      return 'Function body must be wrapped in { }';
    }

    return null;
  }

  private createFunction(container: HTMLElement, source: string): void {
    const trimmedSource = source.trim();

    const validationError = this.validateFunctionSource(trimmedSource);
    if (validationError) {
      this.renderError(container, validationError);
      return;
    }

    const functionName = this.parseFunctionName(trimmedSource);
    if (!functionName) {
      this.renderError(container, 'Could not parse function name');
      return;
    }

    try {
      this.plugin.api.registerCustomFunction(functionName, trimmedSource);

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

  private renderError(container: HTMLElement, message: string): void {
    container.createDiv({
      cls: 'vaultquery-error',
      text: message
    });
  }
}
