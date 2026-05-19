import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { splitQuerySections } from '../utils/QueryParsingUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;

const logger = rootLogger.scope('Renderer');

interface FloatingButtonConfig {
  ariaLabel: string;
  icon: string;
  spinnerClass?: string;
  onClick: () => Promise<void>;
}

interface ErrorRenderOptions {
  title: string;
  message?: string;
  icon?: string;
  className?: string;
}

export interface RenderContext {
  results: Record<string, unknown>[];
  parsed: ParsedQuery;
  container: HTMLElement;
  app: App;
  openFile: (path: string) => void;
  MarkdownRenderer?: typeof MarkdownRenderer;
  pluginContext?: Component;
  settings?: VaultQuerySettings;
  onRefresh?: () => Promise<void>;
  sourcePath?: string;
}

export abstract class BaseRenderer {
  static renderError(container: HTMLElement, options: ErrorRenderOptions): HTMLElement {
    const classes = ['vaultquery-error'];
    if (options.className) {
      classes.push(...options.className.split(/\s+/).filter(Boolean).map(cls => `vaultquery-${cls}`));
    }

    const errorDiv = container.createDiv({ cls: classes.join(' ') });
    const titleText = options.icon ? `${options.icon} ${options.title}` : options.title;
    errorDiv.createEl('h3', { text: titleText });

    if (options.message) {
      errorDiv.createEl('p', { text: options.message });
    }

    return errorDiv;
  }

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

  private static createFloatingButton(container: HTMLElement, config: FloatingButtonConfig): HTMLElement {
    const button = container.createDiv('vaultquery-floating-button');
    button.setAttribute('aria-label', config.ariaLabel);
    setIcon(button, config.icon);

    let isProcessing = false;

    button.addEventListener('click', () => {
      if (isProcessing) return;
      isProcessing = true;

      if (config.spinnerClass) {
        button.addClass(config.spinnerClass);
      }

      void (async () => {
        try {
          await config.onClick();
          this.showButtonFeedback(button, 'check', config.icon, config.spinnerClass);
        } catch (err) {
          logger.error(`${config.ariaLabel} failed`, err);
          this.showButtonFeedback(button, 'x', config.icon, config.spinnerClass);
        } finally {
          activeWindow.setTimeout(() => {
            isProcessing = false;
          }, 2000);
        }
      })();
    });

    return button;
  }

  private static showButtonFeedback(button: HTMLElement, feedbackIcon: string, originalIcon: string, spinnerClass?: string): void {
    if (spinnerClass) {
      button.removeClass(spinnerClass);
    }
    button.empty();
    setIcon(button, feedbackIcon);
    activeWindow.setTimeout(() => {
      button.empty();
      setIcon(button, originalIcon);
    }, 2000);
  }

  static addCopyAsMarkdownButton(buttonContainer: HTMLElement, results: Record<string, unknown>[], columns?: string[]): void {
    this.createFloatingButton(buttonContainer, {
      ariaLabel: 'Copy as Markdown',
      icon: 'clipboard',
      onClick: async () => {
        const markdownTable = this.generateMarkdownTable(results, columns);
        await navigator.clipboard.writeText(markdownTable);
      }
    });
  }

  static generateMarkdownTable(results: Record<string, unknown>[], columns?: string[]): string {
    if (results.length === 0) return '';

    const visibleColumns = (columns && columns.length > 0
      ? columns
      : Object.keys(results[0]).filter(col => !col.startsWith('_')));

    const headerRow = '| ' + visibleColumns.join(' | ') + ' |';
    const separatorRow = '| ' + visibleColumns.map(() => '---').join(' | ') + ' |';

    const dataRows = results.map(row => {
      const cells = visibleColumns.map(col => {
        const value = row[col];
        if (value == null) return '';

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

    if (/^\d{13}$/.test(strValue)) {
      const timestamp = Number(strValue);
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date.toLocaleString();
      }
    }

    const formattedDate = this.formatIsoDateString(strValue);
    if (formattedDate !== strValue) {
      return formattedDate;
    }

    return strValue;
  }

  protected static formatIsoDateString(dateStr: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return date.toLocaleDateString();
      }
    }

    return dateStr;
  }

  static addRefreshButton(buttonContainer: HTMLElement, onRefresh: () => Promise<void>): void {
    this.createFloatingButton(buttonContainer, {
      ariaLabel: 'Refresh',
      icon: 'refresh-cw',
      spinnerClass: 'vaultquery-refresh-spinning',
      onClick: onRefresh
    });
  }

  static renderQueryError(app: App, container: HTMLElement, error: unknown, querySource: string, component?: Component): void {
    container.empty();
    const errorContainer = container.createDiv({ cls: 'vaultquery-error-container' });

    // Try to split query sections, but don't fail if parsing throws
    // (e.g., when the error IS the parsing error like missing semicolon)
    let sqlQuery = querySource;
    let templateConfigText: string | null = null;
    let configSectionText: string | null = null;
    try {
      const sections = splitQuerySections(querySource);
      sqlQuery = sections.sqlQuery;
      templateConfigText = sections.templateConfigText;
      configSectionText = sections.configSection;
    } catch {
      // If splitting fails, just show the raw source
    }

    this.renderError(errorContainer, {
      title: 'Query Error',
      message: getErrorMessage(error) || 'Unknown error occurred'
    });

    const queryEl = errorContainer.createDiv({ cls: 'vaultquery-error-query' });
    queryEl.createEl('h4', { text: 'Query:' });
    this.renderSqlCodeBlock(app, queryEl, sqlQuery, component);

    if (templateConfigText) {
      const templateEl = errorContainer.createDiv({ cls: 'vaultquery-error-template' });
      templateEl.createEl('h4', { text: 'JavaScript rendering code:' });
      const pre = templateEl.createEl('pre', { cls: 'vaultquery-error-help' });
      pre.createEl('code', { text: templateConfigText.trim() });
    }

    if (configSectionText) {
      const configEl = errorContainer.createDiv({ cls: 'vaultquery-error-template' });
      configEl.createEl('h4', { text: 'Output configuration:' });
      const pre = configEl.createEl('pre', { cls: 'vaultquery-error-help' });
      pre.createEl('code', { text: configSectionText.trim() });
    }

  }
}
