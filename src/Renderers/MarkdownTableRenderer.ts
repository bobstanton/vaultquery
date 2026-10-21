import { INFO_MESSAGES } from '../utils/ErrorMessages';
import { formatDisplayValue } from '../utils/ResultFormatUtils';
import { Component } from 'obsidian';
import { csvVisibleColumns } from '../Tabular/TabularPresentation';
import { BaseRenderer } from './BaseRenderer';
import { addFloatingButtons } from './OutputChrome';
import { exportNameFor } from './ExportMenu';
import { markdownCellSource, parseMarkdownColumns, shouldRenderMarkdownColumn, NO_MARKDOWN_COLUMNS } from './MarkdownCells';
import type { MarkdownColumnSelection } from './MarkdownCells';
import type { RenderContext } from './BaseRenderer';

interface MarkdownTableConfig {
  columns?: string[];
  alignment?: Array<'left' | 'center' | 'right'>;
  markdown?: MarkdownColumnSelection;
}

const renderComponents = new WeakMap<HTMLElement, Component>();

export class MarkdownTableRenderer extends BaseRenderer {
  static cleanupContainer(container: HTMLElement): void {
    renderComponents.get(container)?.unload();
    renderComponents.delete(container);
  }

  static parseConfig(options?: Record<string, unknown>): MarkdownTableConfig {
    const config: MarkdownTableConfig = {};

    const columnsValue = typeof options?.columns === 'string' ? options.columns : '';

    if (columnsValue) {
      config.columns = columnsValue
        .split(',')
        .map(column => column.trim())
        .filter(Boolean);
    }

    config.markdown = parseMarkdownColumns(options);

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
        text: INFO_MESSAGES.NO_RESULTS
      });

      container.empty();
      container.append(...Array.from(tempContainer.childNodes));
      addFloatingButtons(container, { onRefresh });

      return;
    }

    const columns = this.resolveColumns(results, config.columns, context.dataFileColumns);

    if (!columns.length) {
      throw new Error('Markdown output columns config did not match any query result columns.');
    }

    this.cleanupContainer(container);
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

        const content = formatDisplayValue(row[columns[i]], columns[i], Boolean(context.dataFileColumns));

        if (!content) {
          continue;
        }

        const markdown = shouldRenderMarkdownColumn(config.markdown ?? NO_MARKDOWN_COLUMNS, columns[i])
          ? markdownCellSource(content) : undefined;

        if (markdown !== undefined) {
          markdownCells.push({ td, content: markdown });
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

        await Promise.all(batch.map(({ td, content }) => context.MarkdownRenderer!.render(app, content, td, sourcePath ?? '', renderComponent)
        ));
      }
    }

    container.empty();
    container.append(...Array.from(tempContainer.childNodes));

    addFloatingButtons(container, { results, columns, dataFileColumns: context.dataFileColumns, app: context.app,
      exportFolder: context.settings.exportFolder, exportName: exportNameFor(context), onRefresh });
  }

  private static resolveColumns(results: Record<string, unknown>[], configuredColumns?: string[], dataFileColumns?: readonly string[]): string[] {
    const availableColumns = csvVisibleColumns(results[0], dataFileColumns);

    if (!configuredColumns?.length) {
      return availableColumns;
    }

    return configuredColumns.filter(column => availableColumns.includes(column));
  }
}
