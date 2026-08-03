import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { splitQuerySections } from '../utils/QueryParsingUtils';
import { formatResultsAsMarkdown } from '../utils/ResultFormatUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Renderer');

interface FloatingButtonConfig {
  ariaLabel: string;
  icon: string;
  spinnerClass?: string;
  onClick: () => Promise<void>;
}

/**
 * Keep refresh buttons busy for at least this long, even when the refresh resolves
 * instantly, so rapid double clicks cannot trigger a second refresh.
 * Mirrors the Places plugins' refresh-button behavior.
 */
const MIN_REFRESH_BUSY_MS = 1000;

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
  settings: VaultQuerySettings;
  /** `force: true` is passed by the manual refresh button to bypass skip-if-unchanged. */
  onRefresh?: (force?: boolean) => Promise<void>;
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

    const beginRefreshProgress = (): (() => void) => {
      const host = container.parentElement;
      if (!host) return () => undefined;
      host.addClass('vaultquery-refresh-progress-host');
      const bar = host.createDiv('vaultquery-refresh-progress');
      return () => {
        bar.remove();
        host.removeClass('vaultquery-refresh-progress-host');
      };
    };

    button.addEventListener('click', () => {
      if (isProcessing) return;
      isProcessing = true;
      button.setAttribute('aria-disabled', 'true');

      const isRefreshButton = Boolean(config.spinnerClass);
      let endRefreshProgress: (() => void) | null = null;
      if (isRefreshButton) {
        container.addClass('vaultquery-floating-buttons-active');
        button.addClass(config.spinnerClass!);
        button.empty();
        setIcon(button, 'loader');
        endRefreshProgress = beginRefreshProgress();
      }
      const startedAt = Date.now();

      void (async () => {
        try {
          await config.onClick();
          if (!isRefreshButton) {
            this.showButtonFeedback(button, 'check', config.icon);
          }
        } catch (err) {
          logger.error(`${config.ariaLabel} failed`, err);
          if (!isRefreshButton) {
            this.showButtonFeedback(button, 'x', config.icon);
          }
        } finally {
          if (isRefreshButton) {
            // Keep the busy state visible for a minimum window to absorb double clicks
            // even when the refresh is effectively instantaneous.
            const remainingMs = MIN_REFRESH_BUSY_MS - (Date.now() - startedAt);
            if (remainingMs > 0) {
              await new Promise(resolve => window.setTimeout(resolve, remainingMs));
            }
            endRefreshProgress?.();
            button.removeClass(config.spinnerClass!);
            container.removeClass('vaultquery-floating-buttons-active');
            button.empty();
            setIcon(button, config.icon);
            button.removeAttribute('aria-disabled');
            isProcessing = false;
          } else {
            window.setTimeout(() => {
              button.removeAttribute('aria-disabled');
              isProcessing = false;
            }, 2000);
          }
        }
      })();
    });

    return button;
  }

  private static showButtonFeedback(button: HTMLElement, feedbackIcon: string, originalIcon: string): void {
    button.empty();
    setIcon(button, feedbackIcon);
    window.setTimeout(() => {
      button.empty();
      setIcon(button, originalIcon);
    }, 2000);
  }

  static addCopyAsMarkdownButton(buttonContainer: HTMLElement, results: Record<string, unknown>[] | (() => Record<string, unknown>[]), columns?: string[]): void {
    this.createFloatingButton(buttonContainer, {
      ariaLabel: 'Copy as Markdown',
      icon: 'clipboard',
      onClick: async () => {
        const currentResults = typeof results === 'function' ? results() : results;
        const markdownTable = this.generateMarkdownTable(currentResults, columns);
        await navigator.clipboard.writeText(markdownTable);
      }
    });
  }

  static generateMarkdownTable(results: Record<string, unknown>[], columns?: string[]): string {
    return formatResultsAsMarkdown(results, {
      columns,
      formatValues: true
    });
  }

  static addRefreshButton(buttonContainer: HTMLElement, onRefresh: (force?: boolean) => Promise<void>): void {
    this.createFloatingButton(buttonContainer, {
      ariaLabel: 'Refresh',
      icon: 'refresh-cw',
      spinnerClass: 'vaultquery-refresh-spinning',
      // Manual refresh forces a redraw even when results are unchanged.
      onClick: () => onRefresh(true)
    });
  }

  static renderQueryError(app: App, container: HTMLElement, error: unknown, querySource: string, component?: Component): void {
    container.empty();
    const errorContainer = container.createDiv({ cls: 'vaultquery-error-container' });

    let sqlQuery = querySource;
    let templateConfigText: string | null = null;
    let configSectionText: string | null = null;
    try {
      const sections = splitQuerySections(querySource);
      sqlQuery = sections.sqlQuery;
      templateConfigText = sections.templateConfigText;
      configSectionText = sections.configSection;
    } catch (error) {
      // Best-effort section split for error display; keep the raw query on failure.
      logger.info('Failed to split query sections for error display; using raw query', error);
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
