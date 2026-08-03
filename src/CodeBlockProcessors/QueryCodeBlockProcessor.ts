import { BaseRenderer } from '../Renderers/BaseRenderer';
import { containsSqlKeywords } from '../utils/SQLParsingUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import { BaseReadQueryCodeBlockProcessor } from './BaseReadQueryCodeBlockProcessor';

export class QueryCodeBlockProcessor extends BaseReadQueryCodeBlockProcessor {
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
    return containsSqlKeywords(query, ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER']);
  }

}
