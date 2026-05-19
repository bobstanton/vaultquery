import { App } from 'obsidian';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import { BaseReadQueryCodeBlockProcessor } from './BaseReadQueryCodeBlockProcessor';

export class QueryCodeBlockProcessor extends BaseReadQueryCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
  }

  protected getBlockType(): string {
    return 'vaultquery';
  }

  protected validateParsedQuery(container: HTMLElement, parsed: ParsedQuery): boolean {
    if (!this.containsWriteOperations(parsed.query)) {
      return true;
    }

    BaseRenderer.renderError(container, {
      title: 'Query Error',
      message: 'Write operations (INSERT, UPDATE, DELETE) are not allowed in regular vaultquery blocks. Use vaultquery-write blocks for write operations.'
    });
    return false;
  }

  private containsWriteOperations(query: string): boolean {
    // Strip string literals to avoid false positives from keywords inside strings
    const queryWithoutStrings = query.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const upperQuery = queryWithoutStrings.toUpperCase().trim();
    const writeOperations = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER'];

    return writeOperations.some(op => {
      const regex = new RegExp(`\\b${op}\\b`, 'i');
      return regex.test(upperQuery);
    });
  }

}
