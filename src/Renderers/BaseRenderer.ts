import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { splitQuerySections } from '../utils/QueryParsingUtils';

declare const activeWindow: Window;

export interface RenderContext {
  results: Record<string, unknown>[];
  parsed: {
    query: string;
    template?: string;
    chart?: Record<string, unknown>;
  };
  container: HTMLElement;
  app: App;
  openFile: (path: string) => void;
  MarkdownRenderer?: typeof MarkdownRenderer;
  pluginContext?: Component;
  settings?: VaultQuerySettings;
  onRefresh?: () => Promise<void>;
  sourcePath?: string;
}

export class RendererError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RendererError';
  }
}

export abstract class BaseRenderer {
  static renderSqlCodeBlock(app: App, container: HTMLElement, code: string, component?: Component): void {
    const codeBlockMarkdown = '```sql\n' + code.trim() + '\n```';
    const comp = component || new Component();
    if (!component) comp.load();
    void MarkdownRenderer.render(app, codeBlockMarkdown, container, '', comp);
  }

  static setupInternalLinks(container: HTMLElement, openFile: (path: string) => void): void {
    const links = container.querySelectorAll('a.internal-link[data-path]');
    links.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const path = (link as HTMLElement).dataset.path;
        if (path) {
          openFile(path);
        }
      });
    });
  }

  static addCopyAsMarkdownButton(buttonContainer: HTMLElement, results: Record<string, unknown>[]): void {
    const copyButton = buttonContainer.createDiv('vaultquery-floating-button');
    copyButton.setAttribute('aria-label', 'Copy as Markdown');
    setIcon(copyButton, 'clipboard');

    copyButton.addEventListener('click', async () => {
      try {
        const markdownTable = this.generateMarkdownTable(results);
        await navigator.clipboard.writeText(markdownTable);

        copyButton.empty();
        setIcon(copyButton, 'check');
        activeWindow.setTimeout(() => {
          copyButton.empty();
          setIcon(copyButton, 'clipboard');
        }, 2000);
      }
      catch (err) {
        console.error('Copy failed:', err);

        copyButton.empty();
        setIcon(copyButton, 'x');
        activeWindow.setTimeout(() => {
          copyButton.empty();
          setIcon(copyButton, 'clipboard');
        }, 2000);
      }
    });
  }

  static generateMarkdownTable(results: Record<string, unknown>[]): string {
    if (results.length === 0) return '';

    const columns = Object.keys(results[0]).filter(col => !col.startsWith('_'));
    const headerRow = '| ' + columns.join(' | ') + ' |';
    const separatorRow = '| ' + columns.map(() => '---').join(' | ') + ' |';

    const dataRows = results.map(row => {
      const cells = columns.map(col => {
        const value = row[col];
        if (value === null || value === undefined) return '';

        const cellValue = this.formatValueForMarkdown(col, value);

        return cellValue
          .replace(/\|/g, '\\|')
          .replace(/\n/g, '<br>')
          .replace(/\r/g, '');
      });
      return '| ' + cells.join(' | ') + ' |';
    });

    const parts = [headerRow, separatorRow, ...dataRows];
    return parts.join('\n');
  }

  private static formatValueForMarkdown(_columnName: string, value: unknown): string {
    const strValue = String(value);

    // Millisecond timestamps (13-digit numbers)
    if (/^\d{13}$/.test(strValue)) {
      const timestamp = Number(strValue);
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date.toLocaleString();
      }
    }

    // Date strings (YYYY-MM-DD format)
    if (/^\d{4}-\d{2}-\d{2}$/.test(strValue)) {
      const [year, month, day] = strValue.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return date.toLocaleDateString();
      }
    }

    return strValue;
  }

  static addRefreshButton(buttonContainer: HTMLElement, onRefresh: () => Promise<void>): void {
    const refreshButton = buttonContainer.createDiv('vaultquery-floating-button');
    refreshButton.setAttribute('aria-label', 'Refresh');
    setIcon(refreshButton, 'refresh-cw');

    let isRefreshing = false;

    refreshButton.addEventListener('click', async () => {
      if (isRefreshing) return;
      isRefreshing = true;

      refreshButton.addClass('vaultquery-refresh-spinning');

      try {
        await onRefresh();
      }
      catch (error) {
        console.error('Refresh failed:', error);

        refreshButton.removeClass('vaultquery-refresh-spinning');
        refreshButton.empty();
        setIcon(refreshButton, 'x');
        activeWindow.setTimeout(() => {
          refreshButton.empty();
          setIcon(refreshButton, 'refresh-cw');
          isRefreshing = false;
        }, 2000);
        return;
      }

      refreshButton.removeClass('vaultquery-refresh-spinning');
      isRefreshing = false;
    });
  }

  static renderQueryError(app: App, container: HTMLElement, error: unknown, querySource: string, component?: Component): void {
    const errorContainer = container.createDiv({ cls: 'vaultquery-error-container' });

    const { sqlQuery, templateConfigText } = splitQuerySections(querySource);

    const queryEl = errorContainer.createDiv({ cls: 'vaultquery-error-query' });
    this.renderSqlCodeBlock(app, queryEl, sqlQuery, component);

    if (templateConfigText) {
      const templateEl = errorContainer.createDiv({ cls: 'vaultquery-error-template' });
      templateEl.createEl('h4', { text: 'Template configuration:' });
      const pre = templateEl.createEl('pre');
      pre.createEl('code', { text: templateConfigText.trim() });
    }

    errorContainer.createDiv({
      cls: 'vaultquery-error',
      text: getErrorMessage(error) || 'Unknown error occurred'
    });
  }
}