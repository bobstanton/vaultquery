import { Component } from 'obsidian';
import { BaseRenderer } from './BaseRenderer';
import type { RenderContext } from './BaseRenderer';

interface MarkdownTableConfig {
  columns?: string[];
  alignment?: Array<'left' | 'center' | 'right'>;
}

const MARKDOWN_PATTERN = /\[\[|!\[|```|`|^\s*[-*+]\s|^\s*\d+\.\s|\*\*|__|\*|_|^#+\s|^\s*>/m;
const renderComponents = new WeakMap<HTMLElement, Component>();

export class MarkdownTableRenderer extends BaseRenderer {
  static parseConfig(options?: Record<string, unknown>): MarkdownTableConfig {
    const config: MarkdownTableConfig = {};

    const columnsValue = typeof options?.columns === 'string' ? options.columns : '';
    if (columnsValue) {
      config.columns = columnsValue
        .split(',')
        .map(column => column.trim())
        .filter(Boolean);
    }

    const alignmentValue = typeof options?.alignment === 'string' ? options.alignment : '';
    if (alignmentValue) {
      config.alignment = alignmentValue.split(',').map(value => {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'center' || normalized === 'right') {
          return normalized;
        }
        return 'left';
      });
    }

    return config;
  }

  static async render(context: RenderContext, config: MarkdownTableConfig = {}): Promise<void> {
    const { container, results, onRefresh, app, sourcePath } = context;

    const tempContainer = container.createDiv();
    tempContainer.detach();

    if (!results.length) {
      tempContainer.createDiv({
        cls: 'vaultquery-empty',
        text: 'Query returned no results'
      });

      const buttonContainer = tempContainer.createDiv('vaultquery-floating-buttons');
      if (onRefresh) {
        BaseRenderer.addRefreshButton(buttonContainer, onRefresh);
      }

      container.empty();
      container.append(...Array.from(tempContainer.childNodes));
      return;
    }

    const columns = this.resolveColumns(results, config.columns);
    if (!columns.length) {
      throw new Error('Markdown output columns config did not match any query result columns.');
    }
    const shouldRenderMarkdownContent = context.settings.contentRenderingMode === 'rendered-markdown';

    renderComponents.get(container)?.unload();
    const renderComponent = new Component();
    renderComponent.load();
    renderComponents.set(container, renderComponent);

    const table = tempContainer.createEl('table', { cls: 'vaultquery-table vaultquery-markdown-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');

    for (let i = 0; i < columns.length; i++) {
      const th = headerRow.createEl('th');
      const alignment = config.alignment?.[i];
      if (alignment === 'center' || alignment === 'right') {
        th.addClass(`vaultquery-align-${alignment}`);
      }
      th.textContent = columns[i];
    }

    const tbody = table.createEl('tbody');
    const markdownCells: Array<{ td: HTMLElement; content: string }> = [];

    for (const row of results) {
      const tr = tbody.createEl('tr');

      for (let i = 0; i < columns.length; i++) {
        const td = tr.createEl('td');
        const alignment = config.alignment?.[i];
        if (alignment === 'center' || alignment === 'right') {
          td.addClass(`vaultquery-align-${alignment}`);
        }

        const content = row[columns[i]] == null ? '' : String(row[columns[i]]);
        if (!content) {
          continue;
        }

        if (shouldRenderMarkdownContent && MARKDOWN_PATTERN.test(content)) {
          markdownCells.push({ td, content });
        }
        else {
          td.textContent = content;
        }
      }
    }

    if (markdownCells.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < markdownCells.length; i += BATCH_SIZE) {
        const batch = markdownCells.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(({ td, content }) =>
          context.MarkdownRenderer!.render(app, content, td, sourcePath ?? '', renderComponent)
        ));
      }
    }

    const buttonContainer = tempContainer.createDiv('vaultquery-floating-buttons');
    BaseRenderer.addCopyAsMarkdownButton(buttonContainer, results, columns);
    if (onRefresh) {
      BaseRenderer.addRefreshButton(buttonContainer, onRefresh);
    }

    container.empty();
    container.append(...Array.from(tempContainer.childNodes));
  }

  private static resolveColumns(results: Record<string, unknown>[], configuredColumns?: string[]): string[] {
    const availableColumns = Object.keys(results[0]).filter(column => !column.startsWith('_'));

    if (!configuredColumns?.length) {
      return availableColumns;
    }

    return configuredColumns.filter(column => availableColumns.includes(column));
  }
}
