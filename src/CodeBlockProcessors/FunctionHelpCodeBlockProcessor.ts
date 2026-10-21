import { App } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import * as functionHelp from '../generated-help/vaultquery-function-help.generated';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';

export class FunctionHelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-function-help', functionHelp);
  }

  protected renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'functions') {
      this.renderGeneratedMarkdown(container, () => this.generateFunctionsMarkdown());
    }
    else {
      super.renderDynamicContent(container, key);
    }
  }

  private async generateFunctionsMarkdown(): Promise<string> {
    const sections: string[] = [];

    const userFunctions = await this.plugin.api?.getAllUserFunctions() ?? [];

    if (userFunctions.length > 0) {
      sections.push('| Function | Source file | Definition |');
      sections.push('|----------|-------------|------------|');

      for (const { function_name, path, source } of userFunctions.sort((a, b) => a.function_name.localeCompare(b.function_name))) {
        const sigMatch = source.match(/function\s+\w+\s*\([^)]*\)/);
        const signature = sigMatch ? sigMatch[0] : function_name;
        const truncated = source.length > 50 ? source.substring(0, 47) + '...' : source;
        const escaped = truncated.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const fileName = path.split('/').pop() || path;
        sections.push(`| \`${signature}\` | ${fileName} | \`${escaped}\` |`);
      }

      sections.push('');
    }

    else {
      sections.push('> No user-defined functions. Use `vaultquery-function` to define one.\n');
    }

    return sections.join('\n');
  }
}
