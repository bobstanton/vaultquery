import { debounce } from 'obsidian';
import { mergeHelpers, obsidianHelpers } from 'placeholder-resolver';
import { renderUserHtmlTemplate } from 'user-template-renderer';
import { BaseRenderer } from './BaseRenderer';
import { logger as rootLogger } from '../utils/logger';
import { getErrorMessage } from '../utils/ErrorMessages';

const logger = rootLogger.scope('JavaScriptRenderer');

interface TemplateRenderContext {
  results: Record<string, unknown>[];
  query: string;
  count: number;
}

// Cache debounced render functions per container (WeakMap for automatic cleanup)
type RenderFn = (template: string, context: TemplateRenderContext, openFile: (path: string) => void) => void;
const debouncedRenderers = new WeakMap<HTMLElement, RenderFn>();
const DEBOUNCE_MS = 50;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderWikilinks(text: string): string {
  if (!text) return '';

  const wikilinkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
  const result: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = wikilinkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(escapeHtml(text.slice(lastIndex, match.index)));
    }

    const target = match[1];
    const displayText = match[2] || target;
    const escapedPath = target.replace(/"/g, '&quot;');
    result.push(`<a href="${escapedPath}" class="internal-link" data-path="${escapedPath}">${escapeHtml(displayText)}</a>`);

    lastIndex = wikilinkRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push(escapeHtml(text.slice(lastIndex)));
  }

  return result.join('');
}

function buildTemplateHelpers() {
  return { ...mergeHelpers(obsidianHelpers), renderWikilinks };
}

export class JavaScriptRenderer extends BaseRenderer {
  static render(template: string, context: TemplateRenderContext, container: HTMLElement, openFile: (path: string) => void): void {
    let debouncedRender = debouncedRenderers.get(container);
    if (!debouncedRender) {
      debouncedRender = debounce(
        (t: string, ctx: TemplateRenderContext, open: (path: string) => void) => {
          this.renderImmediate(t, ctx, container, open);
        },
        DEBOUNCE_MS,
        true
      );
      debouncedRenderers.set(container, debouncedRender);
    }

    debouncedRender(template, context, openFile);
  }

  private static renderImmediate(template: string, context: TemplateRenderContext, container: HTMLElement, openFile: (path: string) => void): void {
    try {
      let parent = container.parentElement;
      while (parent) {
        if (parent.classList.contains('vaultquery-container') || parent.classList.contains('vaultquery-results')) {
          logger.warn('Detected nested template render attempt, skipping to prevent recursion');
          BaseRenderer.renderError(container, {
            title: 'JavaScript rendering error',
            message: 'Cannot render nested queries'
          });
          return;
        }
        parent = parent.parentElement;
      }

      const helpers = buildTemplateHelpers();

      container.empty();
      renderUserHtmlTemplate({
        template,
        mode: 'function-body',
        args: [
          { name: 'results', value: context.results },
          { name: 'query', value: context.query },
          { name: 'count', value: context.count },
          { name: 'h', value: helpers },
        ],
        container,
        clearContainer: false,
        setupRoot: (root) => this.setupInternalLinks(root, openFile),
      });
    }
    catch (error: unknown) {
      logger.error('JavaScript rendering failed', error);
      container.empty();
      BaseRenderer.renderError(container, {
        title: 'JavaScript rendering error',
        message: getErrorMessage(error)
      });
    }
  }

}
